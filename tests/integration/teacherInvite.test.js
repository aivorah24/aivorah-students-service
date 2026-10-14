// Real-email student (invite + verification), teacher's own school, and the
// blank import template.
const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const mockAuth = {
  getUserByEmail: jest.fn(),
  createUser: jest.fn(),
  deleteUser: jest.fn(),
  generatePasswordResetLink: jest.fn(),
};
jest.mock('../../services/firebaseAdmin', () => ({ auth: () => mockAuth }));

const mockInviteEmail = jest.fn();
jest.mock('../../services/mailer', () => ({
  sendCredentialsEmail: jest.fn().mockResolvedValue(undefined),
  sendBulkCredentialsEmail: jest.fn().mockResolvedValue(undefined),
  sendOwnAccountCredentialsEmail: jest.fn().mockResolvedValue(undefined),
  sendStudentInviteEmail: (...a) => mockInviteEmail(...a),
}));

const request = require('supertest');
const app = require('../../index');

const TEACHER = { data: { id: 'teacher-uuid', school: 'TSRA', school_id: 'school-tsra' }, error: null };
const SCHOOL = { data: { id: 'school-tsra', name: 'TSRA', curriculum: 'IB' }, error: null };

function writes(table, method) {
  const { calls, results } = mockSb.supabase.from.mock;
  return calls.map((c, i) => (c[0] === table ? results[i].value[method].mock.calls : [])).flat();
}

beforeEach(() => {
  mockSb.reset();
  mockSb.supabase.from.mockClear();
  Object.values(mockAuth).forEach(f => f.mockReset());
  mockAuth.getUserByEmail.mockRejectedValue(Object.assign(new Error('nf'), { code: 'auth/user-not-found' }));
  mockAuth.createUser.mockResolvedValue({ uid: 'fb-new' });
  mockAuth.generatePasswordResetLink.mockResolvedValue('https://reset.link');
  mockInviteEmail.mockReset().mockResolvedValue(undefined);
  global.fetch = jest.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }));
});

describe('POST /teacher/:teacherEmail/students/invite', () => {
  const body = { name: 'aanya kapoor', email: 'Aanya@Real.com', grade: 'Grade 11', curriculum: 'IB PYP', frontendOrigin: 'https://app.aivorah.ai' };

  test('creates an unverified account in the teacher school, sends set-password invite + verification', async () => {
    mockSb.setTable('users', [TEACHER, { data: null, error: null }, { data: null, error: null }]);
    mockSb.setTable('schools', SCHOOL);

    const res = await request(app).post('/teacher/t@school.com/students/invite').send(body);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, inviteSent: true, verificationSent: true });
    expect(res.body.student).toMatchObject({ email: 'aanya@real.com', name: 'Aanya Kapoor', school: 'TSRA', schoolId: 'school-tsra', curriculum: 'IB DP' });
    expect(res.body.student.password).toBeUndefined();

    expect(mockAuth.createUser).toHaveBeenCalledWith(expect.objectContaining({ email: 'aanya@real.com', emailVerified: false }));
    expect(writes('users', 'insert')[0][0]).toMatchObject({ role: 'student', school: 'TSRA', school_id: 'school-tsra', curriculum: 'IB DP' });
    const prefs = writes('user_preferences', 'upsert')[0][0];
    expect(prefs.data.accountStatus).toBe('pending_verification');
    expect(prefs.data.initialPassword).toBeUndefined();

    expect(mockAuth.generatePasswordResetLink).toHaveBeenCalledWith('aanya@real.com', { url: 'https://app.aivorah.ai/' });
    expect(mockInviteEmail).toHaveBeenCalledWith({ to: 'aanya@real.com', name: 'Aanya Kapoor', link: 'https://reset.link' });
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toMatch(/\/user\/send-verification$/);
    expect(JSON.parse(opts.body)).toEqual({ email: 'aanya@real.com', name: 'Aanya Kapoor', frontendOrigin: 'https://app.aivorah.ai' });
  });

  test('rejects an auto-generated @aivorah.student login (those keep the credentials flow)', async () => {
    const res = await request(app).post('/teacher/t@school.com/students/invite').send({ ...body, email: 's1@aivorah.student' });
    expect(res.status).toBe(400);
    expect(mockAuth.createUser).not.toHaveBeenCalled();
  });

  test('409 when the email already has an account', async () => {
    mockSb.setTable('users', [TEACHER, { data: { id: 'someone' }, error: null }]);
    mockSb.setTable('schools', SCHOOL);
    const res = await request(app).post('/teacher/t@school.com/students/invite').send(body);
    expect(res.status).toBe(409);
    expect(mockAuth.createUser).not.toHaveBeenCalled();
  });

  test('404 when the teacher does not exist', async () => {
    mockSb.setTable('users', { data: null, error: null });
    const res = await request(app).post('/teacher/ghost@school.com/students/invite').send(body);
    expect(res.status).toBe(404);
  });

  test('a failed invite email keeps the account and reports it', async () => {
    mockSb.setTable('users', [TEACHER, { data: null, error: null }, { data: null, error: null }]);
    mockSb.setTable('schools', SCHOOL);
    mockInviteEmail.mockRejectedValue(new Error('smtp down'));
    const res = await request(app).post('/teacher/t@school.com/students/invite').send(body);
    expect(res.status).toBe(200);
    expect(res.body.inviteSent).toBe(false);
    expect(res.body.inviteError).toMatch(/could not be sent/);
    expect(res.body.verificationSent).toBe(true);
  });

  test('deletes the Firebase user if the users row cannot be written', async () => {
    mockSb.setTable('users', [TEACHER, { data: null, error: null }, { data: null, error: { message: 'db down' } }]);
    mockSb.setTable('schools', SCHOOL);
    const res = await request(app).post('/teacher/t@school.com/students/invite').send(body);
    expect(res.status).toBe(500);
    expect(mockAuth.deleteUser).toHaveBeenCalledWith('fb-new');
  });
});

