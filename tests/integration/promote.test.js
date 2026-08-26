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
});
