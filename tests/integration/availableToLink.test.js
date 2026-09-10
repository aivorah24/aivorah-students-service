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

  // Bug 3 RCA (confirmed live against the real DB, 2026-09-10): a teacher
  // whose own users.role happened to be 'parent' (not 'teacher') showed up as
  // a "linkable student" for their own grade, because the old filter was a
  // `role !== 'teacher'` blacklist instead of a `role === 'student'`
  // whitelist. Real student eligibility must be a whitelist.
  test('a non-teacher, non-student account (e.g. role: parent) is never offered as a linkable student', async () => {
    mockSb.setTable('users', [
      { data: { id: 'teacher-uuid', grade: 'Grade 12', curriculum: 'CBSE', school: 'Vethathiri' }, error: null },
      {
        data: [
          { id: 'leaked-parent', name: 'Giri', email: 'sbrintha06@gmail.com', grade: 'Grade 12', curriculum: 'CBSE', school: 'Vethathiri', role: 'parent' },
          { id: 'real-student', name: 'SriSiva', email: 'saibrintha02@gmail.com', grade: 'Grade 12', curriculum: 'CBSE', school: 'Vethathiri', role: 'student' },
        ],
        error: null,
      },
    ]);
    mockSb.setTable('teacher_student', { data: [], error: null });

    const res = await request(app).get('/student/available-to-link?teacherEmail=t@school.com&grades=Grade%2012');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('real-student');
  });

  // Bug 3 RCA (confirmed live): real DB rows exist with BOTH "6" and
  // "Grade 6" for the same grade — depending on which was passed in
  // ?grades=, an exact-string .in() match silently returned zero students
  // even though a real, eligible student existed with a differently-
  // formatted (but equivalent) grade value.
  test('matches students regardless of "Grade 6" vs "6" format disagreement (grade normalization)', async () => {
    mockSb.setTable('users', [
      { data: { id: 'teacher-uuid', grade: 'Grade 6', curriculum: 'CBSE', school: 'TSRA' }, error: null },
      {
        data: [
          { id: 'bare-digit-student', name: 'Bare Digit Kid', email: 'bd@real.com', grade: '6', curriculum: 'CBSE', school: 'TSRA', role: 'student' },
        ],
        error: null,
      },
    ]);
    mockSb.setTable('teacher_student', { data: [], error: null });

    // Teacher's own grades param uses the full "Grade 6" format; the real
    // candidate is stored as the bare digit "6" — must still match.
    const res = await request(app).get('/student/available-to-link?teacherEmail=t@school.com&grades=Grade%206');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('bare-digit-student');
  });

  test('does not match a genuinely different grade after normalization', async () => {
    mockSb.setTable('users', [
      { data: { id: 'teacher-uuid', grade: 'Grade 6', curriculum: 'CBSE', school: 'TSRA' }, error: null },
      {
        data: [
          { id: 'wrong-grade-student', name: 'Wrong Grade Kid', email: 'wg@real.com', grade: 'Grade 7', curriculum: 'CBSE', school: 'TSRA', role: 'student' },
        ],
        error: null,
      },
    ]);
    mockSb.setTable('teacher_student', { data: [], error: null });

    const res = await request(app).get('/student/available-to-link?teacherEmail=t@school.com&grades=Grade%206');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
