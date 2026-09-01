// Chainable Supabase mock, same pattern as aivorah-teacher-dashboard-service's,
// extended with write methods (upsert/update/insert/delete) since this service
// writes to Supabase (create/link/remove/promote students), unlike the
// read-only dashboard service this pattern was copied from.
function makeSupabaseMock() {
  const tableResponses = {};
  const tableCallCounts = {};

  function nextResponseFor(table) {
    const configured = tableResponses[table];
    if (configured === undefined) return { data: null, error: null };
    if (Array.isArray(configured)) {
      const i = tableCallCounts[table] || 0;
      tableCallCounts[table] = i + 1;
      return configured[Math.min(i, configured.length - 1)];
    }
    return configured;
  }

  function makeChain(table) {
    const chain = {
      select: jest.fn(() => chain),
      eq: jest.fn(() => chain),
      or: jest.fn(() => chain),
      in: jest.fn(() => chain),
      not: jest.fn(() => chain),
      neq: jest.fn(() => chain),
      order: jest.fn(() => chain),
      limit: jest.fn(() => chain),
      gte: jest.fn(() => chain),
      lte: jest.fn(() => chain),
      upsert: jest.fn(() => chain),
      update: jest.fn(() => chain),
      insert: jest.fn(() => chain),
      delete: jest.fn(() => chain),
      single: jest.fn(() => Promise.resolve(nextResponseFor(table))),
      maybeSingle: jest.fn(() => Promise.resolve(nextResponseFor(table))),
      then: (resolve, reject) => Promise.resolve(nextResponseFor(table)).then(resolve, reject),
    };
    return chain;
  }

  const supabase = {
    from: jest.fn((table) => makeChain(table)),
  };

  return {
    supabase,
    setTable(table, response) { tableResponses[table] = response; },
    reset() {
      Object.keys(tableResponses).forEach(k => delete tableResponses[k]);
      Object.keys(tableCallCounts).forEach(k => delete tableCallCounts[k]);
    },
  };
}

module.exports = { makeSupabaseMock };
