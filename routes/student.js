const express  = require('express');
const router   = express.Router();
const supabase = require('../services/supabase');
const { normalizeGrade } = require('../services/gradeMatch');

// ── GET /student/available-to-link?teacherEmail=xxx ────────
// Returns students NOT already linked to this teacher.
// If teacher record has grade/curriculum, filters to matching students.

router.get('/available-to-link', async (req, res) => {
  try {
    const teacherEmail = String(req.query.teacherEmail || '').toLowerCase().trim();
    if (!teacherEmail) return res.status(400).json({ error: 'teacherEmail required' });

    // Resolve teacher record (optional — used for grade/curriculum/school filtering)
    const { data: teacher } = await supabase
      .from('users')
      .select('id, grade, curriculum, school')
      .eq('email', teacherEmail)
      .maybeSingle();

    // Get already-linked student IDs (works even if teacher not in users table)
    let linkedIds = [];
    if (teacher?.id) {
      const { data: linked } = await supabase
        .from('teacher_student')
        .select('student_id')
        .eq('teacher_id', teacher.id);
      linkedIds = (linked || []).map(l => l.student_id);
    }

    // Grades to filter by — priority: ?grades param → user_preferences teaches → teacher.grade → all pilot grades
    const VALID_GRADES = ['Grade 3', 'Grade 4', 'Grade 5'];
    let gradesToShow = VALID_GRADES;

    // 1. Grades passed directly from frontend (the teacher's actual grades). Accept
    //    them as-is — don't drop grades outside the old pilot set (UKG, Grade 6, etc.).
    const gradesParam = req.query.grades
      ? String(req.query.grades).split(',').map(g => decodeURIComponent(g.trim())).filter(Boolean)
      : [];

    if (gradesParam.length > 0) {
      gradesToShow = gradesParam;
    } else {
      // 2. Look up teaches[] from user_preferences in Supabase
      const { data: prefs } = await supabase
        .from('user_preferences')
        .select('data')
        .eq('user_email', teacherEmail)
        .maybeSingle();
      const teaches = prefs?.data?.teaches;
      if (Array.isArray(teaches) && teaches.length > 0) {
        const fromPrefs = teaches.map(t => t.grade).filter(Boolean);
        if (fromPrefs.length > 0) gradesToShow = fromPrefs;
      } else if (teacher?.grade) {
        // 3. Single grade from users table
        gradesToShow = [teacher.grade];
      }
    }

    // Grade match is done in JS (normalizeGrade), not a DB .in() on the raw
    // string — real data has both "6" and "Grade 6" stored for the same
    // grade (confirmed live), so an exact-string .in() silently returns zero
    // rows whenever the teacher's stored format and the student's stored
    // format disagree, even though every other field matches.
    let query = supabase
      .from('users')
      .select('id, name, email, grade, curriculum, photo_url, role')
      .eq('role', 'student'); // whitelist, not a "not teacher" blacklist — a
      // non-teacher, non-student account (e.g. role: 'parent') must never be
      // offered as a linkable "student" (confirmed live: happened for a
      // teacher whose own account had role 'parent').

    if (teacher?.curriculum) query = query.eq('curriculum', teacher.curriculum);
    // School scoping: a teacher can only link students from their OWN school —
    // same curriculum + grade but a different school must not appear here.
    if (teacher?.school) query = query.eq('school', teacher.school);

    const { data: candidates } = await query;

    const normalizedTargetGrades = new Set(gradesToShow.map(normalizeGrade));
    const available = (candidates || [])
      // role: 'student' checked again here, not just in the query above — a
      // whitelist at both the DB and JS layer, so nothing slips through if the
      // Supabase query's own filter is ever bypassed or a caller mocks/stubs it.
      .filter(s => !linkedIds.includes(s.id) && s.name && s.role === 'student' && normalizedTargetGrades.has(normalizeGrade(s.grade)))
      .map(s => ({ id: s.id, name: s.name, email: s.email, grade: s.grade, curriculum: s.curriculum, photoUrl: s.photo_url }));

    res.json(available);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function todayISO() {
  return new Date().toISOString().split('T')[0];
}

function computeLevel(xp) {
  let level = 1, threshold = 500, total = 0;
  while (xp >= total + threshold) { total += threshold; threshold += 250; level++; }
  return level;
}

// Normalise DB row → frontend shape (snake_case → camelCase)
function normalise(row) {
  return {
    studentId:           row.student_id,
    xpPoints:            row.xp_points,
    level:               row.level,
    studyTimeMinutes:    row.study_time_minutes,
    learningPathMinutes: row.learning_path_minutes,
    assignmentTimeMinutes: row.assignment_time_minutes ?? 0,
    challengeTimeMinutes:  row.challenge_time_minutes ?? 0,
    topicsExplored:      row.topics_explored,
    challengesCompleted: row.challenges_completed,
    assignmentsDone:     row.assignments_done,
    currentStreak:       row.current_streak,
    lastActiveDate:      row.last_active_date,
    todayStudyMinutes:   row.today_study_minutes,
    todayXP:             row.today_xp,
    completedTopics:     row.completed_topics ?? [],
    lastLesson:          row.last_lesson ?? '',
  };
}

// Get or create student_stats row
async function getOrCreate(studentId) {
  let { data } = await supabase
    .from('student_stats')
    .select('*')
    .eq('student_id', studentId)
    .maybeSingle();

  if (!data) {
    // Verify the user exists before inserting (avoids FK violation)
    const { data: userExists } = await supabase
      .from('users')
      .select('id')
      .eq('id', studentId)
      .maybeSingle();

    if (!userExists) {
      // Return default stats object without persisting
      return {
        student_id: studentId, xp_points: 0, level: 1, current_streak: 0,
        completed_topics: [], study_time_minutes: 0, today_study_minutes: 0,
        today_xp: 0, assignments_done: 0, last_active_date: todayISO(),
      };
    }

    const { data: created, error: createErr } = await supabase
      .from('student_stats')
      .insert({ student_id: studentId, last_active_date: todayISO() })
      .select()
      .single();
    if (createErr) throw createErr;
    data = created;
  }
  return data;
}

// ── GET /student/leaderboard?limit=10&teacherEmail=xxx ──────
// Returns top students ranked by XP from student_stats + users tables.
// When teacherEmail is supplied, it becomes a *class* leaderboard scoped to
// that teacher: only their linked students, in the same school + curriculum
// and the grade(s) the teacher actually teaches.



async function fetchTotalTopicsFromQdrant(curriculum, grade) {
  try {
    const LEARNING_PATHS_URL = process.env.LEARNING_PATHS_SERVER_URL || 'http://localhost:3014';
    const res = await fetch(`${LEARNING_PATHS_URL}/curriculum/topic-count?curriculum=${encodeURIComponent(curriculum)}&grade=${encodeURIComponent(grade)}`);
    if (!res.ok) return 0;
    const data = await res.json();
    return data.totalTopics || 0;
  } catch {
    return 0;
  }
}

router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let record = await getOrCreate(id);
    const today = todayISO();

    // Reset today's counters if new day; recalculate streak
    if (record.last_active_date !== today) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yISO = yesterday.toISOString().split('T')[0];
      const newStreak = record.last_active_date === yISO
        ? (record.current_streak || 0) + 1
        : 1;

      const { data: updated } = await supabase
        .from('student_stats')
        .update({
          today_study_minutes: 0,
          today_xp:            0,
          current_streak:      newStreak,
          last_active_date:    today,
          updated_at:          new Date().toISOString(),
        })
        .eq('student_id', id)
        .select()
        .single();
      record = updated ?? record;
    }

    // Fetch user profile to get curriculum + grade for dynamic totalTopics
    const { data: userRow } = await supabase
      .from('users')
      .select('curriculum, grade')
      .eq('id', id)
      .single();

    const curriculum  = userRow?.curriculum ?? '';
    const grade       = userRow?.grade ?? '';
    const totalTopics = await fetchTotalTopicsFromQdrant(curriculum, grade);

    // Compute challenges-completed LIVE from challenge_assignments so the count is
    // always accurate (the student_stats counter isn't reliably incremented on
    // completion — caused the parent "0 Done" even after the child completed some).
    const { count: completedChallenges } = await supabase
      .from('challenge_assignments')
      .select('id', { head: true, count: 'exact' })
      .eq('student_id', id)
      .eq('status', 'completed');

    res.json({
      ...normalise(record),
      totalTopics,
      challengesCompleted: Number.isFinite(completedChallenges) ? Number(completedChallenges) : (normalise(record).challengesCompleted ?? 0),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /student/:id ────────────────────────────────────────
// Full stats sync from client


router.get('/:id/weekly', async (req, res) => {
  try {
    const { id } = req.params;

    // Build current calendar week (Mon → Sun), zeros for future days
    const today = new Date();
    const todayDay = today.getDay(); // 0=Sun,1=Mon,...,6=Sat
    const mondayOffset = todayDay === 0 ? -6 : 1 - todayDay; // days back to Monday
    const monday = new Date(today);
    monday.setDate(today.getDate() + mondayOffset);

    const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      days.push({
        date:   d.toISOString().split('T')[0],
        day:    DAY_NAMES[d.getDay()],
        future: d > today,
      });
    }
    const from = days[0].date;
    const to   = days[days.length - 1].date;

    const { data: logs } = await supabase
      .from('student_daily_log')
      .select('*')
      .eq('student_id', id)
      .gte('log_date', from)
      .lte('log_date', to);

    const logMap = {};
    (logs ?? []).forEach(l => { logMap[l.log_date] = l; });

    res.json({
      days: days.map(d => ({
        date:            d.date,
        day:             d.day,
        studyMinutes:    d.future ? 0 : (logMap[d.date]?.study_minutes    ?? 0),
        xp:              d.future ? 0 : (logMap[d.date]?.xp_earned        ?? 0),
        topicsCompleted: d.future ? 0 : (logMap[d.date]?.topics_completed ?? 0),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /student/:id/complete-lesson ──────────────────────


router.get('/:id/mistake-trends', async (req, res) => {
  try {
    const { id } = req.params;
    const { subject, grade, limit: rowLimit } = req.query;

    let query = supabase
      .from('topic_attempts')
      .select('*')
      .eq('student_id', id)
      .order('created_at', { ascending: false });

    if (subject) query = query.eq('subject', subject);
    if (grade)   query = query.eq('grade', grade);
    if (rowLimit) query = query.limit(parseInt(rowLimit) || 200);

    const { data: attempts, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    // Group by topic
    const byTopic = {};
    for (const a of (attempts || [])) {
      if (!byTopic[a.topic]) {
        byTopic[a.topic] = {
          topic:          a.topic,
          subject:        a.subject,
          grade:          a.grade,
          attempts:       [],
          totalAttempts:  0,
          bestScore:      0,
          latestScore:    0,
          passed:         false,
          totalTimeSeconds: 0,
        };
      }
      const t = byTopic[a.topic];
      t.attempts.push({
        attemptNumber:    a.attempt_number,
        score:            parseFloat(a.score),
        passed:           a.passed,
        correctAnswers:   a.correct_answers,
        totalQuestions:    a.total_questions,
        timeSpentSeconds: a.time_spent_seconds,
        date:             a.created_at,
        perQuestionResults: a.per_question_results || [],
      });
      t.totalAttempts++;
      t.bestScore       = Math.max(t.bestScore, parseFloat(a.score));
      t.totalTimeSeconds += a.time_spent_seconds || 0;
      if (a.passed) t.passed = true;
    }

    // Set latest score and sort attempts chronologically within each topic
    const topics = Object.values(byTopic).map(t => {
      t.attempts.sort((a, b) => new Date(a.date) - new Date(b.date));
      t.latestScore = t.attempts[t.attempts.length - 1]?.score || 0;
      t.improving   = t.attempts.length >= 2 &&
        t.attempts[t.attempts.length - 1].score > t.attempts[t.attempts.length - 2].score;
      t.struggling  = t.totalAttempts >= 2 && !t.passed;
      return t;
    });

    // Find most-missed questions across all attempts
    const wrongQuestions = [];
    for (const a of (attempts || [])) {
      for (const q of (a.per_question_results || [])) {
        if (!q.isCorrect) {
          wrongQuestions.push({
            topic:         a.topic,
            question:      q.question,
            studentAnswer: q.studentAnswer,
            correctAnswer: q.correctAnswer,
            date:          a.created_at,
          });
        }
      }
    }

    // Summary stats
    const totalPracticeTime = topics.reduce((s, t) => s + t.totalTimeSeconds, 0);
    const struggling = topics.filter(t => t.struggling);
    const mastered   = topics.filter(t => t.passed);

    res.json({
      topics,
      summary: {
        totalTopicsPracticed: topics.length,
        mastered:             mastered.length,
        struggling:           struggling.length,
        totalPracticeTimeSeconds: totalPracticeTime,
        totalAttempts:        (attempts || []).length,
      },
      strugglingTopics: struggling.map(t => ({ topic: t.topic, subject: t.subject, attempts: t.totalAttempts, bestScore: t.bestScore })),
      recentMistakes:   wrongQuestions.slice(0, 20),
    });
  } catch (err) {
    console.error('GET /student/:id/mistake-trends error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


module.exports = router;
