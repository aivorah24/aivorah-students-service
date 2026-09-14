// Credentials / resend-credentials / reset-password / edit / unlink routes —
// ported from the monolith (ai-mentor/server/routes/parent.js) as part of
// moving the Parent "My Kids" feature off it (see routes/parent.js's
// init-auth comment for the full migration context). These were the routes
// still missing from this service's parent.js when the migration started;
// this file is their regression coverage.

const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

jest.mock('../../services/mailer', () => ({
  sendCredentialsEmail: jest.fn().mockResolvedValue(undefined),
  sendEmailOtpCode: jest.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
}));

const mockGetUserByEmail = jest.fn();
const mockUpdateUser = jest.fn();
const mockGeneratePasswordResetLink = jest.fn();
jest.mock('../../services/firebaseAdmin', () => ({
  auth: () => ({
    getUserByEmail: mockGetUserByEmail,
    updateUser: mockUpdateUser,
    generatePasswordResetLink: mockGeneratePasswordResetLink,
  }),
}));

const request = require('supertest');
const app = require('../../index');
const mailer = require('../../services/mailer');

beforeEach(() => {
  mockSb.reset();
  jest.clearAllMocks();
});

describe('GET /parent/:parentEmail/children/:childId/credentials', () => {
  test('not linked to this parent -> 403', async () => {
    mockSb.setTable('parent_children', { data: null, error: null });
    const res = await request(app).get('/parent/parent@a.com/children/kid-1/credentials');
    expect(res.status).toBe(403);
  });

  test('returns the stored login id and initial password', async () => {
    mockSb.setTable('parent_children', { data: { child_id: 'kid-1' }, error: null });
    mockSb.setTable('users', { data: { email: 'kid@aivorah.student', name: 'Kid' }, error: null });
    mockSb.setTable('user_preferences', { data: { data: { studentId: 'STU-1', initialPassword: 'Abc12345', passwordSavedAt: '2026-01-01' } }, error: null });

    const res = await request(app).get('/parent/parent@a.com/children/kid-1/credentials');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ loginId: 'kid@aivorah.student', studentId: 'STU-1', initialPassword: 'Abc12345' });
  });
});

describe('POST /parent/:parentEmail/children/:childId/resend-credentials', () => {
  test('no saved password -> 400', async () => {
    mockSb.setTable('parent_children', { data: { child_id: 'kid-1' }, error: null });
    mockSb.setTable('users', { data: { email: 'kid@aivorah.student', name: 'Kid' }, error: null });
    mockSb.setTable('user_preferences', { data: { data: {} }, error: null });

    const res = await request(app).post('/parent/parent@a.com/children/kid-1/resend-credentials');
    expect(res.status).toBe(400);
    expect(mailer.sendCredentialsEmail).not.toHaveBeenCalled();
  });

  test('resends the saved credentials to the parent', async () => {
    mockSb.setTable('parent_children', { data: { child_id: 'kid-1' }, error: null });
    mockSb.setTable('users', { data: { email: 'kid@aivorah.student', name: 'Kid' }, error: null });
    mockSb.setTable('user_preferences', { data: { data: { initialPassword: 'Abc12345', studentId: 'STU-1' } }, error: null });

    const res = await request(app).post('/parent/parent@a.com/children/kid-1/resend-credentials');
    expect(res.status).toBe(200);
    expect(mailer.sendCredentialsEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'parent@a.com', loginId: 'kid@aivorah.student' }));
  });
});

