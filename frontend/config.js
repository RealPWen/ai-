/** Public frontend configuration. Never put Tushare/OpenAI keys here. */
// config.js is served beside index.html, including beneath a TideOS mount path.
const moduleUrl = new URL('.', import.meta.url);
const mountPath = moduleUrl.protocol === 'file:' ? '' : moduleUrl.pathname.replace(/\/$/, '');
export const apiPath = path => `${mountPath}/${path.replace(/^\//, '')}`;
export const apiConfig = {
  enabled: true,
  // The frontend server proxies /api to the local backend, including LAN visits.
  baseUrl: mountPath,
  timeoutMs: 12000,
  generationTimeoutMs: 360000,
  credentials: 'same-origin',
};

// Initial selection only. Users can switch to any ticker in the UI.
export const companyConfig = { defaultTicker: '002920.SZ' };
