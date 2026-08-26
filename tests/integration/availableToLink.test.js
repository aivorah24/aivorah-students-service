const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const request = require('supertest');
const app = require('../../index');

beforeEach(() => { mockSb.reset(); });

describe('GET /student/available-to-link', () => {
  test('requires teacherEmail', async () => {
    const res = await request(app).get('/student/available-to-link');
    expect(res.status).toBe(400);
  });

  test('excludes students already linked to this teacher and non-students', async () => {
    mockSb.setTable('users', [
      { data: { id: 'teacher-uuid', grade: 'Grade 3', curriculum: 'IB PYP', school: 'Green Valley' }, error: null }, // teacher lookup
      {
        data: [
          { id: 's1', name: 'Already Linked', email: 'a@real.com', grade: 'Grade 3', curriculum: 'IB PYP', school: 'Green Valley', role: 'student' },
          { id: 's2', name: 'Unlinked Kid', email: 'b@real.com', grade: 'Grade 3', curriculum: 'IB PYP', school: 'Green Valley', role: 'student' },
        ],
        error: null,
      }, // candidates query
    ]);
    mockSb.setTable('teacher_student', { data: [{ student_id: 's1' }], error: null });

    const res = await request(app).get('/student/available-to-link?teacherEmail=t@school.com&grades=Grade%203');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('s2');
  });

  test('works even when the teacher has no users-table record (grade defaults kick in)', async () => {
    mockSb.setTable('users', [
      { data: null, error: null }, // teacher lookup -> none
      { data: [], error: null },   // candidates query
    ]);
    mockSb.setTable('teacher_student', { data: [], error: null });
    mockSb.setTable('user_preferences', { data: null, error: null });

    const res = await request(app).get('/student/available-to-link?teacherEmail=new-teacher@school.com');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
