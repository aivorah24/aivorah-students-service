// Bell notification (account_updated, aivorah-db 0012) for each student whose grade/section
// changed. The student's app re-reads the profile when it arrives, so the new grade shows live.
const supabase = require('./supabase');

function classLabel(grade, section) {
  return [grade, section].filter(Boolean).join(' - ');
}

function promotionNotification(student, { grade, section }, { actorEmail, actorRole, version }) {
  const newSection = section !== undefined ? section : student.section;
  const gradeChanged = (student.grade || '') !== grade;
  const sectionChanged = (student.section || null) !== (newSection || null);
  if (!gradeChanged && !sectionChanged) return null;
  const to = classLabel(grade, newSection);
  const from = classLabel(student.grade, student.section);
  return {
    recipient_id: student.id,
    recipient_role: 'student',
    type: 'account_updated', entity_type: 'user', entity_id: student.id,
    title: gradeChanged ? `You've been promoted to ${grade}` : `Your class changed to ${to}`,
    body: from ? `Moved from ${from} to ${to}.` : `You're now in ${to}.`,
    data: { reason: 'promoted', fromGrade: student.grade || null, toGrade: grade, fromSection: student.section || null, toSection: newSection || null },
    event_key: `account_updated:user:${student.id}:promoted:${version}`,
    actor_email: actorEmail || null, actor_role: actorRole,
  };
}

// Never throws — the grade change is already saved when this runs.
async function notifyPromoted(students, target, actor) {
  const version = new Date().toISOString();
  const rows = (students || [])
    .filter((s) => s && (!s.role || s.role === 'student'))
    .map((s) => promotionNotification(s, target, { ...actor, version }))
    .filter(Boolean);
  if (!rows.length) return { inserted: 0 };
  try {
    const { error } = await supabase.from('notifications').insert(rows);
    if (error) throw new Error(error.message);
    return { inserted: rows.length };
  } catch (err) {
    console.warn('[promote] notification failed:', err.message);
    return { inserted: 0, error: err.message };
  }
}

module.exports = { notifyPromoted, promotionNotification };
