// A teacher-created student always joins the teacher's own school (name +
// school_id) and that school's board — never a client-supplied or default one.
const supabase = require('./supabase');

// Same rule as platform-admin bulk import: IB → PYP/MYP/DP by grade.
function resolveCurriculum(baseCurriculum, grade) {
  const base = String(baseCurriculum || '').trim();
  if (!base) return null;
  if (!/^ib\b/i.test(base)) return base;
  const num = parseInt(String(grade || '').replace(/\D/g, ''), 10);
  if (!num || num <= 5) return 'IB PYP';
  if (num <= 10) return 'IB MYP';
  return 'IB DP';
}

async function getTeacherSchool(cleanTeacherEmail) {
  const { data: teacher } = await supabase.from('users')
    .select('id, school, school_id').eq('email', cleanTeacherEmail).maybeSingle();
  if (!teacher) return null;
  let school = null;
  if (teacher.school_id) {
    ({ data: school } = await supabase.from('schools').select('id, name, curriculum').eq('id', teacher.school_id).maybeSingle());
  } else if (teacher.school) {
    ({ data: school } = await supabase.from('schools').select('id, name, curriculum').eq('name', teacher.school).maybeSingle());
  }
  return {
    teacher,
    school: school?.name || teacher.school || '',
    schoolId: school?.id || teacher.school_id || null,
    curriculum: school?.curriculum || null,
  };
}

module.exports = { getTeacherSchool, resolveCurriculum };
