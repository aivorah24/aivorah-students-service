const { computeLearningProfile, humanizeTopic, sanitizeReport } = require('../../services/learningProfile');

describe('computeLearningProfile', () => {
  const base = {
    completedTopics: [], assignmentsDone: 0, challengesCompleted: 0,
    streak: 0, activeDays: 0, studyMinutes: 0, subjectSummaries: [],
    assignmentScores: [], challengeScores: [],
  };

  test('no activity at all -> just_started pattern, irregular consistency', () => {
    const profile = computeLearningProfile(base);
    expect(profile.learningPattern).toBe('just_started');
    expect(profile.consistencySignal).toBe('irregular');
    expect(profile.riskFlags).toContain('no_assignments');
  });

  test('many topics, no assignments, no quiz data -> broad_explorer', () => {
    const profile = computeLearningProfile({
      ...base,
      completedTopics: ['a', 'b', 'c', 'd', 'e'],
    });
    expect(profile.learningPattern).toBe('broad_explorer');
    expect(profile.riskFlags).toContain('unassessed');
  });

  test('quiz data + assignments -> active_learner', () => {
    const profile = computeLearningProfile({
      ...base,
      assignmentsDone: 3,
      subjectSummaries: [{ subject: 'Math', quizCount: 2, strongTopics: [], weakTopics: [], topicDetails: [] }],
    });
    expect(profile.learningPattern).toBe('active_learner');
  });

  test('high streak and active days -> highly_consistent', () => {
    const profile = computeLearningProfile({ ...base, streak: 7, activeDays: 10 });
    expect(profile.consistencySignal).toBe('highly_consistent');
  });

  test('averages assignment and challenge scores correctly', () => {
    const profile = computeLearningProfile({
      ...base,
      assignmentScores: [80, 90],
      challengeScores: [60, 70, 80],
    });
    expect(profile.avgAssignmentScore).toBe(85);
    expect(profile.avgChallengeScore).toBe(70);
  });

  test('empty score arrays -> null averages, not NaN or 0', () => {
    const profile = computeLearningProfile(base);
    expect(profile.avgAssignmentScore).toBeNull();
    expect(profile.avgChallengeScore).toBeNull();
  });

  test('collects strong/weak topics from subjectSummaries with subject attached', () => {
    const profile = computeLearningProfile({
      ...base,
      subjectSummaries: [{
        subject: 'Science',
        quizCount: 1,
        strongTopics: [{ topic: 'ch1_plants', avgScore: 80 }],
        weakTopics: [{ topic: 'ch2_rocks', avgScore: 40 }],
        topicDetails: [],
      }],
    });
    expect(profile.strongTopics[0]).toMatchObject({ topic: 'ch1_plants', subject: 'Science' });
    expect(profile.weakTopics[0]).toMatchObject({ topic: 'ch2_rocks', subject: 'Science' });
    expect(profile.riskFlags).toContain('weak_quiz_topics');
    expect(profile.positiveSignals).toContain('strong_quiz_topics');
  });
});

describe('humanizeTopic', () => {
  test('converts chapter-numbered raw topic keys to readable titles', () => {
    expect(humanizeTopic('ch1_numbers')).toBe('Chapter 1: Numbers');
    expect(humanizeTopic('ch12_fractions_and_decimals')).toBe('Chapter 12: Fractions And Decimals');
  });

  test('title-cases plain underscore-separated topics without a chapter prefix', () => {
    expect(humanizeTopic('photosynthesis_basics')).toBe('Photosynthesis Basics');
  });
});

describe('sanitizeReport', () => {
  test('strips banned self-esteem phrases from string fields', () => {
    const out = sanitizeReport({ whats_going_well: 'Shows strong grasp of the topic.' });
    expect(out.whats_going_well).not.toMatch(/strong grasp/i);
  });

  test('recurses into nested arrays and objects', () => {
    const out = sanitizeReport({
      subject_insights: [{ subject: 'Math', insight: 'Very hardworking student.' }],
    });
    expect(out.subject_insights[0].insight).not.toMatch(/hardworking/i);
  });

  test('humanizes raw chapter keys embedded in AI-written text', () => {
    const out = sanitizeReport({ message_to_child: 'Great job finishing ch3_geometry!' });
    expect(out.message_to_child).toContain('Chapter 3: Geometry');
  });

  test('leaves non-string, non-object values untouched', () => {
    expect(sanitizeReport(null)).toBeNull();
    expect(sanitizeReport(42)).toBe(42);
  });
});
