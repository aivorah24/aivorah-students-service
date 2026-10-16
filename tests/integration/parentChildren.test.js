// GET /parent/:parentEmail/children — ported from the monolith
// (ai-mentor/server/routes/parent.js) as part of the parent/child-linkage
// domain migration. totalTopics comes from aivorah-learning-paths-service
// over HTTP (curriculum domain owns Qdrant), not computed in this service -
// that outbound call is mocked here via global.fetch.

const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const request = require('supertest');
const app = require('../../index');

beforeEach(() => {
  mockSb.reset();
  global.fetch = jest.fn();
});

describe('POST /parent/:parentEmail/children (link an existing student)', () => {
  test('normalizes parentEmail to lowercase/trimmed before inserting the link - a mixed-case URL param must still match the lowercase rows every other insert path and the messages-service lookup use', async () => {
    mockSb.setTable('users', { data: { id: 's1', name: 'Kid', email: 'kid@example.com', grade: 'Grade 5', school: 'Green Valley', role: 'student' }, error: null });
    mockSb.setTable('parent_children', { data: null, error: null });

    const res = await request(app)
      .post('/parent/Parent@Example.com/children')
      .send({ childEmail: 'kid@example.com' });

    expect(res.status).toBe(200);
    const insertCall = mockSb.supabase.from.mock.results
      .find((r, i) => mockSb.supabase.from.mock.calls[i][0] === 'parent_children');
    expect(insertCall.value.insert).toHaveBeenCalledWith({ parent_email: 'parent@example.com', child_id: 's1' });
  });

  // Regression: this route used to look up childEmail with a plain
  // .eq('email', ...).single() and NO role filter — any registered account
  // (a teacher's, another parent's) linked successfully as if it were a
  // child. Same bug independently found and fixed in the monolith's copy.
  test('a real TEACHER email is rejected as "not found", not linked as a child', async () => {
    mockSb.setTable('users', { data: { id: 't1', name: 'Teacher', email: 'teacher@example.com', grade: null, school: 'X', role: 'teacher' }, error: null });

    const res = await request(app)
      .post('/parent/parent@example.com/children')
      .send({ childEmail: 'teacher@example.com' });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no student found/i);
  });

  test('a real PARENT email is rejected as "not found", not linked as a child', async () => {
    mockSb.setTable('users', { data: { id: 'p2', name: 'Other Parent', email: 'other-parent@example.com', grade: null, school: 'X', role: 'parent' }, error: null });

    const res = await request(app)
      .post('/parent/parent@example.com/children')
      .send({ childEmail: 'other-parent@example.com' });

    expect(res.status).toBe(404);
  });

  test('a genuinely unregistered email is rejected as "not found"', async () => {
    mockSb.setTable('users', { data: null, error: null });

    const res = await request(app)
      .post('/parent/parent@example.com/children')
      .send({ childEmail: 'nobody@example.com' });

    expect(res.status).toBe(404);
  });
});

describe('GET /parent/:parentEmail/children', () => {
  test('no linked children -> empty array', async () => {
    mockSb.setTable('parent_children', { data: [], error: null });

    const res = await request(app).get('/parent/parent@example.com/children');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('returns each linked child with stats and totalTopics from learning-paths-service', async () => {
    mockSb.setTable('parent_children', {
      data: [
        {
          child_id: 'child-1',
          added_at: '2026-01-01T00:00:00.000Z',
          users: { id: 'child-1', name: 'Riya', email: 'riya@example.com', grade: 'Grade 11', curriculum: 'CBSE', school: 'Hyderabad International' },
        },
      ],
      error: null,
    });
    mockSb.setTable('student_stats', {
      data: [{ student_id: 'child-1', xp_points: 500, level: 2, current_streak: 4, study_time_minutes: 120, completed_topics: ['a', 'b'] }],
      error: null,
    });
    global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ totalTopics: 17 }) });

    const res = await request(app).get('/parent/parent@example.com/children');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: 'child-1',
      name: 'Riya',
      email: 'riya@example.com',
      grade: 'Grade 11',
      curriculum: 'CBSE',
      profileGrade: 'Grade 11',
      profileCurriculum: 'CBSE',
      school: 'Hyderabad International',
      totalTopics: 17,
      xpPoints: 500,
      level: 2,
      currentStreak: 4,
      studyTimeMinutes: 120,
      completedTopics: ['a', 'b'],
    });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/curriculum/topic-count?curriculum=CBSE&grade=Grade%2011'),
    );
  });

  test('learning-paths-service unreachable -> totalTopics falls back to 0, list still returns', async () => {
    mockSb.setTable('parent_children', {
      data: [{ child_id: 'child-1', added_at: null, users: { id: 'child-1', name: 'Kai', email: 'kai@example.com', grade: 'Grade 3', curriculum: 'IB PYP', school: '' } }],
      error: null,
    });
    mockSb.setTable('student_stats', { data: [], error: null });
    global.fetch.mockRejectedValueOnce(new Error('network error'));

    const res = await request(app).get('/parent/parent@example.com/children');

    expect(res.status).toBe(200);
    expect(res.body[0].totalTopics).toBe(0);
  });

  test('unset grade/curriculum -> defaults stay, but profileGrade/profileCurriculum are empty', async () => {
    mockSb.setTable('parent_children', {
      data: [{ child_id: 'child-1', added_at: null, users: { id: 'child-1', name: 'New', email: 'new@example.com', grade: null, curriculum: null, school: '' } }],
      error: null,
    });
    mockSb.setTable('student_stats', { data: [], error: null });
    global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ totalTopics: 0 }) });

    const res = await request(app).get('/parent/parent@example.com/children');

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ grade: 'Grade 3', curriculum: 'IB PYP', profileGrade: '', profileCurriculum: '' });
  });

  test('legacy NCERT on the users row -> profileCurriculum is CBSE', async () => {
    mockSb.setTable('parent_children', {
      data: [{ child_id: 'child-1', added_at: null, users: { id: 'child-1', name: 'Asha', email: 'asha@example.com', grade: 'Grade 8', curriculum: 'NCERT', school: '' } }],
      error: null,
    });
    mockSb.setTable('student_stats', { data: [], error: null });
    global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ totalTopics: 0 }) });

    const res = await request(app).get('/parent/parent@example.com/children');

    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ curriculum: 'CBSE', profileCurriculum: 'CBSE', profileGrade: 'Grade 8' });
  });

  test('supabase error on the parent_children lookup -> 500', async () => {
    mockSb.setTable('parent_children', { data: null, error: { message: 'db down' } });

    const res = await request(app).get('/parent/parent@example.com/children');

    expect(res.status).toBe(500);
  });
});
