// Real DB data (checked live, 2026-09-10) has BOTH "3" and "Grade 3" stored in
// users.grade for the same numeric grade — a teacher's own teaches[].grade
// preference can also carry either format. An exact string match between the
// two silently returns zero rows. Mirrors the same fix already applied on the
// frontend (aivorah-frontend's rosterFilters.ts normalizeGrade()).
function normalizeGrade(grade) {
  if (!grade) return '';
  const digits = String(grade).replace(/\D/g, '');
  return digits || String(grade).trim().toLowerCase();
}

module.exports = { normalizeGrade };
