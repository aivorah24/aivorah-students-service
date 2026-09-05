const express  = require('express');
const router   = express.Router();
const supabase = require('../services/supabase');
const Groq     = require('groq-sdk');
const { randomUUID } = require('crypto');
const { computeLearningProfile, humanizeTopic, sanitizeReport } = require('../services/learningProfile');
const { generateSecurePassword, toTitleCase } = require('../services/studentAccounts');
const { sendCredentialsEmail, sendEmailOtpCode } = require('../services/mailer');
const otpStore = require('../services/otpStore');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Same @aivorah.student login-ID scheme the monolith used, kept identical so
// existing accounts created there stay consistent with new ones created here.
async function generateChildLoginId(parentEmail) {
  if (parentEmail) {
    const localPart = parentEmail.split('@')[0].toLowerCase().trim().replace(/[^a-z0-9]/g, '');
    for (let n = 1; n < 100; n++) {
      const candidate = `${localPart}_ch${n}@aivorah.student`;
      const { data: existing } = await supabase.from('users').select('id').eq('email', candidate).maybeSingle();
      if (!existing) return candidate;
    }
  }
  for (let n = 1; n < 100000; n++) {
    const candidate = `ch${n}@aivorah.student`;
    const { data: existing } = await supabase.from('users').select('id').eq('email', candidate).maybeSingle();
    if (!existing) return candidate;
  }
  return `ch${Date.now()}@aivorah.student`;
}

async function setStudentMeta(email, studentId, parentEmail, firebaseUid, initialPassword) {
  const emailKey = String(email || '').toLowerCase().trim();
  if (!emailKey) return;
  const { data: existing } = await supabase
    .from('user_preferences').select('data').eq('user_email', emailKey).maybeSingle();
  const merged = {
    ...(existing?.data || {}),
    studentId,
    createdByParent: String(parentEmail || '').toLowerCase().trim(),
    firebaseUid: String(firebaseUid || '').trim() || undefined,
    accountStatus: 'active',
    activatedAt: existing?.data?.activatedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(initialPassword ? { initialPassword, passwordSavedAt: new Date().toISOString(), mustChangePassword: true } : {}),
  };
  await supabase.from('user_preferences').upsert(
    { user_email: emailKey, data: merged, updated_at: new Date().toISOString() },
    { onConflict: 'user_email' },
  );
}

// Curriculum/content domain owns Qdrant (see aivorah-learning-paths-service) -
// this service asks it for each child's totalTopics over HTTP instead of
// embedding Qdrant logic itself, per the parent/children + curriculum
// domain-boundary migration off the monolith.
const LEARNING_PATHS_SERVICE_URL =
  process.env.LEARNING_PATHS_SERVICE_URL || 'https://aivorah-learning-paths-service.onrender.com';

async function fetchTotalTopics(curriculum, grade) {
  try {
    const res = await fetch(
      `${LEARNING_PATHS_SERVICE_URL}/curriculum/topic-count?curriculum=${encodeURIComponent(curriculum)}&grade=${encodeURIComponent(grade)}`,
    );
    if (!res.ok) return 0;
    const data = await res.json();
    return typeof data.totalTopics === 'number' ? data.totalTopics : 0;
  } catch {
    // A learning-paths-service hiccup must not fail the whole children list -
    // same graceful-fallback contract the monolith's in-process Qdrant call had.
    return 0;
  }
}

