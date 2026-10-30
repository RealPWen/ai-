import { dataPath } from '../backend/src/runtime-config.mjs';
import { resolve } from 'node:path';
import { createTushareClient } from '../backend/market-data/tushare-client.mjs';
import { createForecastStore } from '../backend/market-data/forecast-store.mjs';
import { syncForecasts } from '../backend/market-data/forecast-sync.mjs';

const options = {}; let store;
try {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('用法：node --env-file-if-exists=.env scripts/sync-forecasts.mjs --start 20251014 --end 20261013 --mode sync|download|import [--refresh]');
  } else {
    for (let i = 0; i < args.length; i++) {
      const key = args[i];
      if (key === '--refresh') { if (options.refresh) throw new Error('invalid_arguments'); options.refresh = true; continue; }
      if (!['--start', '--end', '--mode'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--') || Object.hasOwn(options, key.slice(2))) throw new Error('invalid_arguments');
      options[key.slice(2)] = args[++i];
    }
    if (!options.start || !options.end || (options.mode && !['sync', 'download', 'import'].includes(options.mode))) throw new Error('invalid_arguments');
    const mode = options.mode ?? 'sync', client = mode === 'import' ? null : createTushareClient({ token: process.env.TUSHARE_TOKEN, intervalMs: 400 });
    if (mode !== 'download') store = createForecastStore({ connectionString: process.env.DATABASE_URL });
    const report = await syncForecasts({ client, store, mode, refresh: options.refresh ?? false, startDate: options.start, endDate: options.end,
      cacheDir: dataPath('market-data'), log: value => console.log(JSON.stringify(value)) });
    const { ranges, ...summary } = report; console.log(JSON.stringify({ type: 'forecast_summary', ...summary })); process.exitCode = report.status === 'completed' ? 0 : 2;
  }
} catch {
  console.error(JSON.stringify({ type: 'forecast_failed', kind: 'configuration_or_runtime', message: '请检查日期参数、Tushare 权限及数据库配置。' })); process.exitCode = 1;
} finally {
  if (store) { try { await store.close(); } catch { console.error(JSON.stringify({ type: 'forecast_failed', kind: 'database' })); process.exitCode = 1; } }
}
