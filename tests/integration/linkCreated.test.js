const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const request = require('supertest');
const app = require('../../index');

beforeEach(() => { mockSb.reset(); });

describe('POST /teacher/:teacherEmail/students/link-created', () => {
  const validBody = {
    firebaseUid: 'fb-uid-1', name: 'Aanya Kapoor', email: 'aanya@real.com',
    grade: 'Grade 3', curriculum: 'IB PYP',
  };

  test('requires firebaseUid, name, email, grade, curriculum', async () => {
    const res = await request(app).post('/teacher/t@school.com/students/link-created').send({ name: 'X' });
    expect(res.status).toBe(400);
  });

  test('404s when the teacher account does not exist', async () => {
    mockSb.setTable('users', [
      { data: null, error: null }, // existingUser lookup (none)
      { data: null, error: null }, // upsert result
      { data: null, error: null }, // teacher lookup -> not found
    ]);
    const res = await request(app).post('/teacher/ghost@school.com/students/link-created').send(validBody);
    expect(res.status).toBe(404);
  });

  test('creates the student, links to the teacher, and returns the student record', async () => {
    mockSb.setTable('users', [
      { data: null, error: null },                 // existingUser lookup (none, new student)
      { data: null, error: null },                 // upsert result (no error)
      { data: { id: 'teacher-uuid' }, error: null }, // teacher found
    ]);
    mockSb.setTable('student_stats', { data: null, error: null });
    mockSb.setTable('teacher_student', { data: null, error: null });
    mockSb.setTable('user_preferences', [
      { data: null, error: null }, // existing prefs (none)
      { data: null, error: null }, // upsert result
    ]);

    const res = await request(app).post('/teacher/t@school.com/students/link-created').send(validBody);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.student.email).toBe('aanya@real.com');
    expect(res.body.student.name).toBe('Aanya Kapoor'); // title-cased
  });
});
