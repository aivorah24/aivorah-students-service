const express  = require('express');
const router   = express.Router();
const supabase = require('../services/supabase');
const { randomUUID, randomInt } = require('crypto');
const { sendCredentialsEmail, sendBulkCredentialsEmail, sendOwnAccountCredentialsEmail } = require('../services/mailer');
const { generateParentLoginId } = require('../services/studentAccounts');
const { getTeacherSchool, resolveCurriculum } = require('../services/teacherSchool');
const { isRealEmail, createInvitedFirebaseUser, sendInviteAndVerification } = require('../services/studentInvite');
const multer   = require('multer');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function toTitleCase(str) {
  return String(str || '').replace(/\b\w/g, c => c.toUpperCase());
}

function generateSecurePassword() {
  const groups = [
    'ABCDEFGHJKLMNPQRSTUVWXYZ',
    'abcdefghijkmnopqrstuvwxyz',
    '23456789',
    '#@$%&*?',
  ];
  const all = groups.join('');
  const chars = groups.map(g => g[randomInt(g.length)]);
  while (chars.length < 12) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// Checks Firebase Auth directly via the Admin SDK's getUserByEmail().
//
// FIX (2026-09-14): this used to call the public accounts:createAuthUri REST
// endpoint, which is how you check email existence WITHOUT admin credentials
// — except this Firebase project has Email Enumeration Protection enabled,
// which makes that endpoint (and signInWithPassword) return the identical
// response for an existing and a nonexistent email. That made this check a
// permanent no-op: it always reported "not registered", so an orphaned
// Firebase-only account (created but never linked into Supabase — e.g. the
// browser closed between account creation and the link-created call) stayed
// invisible forever, and generateStudentLoginId() kept handing out that same
// poisoned candidate on every retry, failing with auth/email-already-in-use
// every time. getUserByEmail() via the Admin SDK isn't subject to enumeration
// protection (it's a privileged server-side call), so it actually works.
const firebaseAdmin = require('../services/firebaseAdmin');
async function firebaseEmailExists(email) {
  if (!firebaseAdmin) return false; // no service account configured — don't block account creation on it
  try {
    await firebaseAdmin.auth().getUserByEmail(email);
    return true;
  } catch (err) {
    if (err?.code === 'auth/user-not-found') return false;
    return false; // any other error (network, etc.) — don't block on a check we can't complete
  }
}

// Simple, typeable login IDs — s1, s2, s3, ... (global counter, no teacher
// name attached) instead of a name + timestamp + random digits blob a student
// can't reliably type. Collision-safe: checks the next free number.
//
// FIX (2026-08-26, during the aivorah-students-service extraction): the
// monolith version of this function only checked Supabase for collisions,
// never Firebase Auth. A student created here writes to Firebase Auth FIRST
// (frontend creates the account, then calls link-created) — if that flow is
// interrupted after the Firebase account exists but before the Supabase row
// is written, the email is "free" in Supabase forever, so this function keeps
// handing out an id that Firebase will reject with auth/email-already-in-use
// on every future retry. Now checks both stores before accepting a candidate.
async function generateStudentLoginId() {
  for (let n = 1; n < 100000; n++) {
    const candidate = `s${n}@aivorah.student`;
    const { data: existing } = await supabase.from('users').select('id').eq('email', candidate).maybeSingle();
    if (existing) continue;
    if (await firebaseEmailExists(candidate)) continue;
    return candidate;
  }
  return `s${Date.now()}@aivorah.student`;
}

// ── POST /teacher/students/init-auth ──────────────────────────────────────────
// Generate login credentials for a new student — call BEFORE creating Firebase account.
// Body: { name, email?, password? }
router.post('/students/init-auth', async (req, res) => {
  try {
    const { name, email, password: customPassword } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name is required' });

    const emailProvided = Boolean(email && String(email).trim());
    const cleanEmail = emailProvided
      ? String(email).toLowerCase().trim()
      : await generateStudentLoginId();

    // Check for duplicate
    const { data: existing } = await supabase.from('users').select('id').eq('email', cleanEmail).maybeSingle();
    if (existing) return res.status(409).json({ error: 'An account with this email already exists.' });

    const trimmed = customPassword && String(customPassword).trim();
    const password = (trimmed && trimmed.length >= 6) ? trimmed : generateSecurePassword();

    res.json({ success: true, email: cleanEmail, password, emailProvided });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /teacher/:teacherEmail/students/link-created ─────────────────────────
// After the frontend creates the Firebase account, call this to:
//   - save the student to the users table
//   - link them to this teacher in teacher_student
//   - store credentials in user_preferences
// Body: { firebaseUid, name, email, grade, curriculum, studentId?, initialPassword? }
// School (name + school_id) always comes from the teacher; curriculum from the
// school's board when it has one.
router.post('/:teacherEmail/students/link-created', async (req, res) => {
  try {
    const { teacherEmail } = req.params;
    const { firebaseUid, name, email, grade, studentId, initialPassword } = req.body || {};

    if (!firebaseUid || !name || !email || !grade || !req.body?.curriculum) {
      return res.status(400).json({ error: 'firebaseUid, name, email, grade, curriculum are required' });
    }

    const cleanEmail        = String(email).toLowerCase().trim();
    const cleanTeacherEmail = String(teacherEmail).toLowerCase().trim();
    const resolvedStudentId = String(studentId || '').trim() || `STU-${Date.now()}`;
    const newId             = randomUUID();

    const ctx = await getTeacherSchool(cleanTeacherEmail);
    if (!ctx) return res.status(404).json({ error: 'Teacher account not found.' });
    const { teacher, school, schoolId } = ctx;
    const curriculum = resolveCurriculum(ctx.curriculum, grade) || req.body.curriculum;

    // 1. Upsert student in users table
    const { data: existingUser } = await supabase.from('users').select('id').eq('email', cleanEmail).maybeSingle();
    const userId = existingUser?.id || newId;

    const { error: userErr } = await supabase.from('users').upsert({
      id: userId,
      name: toTitleCase(String(name).trim()),
      email: cleanEmail,
      role: 'student',
      grade,
      curriculum,
      school,
      school_id: schoolId,
      onboarding_complete: true,
    }, { onConflict: 'id' });
    if (userErr) return res.status(500).json({ error: userErr.message });

    // 2. Init student stats row
    await supabase.from('student_stats')
      .upsert({ student_id: userId }, { onConflict: 'student_id', ignoreDuplicates: true });

    // 3. Link to the teacher
    await supabase.from('teacher_student').upsert({
      teacher_id: teacher.id,
      student_id: userId,
      subject: curriculum,
    }, { onConflict: 'teacher_id,student_id,subject', ignoreDuplicates: true });

    // 4. Save preferences (credentials + meta)
    const { data: existingPrefs } = await supabase.from('user_preferences').select('data').eq('user_email', cleanEmail).maybeSingle();
    const merged = {
      ...(existingPrefs?.data ?? {}),
      studentId: resolvedStudentId,
      createdByTeacher: cleanTeacherEmail,
      accountStatus: 'active',
      firebaseUid,
      activatedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...(initialPassword ? { initialPassword, passwordSavedAt: new Date().toISOString() } : {}),
    };
    await supabase.from('user_preferences').upsert(
      { user_email: cleanEmail, data: merged, updated_at: new Date().toISOString() },
      { onConflict: 'user_email' }
    );

    // Email credentials to the teacher (always — they created the account and
    // may need to hand it off) and, when the teacher entered the student's OWN
    // real email address (not the auto-generated @aivorah.student placeholder
    // used when the field was left blank), also send a copy directly to the
    // student themselves so they don't have to wait on the teacher to relay it.
    await sendCredentialsEmail({
      to: cleanTeacherEmail,
      childName: toTitleCase(String(name).trim()),
      loginId: cleanEmail,
      password: initialPassword || undefined,
      studentId: resolvedStudentId,
      childEmail: cleanEmail,
    });
    if (!cleanEmail.endsWith('@aivorah.student') && cleanEmail !== cleanTeacherEmail) {
      await sendCredentialsEmail({
        to: cleanEmail,
        childName: toTitleCase(String(name).trim()),
        loginId: cleanEmail,
        password: initialPassword || undefined,
        studentId: resolvedStudentId,
      }).catch(err => console.log('[teacher/link-created] student credentials email failed (non-fatal):', err.message));
    }

    res.json({
      success: true,
      student: {
        id: userId,
        studentId: resolvedStudentId,
        name: toTitleCase(String(name).trim()),
        email: cleanEmail,
        grade,
        curriculum,
        school,
        schoolId,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /teacher/:teacherEmail/students/invite ───────────────────────────────
// A student with a REAL email: same flow as platform-admin Add user — account
// with a random password, set-password invite, auth-service verification. The
// student can't use the app until they verify. Body: { name, email, grade, curriculum, frontendOrigin? }
router.post('/:teacherEmail/students/invite', async (req, res) => {
  try {
    const { name, email, grade, frontendOrigin } = req.body || {};
    const cleanName = toTitleCase(String(name || '').trim());
    const cleanEmail = String(email || '').toLowerCase().trim();
    const cleanTeacherEmail = String(req.params.teacherEmail).toLowerCase().trim();
    if (!cleanName) return res.status(400).json({ error: 'Name is required.' });
    if (!isRealEmail(cleanEmail)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (!grade || !req.body?.curriculum) return res.status(400).json({ error: 'grade and curriculum are required' });
    if (!firebaseAdmin) return res.status(500).json({ error: 'Auth is not configured on this server.' });

    const ctx = await getTeacherSchool(cleanTeacherEmail);
    if (!ctx) return res.status(404).json({ error: 'Teacher account not found.' });
    const { teacher, school, schoolId } = ctx;
    const curriculum = resolveCurriculum(ctx.curriculum, grade) || req.body.curriculum;

    const { data: existing } = await supabase.from('users').select('id').eq('email', cleanEmail).maybeSingle();
    if (existing) return res.status(409).json({ error: 'An account with this email already exists.' });
    if (await firebaseEmailExists(cleanEmail)) {
      return res.status(409).json({ error: 'This email is already registered — ask the student to sign in or reset their password.' });
    }

    let created;
    try {
      created = await createInvitedFirebaseUser(cleanEmail, cleanName);
    } catch (err) {
      if (err.code === 'auth/email-already-exists') {
        return res.status(409).json({ error: 'This email is already registered — ask the student to sign in or reset their password.' });
      }
      throw err;
    }

    const userId = randomUUID();
    const studentId = `STU-${Date.now()}`;
    const { error: userErr } = await supabase.from('users').insert({
      id: userId, name: cleanName, email: cleanEmail, role: 'student',
      grade, curriculum, school, school_id: schoolId, onboarding_complete: true,
    });
    if (userErr) {
      await firebaseAdmin.auth().deleteUser(created.uid).catch(() => {});
      return res.status(500).json({ error: userErr.message });
    }

    await supabase.from('student_stats').upsert({ student_id: userId }, { onConflict: 'student_id', ignoreDuplicates: true });
    await supabase.from('teacher_student').upsert({
      teacher_id: teacher.id, student_id: userId, subject: curriculum,
    }, { onConflict: 'teacher_id,student_id,subject', ignoreDuplicates: true });
    await supabase.from('user_preferences').upsert({
      user_email: cleanEmail,
      data: {
        studentId, createdByTeacher: cleanTeacherEmail, firebaseUid: created.uid,
        accountStatus: 'pending_verification', invitedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_email' });

    const sent = await sendInviteAndVerification({ email: cleanEmail, name: cleanName, frontendOrigin });
    res.json({
      success: true,
      student: { id: userId, studentId, name: cleanName, email: cleanEmail, grade, curriculum, school, schoolId },
      ...sent,
    });
  } catch (err) {
    console.error('[POST /teacher/:teacherEmail/students/invite] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /teacher/:teacherEmail/students/:studentId ────────────────────────
// Unlink a student from this teacher's class.
router.delete('/:teacherEmail/students/:studentId', async (req, res) => {
  try {
    const cleanTeacherEmail = String(req.params.teacherEmail).toLowerCase().trim();
    const studentId = req.params.studentId;

    const { data: teacher } = await supabase.from('users').select('id').eq('email', cleanTeacherEmail).maybeSingle();
    if (!teacher) return res.status(404).json({ error: 'Teacher not found.' });

    const { error } = await supabase
      .from('teacher_student')
      .delete()
      .eq('teacher_id', teacher.id)
      .eq('student_id', studentId);

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /teacher/:teacherEmail/students/promote ───────────────────────────────
// A teacher's own version of school-admin's bulk-grade — only Grade (and
// optionally Section) change; id, email, admission number, and every other
// table (assignments, submissions, attendance, stats, parent links, reports)
// are untouched, so the student's dashboard picks up the new grade on its
// next fetch without anything else moving. Scoped to teacher_student: a
// teacher can only promote students actually linked to them, never the whole
// school's roster (that's still school-admin-only via /school-admin/students/bulk-grade).
// Body: { studentIds: [], grade, section? }
router.post('/:teacherEmail/students/promote', async (req, res) => {
  try {
    const cleanTeacherEmail = String(req.params.teacherEmail).toLowerCase().trim();
    const { studentIds, grade, section } = req.body || {};
    if (!Array.isArray(studentIds) || !studentIds.length) return res.status(400).json({ error: 'studentIds required' });
    const targetGrade = String(grade || '').trim();
    if (!targetGrade) return res.status(400).json({ error: 'Target grade required' });

    const { data: teacher } = await supabase.from('users').select('id').eq('email', cleanTeacherEmail).maybeSingle();
    if (!teacher) return res.status(404).json({ error: 'Teacher not found.' });

    const { data: links, error: linkErr } = await supabase
      .from('teacher_student')
      .select('student_id')
      .eq('teacher_id', teacher.id)
      .in('student_id', studentIds);
    if (linkErr) return res.status(500).json({ error: linkErr.message });

    const owned = Array.from(new Set((links || []).map((l) => l.student_id)));
    const skipped = studentIds.filter((id) => !owned.includes(id));

    if (owned.length) {
      const patch = { grade: targetGrade };
      if (section !== undefined) patch.section = String(section || '').trim() || null;
      const { error } = await supabase.from('users').update(patch).in('id', owned);
      if (error) return res.status(500).json({ error: error.message });
    }

    res.json({ promoted: owned.length, skipped, grade: targetGrade, section: section !== undefined ? (String(section || '').trim() || null) : undefined });
  } catch (err) {
    console.error('[POST /teacher/:teacherEmail/students/promote] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /teacher/:teacherEmail/students/link-existing ────────────────────────
// Link an existing Aivorah student (by their email) to this teacher's class.
// Body: { studentEmail }
router.post('/:teacherEmail/students/link-existing', async (req, res) => {
  try {
    const { teacherEmail } = req.params;
    const { studentEmail } = req.body || {};

    if (!studentEmail) return res.status(400).json({ error: 'studentEmail is required' });

    const cleanTeacherEmail = String(teacherEmail).toLowerCase().trim();
    const cleanStudentEmail = String(studentEmail).toLowerCase().trim();

    // Find teacher
    const { data: teacher } = await supabase.from('users').select('id').eq('email', cleanTeacherEmail).maybeSingle();
    if (!teacher) return res.status(404).json({ error: 'Teacher not found.' });

    // Find student
    const { data: student } = await supabase
      .from('users')
      .select('id, name, email, grade, curriculum')
      .eq('email', cleanStudentEmail)
      .eq('role', 'student')
      .maybeSingle();
    if (!student) return res.status(404).json({ error: 'No student found with that email. Make sure they have an Aivorah account.' });

    // Link
    const { error } = await supabase.from('teacher_student').upsert({
      teacher_id: teacher.id,
      student_id: student.id,
      subject: student.curriculum || 'General',
    }, { onConflict: 'teacher_id,student_id,subject', ignoreDuplicates: true });
    if (error) return res.status(500).json({ error: error.message });

    res.json({ success: true, student });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Helpers for bulk import ───────────────────────────────────────────────────

function parseXLSX(buffer) {
  const XLSX = require('xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  // raw: false formats every cell as a display string (consistent with the CSV
  // path, which is all strings) — avoids numbers/dates coming through as raw
  // JS numbers that then fail the .trim() calls downstream.
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  return rows.map(row => row.map(cell => String(cell ?? '').trim()));
}

function parseCSV(text) {
  // Strip BOM if present (Excel UTF-8 files)
  const clean = text.replace(/^﻿/, '');
  const lines = clean.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const rows = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = [];
    let inQuote = false, cur = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = !inQuote;
      } else if (ch === ',' && !inQuote) {
        cols.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    cols.push(cur.trim());
    rows.push(cols);
  }
  return rows;
}

async function createFirebaseAccount(email, password) {
  const apiKey = process.env.FIREBASE_API_KEY;
  if (!apiKey) throw new Error('FIREBASE_API_KEY not set on server');
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: false }),
    }
  );
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || 'Firebase signup failed';
    throw new Error(msg);
  }
  return data.localId; // Firebase UID
}

// ── GET /teacher/:teacherEmail/students/template.csv|.xlsx ───────────────────
// Blank import template: headers + 2 obviously fake sample rows. Never includes
// real student/parent data. Mirrors the School Admin bulk import template
// styling (branded header, borders, frozen row, sample rows visually marked).
const TEACHER_TEMPLATE_HEADER = ['Name', 'Email', 'Grade', 'Section', 'Curriculum', 'School', 'Parent Name', 'Parent Email', 'Parent Phone'];
const TEACHER_SAMPLE_ROW_COUNT = 2;

function teacherSampleRows(defaultGrade, defaultCurriculum, school) {
  return [
    ['Aarav Sample (delete before uploading)', '', defaultGrade, 'A', defaultCurriculum, school || '', 'Ravi Sample', 'ravi.sample@example.com', '+91 90000 00001'],
    ['Diya Sample (delete before uploading)', '', defaultGrade, 'B', defaultCurriculum, school || '', '', '', ''],
  ];
}

function teacherCsvCell(value) {
  if (value === null || value === undefined || value === '') return '';
  return `"${String(value).replace(/"/g, '""')}"`;
}

function teacherToCsv(header, rows) {
  const lines = [header.map(teacherCsvCell).join(',')];
  for (const row of rows) lines.push(row.map(teacherCsvCell).join(','));
  return lines.join('\r\n');
}

async function buildTeacherTemplateRows(cleanTeacherEmail) {
  const ctx = await getTeacherSchool(cleanTeacherEmail);
  if (!ctx) return { rows: teacherSampleRows('Grade 3', 'IB PYP', '') };

  const { data: teacherPrefs } = await supabase
    .from('user_preferences').select('data').eq('user_email', cleanTeacherEmail).maybeSingle();
  const teaches = teacherPrefs?.data?.teaches || [];
  const defaultGrade = teaches[0]?.grade || 'Grade 3';
  const defaultCurriculum = resolveCurriculum(ctx.curriculum, defaultGrade) || teaches[0]?.curriculum || 'IB PYP';
  return { rows: teacherSampleRows(defaultGrade, defaultCurriculum, ctx.school) };
}

router.get('/:teacherEmail/students/template.csv', async (req, res) => {
  try {
    const cleanTeacherEmail = String(req.params.teacherEmail).toLowerCase().trim();
    const { rows } = await buildTeacherTemplateRows(cleanTeacherEmail);
    const csv = teacherToCsv(TEACHER_TEMPLATE_HEADER, rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="aivorah_students_template.csv"');
    res.send(csv);
  } catch (err) {
    console.error('[GET /teacher/:teacherEmail/students/template.csv] error:', err.message);
    res.status(500).json({ error: 'Failed to build template' });
  }
});

router.get('/:teacherEmail/students/template.xlsx', async (req, res) => {
  try {
    const cleanTeacherEmail = String(req.params.teacherEmail).toLowerCase().trim();
    const { rows } = await buildTeacherTemplateRows(cleanTeacherEmail);

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Aivorah';
    wb.created = new Date();
    const ws = wb.addWorksheet('Students', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });

    const COL_WIDTHS = [30, 30, 12, 10, 14, 24, 24, 28, 18];
    ws.columns = TEACHER_TEMPLATE_HEADER.map((header, i) => ({ header, key: `c${i}`, width: COL_WIDTHS[i] || 18 }));

    const HEADER_FILL = 'FF5C4A1E'; // deep olive-gold — Aivorah brand accent
    const SAMPLE_FILL = 'FFFBF0DA'; // soft warm tint to mark placeholder rows
    const THIN_BORDER = { style: 'thin', color: { argb: 'FFD9D3C7' } };

    const headerRow = ws.getRow(1);
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
      cell.alignment = { vertical: 'middle' };
      cell.border = { top: THIN_BORDER, left: THIN_BORDER, right: THIN_BORDER, bottom: THIN_BORDER };
    });
    headerRow.height = 22;

    // Parent Phone column holds values like "+91 9361594071". Excel reads a
    // leading "+" (or "=", "-") as the start of a formula and pops up the
    // "we found a typo in your formula" prompt. Force the whole column to Text
    // format so both the pre-filled values AND anything the user types there are
    // treated literally — no formula parsing. (Parent Phone is the last column.)
    const PHONE_COL = TEACHER_TEMPLATE_HEADER.indexOf('Parent Phone') + 1;
    ws.getColumn(PHONE_COL).numFmt = '@';

    rows.forEach((rowValues, i) => {
      const row = ws.addRow(rowValues);
      const isSample = i < TEACHER_SAMPLE_ROW_COUNT;
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.border = { top: THIN_BORDER, left: THIN_BORDER, right: THIN_BORDER, bottom: THIN_BORDER };
        if (isSample) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SAMPLE_FILL } };
          cell.font = { italic: true, color: { argb: 'FF8A7550' } };
        }
      });
      // Belt-and-braces: also stamp Text format on this row's phone cell (column
      // numFmt alone can be overridden by per-cell defaults in some Excel builds).
      const phoneCell = row.getCell(PHONE_COL);
      phoneCell.numFmt = '@';
      if (phoneCell.value != null) phoneCell.value = String(phoneCell.value);
    });

    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: TEACHER_TEMPLATE_HEADER.length } };

    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="aivorah_students_template.xlsx"');
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('[GET /teacher/:teacherEmail/students/template.xlsx] error:', err.message);
    res.status(500).json({ error: 'Failed to build template' });
  }
});

// ── POST /teacher/:teacherEmail/students/bulk-import ─────────────────────────
// Accepts multipart/form-data with a 'csv' file field.
// CSV columns (case-insensitive, order-independent):
//   Name (required), Email (optional), Grade, Section (optional), Curriculum, School,
//   Parent Name (optional), Parent Email (optional), Parent Phone (optional)
// When a Parent Name is present the parent is onboarded too — a parent account
// is created (or an existing one reused) and linked to the student, mirroring
// the School Admin bulk import. Both student and parent are flagged
// mustChangePassword so they must set their own password on first sign-in.
// Optional body fields: defaultGrade, defaultCurriculum
//
// Two-step flow — nothing is EVER created without an explicit commit:
//   1. previewOnly=true  → classify every row (matched / needs_confirmation /
//      skipped-duplicate) with NO database writes, no accounts, no email, no
//      download. Lets the teacher review and pick exactly who to import.
//   2. previewOnly absent + selectedRowIndexes=[...] → creates ONLY those exact
//      rows (by their 1-based position in the file), whether they were
//      originally matched or flagged for review. One single pass, one email,
//      one download — never re-processes rows the teacher didn't select.
router.post('/:teacherEmail/students/bulk-import', upload.single('csv'), async (req, res) => {
  try {
    const { teacherEmail } = req.params;
    const defaultGrade      = (req.body?.defaultGrade      || 'Grade 3').trim();
    const defaultCurriculum = (req.body?.defaultCurriculum || 'IB PYP').trim();
    const previewOnly = req.body?.previewOnly === 'true' || req.body?.previewOnly === true;

    if (!req.file) return res.status(400).json({ error: 'No CSV file uploaded.' });

    const cleanTeacherEmail = String(teacherEmail).toLowerCase().trim();
    const ctx = await getTeacherSchool(cleanTeacherEmail);
    if (!ctx) return res.status(404).json({ error: 'Teacher account not found.' });
    // Every student joins the teacher's own school; the row's School column is only checked.
    const teacher = { ...ctx.teacher, school: ctx.school };

    // Which grade+curriculum combos this teacher actually handles (Staff Subject
    // Mapping) — a CSV row outside this set is flagged for the teacher to
    // confirm rather than silently linked to the wrong class.
    const { data: teacherPrefs } = await supabase
      .from('user_preferences').select('data').eq('user_email', cleanTeacherEmail).maybeSingle();
    const teacherTeaches = teacherPrefs?.data?.teaches || [];
    const normKey = (g, c) => `${String(g || '').trim().toLowerCase()}|${String(c || '').trim().toLowerCase()}`;
    const teacherGradeCurriculumSet = new Set(teacherTeaches.map(t => normKey(t.grade, t.curriculum)));

    // Which exact rows (by 1-based position in the parsed file) the teacher
    // has decided to actually import — only present on the commit call.
    let selectedRowIndexes = null;
    if (!previewOnly) {
      try {
        const parsed = JSON.parse(req.body?.selectedRowIndexes || '[]');
        if (Array.isArray(parsed)) selectedRowIndexes = new Set(parsed.map(Number));
      } catch {}
      if (!selectedRowIndexes) selectedRowIndexes = new Set();
    }

    // The file input accepts .csv and .xlsx/.xls — a real Excel workbook is a
    // zipped binary format, so decoding it as UTF-8 text and running it through
    // the CSV parser would just produce garbage rows. Branch on extension.
    const isExcel = /\.xlsx?$/i.test(req.file.originalname || '');
    const rows = isExcel
      ? parseXLSX(req.file.buffer)
      : parseCSV(req.file.buffer.toString('utf-8'));
    if (rows.length < 2) return res.status(400).json({ error: 'File must have a header row and at least one student row.' });

    // Map header columns
    const header = rows[0].map(h => h.toLowerCase().replace(/[^a-z]/g, ''));
    const col = (name) => header.indexOf(name);
    const nameIdx        = col('name');
    const emailIdx       = col('email');
    const gradeIdx       = col('grade');
    const sectionIdx     = col('section');
    const curriculumIdx  = col('curriculum');
    const schoolIdx      = col('school');
    const parentNameIdx  = col('parentname');
    const parentEmailIdx = col('parentemail');
    const parentPhoneIdx = col('parentphone');

    if (nameIdx === -1) return res.status(400).json({ error: 'CSV must have a "Name" column.' });

    const results = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const rawName = row[nameIdx]?.trim() || '';
      if (!rawName) continue;

      const cleanName    = toTitleCase(rawName);
      const emailRaw     = emailIdx >= 0 ? (row[emailIdx]?.trim() || '') : '';
      const grade        = gradeIdx >= 0 && row[gradeIdx]?.trim() ? row[gradeIdx].trim() : defaultGrade;
      const section      = sectionIdx >= 0 ? (row[sectionIdx]?.trim() || '') : '';
      const curriculum   = resolveCurriculum(ctx.curriculum, grade)
        || (curriculumIdx >= 0 && row[curriculumIdx]?.trim() ? row[curriculumIdx].trim() : defaultCurriculum);
      const school       = schoolIdx >= 0 ? (row[schoolIdx]?.trim() || '') : '';
      const parentName   = parentNameIdx  >= 0 ? (row[parentNameIdx]?.trim() || '')  : '';
      const parentEmailIn = parentEmailIdx >= 0 ? (row[parentEmailIdx]?.trim().toLowerCase() || '') : '';
      const parentPhone  = parentPhoneIdx >= 0 ? (row[parentPhoneIdx]?.trim() || '') : '';

      const gradeCurriculumMismatch = teacherGradeCurriculumSet.size > 0 && !teacherGradeCurriculumSet.has(normKey(grade, curriculum));
      const schoolMismatch = Boolean(school) && Boolean(teacher.school)
        && school.trim().toLowerCase() !== teacher.school.trim().toLowerCase();
      const isMismatch = gradeCurriculumMismatch || schoolMismatch;
      const mismatchReason = gradeCurriculumMismatch && schoolMismatch
        ? `${grade} · ${curriculum} · ${school} doesn't match your classes or school`
        : gradeCurriculumMismatch
          ? `${grade} · ${curriculum} isn't a class you teach`
          : `"${school}" doesn't match your school ("${teacher.school}")`;

      // ── PREVIEW: classify only, never touch the database ──────────────────
      if (previewOnly) {
        let dupEmail = false;
        if (emailRaw) {
          const { data: dup } = await supabase.from('users').select('id').eq('email', emailRaw.toLowerCase()).maybeSingle();
          dupEmail = Boolean(dup);
        }
        results.push({
          rowIndex: i, name: cleanName, email: emailRaw, grade, section, curriculum, school,
          parentName, parentEmail: parentEmailIn,
          status: dupEmail ? 'skipped' : (isMismatch ? 'needs_confirmation' : 'matched'),
          error: dupEmail ? 'Email already exists' : (isMismatch ? `${mismatchReason} — confirm to import anyway.` : undefined),
        });
        continue;
      }

      // ── COMMIT: only create rows the teacher explicitly selected ──────────
      if (!selectedRowIndexes.has(i)) continue;

      const studentEmail = emailRaw ? emailRaw.toLowerCase() : await generateStudentLoginId();

      try {
        // Skip duplicates
        const { data: dup } = await supabase.from('users').select('id').eq('email', studentEmail).maybeSingle();
        if (dup) {
          results.push({ name: cleanName, email: studentEmail, grade, section, curriculum, status: 'skipped', error: 'Email already exists' });
          continue;
        }

        // Real emails get an invite + verification (no password handed out);
        // auto-generated logins keep the credentials flow.
        const invited = isRealEmail(studentEmail) && Boolean(firebaseAdmin);
        const password = invited ? null : generateSecurePassword();

        const firebaseUid = invited
          ? (await createInvitedFirebaseUser(studentEmail, cleanName)).uid
          : await createFirebaseAccount(studentEmail, password);

        // Save to Supabase
        const userId = randomUUID();
        const resolvedStudentId = `STU-${Date.now()}-${randomInt(1000, 9999)}`;

        const { error: userErr } = await supabase.from('users').upsert({
          id: userId, name: cleanName, email: studentEmail, role: 'student',
          grade, section, curriculum, school: ctx.school, school_id: ctx.schoolId, onboarding_complete: true,
        }, { onConflict: 'id' });
        if (userErr) throw new Error(userErr.message);

        await supabase.from('student_stats').upsert({ student_id: userId }, { onConflict: 'student_id', ignoreDuplicates: true });

        await supabase.from('teacher_student').upsert({
          teacher_id: teacher.id, student_id: userId, subject: curriculum,
        }, { onConflict: 'teacher_id,student_id,subject', ignoreDuplicates: true });

        await supabase.from('user_preferences').upsert({
          user_email: studentEmail,
          data: invited ? {
            studentId: resolvedStudentId, createdByTeacher: cleanTeacherEmail, firebaseUid,
            accountStatus: 'pending_verification', invitedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          } : {
            studentId: resolvedStudentId, createdByTeacher: cleanTeacherEmail,
            accountStatus: 'active', firebaseUid, mustChangePassword: true,
            activatedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            initialPassword: password, passwordSavedAt: new Date().toISOString(),
          },
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_email' });

        // Email the student directly when a real email was given in the CSV (not
        // the auto-generated placeholder). The teacher gets ONE consolidated
        // email with every row after the loop (below) instead of one per student —
        // a large bulk import used to flood their inbox with a separate email per row.
        let resolvedParentEmail = ''; // set to a REAL (CSV-provided) parent email, used to route the student's login when the student has no real inbox
        if (invited) {
          await sendInviteAndVerification({ email: studentEmail, name: cleanName, frontendOrigin: req.body?.frontendOrigin });
        } else if (!studentEmail.endsWith('@aivorah.student') && studentEmail !== cleanTeacherEmail) {
          sendCredentialsEmail({ to: studentEmail, childName: cleanName, loginId: studentEmail, password, studentId: resolvedStudentId })
            .catch(err => console.log('[teacher/bulk-import] student credentials email failed (non-fatal):', err.message));
        }

        results.push({ name: cleanName, email: studentEmail, password: password || undefined, invited: invited || undefined, studentId: resolvedStudentId, grade, section, curriculum, role: 'student', status: 'created' });

        // ── PARENT onboarding (only when a Parent Name is supplied) ──────────
        // Mirrors the School Admin bulk import: create-or-reuse a parent account,
        // link it to this student, flag mustChangePassword, and email real
        // (CSV-provided) parent emails their own login.
        if (parentName) {
          try {
            let parentEmail = parentEmailIn;
            let parentUser = null;
            if (parentEmail) {
              const { data: existing } = await supabase.from('users').select('id, email, role, phone').eq('email', parentEmail).maybeSingle();
              if (existing && existing.role === 'parent') {
                parentUser = existing;
                if (parentPhone && parentPhone !== existing.phone) {
                  await supabase.from('users').update({ phone: parentPhone }).eq('id', existing.id);
                }
              } else if (existing) {
                throw new Error(`Parent email ${parentEmail} already belongs to a non-parent account`);
              }
            }
            if (!parentUser) {
              if (!parentEmail) parentEmail = await generateParentLoginId(supabase);
              const pName = toTitleCase(parentName);
              const pPassword = generateSecurePassword();
              const pFirebaseUid = await createFirebaseAccount(parentEmail, pPassword);
              const parentUserId = randomUUID();
              const { error: pErr } = await supabase.from('users').insert({
                id: parentUserId, name: pName, email: parentEmail, role: 'parent',
                phone: parentPhone || null, school: teacher.school || null, school_id: ctx.schoolId,
                onboarding_complete: true,
              });
              if (pErr) throw new Error(pErr.message);
              await supabase.from('user_preferences').upsert({
                user_email: parentEmail,
                data: {
                  loginId: parentEmail, initialPassword: pPassword, parentName: pName,
                  school: teacher.school || null, firebaseUid: pFirebaseUid,
                  createdByTeacher: cleanTeacherEmail, mustChangePassword: true,
                  accountStatus: 'active', passwordSavedAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                },
                updated_at: new Date().toISOString(),
              }, { onConflict: 'user_email' });

              // Only a real, CSV-provided parent email is a deliverable inbox —
              // an auto-generated .parent placeholder isn't.
              if (parentEmailIn) {
                sendOwnAccountCredentialsEmail({ to: parentEmail, name: pName, loginId: parentEmail, password: pPassword, role: 'parent' })
                  .catch(err => console.log('[teacher/bulk-import] parent credentials email failed (non-fatal):', err.message));
              }
              results.push({ name: pName, email: parentEmail, password: pPassword, role: 'parent', status: 'created' });
            }

            // Link parent → student (select-then-insert to avoid duplicates)
            const { data: link } = await supabase.from('parent_children')
              .select('child_id').eq('parent_email', parentEmail).eq('child_id', userId).maybeSingle();
            if (!link) {
              await supabase.from('parent_children').insert({ parent_email: parentEmail, child_id: userId });
            }
            if (parentEmailIn) resolvedParentEmail = parentEmail;
          } catch (parentErr) {
            // A parent failure must never lose the already-created student — record
            // it against the row and move on.
            results.push({ name: `${parentName} (parent of ${cleanName})`, email: parentEmailIn, role: 'parent', status: 'error', error: parentErr.message });
          }
        }

        // If the student had no real inbox but a real parent email is on file,
        // send the student's login there (a child usually can't check a
        // system-generated @aivorah.student address).
        if (studentEmail.endsWith('@aivorah.student') && resolvedParentEmail) {
          sendCredentialsEmail({ to: resolvedParentEmail, childName: cleanName, loginId: studentEmail, password, studentId: resolvedStudentId })
            .catch(err => console.log('[teacher/bulk-import] student-login-to-parent email failed (non-fatal):', err.message));
        }
      } catch (rowErr) {
        results.push({ name: cleanName, email: studentEmail, grade, section, curriculum, role: 'student', status: 'error', error: rowErr.message });
      }
    }

    if (previewOnly) {
      const matched = results.filter(r => r.status === 'matched').length;
      const needsConfirmation = results.filter(r => r.status === 'needs_confirmation').length;
      const skipped = results.filter(r => r.status === 'skipped').length;
      return res.json({ success: true, preview: true, summary: { matched, needsConfirmation, skipped, total: results.length }, results });
    }

    const createdRows = results.filter(r => r.status === 'created');
    // "created" = students onboarded; parents are counted separately so the
    // headline number keeps meaning "students imported".
    const created = createdRows.filter(r => r.role !== 'parent').length;
    const parentsCreated = createdRows.filter(r => r.role === 'parent').length;
    const skipped = results.filter(r => r.status === 'skipped').length;
    const errors  = results.filter(r => r.status === 'error').length;
    const needsConfirmation = 0; // commit pass never leaves anything pending — unselected rows are simply not processed

    // One consolidated email to the teacher with EVERY login created in this
    // batch — students and parents alike.
    if (createdRows.length > 0) {
      sendBulkCredentialsEmail({ to: cleanTeacherEmail, created: createdRows })
        .catch(err => console.log('[teacher/bulk-import] bulk credentials email failed (non-fatal):', err.message));
    }

    res.json({ success: true, summary: { created, parentsCreated, skipped, errors, needsConfirmation, total: results.length }, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
