import { resolve } from 'node:path';
import { createTushareClient } from '../backend/market-data/tushare-client.mjs';
import { createMarketStore } from '../backend/market-data/postgres-store.mjs';
import { syncDailyData } from '../backend/market-data/sync.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((value, index, values) => value.startsWith('--') ? [value.slice(2), values[index + 1]] : null).filter(Boolean));
if (process.argv.includes('--help')) {
  console.log('用法：npm run data:sync -- --start 20251014 --end 20261013 --markets A --mode sync|download|import；港股仅维护投资池，请用 npm run data:update -- --markets HK。');
  process.exit(0);
}
let store;
try {
  if (!args.start || !args.end) throw new Error('请显式指定 --start YYYYMMDD 和 --end YYYYMMDD。');
  const mode = args.mode || 'sync';
  const markets = (args.markets || 'A').split(',').map(value => value.trim().toUpperCase());
  if (markets.includes('HK')) {
    const error = new Error('港股仅维护投资池，请使用 npm run data:update -- --markets HK。'); error.kind = 'validation'; throw error;
  }
  const client = mode === 'import' ? null : createTushareClient({ token: process.env.TUSHARE_TOKEN, intervalMs: 400 });
  if (mode !== 'download') store = createMarketStore({ connectionString: process.env.DATABASE_URL });
  const report = await syncDailyData({ client, store, mode, markets, startDate: args.start, endDate: args.end,
    cacheDir: resolve('backend/storage/market-data'), log: value => console.log(JSON.stringify(value)) });
  console.log(JSON.stringify({ type: 'summary', ...report }));
  process.exitCode = report.status === 'completed' ? 0 : 2;
} catch (error) {
  // Only local fixed messages and known classifications; no upstream causes or DSNs.
  console.error(JSON.stringify({ type: 'failed', code: error.code || error.kind || 'sync_error', message: error.code === 'DATABASE_ERROR' ? 'PostgreSQL 连接或写入失败，请检查应用权限与连接配置。' : error.kind ? error.message : '请检查日期参数、Token 和数据库配置。' }));
  process.exitCode = 1;
} finally { if (store) await store.close(); }
