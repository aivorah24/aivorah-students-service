const express  = require('express');
const router   = express.Router();
const supabase = require('../services/supabase');

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

    let query = supabase
      .from('users')
      .select('id, name, email, grade, curriculum, photo_url, role')
      .neq('role', 'teacher')
      .in('grade', gradesToShow);

    if (teacher?.curriculum) query = query.eq('curriculum', teacher.curriculum);
    // School scoping: a teacher can only link students from their OWN school —
    // same curriculum + grade but a different school must not appear here.
    if (teacher?.school) query = query.eq('school', teacher.school);

    const { data: candidates } = await query;

    const available = (candidates || [])
      .filter(s => !linkedIds.includes(s.id) && s.name && s.role !== 'teacher')
      .map(s => ({ id: s.id, name: s.name, email: s.email, grade: s.grade, curriculum: s.curriculum, photoUrl: s.photo_url }));

    res.json(available);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
