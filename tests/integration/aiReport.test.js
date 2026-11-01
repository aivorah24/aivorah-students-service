// GET /parent/:parentEmail/children/:childId/ai-report — ported from the
// monolith (ai-mentor/server/routes/parent.js) as part of moving the AI
// Progress Report feature off the monolith. The monolith's Groq model
// (llama-3.3-70b-versatile) was returning 404 model_not_found in production;
// this service uses openai/gpt-oss-120b instead (confirmed live-accessible).

const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const mockGroqCreate = jest.fn();
jest.mock('groq-sdk', () => jest.fn().mockImplementation(() => ({
  chat: { completions: { create: mockGroqCreate } },
})));

const request = require('supertest');
const app = require('../../index');

function aiReportJson(overrides = {}) {
  return {
    learning_pattern_insight: 'insight',
    whats_going_well: 'good stuff',
    where_to_focus: 'focus area',
    subject_insights: [],
    consistency_insight: 'consistency',
    assignment_insight: null,
    this_week_actions: ['do a thing'],
    message_to_child: 'well done!',
    ...overrides,
  };
}

beforeEach(() => {
  mockSb.reset();
  mockGroqCreate.mockReset();
  mockGroqCreate.mockResolvedValue({
    choices: [{ message: { content: JSON.stringify(aiReportJson()) } }],
  });
});

