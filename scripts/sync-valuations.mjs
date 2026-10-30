import { dataPath } from '../backend/src/runtime-config.mjs';
import { resolve } from 'node:path';
import { createTushareClient } from '../backend/market-data/tushare-client.mjs';
import { createValuationStore } from '../backend/market-data/valuation-store.mjs';
import { syncValuations } from '../backend/market-data/valuation-sync.mjs';

const options = {};
let store;
try {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('用法：node --env-file-if-exists=.env scripts/sync-valuations.mjs --start 20251014 --end 20261013 --mode sync|download|import');
  } else {
    for (let i = 0; i < args.length; i += 2) {
      if (!['--start', '--end', '--mode'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || Object.hasOwn(options, args[i].slice(2))) throw new Error('invalid_arguments');
      options[args[i].slice(2)] = args[i + 1];
    }
    if (!options.start || !options.end || (options.mode && !['sync', 'download', 'import'].includes(options.mode))) throw new Error('invalid_arguments');
    const mode = options.mode ?? 'sync';
    const client = mode === 'import' ? null : createTushareClient({ token: process.env.TUSHARE_TOKEN, intervalMs: 400 });
    if (mode !== 'download') store = createValuationStore({ connectionString: process.env.DATABASE_URL });
    const report = await syncValuations({ client, store, mode, startDate: options.start, endDate: options.end,
      cacheDir: dataPath('market-data'), log: value => console.log(JSON.stringify(value)) });
    const { days, ...summary } = report;
    console.log(JSON.stringify({ type: 'valuation_summary', ...summary })); process.exitCode = report.status === 'completed' ? 0 : 2;
  }
} catch {
  // Never print exception messages / connection strings / tokens.
  console.error(JSON.stringify({ type: 'valuation_failed', kind: 'configuration_or_runtime', message: '请检查日期参数、Tushare 权限及数据库配置。' })); process.exitCode = 1;
} finally {
  if (store) { try { await store.close(); } catch { console.error(JSON.stringify({ type: 'valuation_failed', kind: 'database' })); process.exitCode = 1; } }
}
