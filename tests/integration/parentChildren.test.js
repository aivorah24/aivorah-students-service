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

  test('supabase error on the parent_children lookup -> 500', async () => {
    mockSb.setTable('parent_children', { data: null, error: { message: 'db down' } });

    const res = await request(app).get('/parent/parent@example.com/children');

    expect(res.status).toBe(500);
  });
});
