import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HK_SECURITY_FIELDS, validateHkSecurities } from './hk-securities-store.mjs';
import { validateHongKongUniverse } from './hk-pool-universe.mjs';

function invalid() { const e = new Error('港股名单资料或缓存无效。'); e.kind = 'validation'; return e; }
async function json(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw invalid(); }
}

/** Reference collection is restricted to the workbook pool, including refreshes. */
export async function syncHkPoolSecurities({ universe, client, store, cacheDir, mode = 'sync', refresh = false }) {
  const { tickers: selectedTickers, universeHash: hash } = validateHongKongUniverse(universe);
  if (!['sync', 'download', 'import'].includes(mode)) throw invalid();
  if (mode !== 'download' && !store) throw invalid();
  const tickers = [...selectedTickers].sort();
  const directory = join(cacheDir, 'securities', 'HK');
  const path = join(directory, `pool-${hash}.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let snapshot = !refresh || mode === 'import' ? await json(path) : null;
  if (!snapshot && (!refresh || mode === 'import')) {
    const previous = await json(join(directory, 'snapshot.json'));
    if (previous?.source === 'tushare' && previous.apiName === 'hk_basic' && previous.status === 'completed') {
      snapshot = { version: 1, source: 'tushare', apiName: 'hk_basic', universeHash: hash,
        fetchedAt: previous.fetchedAt, rows: previous.rows?.filter(s => tickers.includes(s.ts_code)) };
    }
  }
  const cached = !!snapshot;
  if (!snapshot) {
    if (mode === 'import' || !client) throw invalid();
    const rows = [];
    for (const ticker of tickers) {
      const result = await client.query('hk_basic', { ts_code: ticker }, HK_SECURITY_FIELDS);
      if (result.length !== 1 || result[0].ts_code !== ticker) throw invalid();
      rows.push(...validateHkSecurities(result));
    }
    snapshot = { version: 1, source: 'tushare', apiName: 'hk_basic', universeHash: hash, fetchedAt: new Date().toISOString(), rows };
  }
  if (snapshot.version !== 1 || snapshot.universeHash !== hash || snapshot.source !== 'tushare'
    || snapshot.apiName !== 'hk_basic' || !Number.isFinite(Date.parse(snapshot.fetchedAt))) throw invalid();
  const rows = validateHkSecurities(snapshot.rows);
  if (rows.length !== tickers.length || rows.some(s => !tickers.includes(s.ts_code))) throw invalid();
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify({ ...snapshot, rows })}\n`, { mode: 0o600 });
  await rename(temp, path);
  if (mode !== 'download') {
    await store.migrate();
    await store.upsertSecurities({ rows, fetchedAt: snapshot.fetchedAt });
  }
  return { status: 'completed', market: 'HK', scope: 'workbook_pool', mode, cached, referenceRecords: rows.length,
    importedRecords: mode === 'download' ? 0 : rows.length, fetchedAt: snapshot.fetchedAt };
}
