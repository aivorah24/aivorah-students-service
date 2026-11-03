const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const request = require('supertest');
const app = require('../../index');

beforeEach(() => {
  mockSb.reset();
  global.fetch = jest.fn();
});

describe('GET /student/:id', () => {
  test('returns stats with totalTopics from learning-paths-service', async () => {
    mockSb.setTable('users', {
      data: { curriculum: 'CBSE', grade: 'Grade 11' },
      error: null,
    });
    mockSb.setTable('student_stats', {
      data: { student_id: 'child-1', xp_points: 500, level: 2, current_streak: 4, study_time_minutes: 120, completed_topics: ['a', 'b'], last_active_date: new Date().toISOString().split('T')[0] },
      error: null,
    });
    mockSb.setTable('challenge_assignments', {
      count: 5,
      error: null,
    });
    global.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ totalTopics: 42 }) });

    const res = await request(app).get('/student/child-1');

    expect(res.status).toBe(200);
    expect(res.body.xpPoints).toBe(500);
    expect(res.body.totalTopics).toBe(42);
    expect(res.body.challengesCompleted).toBe(5);
  });
});

describe('GET /student/:id/weekly', () => {
  test('returns weekly data', async () => {
    mockSb.setTable('student_daily_log', {
      data: [],
      error: null,
    });

    const res = await request(app).get('/student/child-1/weekly');
    

    expect(res.status).toBe(200);
    expect(res.body.days).toHaveLength(7);
  });
});

describe('GET /student/:id/mistake-trends', () => {
  test('returns mistake trends', async () => {
    mockSb.setTable('topic_attempts', {
      data: [
        { topic: 'Math', subject: 'Math', grade: 'Grade 3', attempt_number: 1, score: 50, passed: false, time_spent_seconds: 60, created_at: '2026-09-01T00:00:00Z', per_question_results: [{ question: '1+1', isCorrect: false, studentAnswer: '3', correctAnswer: '2' }] }
      ],
      error: null,
    });

    const res = await request(app).get('/student/child-1/mistake-trends');

    expect(res.status).toBe(200);
    expect(res.body.topics).toHaveLength(1);
    expect(res.body.recentMistakes).toHaveLength(1);
  });

  test('ignores the 0-question 100% row a lesson completion writes', async () => {
    const row = (score, q, at) => ({ topic: 'Poem', subject: 'Hindi', grade: 'Grade 10', attempt_number: 1, score, passed: score >= 60,
      total_questions: q, correct_answers: Math.round(q * score / 100), time_spent_seconds: q ? 29 : 0, created_at: at, per_question_results: [] });
    mockSb.setTable('topic_attempts', {
      data: [row(100, 0, '2026-10-28T15:25:19Z'), row(80, 5, '2026-10-28T15:25:18Z')],
      error: null,
    });

    const res = await request(app).get('/student/child-1/mistake-trends');

    expect(res.status).toBe(200);
    expect(res.body.topics).toHaveLength(1);
    expect(res.body.topics[0]).toMatchObject({ totalAttempts: 1, bestScore: 80, latestScore: 80, totalTimeSeconds: 29 });
    expect(res.body.summary.totalAttempts).toBe(1);
  });

  test('a topic only completed (never quizzed) is not a practice test', async () => {
    mockSb.setTable('topic_attempts', {
      data: [{ topic: 'Poem', subject: 'Hindi', score: 100, passed: true, total_questions: 0, time_spent_seconds: 0, created_at: '2026-10-28T00:00:00Z', per_question_results: [] }],
      error: null,
    });

    const res = await request(app).get('/student/child-1/mistake-trends');

    expect(res.body.topics).toEqual([]);
    expect(res.body.summary.totalAttempts).toBe(0);
  });
});
