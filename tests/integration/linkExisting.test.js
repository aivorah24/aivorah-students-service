const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const request = require('supertest');
const app = require('../../index');

beforeEach(() => { mockSb.reset(); });

describe('POST /teacher/:teacherEmail/students/link-existing', () => {
  test('requires studentEmail', async () => {
    const res = await request(app).post('/teacher/t@school.com/students/link-existing').send({});
    expect(res.status).toBe(400);
  });

  test('404s when the teacher does not exist', async () => {
    mockSb.setTable('users', { data: null, error: null });
    const res = await request(app).post('/teacher/ghost@school.com/students/link-existing').send({ studentEmail: 'kid@real.com' });
    expect(res.status).toBe(404);
  });

  test('404s when no student with that email exists', async () => {
    mockSb.setTable('users', [
      { data: { id: 'teacher-uuid' }, error: null }, // teacher found
      { data: null, error: null },                    // student not found
    ]);
    const res = await request(app).post('/teacher/t@school.com/students/link-existing').send({ studentEmail: 'ghost@real.com' });
    expect(res.status).toBe(404);
  });

  test('links an existing student and returns their record', async () => {
    mockSb.setTable('users', [
      { data: { id: 'teacher-uuid' }, error: null },
      { data: { id: 'student-uuid', name: 'Rohan', email: 'rohan@real.com', grade: 'Grade 4', curriculum: 'IB PYP' }, error: null },
    ]);
    mockSb.setTable('teacher_student', { data: null, error: null });

    const res = await request(app).post('/teacher/t@school.com/students/link-existing').send({ studentEmail: 'rohan@real.com' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.student.email).toBe('rohan@real.com');
  });
});
