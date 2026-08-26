/**
 * Shared student-account provisioning helpers — extracted from routes/admin.js
 * (which now imports from here too) so the super_admin bulk-create path and
 * the new school_admin Student Administration path can't drift apart.
 * Pure, stateless logic — no behavior change from the original inline copy.
 */
const { randomInt } = require('crypto');

function generateSecurePassword() {
  const groups = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '#@$%&*?'];
  const all = groups.join('');
  const chars = groups.map(g => g[randomInt(g.length)]);
  while (chars.length < 10) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

function generateStudentEmail(name, school) {
  const slug = String(name || 'student').trim().toLowerCase()
    .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '.').slice(0, 30);
  const schoolSlug = String(school || 'school').trim().toLowerCase()
    .replace(/[^a-z0-9]/g, '').slice(0, 10);
  return `${slug}.${Date.now()}@${schoolSlug}.student`;
}

// Same slug scheme as generateStudentEmail but for staff (teacher/parent)
// accounts created by a school_admin without a personal email on file — a
// distinct suffix (.staff) keeps them visually distinguishable from real
// personal emails and from system-generated student logins.
function generateStaffEmail(name, school, roleSuffix) {
  const slug = String(name || 'user').trim().toLowerCase()
    .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '.').slice(0, 30);
  const schoolSlug = String(school || 'school').trim().toLowerCase()
    .replace(/[^a-z0-9]/g, '').slice(0, 10);
  return `${slug}.${Date.now()}@${schoolSlug}.${roleSuffix || 'staff'}`;
}

// Simple, typeable login IDs — p1, p2, p3, ... @aivorah.parent — mirroring the
// student "s1, s2, ..." scheme (see generateStudentLoginId in routes/teacher.js).
// A name + timestamp + school blob (the old generateStaffEmail output) was long
// and impossible to type; parents just get the next free short id. Collision-safe:
// checks the DB for the next unused number. Requires a supabase client passed in
// (this module is otherwise DB-free).
async function generateParentLoginId(supabase) {
  for (let n = 1; n < 100000; n++) {
    const candidate = `p${n}@aivorah.parent`;
    const { data: existing } = await supabase.from('users').select('id').eq('email', candidate).maybeSingle();
    if (!existing) return candidate;
  }
  return `p${Date.now()}@aivorah.parent`;
}

async function createFirebaseAccount(email, password) {
  const apiKey = process.env.FIREBASE_API_KEY;
  if (!apiKey) throw new Error('FIREBASE_API_KEY not set');
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: false }) }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || 'Firebase signup failed');
  return data.localId;
}

function toTitleCase(str) {
  return String(str || '').replace(/\b\w/g, c => c.toUpperCase());
}

// New: real admission-number generation (TSRA-1001 style). Best-effort
// sequential per school — computed from the current count of students at
// that school, which is fine at pilot scale (one admin, adding students one
// at a time) though not collision-proof under true concurrent writes.
function generateAdmissionNumber(schoolName, existingCount) {
  const prefix = String(schoolName || 'SCH').trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4) || 'SCH';
  return `${prefix}-${1001 + existingCount}`;
}

module.exports = {
  generateSecurePassword,
  generateStudentEmail,
  generateStaffEmail,
  generateParentLoginId,
  createFirebaseAccount,
  toTitleCase,
  generateAdmissionNumber,
};