// ── GET /parent/:parentEmail/children ────────────────────
// Returns all children linked to this parent with their live stats.
// Ported from the monolith's ai-mentor/server/routes/parent.js (same route,
// same response shape) as part of moving parent/child-linkage ownership to
// this service - the monolith's route is untouched for any consumer not
// yet repointed here.
router.get('/:parentEmail/children', async (req, res) => {
  try {
    const { parentEmail } = req.params;

    const { data: links, error } = await supabase
      .from('parent_children')
      .select('child_id, added_at, users!parent_children_child_id_fkey(id, name, email, grade, school, curriculum)')
      .eq('parent_email', parentEmail);

    if (error) return res.status(500).json({ error: error.message });
    if (!links || links.length === 0) return res.json([]);

    const childIds = links.map(l => l.child_id);

    const { data: stats } = await supabase
      .from('student_stats')
      .select('*')
      .in('student_id', childIds);

    const statsMap = {};
    (stats ?? []).forEach(s => { statsMap[s.student_id] = s; });

    const children = await Promise.all(links.map(async (link) => {
      const user = link.users ?? {};
      const s    = statsMap[link.child_id] ?? {};
      const grade = user.grade || 'Grade 3';
      const curriculum = user.curriculum || 'IB PYP';
      const totalTopics = await fetchTotalTopics(curriculum, grade);
      return {
        id:               link.child_id,
        name:             user.name    || 'Student',
        email:            user.email   || '',
        grade,
        curriculum,
        school:           user.school     || '',
        totalTopics,
        xpPoints:         s.xp_points         ?? 0,
        level:            s.level             ?? 1,
        currentStreak:    s.current_streak    ?? 0,
        studyTimeMinutes: s.study_time_minutes ?? 0,
        todayStudyMinutes: s.today_study_minutes ?? 0,
        topicsExplored:   s.topics_explored   ?? 0,
        completedTopics:  s.completed_topics  ?? [],
        assignmentsDone:  s.assignments_done  ?? 0,
        lastLesson:       s.last_lesson       || '',
        lastActive:       s.last_active_date  || null,
        addedAt:          link.added_at,
      };
    }));

    res.json(children);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /parent/:parentEmail/children/:childId/ai-report ──────────────────
// Two-stage pipeline: deterministic signals (this service) → AI mentor
// reasoning (Groq). Ported from the monolith's ai-mentor/server/routes/parent.js
// as part of moving the AI Progress Report feature off the monolith, with the
// decommissioned Groq model (llama-3.3-70b-versatile → 404 model_not_found in
// production) replaced by openai/gpt-oss-120b, the model this account
// currently has access to.
router.get('/:parentEmail/children/:childId/ai-report', async (req, res) => {
  try {
    const { parentEmail, childId } = req.params;

    const { data: link } = await supabase
      .from('parent_children')
      .select('child_id')
      .eq('parent_email', parentEmail.toLowerCase())
      .eq('child_id', childId)
      .maybeSingle();
    if (!link) return res.status(403).json({ error: 'Not authorised.' });

    const { data: student } = await supabase
      .from('users')
      .select('name, email, grade, curriculum, school')
      .eq('id', childId)
      .maybeSingle();
    if (!student) return res.status(404).json({ error: 'Student not found.' });

    const [statsRes, dailyLogsRes, submissionsRes, challengesRes, eventsRes] = await Promise.all([
      supabase.from('student_stats').select('*').eq('student_id', childId).maybeSingle(),
      supabase.from('student_daily_log')
        .select('log_date, study_minutes, xp_earned, topics_completed')
        .eq('student_id', childId)
        .gte('log_date', (() => { const d = new Date(); d.setDate(d.getDate() - 13); return d.toISOString().split('T')[0]; })())
        .order('log_date', { ascending: true }),
      supabase.from('assignment_submissions')
        .select('score, status, completed_at')
        .eq('student_id', childId)
        .order('completed_at', { ascending: false })
        .limit(20),
      supabase.from('challenge_assignments')
        .select('score, status, completed_at')
        .eq('student_id', childId)
        .order('completed_at', { ascending: false })
        .limit(10),
      supabase.from('analytics_events')
        .select('*')
        .eq('user_email', String(student.email || '').toLowerCase())
        .order('timestamp', { ascending: false })
        .limit(500),
    ]);

    const stats       = statsRes.data;
    const dailyLogs   = dailyLogsRes.data   || [];
    const submissions = submissionsRes.data || [];
    const challenges  = challengesRes.data  || [];
    const analyticsEvents = (eventsRes.data || []).map(e => ({
      eventType: e.event_type,
      timestamp: e.timestamp,
      topic:     e.topic   || '',
      subject:   e.subject || '',
      score:     e.score,
    }));

    const xp                  = stats?.xp_points          ?? 0;
    const streak               = stats?.current_streak     ?? 0;
    const studyMinutes         = stats?.study_time_minutes ?? 0;
    const completedTopics      = stats?.completed_topics   ?? [];
    const assignmentsDone      = stats?.assignments_done   ?? 0;
    const challengesCompleted  = stats?.challenges_completed ?? 0;
    const level                = stats?.level ?? 1;

    const activeDays         = dailyLogs.filter(d => (d.study_minutes ?? 0) > 0).length;
    const totalRecentMinutes = dailyLogs.reduce((s, d) => s + (d.study_minutes ?? 0), 0);
    const avgDailyMinutes    = activeDays > 0 ? Math.round(totalRecentMinutes / activeDays) : 0;

    const scoredSubs       = submissions.filter(s => s.score != null && s.status === 'completed');
    const assignmentScores = scoredSubs.map(s => Number(s.score));
    let assignmentTrend    = null;
    if (assignmentScores.length >= 4) {
      const half  = Math.floor(assignmentScores.length / 2);
      const older = assignmentScores.slice(half).reduce((a, b) => a + b, 0) / half;
      const newer = assignmentScores.slice(0, half).reduce((a, b) => a + b, 0) / half;
      assignmentTrend = newer > older + 5 ? 'improving' : newer < older - 5 ? 'declining' : 'stable';
    }

    const scoredChallenges = challenges.filter(c => c.score != null);
    const challengeScores  = scoredChallenges.map(c => Number(c.score));

    const subjectMap = {};
    for (const e of analyticsEvents) {
      if (!e.topic || !e.subject) continue;
      if (!subjectMap[e.subject]) subjectMap[e.subject] = { scores: [], topics: {} };
      const subj = subjectMap[e.subject];
      if (!subj.topics[e.topic]) subj.topics[e.topic] = { scores: [], sessions: 0 };
      const t = subj.topics[e.topic];
      if ((e.eventType === 'ibpyp_quiz_result' || e.eventType === 'ncert_quiz_result') && typeof e.score === 'number') {
        subj.scores.push(e.score); t.scores.push(e.score);
      }
      if (e.eventType === 'lesson_started' || e.eventType === 'ai_lesson_script') t.sessions++;
    }

    const subjectSummaries = Object.entries(subjectMap).map(([subject, data]) => {
      const topicDetails = Object.entries(data.topics).map(([topic, td]) => {
        const tAvg = td.scores.length ? Math.round(td.scores.reduce((a, b) => a + b, 0) / td.scores.length) : null;
        return { topic, avgScore: tAvg, quizAttempts: td.scores.length, sessions: td.sessions };
      });
      const avgScore       = data.scores.length ? Math.round(data.scores.reduce((a, b) => a + b, 0) / data.scores.length) : null;
      const strongTopics   = topicDetails.filter(t => t.avgScore != null && t.avgScore >= 75);
      const weakTopics     = topicDetails.filter(t => t.avgScore != null && t.avgScore < 60);
      const exploredTopics = topicDetails.filter(t => t.sessions > 0);
      return { subject, avgScore, topicDetails, strongTopics, weakTopics, exploredTopics, quizCount: data.scores.length };
    });

    const hasActivity = xp > 0 || studyMinutes > 0 || completedTopics.length > 0
      || assignmentsDone > 0 || challengesCompleted > 0 || analyticsEvents.length > 0;
    if (!hasActivity) {
      return res.json({
        student: { name: student.name, grade: student.grade, curriculum: student.curriculum, school: student.school },
        noData: true, generatedAt: new Date().toISOString(),
      });
    }

    const profile = computeLearningProfile({
      completedTopics, assignmentsDone, challengesCompleted,
      streak, activeDays, studyMinutes, subjectSummaries,
      assignmentScores, challengeScores,
    });

    const avgAssignmentScore = profile.avgAssignmentScore;
    const avgChallengeScore  = profile.avgChallengeScore;
    const readableTopics     = completedTopics.map(humanizeTopic);

    const signalCard = {
      student:    `${student.name}, ${student.grade}, ${student.curriculum}`,
      pattern:    profile.learningPattern,
      consistency: profile.consistencySignal,
      topicsCompleted: completedTopics.length,
      topicNames: readableTopics.slice(0, 8).join(', ') + (completedTopics.length > 8 ? ` and ${completedTopics.length - 8} more` : ''),
      streakDays:  streak,
      activeDaysOf14: activeDays,
      studyTimeTotal: `${Math.floor(studyMinutes / 60)}h ${studyMinutes % 60}m`,
      hasQuizData: profile.hasQuizScores,
      strongTopics: profile.strongTopics.map(t => `${humanizeTopic(t.topic)} (${t.subject}, ${t.avgScore}%)`),
      weakTopics:   profile.weakTopics.map(t => `${humanizeTopic(t.topic)} (${t.subject}, ${t.avgScore}%)`),
      assignmentsDone,
      avgAssignmentScore,
      assignmentTrend,
      challengesCompleted,
      avgChallengeScore,
      riskFlags:      profile.riskFlags,
      positiveSignals: profile.positiveSignals,
    };

    const patternDescriptions = {
      just_started:         'just beginning their learning journey',
      broad_explorer:       'exploring a wide range of topics but not yet assessed on them',
      active_learner:       'actively learning and being assessed — a great combination',
      assignment_focused:   'completing assignments regularly, showing structured effort',
      developing:           'in the early stages of building a learning routine',
    };
    const consistencyDescriptions = {
      highly_consistent: 'studying very consistently — daily habit is strong',
      building_habit:    'building a study habit — some good days but not yet daily',
      occasional:        'studying occasionally — needs more regular sessions',
      irregular:         'studying irregularly — needs help building a routine',
    };

    const prompt = `You are Aivorah, an AI learning mentor. A parent is reading this report about their child. Write like a caring, insightful mentor who has studied this child's learning data closely.

STUDENT PROFILE (computed from real data):
- Student: ${signalCard.student}
- Learning pattern: ${patternDescriptions[signalCard.pattern]}
- Consistency: ${consistencyDescriptions[signalCard.consistency]}
- Topics completed: ${signalCard.topicsCompleted} — exact names: ${signalCard.topicNames} (use these exact topic names when mentioning them, do not rewrite or abbreviate them)
- Study time overall: ${signalCard.studyTimeTotal}
- Current streak: ${signalCard.streakDays} day(s), active ${signalCard.activeDaysOf14} of last 14 days
- Quiz data available: ${signalCard.hasQuizData ? 'Yes' : 'No — student has not taken quizzes yet'}
${signalCard.strongTopics.length > 0 ? `- Performing well in: ${signalCard.strongTopics.join(', ')}` : ''}
${signalCard.weakTopics.length > 0   ? `- Struggling with: ${signalCard.weakTopics.join(', ')}`    : ''}
- Assignments completed: ${signalCard.assignmentsDone}${avgAssignmentScore != null ? ` (avg ${avgAssignmentScore}%, trend: ${assignmentTrend})` : ''}
- Challenges completed: ${signalCard.challengesCompleted}${avgChallengeScore != null ? ` (avg ${avgChallengeScore}%)` : ''}
- Risk flags: ${signalCard.riskFlags.join(', ') || 'none'}
- Positive signals: ${signalCard.positiveSignals.join(', ') || 'none yet'}

YOUR TASK:
Write a mentor report for the parent. Each section must interpret the SIGNALS above — not just repeat numbers. Think about what this pattern MEANS for the child's learning journey.

RULES:
1. DO NOT invent skills, traits, or abilities. You only know what the signals show.
2. If quiz data is not available, say so honestly — "we haven't assessed this yet".
3. learning_pattern="${signalCard.pattern}" should drive your interpretation of why things are the way they are.
4. Recommendations must be specific actions the parent can take THIS WEEK.
5. Tone: warm mentor, not a robot reading a spreadsheet. Speak directly to the parent.

Return ONLY valid JSON, no markdown:
{
  "learning_pattern_insight": "2-3 sentences: what does this student's pattern tell us about how they learn right now?",
  "whats_going_well": "2-3 sentences on positive signals only — name specific topics or streaks",
  "where_to_focus": "2-3 sentences on what needs attention — be specific, not alarming",
  "subject_insights": [{ "subject": "name", "insight": "what the data shows about this subject" }],
  "consistency_insight": "1-2 sentences on study habit — use the streak and active days signal",
  "assignment_insight": ${assignmentsDone > 0 ? '"1-2 sentences on assignment performance from the signals"' : 'null'},
  "this_week_actions": ["specific action 1 for parent to take this week", "specific action 2", "specific action 3"],
  "message_to_child": "1 warm sentence the parent can read to the child — reference a real topic or streak"
}`;

    const completion = await groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages: [
        {
          role: 'system',
          content: `You are Aivorah, a warm and insightful AI learning mentor writing reports for parents.
ABSOLUTE RULES — breaking even one makes the report invalid:
- FORBIDDEN PHRASES (never use, no exceptions): "enthusiasm for learning", "love of learning", "passion for learning", "natural curiosity", "problem-solving skills", "communication skills", "creative approach", "positive attitude", "hardworking", "talented", "keen interest", "social skills", "strong grasp", "excellent understanding", "dedicated learner", "bright student", "exceptional", "remarkable talent".
- The phrase "strong grasp" is FORBIDDEN. Do not write it under any circumstances.
- Every claim must be directly traceable to a signal in the student profile. Zero invented traits.
- If quiz data is absent, never imply competence. Say what you don't know rather than guessing.
- If a student just started, do not praise skills you cannot measure. Describe what you observed: topics explored, time studied, consistency.
- Always reference specific topics, numbers, and subjects from the profile.`,
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 1200,
    });

    let aiReport;
    try {
      aiReport = JSON.parse(completion.choices[0].message.content.trim());
    } catch {
      const match = completion.choices[0].message.content.match(/\{[\s\S]*\}/);
      aiReport = match ? JSON.parse(match[0]) : {};
    }

    aiReport = sanitizeReport(aiReport);

    const report = {
      learning_pattern_insight: aiReport.learning_pattern_insight || null,
      whats_going_well:  aiReport.whats_going_well  || null,
      where_to_focus:    aiReport.where_to_focus    || null,
      subject_insights:  aiReport.subject_insights  || [],
      consistency_insight: aiReport.consistency_insight || null,
      assignment_insight:  aiReport.assignment_insight  || null,
      this_week_actions: aiReport.this_week_actions  || [],
      message_to_child:  aiReport.message_to_child   || null,
      strong_topics: profile.strongTopics.map(t => ({ topic: humanizeTopic(t.topic), subject: t.subject, score: t.avgScore })),
      weak_topics:   profile.weakTopics.map(t =>   ({ topic: humanizeTopic(t.topic), subject: t.subject, score: t.avgScore })),
      learning_pattern: signalCard.pattern,
      consistency_level: signalCard.consistency,
    };

    res.json({
      student: { name: student.name, grade: student.grade, curriculum: student.curriculum, school: student.school },
      metrics: {
        xp, level, studyTimeMinutes: studyMinutes,
        recentStudyMinutes: totalRecentMinutes,
        activeDays, activeDaysThisWeek: Math.min(activeDays, 7), avgDailyMinutes, currentStreak: streak,
        topicsCompleted: completedTopics.length, completedTopics,
        assignmentsDone, avgAssignmentScore, assignmentTrend,
        challengesCompleted, avgChallengeScore,
      },
      subjectPerformance: subjectSummaries,
      report,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[ai-report]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /parent/children/init-auth ────────────────────────
// Prepare child credentials for onboarding Step 4. Ported from the
// monolith's ai-mentor/server/routes/parent.js (same route, same response
// shape) - part of moving parent-onboarding child creation off the
// monolith, which had no test-environment Supabase project (root cause of
// a real incident: an E2E test run wrote a real child account into Prod
// via this route's old monolith copy, 2026-09-05).
router.post(['/children/init-auth', '/:parentEmail/children/init-auth'], async (req, res) => {
  try {
    const { name, email, studentId, password: customPassword, parentEmail: bodyParentEmail } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });

    const parentEmail = req.params.parentEmail || bodyParentEmail || '';
    const emailProvided = Boolean(email && String(email).trim());
    const cleanEmail = emailProvided
      ? String(email).toLowerCase().trim()
      : await generateChildLoginId(parentEmail);

    const resolvedStudentId = String(studentId || '').trim() || `STU-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

    const { data: existing } = await supabase.from('users').select('id').eq('email', cleanEmail).maybeSingle();
    if (existing) return res.status(409).json({ error: 'An account with this email already exists.' });

    const trimmedCustom = customPassword && String(customPassword).trim();
    const generatedPassword = (trimmedCustom && trimmedCustom.length >= 6) ? trimmedCustom : generateSecurePassword();

    res.json({
      success: true,
      childEmail: cleanEmail,
      message: 'Login credentials generated',
      email: cleanEmail,
      password: generatedPassword,
      studentId: resolvedStudentId,
      emailProvided,
      verificationRequired: false,
    });
  } catch (err) {
    console.error('[parent/children/init-auth]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /parent/:parentEmail/children/link-created ────────
// Links a Firebase-created student account into app DB + parent linkage.
// Ported from the monolith - see init-auth's comment above for why.
router.post('/:parentEmail/children/link-created', async (req, res) => {
  try {
    const { parentEmail } = req.params;
    const { firebaseUid, studentId, name, email, grade, curriculum, school = '', initialPassword } = req.body || {};

    if (!firebaseUid || !name || !email || !grade || !curriculum) {
      return res.status(400).json({ error: 'firebaseUid, name, email, grade, curriculum are required' });
    }

    const cleanEmail = String(email).toLowerCase().trim();
    const cleanName = toTitleCase(String(name).trim());
    const cleanParentEmail = String(parentEmail).toLowerCase().trim();
    const resolvedStudentId = String(studentId || '').trim() || `STU-${Date.now()}`;

    // Prevent creating the same child (same name + grade) more than once under this parent.
    const { data: existingChildren } = await supabase
      .from('parent_children')
      .select('child_id, users!parent_children_child_id_fkey(name, grade)')
      .eq('parent_email', cleanParentEmail);
    if (existingChildren?.length) {
      const duplicate = existingChildren.find((row) => {
        const child = row.users;
        return child
          && String(child.name || '').toLowerCase().trim() === cleanName.toLowerCase()
          && String(child.grade || '').toLowerCase().trim() === String(grade || '').toLowerCase().trim();
      });
      if (duplicate) {
        return res.status(409).json({
          error: `A child named "${cleanName}" in ${grade} is already linked to your account. If this is a different child, use a slightly different name to distinguish them.`,
          code: 'DUPLICATE_CHILD',
        });
      }
    }

    const { data: existingByEmail } = await supabase.from('users').select('id').eq('email', cleanEmail).maybeSingle();
    const userId = existingByEmail?.id || randomUUID();

    const { error: userUpsertErr } = await supabase.from('users').upsert({
      id: userId,
      name: cleanName,
      email: cleanEmail,
      role: 'student',
      grade,
      curriculum,
      school: String(school || '').trim(),
      onboarding_complete: true,
    }, { onConflict: 'id' });
    if (userUpsertErr) return res.status(500).json({ error: userUpsertErr.message });

    const { error: linkErr } = await supabase.from('parent_children').insert({ parent_email: cleanParentEmail, child_id: userId });
    if (linkErr && linkErr.code !== '23505') return res.status(500).json({ error: linkErr.message });

    await supabase.from('student_stats').upsert({ student_id: userId }, { onConflict: 'student_id', ignoreDuplicates: true });

    await setStudentMeta(cleanEmail, resolvedStudentId, cleanParentEmail, firebaseUid, initialPassword || undefined);

    await sendCredentialsEmail({
      to: cleanParentEmail, childName: cleanName, loginId: cleanEmail,
      password: initialPassword || undefined, childEmail: cleanEmail,
    }).catch((err) => console.log('[parent/children/link-created] parent credentials email failed (non-fatal):', err.message));

    if (!cleanEmail.endsWith('@aivorah.student') && cleanEmail !== cleanParentEmail) {
      sendCredentialsEmail({
        to: cleanEmail, childName: cleanName, loginId: cleanEmail, password: initialPassword || undefined,
      }).catch((err) => console.log('[parent/children/link-created] child credentials email failed (non-fatal):', err.message));
    }

    res.json({
      success: true,
      child: {
        id: userId, studentId: resolvedStudentId, name: cleanName, email: cleanEmail,
        grade, curriculum, school: String(school || '').trim(), firebaseUid,
        onboardingComplete: true, accountStatus: 'active',
      },
    });
  } catch (err) {
    console.error('[parent/children/link-created]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /parent/:parentEmail/children ──────────────────────
// Links an EXISTING student account (age 14+ path) to this parent, instead
// of creating a new one. Ported from the monolith - see init-auth's
// comment above for why.
router.post('/:parentEmail/children', async (req, res) => {
  try {
    const { parentEmail } = req.params;
    const { childEmail } = req.body || {};
    if (!childEmail) return res.status(400).json({ error: 'childEmail required' });

    const { data: child, error: lookupErr } = await supabase
      .from('users').select('id, name, email, grade, school')
      .eq('email', childEmail.toLowerCase().trim()).single();
    if (lookupErr || !child) {
      return res.status(404).json({ error: 'No student found with that email. Ask your child to register first.' });
    }

    const { error: linkErr } = await supabase.from('parent_children').insert({ parent_email: parentEmail, child_id: child.id });
    if (linkErr) {
      if (linkErr.code === '23505') return res.status(409).json({ error: 'This child is already linked to your account.' });
      return res.status(500).json({ error: linkErr.message });
    }

    res.json({ success: true, child: { id: child.id, name: child.name, email: child.email, grade: child.grade, school: child.school } });
  } catch (err) {
    console.error('[parent/:parentEmail/children]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /parent/children/email-otp/send ────────────────────
// ── POST /parent/children/email-otp/verify ──────────────────
// Inline verification of a child's real email during onboarding (Step 4's
// optional email field). Ported from the monolith's generic
// /user/email-otp/send + /verify (ai-mentor/server/routes/user.js) as part
// of moving the whole parent-onboarding child flow off the monolith - see
// init-auth's comment above. Scoped under /parent/children since this
// service's only OTP consumer is this exact flow, unlike the monolith's
// route which also serves email-change/recovery elsewhere (left on the
// monolith, out of scope here).
router.post('/children/email-otp/send', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const name = req.body?.name ? String(req.body.name) : 'there';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    await otpStore.setOtp(email, 'email_verify', { otp });
    await sendEmailOtpCode({ to: email, otp, name });
    res.json({ ok: true });
  } catch (err) {
    console.error('[parent/children/email-otp/send]', err.message);
    res.status(500).json({ error: 'Could not send the verification code. Please try again.' });
  }
});

router.post('/children/email-otp/verify', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const otp = String(req.body?.otp || '').trim();
    const stored = await otpStore.getOtp(email, 'email_verify');
    if (!stored) return res.status(400).json({ error: 'No code requested. Please send a code first.' });
    if (Date.now() > stored.expiresAt) {
      await otpStore.deleteOtp(email, 'email_verify');
      return res.status(400).json({ error: 'Code expired. Please request a new one.' });
    }
    if (stored.otp !== otp) return res.status(400).json({ error: 'Incorrect code. Please try again.' });
    await otpStore.deleteOtp(email, 'email_verify');
    res.json({ verified: true });
  } catch (err) {
    console.error('[parent/children/email-otp/verify]', err.message);
    res.status(500).json({ error: 'Verification failed. Please try again.' });
  }
});

module.exports = router;