describe('bulk import uses the teacher school and invites real emails', () => {
  const CSV = 'Name,Email,Grade,Curriculum,School\nAarav Kapoor,,Grade 3,CBSE,Hyderabad International School\nMeera Rao,meera@real.com,Grade 7,CBSE,\n';

  test('every student gets the teacher school + school_id + board; real email → invite, no password', async () => {
    mockSb.setTable('users', [TEACHER, { data: null, error: null }]);
    mockSb.setTable('schools', SCHOOL);
    mockSb.setTable('user_preferences', { data: { data: { teaches: [] } }, error: null });
    global.fetch = jest.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ localId: 'fb-rest' }) }));

    const res = await request(app)
      .post('/teacher/t@school.com/students/bulk-import')
      .field('selectedRowIndexes', JSON.stringify([1, 2]))
      .attach('csv', Buffer.from(CSV), 'students.csv');

    expect(res.status).toBe(200);
    expect(res.body.summary.created).toBe(2);
    const [auto, real] = res.body.results;
    expect(auto).toMatchObject({ curriculum: 'IB PYP', status: 'created' });
    expect(auto.password).toBeTruthy();
    expect(real).toMatchObject({ email: 'meera@real.com', curriculum: 'IB MYP', invited: true, status: 'created' });
    expect(real.password).toBeUndefined();

    const userRows = writes('users', 'upsert').map(c => c[0]);
    expect(userRows.every(r => r.school === 'TSRA' && r.school_id === 'school-tsra')).toBe(true);
    expect(mockInviteEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'meera@real.com' }));
    const prefs = writes('user_preferences', 'upsert').map(c => c[0]);
    expect(prefs.find(p => p.user_email === 'meera@real.com').data.accountStatus).toBe('pending_verification');
  });
});

describe('GET /teacher/:teacherEmail/students/template', () => {
  test('CSV has only the header + 2 fake sample rows — never real students or parents', async () => {
    mockSb.setTable('users', TEACHER);
    mockSb.setTable('schools', SCHOOL);
    mockSb.setTable('user_preferences', { data: { data: { teaches: [{ grade: 'Grade 4', curriculum: 'IB PYP' }] } }, error: null });
    // Would leak if the template still queried the roster.
    mockSb.setTable('teacher_student', { data: [{ student_id: 'real-1' }], error: null });
    mockSb.setTable('parent_children', { data: [{ parent_email: 'realparent@x.com', child_id: 'real-1' }], error: null });

    const res = await request(app).get('/teacher/t@school.com/students/template.csv');
    expect(res.status).toBe(200);
    const lines = res.text.split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^"Name","Email","Grade"/);
    expect(lines[1]).toMatch(/Sample \(delete before uploading\)/);
    expect(lines[2]).toMatch(/Sample \(delete before uploading\)/);
    expect(lines[1]).toContain('"TSRA"');
    const tables = mockSb.supabase.from.mock.calls.map(c => c[0]);
    expect(tables).not.toContain('teacher_student');
    expect(tables).not.toContain('parent_children');
  });

  test('XLSX has only the header + 2 sample rows', async () => {
    mockSb.setTable('users', TEACHER);
    mockSb.setTable('schools', SCHOOL);
    mockSb.setTable('user_preferences', { data: null, error: null });
    const res = await request(app).get('/teacher/t@school.com/students/template.xlsx')
      .buffer(true).parse((r, cb) => { const d = []; r.on('data', c => d.push(c)); r.on('end', () => cb(null, Buffer.concat(d))); });
    expect(res.status).toBe(200);
    const XLSX = require('xlsx');
    const wb = XLSX.read(res.body, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
    expect(rows).toHaveLength(3);
    expect(rows.slice(1).every(r => /Sample/.test(r[0]))).toBe(true);
  });
});