describe('POST /parent/:parentEmail/children/:childId/reset-password', () => {
  test('no Firebase Admin credential configured -> 500', async () => {
    jest.resetModules();
    jest.doMock('../../services/supabase', () => mockSb.supabase);
    jest.doMock('../../services/mailer', () => ({ sendCredentialsEmail: jest.fn(), sendEmailOtpCode: jest.fn(), sendPasswordResetEmail: jest.fn() }));
    jest.doMock('../../services/firebaseAdmin', () => null);
    mockSb.setTable('parent_children', { data: { child_id: 'kid-1' }, error: null });
    mockSb.setTable('users', { data: { email: 'kid@aivorah.student', name: 'Kid' }, error: null });

    const freshApp = require('../../index');
    const res = await request(freshApp).post('/parent/parent@a.com/children/kid-1/reset-password').send({});
    expect(res.status).toBe(500);
    jest.dontMock('../../services/firebaseAdmin');
    jest.dontMock('../../services/mailer');
  });

  test('generates a themed reset link, clears the stored password, and emails the parent', async () => {
    mockSb.setTable('parent_children', { data: { child_id: 'kid-1' }, error: null });
    mockSb.setTable('users', { data: { email: 'kid@aivorah.student', name: 'Kid' }, error: null });
    mockSb.setTable('user_preferences', { data: { data: { initialPassword: 'Abc12345', studentId: 'STU-1' } }, error: null });
    mockGeneratePasswordResetLink.mockResolvedValue('https://real-firebase-link/?oobCode=xyz123&other=1');

    const res = await request(app)
      .post('/parent/parent@a.com/children/kid-1/reset-password')
      .send({ frontendOrigin: 'https://app.example.com' });

    expect(res.status).toBe(200);
    expect(mailer.sendPasswordResetEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'parent@a.com',
      resetLink: 'https://app.example.com/reset-password?oobCode=xyz123',
      childName: 'Kid',
    }));
  });

  test('child not linked to this parent -> 403', async () => {
    mockSb.setTable('parent_children', { data: null, error: null });
    const res = await request(app).post('/parent/parent@a.com/children/kid-1/reset-password').send({});
    expect(res.status).toBe(403);
  });
});

describe('PATCH /parent/:parentEmail/children/:childId', () => {
  test('not linked to this parent -> 403', async () => {
    mockSb.setTable('parent_children', { data: null, error: null });
    const res = await request(app).patch('/parent/parent@a.com/children/kid-1').send({ name: 'New Name' });
    expect(res.status).toBe(403);
  });

  test('updates name/grade without touching Firebase when email is unchanged', async () => {
    mockSb.setTable('parent_children', { data: { child_id: 'kid-1' }, error: null });
    mockSb.setTable('users', [
      { data: { id: 'kid-1', name: 'Kid', email: 'kid@aivorah.student', grade: 'Grade 3', curriculum: 'CBSE', school: '' }, error: null },
      { data: { id: 'kid-1', name: 'Kiddo', email: 'kid@aivorah.student', grade: 'Grade 4', curriculum: 'CBSE', school: '' }, error: null },
    ]);

    const res = await request(app).patch('/parent/parent@a.com/children/kid-1').send({ name: 'Kiddo', grade: 'Grade 4' });
    expect(res.status).toBe(200);
    expect(res.body.child.name).toBe('Kiddo');
    expect(mockGetUserByEmail).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  test('changing to an email already used by another account -> 409', async () => {
    mockSb.setTable('parent_children', { data: { child_id: 'kid-1' }, error: null });
    mockSb.setTable('users', [
      { data: { id: 'kid-1', name: 'Kid', email: 'kid@aivorah.student', grade: 'Grade 3', curriculum: 'CBSE', school: '' }, error: null },
      { data: { id: 'someone-else' }, error: null },
    ]);

    const res = await request(app).patch('/parent/parent@a.com/children/kid-1').send({ email: 'taken@real.com' });
    expect(res.status).toBe(409);
  });
});

describe('DELETE /parent/:parentEmail/children/:childId', () => {
  test('unlinks the child', async () => {
    mockSb.setTable('parent_children', { error: null });
    const res = await request(app).delete('/parent/parent@a.com/children/kid-1');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('supabase error -> 500', async () => {
    mockSb.setTable('parent_children', { error: { message: 'db down' } });
    const res = await request(app).delete('/parent/parent@a.com/children/kid-1');
    expect(res.status).toBe(500);
  });
});
