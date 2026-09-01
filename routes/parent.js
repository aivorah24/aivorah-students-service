const express  = require('express');
const router   = express.Router();
const supabase = require('../services/supabase');

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

module.exports = router;
