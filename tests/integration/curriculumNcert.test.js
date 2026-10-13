const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const request = require('supertest');
const app = require('../../index');

beforeEach(() => { mockSb.reset(); mockSb.supabase.from.mockClear(); });

// Every chain method call recorded for one table, e.g. calls('users', 'upsert').
function calls(table, method) {
  return mockSb.supabase.from.mock.calls
    .map((c, i) => (c[0] === table ? mockSb.supabase.from.mock.results[i].value[method].mock.calls : []))
    .flat();
}

describe('"NCERT" is stored and returned as CBSE', () => {
  test('teacher link-created with curriculum NCERT writes CBSE', async () => {
    mockSb.setTable('users', [
      { data: { id: 'teacher-uuid', school: 'TSRA', school_id: null }, error: null },
      { data: null, error: null },
      { data: null, error: null },
    ]);
    const res = await request(app).post('/teacher/t@school.com/students/link-created').send({
      firebaseUid: 'fb-1', name: 'Ravi', email: 'ravi@real.com', grade: 'Grade 8', curriculum: 'NCERT',
    });
    expect(res.status).toBe(200);
    expect(res.body.student.curriculum).toBe('CBSE');
    expect(calls('users', 'upsert')[0][0]).toMatchObject({ curriculum: 'CBSE' });
    expect(calls('teacher_student', 'upsert')[0][0]).toMatchObject({ subject: 'CBSE' });
  });

  test('available-to-link matches legacy NCERT students for a CBSE teacher and returns CBSE', async () => {
    mockSb.setTable('users', [
      { data: { id: 'teacher-uuid', grade: 'Grade 8', curriculum: 'CBSE', school: 'TSRA' }, error: null },
      { data: [{ id: 's1', name: 'Old Row', email: 'o@real.com', grade: 'Grade 8', curriculum: 'NCERT', role: 'student' }], error: null },
    ]);
    mockSb.setTable('teacher_student', { data: [], error: null });

    const res = await request(app).get('/student/available-to-link?teacherEmail=t@school.com&grades=Grade%208');
    expect(res.status).toBe(200);
    expect(res.body[0].curriculum).toBe('CBSE');
    expect(calls('users', 'in')).toContainEqual(['curriculum', ['CBSE', 'NCERT']]);
  });

  test('parent children list shows CBSE for a legacy NCERT child', async () => {
    mockSb.setTable('parent_children', { data: [{ child_id: 'c1', users: { id: 'c1', name: 'Kid', grade: 'Grade 8', curriculum: 'NCERT' } }], error: null });
    mockSb.setTable('student_stats', { data: [], error: null });
    global.fetch = jest.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ totalTopics: 5 }) }));

    const res = await request(app).get('/parent/p@real.com/children');
    expect(res.status).toBe(200);
    expect(res.body[0].curriculum).toBe('CBSE');
  });
});
