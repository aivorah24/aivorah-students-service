const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const request = require('supertest');
const app = require('../../index');

beforeEach(() => { mockSb.reset(); });

describe('DELETE /teacher/:teacherEmail/students/:studentId', () => {
  test('404s when the teacher does not exist', async () => {
    mockSb.setTable('users', { data: null, error: null });
    const res = await request(app).delete('/teacher/ghost@school.com/students/student-uuid');
    expect(res.status).toBe(404);
  });

  test('unlinks the student and returns success', async () => {
    mockSb.setTable('users', { data: { id: 'teacher-uuid' }, error: null });
    mockSb.setTable('teacher_student', { data: null, error: null });
    const res = await request(app).delete('/teacher/t@school.com/students/student-uuid');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('propagates a Supabase delete error as a 500', async () => {
    mockSb.setTable('users', { data: { id: 'teacher-uuid' }, error: null });
    mockSb.setTable('teacher_student', { data: null, error: { message: 'db exploded' } });
    const res = await request(app).delete('/teacher/t@school.com/students/student-uuid');
    expect(res.status).toBe(500);
  });
});
