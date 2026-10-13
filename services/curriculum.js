// NCERT publishes the CBSE textbooks — it is not a curriculum. Legacy "NCERT"
// values (any case/spacing) are CBSE; everything else is only trimmed.
function normalizeCurriculum(value) {
  if (value == null) return value;
  const s = String(value).trim();
  return /^(ncert|cbse)$/i.test(s.replace(/\s+/g, '')) ? 'CBSE' : s;
}

// Same, for teaches[]/children[] entries that carry their own curriculum.
function normalizeCurriculumEntries(list) {
  if (!Array.isArray(list)) return list;
  return list.map((e) => (e && e.curriculum != null ? { ...e, curriculum: normalizeCurriculum(e.curriculum) } : e));
}

// Stored spellings that mean this curriculum, for DB filters that must still
// match legacy un-migrated rows.
function curriculumAliases(value) {
  const c = normalizeCurriculum(value);
  return c === 'CBSE' ? ['CBSE', 'NCERT'] : [c];
}

module.exports = { normalizeCurriculum, normalizeCurriculumEntries, curriculumAliases };
