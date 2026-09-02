// Pure deterministic signal computation for the parent AI Progress Report.
// Ported from ai-mentor/server/routes/parent.js's computeLearningProfile,
// kept dependency-free (no Supabase/Groq) so it's directly unit-testable.

function computeLearningProfile(data) {
  const {
    completedTopics, assignmentsDone, challengesCompleted,
    streak, activeDays, studyMinutes, subjectSummaries,
    assignmentScores, challengeScores,
  } = data;

  const hasQuizScores = subjectSummaries.some(s => s.quizCount > 0);
  const totalTopics = completedTopics.length;

  let learningPattern;
  if (totalTopics === 0 && assignmentsDone === 0) {
    learningPattern = 'just_started';
  } else if (totalTopics >= 5 && assignmentsDone === 0 && !hasQuizScores) {
    learningPattern = 'broad_explorer';
  } else if (hasQuizScores && assignmentsDone >= 2) {
    learningPattern = 'active_learner';
  } else if (assignmentsDone >= 3 && totalTopics < 5) {
    learningPattern = 'assignment_focused';
  } else {
    learningPattern = 'developing';
  }

  let consistencySignal;
  if (streak >= 7 && activeDays >= 10) consistencySignal = 'highly_consistent';
  else if (streak >= 3 && activeDays >= 5) consistencySignal = 'building_habit';
  else if (activeDays >= 3) consistencySignal = 'occasional';
  else consistencySignal = 'irregular';

  const strongTopics = [], weakTopics = [], mediumTopics = [];
  for (const s of subjectSummaries) {
    for (const t of s.strongTopics) strongTopics.push({ ...t, subject: s.subject });
    for (const t of s.weakTopics) weakTopics.push({ ...t, subject: s.subject });
    for (const t of s.topicDetails) {
      if (t.avgScore != null && t.avgScore >= 60 && t.avgScore < 75) {
        mediumTopics.push({ ...t, subject: s.subject });
      }
    }
  }

  const riskFlags = [];
  if (assignmentsDone === 0) riskFlags.push('no_assignments');
  if (consistencySignal === 'irregular') riskFlags.push('irregular_study');
  if (weakTopics.length > 0) riskFlags.push('weak_quiz_topics');
  if (!hasQuizScores && totalTopics >= 3) riskFlags.push('unassessed');

  const positiveSignals = [];
  if (strongTopics.length > 0) positiveSignals.push('strong_quiz_topics');
  if (streak >= 3) positiveSignals.push('active_streak');
  if (totalTopics >= 10) positiveSignals.push('broad_coverage');
  if (challengesCompleted > 0) positiveSignals.push('challenge_taker');
  if (assignmentsDone >= 3) positiveSignals.push('assignment_completer');

  return {
    learningPattern, consistencySignal, hasQuizScores,
    strongTopics, weakTopics, mediumTopics,
    riskFlags, positiveSignals,
    totalTopics, assignmentsDone, challengesCompleted,
    streak, activeDays, studyMinutes,
    subjectSummaries,
    avgAssignmentScore: assignmentScores.length
      ? Math.round(assignmentScores.reduce((a, b) => a + b, 0) / assignmentScores.length) : null,
    avgChallengeScore: challengeScores.length
      ? Math.round(challengeScores.reduce((a, b) => a + b, 0) / challengeScores.length) : null,
  };
}

function humanizeTopic(raw) {
  const chMatch = String(raw).match(/^ch(\d+)[_\s](.+)$/i);
  if (chMatch) {
    const title = chMatch[2].replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    return `Chapter ${chMatch[1]}: ${title}`;
  }
  return String(raw).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

const BANNED_PHRASES = [
  'problem-solving skills', 'problem solving skills',
  'communication skills', 'creative approach',
  'positive attitude', 'keen interest', 'social skills',
  'enthusiasm for learning', 'love of learning', 'passion for learning',
  'natural curiosity', 'strong grasp', 'excellent understanding',
  'talented', 'hardworking', 'dedicated learner', 'bright student',
  'exceptional', 'remarkable talent', 'outstanding ability',
];

function sanitizeText(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  out = out.replace(/\bch(\d+)[_\s]([a-z][a-z0-9_]*)/gi, (_, num, rest) => {
    const title = rest.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    return `Chapter ${num}: ${title}`;
  });
  for (const phrase of BANNED_PHRASES) {
    const re = new RegExp(phrase.replace(/[-()]/g, '\\$&'), 'gi');
    out = out.replace(re, 'consistent effort');
  }
  return out;
}

function sanitizeReport(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeReport);
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = typeof v === 'string' ? sanitizeText(v) : sanitizeReport(v);
  }
  return result;
}

module.exports = { computeLearningProfile, humanizeTopic, sanitizeReport, BANNED_PHRASES };
