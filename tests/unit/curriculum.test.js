const { normalizeCurriculum, normalizeCurriculumEntries, curriculumAliases } = require('../../services/curriculum');

describe('normalizeCurriculum', () => {
  test.each(['NCERT', 'ncert', ' Ncert ', 'N CERT', 'CBSE', 'cbse'])('%p -> CBSE', (v) => {
    expect(normalizeCurriculum(v)).toBe('CBSE');
  });

  test('leaves other curricula untouched (trimmed)', () => {
    expect(normalizeCurriculum(' IB PYP ')).toBe('IB PYP');
    expect(normalizeCurriculum(null)).toBeNull();
  });

  test('entries + aliases', () => {
    expect(normalizeCurriculumEntries([{ curriculum: 'NCERT' }])).toEqual([{ curriculum: 'CBSE' }]);
    expect(curriculumAliases('NCERT')).toEqual(['CBSE', 'NCERT']);
  });
});
