const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const request = require('supertest');
const app = require('../../index');

beforeEach(() => { mockSb.reset(); });

describe('POST /teacher/:teacherEmail/students/promote', () => {
  test('requires a non-empty studentIds array', async () => {
    const res = await request(app).post('/teacher/t@school.com/students/promote').send({ grade: 'Grade 4' });
    expect(res.status).toBe(400);
  });

  test('requires a target grade', async () => {
    const res = await request(app).post('/teacher/t@school.com/students/promote').send({ studentIds: ['s1'] });
    expect(res.status).toBe(400);
  });

  test('404s when the teacher does not exist', async () => {
    mockSb.setTable('users', { data: null, error: null });
    const res = await request(app).post('/teacher/ghost@school.com/students/promote').send({ studentIds: ['s1'], grade: 'Grade 4' });
    expect(res.status).toBe(404);
  });

  test('only promotes students actually linked to this teacher, reporting the rest as skipped', async () => {
    mockSb.setTable('users', [
      { data: { id: 'teacher-uuid' }, error: null }, // teacher lookup
      { data: null, error: null },                    // update() result
    ]);
    mockSb.setTable('teacher_student', { data: [{ student_id: 's1' }], error: null }); // only s1 is actually owned

    const res = await request(app).post('/teacher/t@school.com/students/promote').send({ studentIds: ['s1', 's2'], grade: 'Grade 4' });
    expect(res.status).toBe(200);
    expect(res.body.promoted).toBe(1);
    expect(res.body.skipped).toEqual(['s2']);
    expect(res.body.grade).toBe('Grade 4');
  });

  test('sends each promoted student a bell notification with old and new grade', async () => {
    mockSb.setTable('users', [
      { data: { id: 'teacher-uuid' }, error: null },
      { data: [
        { id: 's1', role: 'student', grade: 'Grade 8', section: 'A' },
        { id: 's2', role: 'student', grade: 'Grade 9', section: 'A' }, // already there
      ], error: null },
      { data: null, error: null },
    ]);
    mockSb.setTable('teacher_student', { data: [{ student_id: 's1' }, { student_id: 's2' }], error: null });
    mockSb.setTable('notifications', { data: null, error: null });

    const res = await request(app).post('/teacher/T@school.com/students/promote').send({ studentIds: ['s1', 's2'], grade: 'Grade 9' });
    expect(res.status).toBe(200);

    const calls = mockSb.supabase.from.mock.calls.map((c, i) => [c[0], mockSb.supabase.from.mock.results[i].value]);
    const notif = calls.find(([t]) => t === 'notifications')[1];
    const rows = notif.insert.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipient_id: 's1', recipient_role: 'student', type: 'account_updated', entity_type: 'user', entity_id: 's1',
      title: "You've been promoted to Grade 9", body: 'Moved from Grade 8 - A to Grade 9 - A.',
      actor_email: 't@school.com', actor_role: 'teacher',
    });
    expect(rows[0].event_key).toMatch(/^account_updated:user:s1:promoted:/);
  });

  test('a failed notification insert still reports the promotion as done', async () => {
    mockSb.setTable('users', [
      { data: { id: 'teacher-uuid' }, error: null },
      { data: [{ id: 's1', role: 'student', grade: 'Grade 8', section: null }], error: null },
      { data: null, error: null },
    ]);
    mockSb.setTable('teacher_student', { data: [{ student_id: 's1' }], error: null });
    mockSb.setTable('notifications', { data: null, error: { message: 'boom' } });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await request(app).post('/teacher/t@school.com/students/promote').send({ studentIds: ['s1'], grade: 'Grade 9' });
    warn.mockRestore();
    expect(res.status).toBe(200);
    expect(res.body.promoted).toBe(1);
  });
});
