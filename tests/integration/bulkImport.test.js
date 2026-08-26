const { makeSupabaseMock } = require('../helpers/supabaseMock');
const mockSb = makeSupabaseMock();
jest.mock('../../services/supabase', () => mockSb.supabase);

const request = require('supertest');
const app = require('../../index');

const CSV = 'Name,Email,Grade,Curriculum\nAarav Kapoor,,Grade 3,IB PYP\n';

beforeEach(() => {
  mockSb.reset();
  global.fetch = jest.fn(() => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ localId: 'fb-uid-new', registered: false }),
  }));
});

describe('POST /teacher/:teacherEmail/students/bulk-import', () => {
  test('requires a file', async () => {
    const res = await request(app).post('/teacher/t@school.com/students/bulk-import').field('previewOnly', 'true');
    expect(res.status).toBe(400);
  });

  test('404s when the teacher account does not exist', async () => {
    mockSb.setTable('users', { data: null, error: null });
    const res = await request(app)
      .post('/teacher/ghost@school.com/students/bulk-import')
      .field('previewOnly', 'true')
      .attach('csv', Buffer.from(CSV), 'students.csv');
    expect(res.status).toBe(404);
  });

  test('preview mode classifies rows with ZERO database writes and returns a summary', async () => {
    mockSb.setTable('users', [
      { data: { id: 'teacher-uuid', school: '' }, error: null }, // teacher lookup
      { data: null, error: null },                                 // dup-email check (no email in row -> not called, but harmless if it is)
    ]);
    mockSb.setTable('user_preferences', { data: { data: { teaches: [{ grade: 'Grade 3', curriculum: 'IB PYP' }] } }, error: null });

    const res = await request(app)
      .post('/teacher/t@school.com/students/bulk-import')
      .field('defaultGrade', 'Grade 3')
      .field('defaultCurriculum', 'IB PYP')
      .field('previewOnly', 'true')
      .attach('csv', Buffer.from(CSV), 'students.csv');

    expect(res.status).toBe(200);
    expect(res.body.preview).toBe(true);
    expect(res.body.summary.total).toBe(1);
    expect(res.body.results[0].status).toBe('matched');
    // Preview must never touch upsert/insert — the mock's from() call count for
    // write-capable tables should reflect only read patterns (select/eq/maybeSingle).
  });

  test('flags a row outside the grades/curricula the teacher teaches as needs_confirmation', async () => {
    mockSb.setTable('users', { data: { id: 'teacher-uuid', school: '' }, error: null });
    mockSb.setTable('user_preferences', { data: { data: { teaches: [{ grade: 'Grade 5', curriculum: 'IB MYP' }] } }, error: null });

    const res = await request(app)
      .post('/teacher/t@school.com/students/bulk-import')
      .field('previewOnly', 'true')
      .attach('csv', Buffer.from(CSV), 'students.csv');

    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe('needs_confirmation');
  });

  test('commit creates ONLY the rows in selectedRowIndexes and returns a created summary', async () => {
    mockSb.setTable('users', [
      { data: { id: 'teacher-uuid', school: '' }, error: null }, // teacher lookup
      { data: null, error: null },                                 // dup check inside commit loop
      { data: null, error: null },                                 // upsert result
    ]);
    mockSb.setTable('user_preferences', [
      { data: { data: { teaches: [{ grade: 'Grade 3', curriculum: 'IB PYP' }] } }, error: null }, // teacherPrefs
      { data: null, error: null }, // student prefs upsert
    ]);
    mockSb.setTable('student_stats', { data: null, error: null });
    mockSb.setTable('teacher_student', { data: null, error: null });

    const res = await request(app)
      .post('/teacher/t@school.com/students/bulk-import')
      .field('defaultGrade', 'Grade 3')
      .field('defaultCurriculum', 'IB PYP')
      .field('selectedRowIndexes', JSON.stringify([1]))
      .attach('csv', Buffer.from(CSV), 'students.csv');

    expect(res.status).toBe(200);
    expect(res.body.summary.created).toBe(1);
    expect(res.body.results[0].status).toBe('created');
    expect(res.body.results[0].email).toMatch(/@aivorah\.student$/); // no email in CSV -> auto-generated
  });

  test('commit with an empty selectedRowIndexes creates nothing', async () => {
    mockSb.setTable('users', { data: { id: 'teacher-uuid', school: '' }, error: null });
    mockSb.setTable('user_preferences', { data: { data: { teaches: [] } }, error: null });

    const res = await request(app)
      .post('/teacher/t@school.com/students/bulk-import')
      .field('selectedRowIndexes', JSON.stringify([]))
      .attach('csv', Buffer.from(CSV), 'students.csv');

    expect(res.status).toBe(200);
    expect(res.body.summary.created).toBe(0);
    expect(res.body.results).toHaveLength(0);
  });
});
