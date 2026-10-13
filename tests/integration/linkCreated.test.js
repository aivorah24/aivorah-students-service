const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const request = require('supertest');
const app = require('../../index');

beforeEach(() => { mockSb.reset(); mockSb.supabase.from.mockClear(); });

describe('POST /teacher/:teacherEmail/students/link-created', () => {
  const validBody = {
    firebaseUid: 'fb-uid-1', name: 'Aanya Kapoor', email: 'aanya@real.com',
    grade: 'Grade 3', curriculum: 'IB PYP',
  };

  test('requires firebaseUid, name, email, grade, curriculum', async () => {
    const res = await request(app).post('/teacher/t@school.com/students/link-created').send({ name: 'X' });
    expect(res.status).toBe(400);
  });

  test('404s when the teacher account does not exist (before writing anything)', async () => {
    mockSb.setTable('users', [
      { data: null, error: null }, // teacher lookup -> not found
    ]);
    const res = await request(app).post('/teacher/ghost@school.com/students/link-created').send(validBody);
    expect(res.status).toBe(404);
  });

  test('creates the student, links to the teacher, and returns the student record', async () => {
    mockSb.setTable('users', [
      { data: { id: 'teacher-uuid' }, error: null }, // teacher found
      { data: null, error: null },                 // existingUser lookup (none, new student)
      { data: null, error: null },                 // upsert result (no error)
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

  test("saves the teacher's own school + school_id and the school's board (IB → MYP by grade), ignoring client school", async () => {
    mockSb.setTable('users', [
      { data: { id: 'teacher-uuid', school: 'TSRA', school_id: 'school-tsra' }, error: null },
      { data: null, error: null },
      { data: null, error: null },
    ]);
    mockSb.setTable('schools', { data: { id: 'school-tsra', name: 'TSRA', curriculum: 'IB' }, error: null });

    const res = await request(app).post('/teacher/t@school.com/students/link-created')
      .send({ ...validBody, grade: 'Grade 7', curriculum: 'IB PYP', school: 'Hyderabad International School' });
    expect(res.status).toBe(200);
    expect(res.body.student).toMatchObject({ school: 'TSRA', schoolId: 'school-tsra', curriculum: 'IB MYP' });
    const userWrite = writes('users', 'upsert')[0][0];
    expect(userWrite).toMatchObject({ school: 'TSRA', school_id: 'school-tsra', curriculum: 'IB MYP' });
  });
});

function writes(table, method) {
  const { calls, results } = mockSb.supabase.from.mock;
  return calls.map((c, i) => (c[0] === table ? results[i].value[method].mock.calls : []))
    .flat().filter(Boolean);
}