describe('GET /parent/:parentEmail/children/:childId/ai-report', () => {
  test('parent not linked to child -> 403, no Groq call made', async () => {
    mockSb.setTable('parent_children', { data: null, error: null });

    const res = await request(app).get('/parent/parent@example.com/children/child-1/ai-report');

    expect(res.status).toBe(403);
    expect(mockGroqCreate).not.toHaveBeenCalled();
  });

  test('child not found -> 404', async () => {
    mockSb.setTable('parent_children', { data: { child_id: 'child-1' }, error: null });
    mockSb.setTable('users', { data: null, error: null });

    const res = await request(app).get('/parent/parent@example.com/children/child-1/ai-report');

    expect(res.status).toBe(404);
  });

  test('no activity at all -> noData:true, Groq never called', async () => {
    mockSb.setTable('parent_children', { data: { child_id: 'child-1' }, error: null });
    mockSb.setTable('users', { data: { name: 'Kai', email: 'kai@example.com', grade: 'Grade 3', curriculum: 'IB PYP', school: 'Test School' }, error: null });
    mockSb.setTable('student_stats', { data: null, error: null });
    mockSb.setTable('student_daily_log', { data: [], error: null });
    mockSb.setTable('assignment_submissions', { data: [], error: null });
    mockSb.setTable('challenge_assignments', { data: [], error: null });
    mockSb.setTable('analytics_events', { data: [], error: null });

    const res = await request(app).get('/parent/parent@example.com/children/child-1/ai-report');

    expect(res.status).toBe(200);
    expect(res.body.noData).toBe(true);
    expect(mockGroqCreate).not.toHaveBeenCalled();
  });

  test('active student -> calls Groq with openai/gpt-oss-120b and returns merged report', async () => {
    mockSb.setTable('parent_children', { data: { child_id: 'child-1' }, error: null });
    mockSb.setTable('users', { data: { name: 'Saimohan', email: 'saimohan@example.com', grade: 'Grade 3', curriculum: 'IB PYP', school: 'Test School' }, error: null });
    mockSb.setTable('student_stats', {
      data: {
        xp_points: 500, current_streak: 5, study_time_minutes: 300,
        completed_topics: ['ch1_numbers'], assignments_done: 3, challenges_completed: 2, level: 2,
      },
      error: null,
    });
    mockSb.setTable('student_daily_log', {
      data: [{ log_date: '2026-08-30', study_minutes: 30, xp_earned: 20, topics_completed: 1 }],
      error: null,
    });
    mockSb.setTable('assignment_submissions', {
      data: [{ score: 80, status: 'completed', completed_at: '2026-08-30' }],
      error: null,
    });
    mockSb.setTable('challenge_assignments', {
      data: [{ score: 70, status: 'completed', completed_at: '2026-08-30' }],
      error: null,
    });
    mockSb.setTable('analytics_events', {
      data: [{ event_type: 'ibpyp_quiz_result', timestamp: '2026-08-30T10:00:00Z', topic: 'ch1_numbers', subject: 'Math', score: 85 }],
      error: null,
    });

    const res = await request(app).get('/parent/parent@example.com/children/child-1/ai-report');

    expect(res.status).toBe(200);
    expect(mockGroqCreate).toHaveBeenCalledTimes(1);
    expect(mockGroqCreate.mock.calls[0][0].model).toBe('openai/gpt-oss-120b');
    expect(res.body.student.name).toBe('Saimohan');
    expect(res.body.metrics.xp).toBe(500);
    expect(res.body.report.this_week_actions).toEqual(['do a thing']);
    expect(res.body.report.learning_pattern).toBeDefined();
  });

  test('Groq returns non-JSON wrapped in prose -> extracts embedded JSON object', async () => {
    mockSb.setTable('parent_children', { data: { child_id: 'child-1' }, error: null });
    mockSb.setTable('users', { data: { name: 'Kai', email: 'kai@example.com', grade: 'Grade 3', curriculum: 'IB PYP', school: '' }, error: null });
    mockSb.setTable('student_stats', { data: { xp_points: 100, assignments_done: 1 }, error: null });
    mockSb.setTable('student_daily_log', { data: [], error: null });
    mockSb.setTable('assignment_submissions', { data: [], error: null });
    mockSb.setTable('challenge_assignments', { data: [], error: null });
    mockSb.setTable('analytics_events', { data: [], error: null });
    mockGroqCreate.mockResolvedValue({
      choices: [{ message: { content: `Here you go:\n${JSON.stringify(aiReportJson({ whats_going_well: 'nice work' }))}\nEnjoy!` } }],
    });

    const res = await request(app).get('/parent/parent@example.com/children/child-1/ai-report');

    expect(res.status).toBe(200);
    expect(res.body.report.whats_going_well).toBe('nice work');
  });

  test('Groq call throws -> 500, error surfaced', async () => {
    mockSb.setTable('parent_children', { data: { child_id: 'child-1' }, error: null });
    mockSb.setTable('users', { data: { name: 'Kai', email: 'kai@example.com', grade: 'Grade 3', curriculum: 'IB PYP', school: '' }, error: null });
    mockSb.setTable('student_stats', { data: { xp_points: 100, assignments_done: 1 }, error: null });
    mockSb.setTable('student_daily_log', { data: [], error: null });
    mockSb.setTable('assignment_submissions', { data: [], error: null });
    mockSb.setTable('challenge_assignments', { data: [], error: null });
    mockSb.setTable('analytics_events', { data: [], error: null });
    mockGroqCreate.mockRejectedValue(new Error('model_not_found'));

    const res = await request(app).get('/parent/parent@example.com/children/child-1/ai-report');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/model_not_found/);
  });

  test('AI text with banned self-praise phrases gets sanitized before returning', async () => {
    mockSb.setTable('parent_children', { data: { child_id: 'child-1' }, error: null });
    mockSb.setTable('users', { data: { name: 'Kai', email: 'kai@example.com', grade: 'Grade 3', curriculum: 'IB PYP', school: '' }, error: null });
    mockSb.setTable('student_stats', { data: { xp_points: 100, assignments_done: 1 }, error: null });
    mockSb.setTable('student_daily_log', { data: [], error: null });
    mockSb.setTable('assignment_submissions', { data: [], error: null });
    mockSb.setTable('challenge_assignments', { data: [], error: null });
    mockSb.setTable('analytics_events', { data: [], error: null });
    mockGroqCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(aiReportJson({ whats_going_well: 'Shows a strong grasp of numbers.' })) } }],
    });

    const res = await request(app).get('/parent/parent@example.com/children/child-1/ai-report');

    expect(res.status).toBe(200);
    expect(res.body.report.whats_going_well).not.toMatch(/strong grasp/i);
  });

  describe('AI reply robustness (live bug: report cut off -> JSON parse error shown to parent)', () => {
    function activeChild() {
      mockSb.setTable('parent_children', { data: { child_id: 'child-1' }, error: null });
      mockSb.setTable('users', { data: { name: 'Kai', email: 'kai@example.com', grade: 'Grade 10', curriculum: 'IB MYP', school: '' }, error: null });
      mockSb.setTable('student_stats', { data: { xp_points: 100, assignments_done: 1 }, error: null });
      mockSb.setTable('student_daily_log', { data: [], error: null });
      mockSb.setTable('assignment_submissions', { data: [], error: null });
      mockSb.setTable('challenge_assignments', { data: [], error: null });
      mockSb.setTable('analytics_events', { data: [], error: null });
    }
    // Real failure captured from gpt-oss-120b: its reasoning used up max_tokens and the JSON was cut off.
    const truncated = {
      choices: [{
        finish_reason: 'length',
        message: { content: JSON.stringify({ learning_pattern_insight: 'x', subject_insights: [{ subject: 'Maths', insight: 'struggling.' }], consistency_insight: 'With a streak of zero days' }, null, 2).slice(0, -30) },
      }],
    };
    const good = (o) => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(aiReportJson(o)) } }] });

    test('asks Groq for JSON mode, low reasoning and enough tokens so the reply is not cut off', async () => {
      activeChild();
      await request(app).get('/parent/parent@example.com/children/child-1/ai-report');

      const args = mockGroqCreate.mock.calls[0][0];
      expect(args.response_format).toEqual({ type: 'json_object' });
      expect(args.reasoning_effort).toBe('low');
      expect(args.max_tokens).toBeGreaterThanOrEqual(2500);
    });

    test('a cut-off reply is retried once and the second report is returned', async () => {
      activeChild();
      mockGroqCreate.mockResolvedValueOnce(truncated).mockResolvedValueOnce(good({ whats_going_well: 'second try' }));

      const res = await request(app).get('/parent/parent@example.com/children/child-1/ai-report');

      expect(res.status).toBe(200);
      expect(mockGroqCreate).toHaveBeenCalledTimes(2);
      expect(res.body.report.whats_going_well).toBe('second try');
    });

    test('two broken replies -> friendly error, never the raw JSON parse message', async () => {
      activeChild();
      mockGroqCreate.mockResolvedValue(truncated);

      const res = await request(app).get('/parent/parent@example.com/children/child-1/ai-report');

      expect(res.status).toBe(502);
      expect(mockGroqCreate).toHaveBeenCalledTimes(2);
      expect(res.body.error).not.toMatch(/JSON|position|array element/i);
      expect(res.body.error).toMatch(/try again/i);
    });

    test('Groq rate limit (429) -> friendly "busy" error, no retry storm', async () => {
      activeChild();
      mockGroqCreate.mockRejectedValue(Object.assign(new Error('429 Rate limit reached for model openai/gpt-oss-120b in organization org_x'), { status: 429 }));

      const res = await request(app).get('/parent/parent@example.com/children/child-1/ai-report');

      expect(res.status).toBe(503);
      expect(mockGroqCreate).toHaveBeenCalledTimes(1);
      expect(res.body.error).not.toMatch(/org_|Rate limit reached/);
      expect(res.body.error).toMatch(/try again/i);
    });
  });
});
