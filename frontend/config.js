/** Public frontend configuration. Never put Tushare/OpenAI keys here. */
export const apiConfig = {
  enabled: false,
  baseUrl: '',
  timeoutMs: 12000,
  credentials: 'omit',
};

// Initial selection only. Users can switch to any ticker in the UI.
export const companyConfig = { defaultTicker: '002920.SZ' };
