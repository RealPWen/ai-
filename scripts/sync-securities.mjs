import { dataPath } from '../backend/src/runtime-config.mjs';
import { pathToFileURL } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { createTushareClient } from '../backend/market-data/tushare-client.mjs';
import { normalizeTradeDate } from '../backend/market-data/postgres-store.mjs';

const directory = pathToFileURL(dataPath('market-data/securities') + '/');
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 });
let connected = false;
try {
  if (!process.env.DATABASE_URL || !process.env.TUSHARE_TOKEN) throw new Error('configuration');
  const tushare = createTushareClient({ token: process.env.TUSHARE_TOKEN, intervalMs: 500 });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const records = [];
  let unsupportedCodes = 0;
  for (const status of ['L', 'D', 'P']) {
    const path = new URL(`${status}.json`, directory);
    let cached;
    if (!process.argv.includes('--refresh')) {
      try { cached = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!cached) {
      const rows = await tushare.queryAll('stock_basic', { list_status: status }, 'ts_code,name,industry,list_date,delist_date,list_status', { pageSize: 6000, maxPages: 20 });
      cached = { source: 'tushare', api: 'stock_basic', listStatus: status, fetchedAt: new Date().toISOString(), rows };
      await writeFile(path, JSON.stringify(cached), { mode: 0o600 });
    }
    if (cached.api !== 'stock_basic' || cached.listStatus !== status || !Array.isArray(cached.rows)) throw new Error('invalid_cache');
    for (const row of cached.rows) {
      if (typeof row.ts_code !== 'string' || typeof row.name !== 'string' || !row.name.trim() || row.list_status !== status) throw new Error('invalid_security');
      // Old delisting records may use prefixed aliases such as T600018.SH.
      // The current A-share price API uses six-digit exchange-qualified codes.
      if (!/^\d{6}\.(SH|SZ|BJ)$/.test(row.ts_code)) { unsupportedCodes += 1; continue; }
      records.push({ ...row, listDate: row.list_date ? normalizeTradeDate(row.list_date).iso : null, delistDate: row.delist_date ? normalizeTradeDate(row.delist_date).iso : null });
    }
    console.log(JSON.stringify({ listStatus: status, records: cached.rows.length }));
  }
  await client.connect(); connected = true;
  await client.query('BEGIN');
  await client.query(await readFile(new URL('../backend/market-data/schema.sql', import.meta.url), 'utf8'));
  for (let offset = 0; offset < records.length; offset += 500) {
    const batch = records.slice(offset, offset + 500);
    const placeholders = batch.map((_, index) => `(${Array.from({ length: 8 }, (__, column) => `$${index * 8 + column + 1}`).join(',')})`).join(',');
    await client.query(`INSERT INTO market_data.securities (ts_code,name,market,industry,list_date,delist_date,list_status,source) VALUES ${placeholders}
      ON CONFLICT (ts_code) DO UPDATE SET name=EXCLUDED.name,industry=EXCLUDED.industry,list_date=EXCLUDED.list_date,delist_date=EXCLUDED.delist_date,list_status=EXCLUDED.list_status,source=EXCLUDED.source,fetched_at=now()`,
    batch.flatMap(row => [row.ts_code, row.name.trim(), 'A', row.industry || null, row.listDate, row.delistDate, row.list_status, 'tushare']));
  }
  await client.query('COMMIT');
  const coverage = await client.query("SELECT count(*)::int AS securities,count(*) FILTER (WHERE s.name IS NOT NULL)::int AS named FROM (SELECT DISTINCT ts_code FROM market_data.daily_prices WHERE market='A') p LEFT JOIN market_data.securities s USING(ts_code)");
  console.log(JSON.stringify({ status: 'completed', referenceRecords: records.length, unsupportedHistoricalAliases: unsupportedCodes, priceCoverage: coverage.rows[0] }));
} catch (error) {
  if (connected) { try { await client.query('ROLLBACK'); } catch {} }
  console.error(JSON.stringify({ status: 'failed', code: error.kind || error.code || 'SECURITIES_SYNC_FAILED', message: error.kind ? error.message : '股票资料同步失败，请检查数据库配置及缓存格式。' }));
  process.exitCode = 1;
} finally { await client.end(); }
