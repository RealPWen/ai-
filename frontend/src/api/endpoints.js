/** API paths and backend parameter names belong here, independent of page components. */
export const endpoints = {
  profile: ({ ticker }) => ({ path: '/api/stocks/profile', query: { ticker } }),
  stocks: ({ q, limit, market = 'all' }) => ({ path: '/api/stocks', query: { q, limit, market } }),
  quote: ({ ticker, asOf }) => ({ path: '/api/market/quote', query: { ticker, asOf } }),
  prices: ({ ticker, asOf, period, adjustment, benchmark }) => {
    const hongKong = /^\d{5}\.HK$/.test(ticker);
    return { path: '/api/market/prices', query: { ticker, asOf, period, adjustment: adjustment ?? (hongKong ? 'none' : 'qfq'),
      benchmark: benchmark ?? (hongKong ? 'hsi' : 'sw2021_l3') } };
  },
  attributions: ({ ticker, asOf }) => ({ path: '/api/market/attribution', query: { ticker, asOf } }),
  attributionGenerate: '/api/market/attribution/generate',
  attributionJob: ({ jobId }) => ({ path: `/api/market/attribution/jobs/${encodeURIComponent(jobId)}` }),
  // This GET only reads saved research; it never starts a paid generation.
  debates: ({ ticker }) => ({ path: '/api/debates', query: { ticker } }),
  debatesGenerate: '/api/debates/generate',
  authStatus: '/api/auth/status',
  authStart: '/api/auth/chatgpt/start',
  authLogout: '/api/auth/logout',
  authModels: '/api/auth/models',
  authTest: '/api/auth/test',
  forecasts: ({ ticker, asOf }) => ({ path: '/api/forecasts', query: { ticker, asOf } }),
  relations: ({ ticker, asOf }) => ({ path: '/api/relations', query: { ticker, asOf } }),
  relationsManual: '/api/relations/manual',
  relationsResearch: '/api/relations/research',
  bands: ({ ticker, asOf, period = '1y' }) => ({ path: '/api/market/bands', query: { ticker, asOf, period } }),
  events: ({ ticker, asOf, category = '公司', limit = 20, offset = 0 }) => ({ path: '/api/events', query: { ticker, asOf, category, limit, offset } }),
};
