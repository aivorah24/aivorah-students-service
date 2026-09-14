const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const mockGetUserByEmail = jest.fn();
jest.mock('../../services/firebaseAdmin', () => ({ auth: () => ({ getUserByEmail: mockGetUserByEmail }) }));

const request = require('supertest');
const app = require('../../index');

beforeEach(() => {
  mockSb.reset();
  mockGetUserByEmail.mockReset();
});

describe('POST /teacher/students/init-auth', () => {
  test('requires a name', async () => {
    const res = await request(app).post('/teacher/students/init-auth').send({});
    expect(res.status).toBe(400);
  });

  test('an explicit email skips the generator entirely and returns it verbatim', async () => {
    mockSb.setTable('users', { data: null, error: null }); // no duplicate
    const res = await request(app).post('/teacher/students/init-auth').send({ name: 'Aarav Kapoor', email: 'aarav@real.com' });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('aarav@real.com');
    expect(res.body.emailProvided).toBe(true);
    expect(mockGetUserByEmail).not.toHaveBeenCalled();
  });

  test('rejects a duplicate email with 409', async () => {
    mockSb.setTable('users', { data: { id: 'existing-id' }, error: null });
    const res = await request(app).post('/teacher/students/init-auth').send({ name: 'Aarav', email: 'taken@real.com' });
    expect(res.status).toBe(409);
  });

  test('a custom password under 6 chars is rejected in favor of an auto-generated one', async () => {
    mockSb.setTable('users', { data: null, error: null });
    const res = await request(app).post('/teacher/students/init-auth').send({ name: 'Aarav', email: 'aarav@real.com', password: 'ab' });
    expect(res.status).toBe(200);
    expect(res.body.password).not.toBe('ab');
    expect(res.body.password.length).toBeGreaterThanOrEqual(12);
  });

  test('a blank email auto-generates one via the s{n}@aivorah.student scheme, skipping ids taken in Supabase or Firebase', async () => {
    // s1 taken in Supabase, s2 free in Supabase but taken in Firebase, s3 free in both.
    mockSb.setTable('users', [
      { data: { id: 'x' }, error: null }, // s1 exists in Supabase
      { data: null, error: null },        // s2 free in Supabase
      { data: null, error: null },        // s3 free in Supabase
      { data: null, error: null },        // final duplicate check for chosen candidate (s3)
    ]);
    mockGetUserByEmail.mockImplementation((email) => {
      if (email === 's2@aivorah.student') return Promise.resolve({ uid: 'orphaned-firebase-user' });
      const err = new Error('no user'); err.code = 'auth/user-not-found';
      return Promise.reject(err);
    });

    const res = await request(app).post('/teacher/students/init-auth').send({ name: 'No Email Kid' });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('s3@aivorah.student');
    expect(res.body.emailProvided).toBe(false);
  });

  test('falls back to Supabase-only when no Firebase Admin credential is configured (firebaseAdmin is null)', async () => {
    jest.resetModules();
    jest.doMock('../../services/supabase', () => mockSb.supabase);
    jest.doMock('../../services/firebaseAdmin', () => null);
    mockSb.setTable('users', [
      { data: null, error: null }, // s1 free in Supabase
      { data: null, error: null }, // final duplicate check
    ]);
    const freshApp = require('../../index');
    const res = await request(freshApp).post('/teacher/students/init-auth').send({ name: 'No Admin Kid' });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('s1@aivorah.student');
    jest.dontMock('../../services/firebaseAdmin');
  });
});
