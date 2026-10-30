import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Relative overrides are project-relative, independent of the scheduler's cwd.
export function dataRoot(env = process.env) {
  return resolve(PROJECT_ROOT, env.COMPANY_RESEARCH_DATA_ROOT?.trim() || 'backend/storage');
}

export const dataPath = (...parts) => resolve(dataRoot(), ...parts);
export const isTideOS = (env = process.env) => /^(true|1)$/i.test(env.COMPANY_RESEARCH_TIDEOS ?? '');
export const automaticUpdatesEnabled = (name, env = process.env) => !isTideOS(env) && env[name] !== 'false';

export function marketRuntimeOptions(env = process.env) {
  return {
    connectionString: env.DATABASE_URL, token: env.TUSHARE_TOKEN,
    hkProvider: env.HK_PRICE_PROVIDER || 'eastmoney', hkPriceScope: env.HK_PRICE_SCOPE || 'pool',
    hkForecastScope: env.HK_FORECAST_SCOPE || 'all', hkValuationScope: env.HK_VALUATION_SCOPE || 'all',
    hkValuationEnabled: env.HK_VALUATION_AUTO_UPDATE_ENABLED !== 'false',
    hkForecastEnabled: env.HK_FORECAST_AUTO_UPDATE_ENABLED !== 'false',
    newsEnabled: env.CLS_NEWS_AUTO_UPDATE_ENABLED !== 'false',
    cacheDir: resolve(dataRoot(env), 'market-data'),
  };
}
