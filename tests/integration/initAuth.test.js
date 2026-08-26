const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const request = require('supertest');
const app = require('../../index');

beforeEach(() => {
  mockSb.reset();
  global.fetch = jest.fn();
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
    expect(global.fetch).not.toHaveBeenCalled();
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
    global.fetch.mockImplementation((url) => {
      if (String(url).includes('createAuthUri')) {
        // Called once per Supabase-free candidate: s2 -> registered, s3 -> not registered
        const callsSoFar = global.fetch.mock.calls.filter(c => String(c[0]).includes('createAuthUri')).length;
        return Promise.resolve({ json: () => Promise.resolve({ registered: callsSoFar === 1 }) });
      }
      return Promise.resolve({ json: () => Promise.resolve({}) });
    });

    const res = await request(app).post('/teacher/students/init-auth').send({ name: 'No Email Kid' });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('s3@aivorah.student');
    expect(res.body.emailProvided).toBe(false);
  });
});
