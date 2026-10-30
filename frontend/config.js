/** Public frontend configuration. Never put Tushare/OpenAI keys here. */
export const apiConfig = {
  enabled: true,
  // The frontend server proxies /api to the local backend, including LAN visits.
  baseUrl: '',
  timeoutMs: 12000,
  generationTimeoutMs: 360000,
  credentials: 'omit',
};

// Initial selection only. Users can switch to any ticker in the UI.
export const companyConfig = { defaultTicker: '002920.SZ' };
