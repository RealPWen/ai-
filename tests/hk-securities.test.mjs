import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHkSecuritiesStore, validateHkSecurities, HK_SECURITY_FIELDS } from '../backend/market-data/hk-securities-store.mjs';
import { syncHkSecurities } from '../backend/market-data/security-sync.mjs';
import { createTushareClient } from '../backend/market-data/tushare-client.mjs';

const security = (overrides = {}) => ({ ts_code: '00700.HK', name: ' 腾讯控股 ', list_date: '20040616', delist_date: null, list_status: 'L', ...overrides });
const fetchedAt = '2026-10-19T10:00:00.000Z';

async function fixture(t) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'hk-securities-')); t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const queries = [], imported = [];
  const client = { async queryAll(api, params, fields, options) {
    queries.push({ api, params, fields, options });
    return params.list_status === 'L' ? [security()] : params.list_status === 'D'
      ? [security({ ts_code: '00001.HK', list_status: 'D', list_date: '', delist_date: '20250101' })] : [];
  } };
  const store = { migrations: 0, async migrate() { this.migrations++; }, async upsertSecurities(request) { imported.push(request); } };
  return { cacheDir, client, store, queries, imported, path: join(cacheDir, 'securities', 'HK', 'snapshot.json') };
}

test('HK reference sync completes all statuses and supports cache-only offline import', async t => {
  const f = await fixture(t);
  const downloaded = await syncHkSecurities({ ...f, store: null, mode: 'download' });
  assert.equal(downloaded.status, 'completed'); assert.equal(downloaded.referenceRecords, 2); assert.equal(downloaded.importedRecords, 0);
  assert.deepEqual(downloaded.statusCounts, { L: 1, D: 1, P: 0 });
  assert.deepEqual(f.queries.map(q => q.params.list_status), ['L', 'D', 'P']);
  for (const query of f.queries) {
    assert.equal(query.api, 'hk_basic'); assert.equal(query.fields, HK_SECURITY_FIELDS);
    assert.equal(query.options.pageSize, 6000); assert.deepEqual(query.options.primaryKey, ['ts_code']);
  }
  assert.equal(f.store.migrations, 0);
  const imported = await syncHkSecurities({ ...f, client: null, mode: 'import' });
  assert.equal(imported.cached, true); assert.equal(imported.importedRecords, 2); assert.equal(f.store.migrations, 1);
  assert.equal(f.imported[0].rows[0].name, '腾讯控股'); assert.equal(f.imported[0].rows[0].list_date, '2004-06-16');
  assert.equal(f.imported[0].rows[1].list_date, null); assert.equal(f.queries.length, 3);
});

test('failed refresh preserves the last complete snapshot and cannot publish partial status lists', async t => {
  const f = await fixture(t); await syncHkSecurities({ ...f, mode: 'download', store: null });
  const before = await readFile(f.path, 'utf8');
  f.client.queryAll = async (_, params) => {
    if (params.list_status === 'D') throw Object.assign(new Error('token secret'), { kind: 'permission' });
    return [security({ name: '新名称' })];
  };
  await assert.rejects(syncHkSecurities({ ...f, refresh: true }), { kind: 'permission' });
  assert.equal(await readFile(f.path, 'utf8'), before); assert.equal(f.imported.length, 0); assert.equal(f.store.migrations, 0);
});

test('known HK delisted aliases remain in the source audit snapshot and never overwrite reused canonical tickers', async t => {
  const f = await fixture(t);
  const aliases = [security({ ts_code: '00700!.HK', name: '旧公司', list_status: 'D', delist_date: '20000101', list_date: '19900101' }),
    security({ ts_code: '02121!AE.HK', name: '已退市公司', list_status: 'D', delist_date: '20250101' })];
  f.client.queryAll = async (_, params) => params.list_status === 'L' ? [security()] : params.list_status === 'D' ? aliases : [];
  const report = await syncHkSecurities(f);
  assert.equal(report.sourceRecords, 3); assert.equal(report.referenceRecords, 1); assert.equal(report.unsupportedHistoricalAliases, 2);
  assert.deepEqual(report.statusCounts, { L: 1, D: 2, P: 0 });
  const snapshot = JSON.parse(await readFile(f.path));
  assert.equal(snapshot.sourceRows.length, 3); assert.deepEqual(snapshot.sourceRows.slice(1), aliases);
  assert.equal(snapshot.sourceRows[0].name, ' 腾讯控股 ');
  assert.deepEqual(f.imported[0].rows.map(row => row.ts_code), ['00700.HK']);
  assert.equal((await syncHkSecurities({ ...f, mode: 'import', client: null })).unsupportedHistoricalAliases, 2);
  for (const code of ['00013!FOO.HK', '00013!!.HK', 'T00013.HK']) assert.throws(() => validateHkSecurities([security({ ts_code: code, list_status: 'D' })], { allowHistoricalAliases: true }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => validateHkSecurities([security({ ts_code: '00013!.HK' })], { allowHistoricalAliases: true }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(createHkSecuritiesStore({ pool: mockPool() }).upsertSecurities({ rows: aliases, fetchedAt }), { code: 'VALIDATION_ERROR' });
});

test('invalid or incomplete caches never reach database migration', async t => {
  const f = await fixture(t);
  await assert.rejects(syncHkSecurities({ ...f, mode: 'import', client: null }), { kind: 'validation' });
  await syncHkSecurities({ ...f, mode: 'download', store: null });
  const valid = JSON.parse(await readFile(f.path, 'utf8'));
  for (const changes of [
    { market: 'A' }, { apiName: 'stock_basic' }, { completedStatuses: ['L', 'D'] }, { fetchedAt: 'invalid' },
    { statusCounts: { L: 2, D: 1, P: 0 } }, { rows: [valid.rows[0], valid.rows[0]] },
    { sourceRecords: 999 }, { unsupportedHistoricalAliases: 1 }, { sourceRows: [valid.sourceRows[0]] },
  ]) {
    await writeFile(f.path, JSON.stringify({ ...valid, ...changes }));
    await assert.rejects(syncHkSecurities({ ...f, mode: 'import', client: null }), { kind: 'validation' });
  }
  assert.equal(f.store.migrations, 0); assert.equal(f.imported.length, 0);
});

test('empty in-market response, cross-status duplicates, and invalid provider fields cannot be cached', async t => {
  for (const rowsFor of [
    () => [],
    status => [security({ list_status: status })],
    status => status === 'L' ? [security({ list_date: '20260230' })] : [],
    status => status === 'L' ? [security({ ts_code: '700.HK' })] : [],
    () => [security({ list_status: 'D' })],
  ]) {
    const f = await fixture(t); f.client.queryAll = async (_, params) => rowsFor(params.list_status);
    await assert.rejects(syncHkSecurities(f), { code: 'VALIDATION_ERROR' });
    await assert.rejects(readFile(f.path), { code: 'ENOENT' }); assert.equal(f.imported.length, 0);
  }
  assert.throws(() => validateHkSecurities([security({ list_date: '2026-10-19', delist_date: '20200101' })]), { code: 'VALIDATION_ERROR' });
});

test('HK reference pagination continues after a short provider page until terminal empty response', async t => {
  const f = await fixture(t), offsets = [];
  const client = createTushareClient({ token: 'test', intervalMs: 0, maxRetries: 0, fetchImpl: async (_, request) => {
    const { api_name: api, params } = JSON.parse(request.body); assert.equal(api, 'hk_basic'); offsets.push([params.list_status, params.offset]);
    const rows = params.list_status === 'L' && params.offset < 2 ? [security({ ts_code: params.offset === 0 ? '00700.HK' : '00005.HK' })] : [];
    const fields = HK_SECURITY_FIELDS.split(',');
    return { status: 200, async json() { return { code: 0, data: { fields, items: rows.map(row => fields.map(field => row[field])) } }; } };
  } });
  const report = await syncHkSecurities({ ...f, client, mode: 'download', store: null });
  assert.equal(report.referenceRecords, 2); assert.deepEqual(offsets, [['L', 0], ['L', 1], ['L', 2], ['D', 0], ['P', 0]]);
});

function mockPool(failOn) {
  const calls = [];
  const pool = { calls, released: 0, async query(sql, values) {
    calls.push({ sql, values }); if (failOn?.(sql, values)) throw Object.assign(new Error('postgres://secret'), { code: '08006' });
    return { rows: [] };
  }, async connect() { return { query: pool.query.bind(pool), release() { pool.released++; } }; }, async end() {} };
  return pool;
}

test('HK upsert uses a single parameterized transaction, explicit market and null industry', async () => {
  const pool = mockPool(), store = createHkSecuritiesStore({ pool });
  const result = await store.upsertSecurities({ rows: [security()], fetchedAt });
  assert.deepEqual(result, { market: 'HK', rowsCount: 1 });
  assert.equal(pool.calls[0].sql, 'BEGIN'); assert.equal(pool.calls.at(-1).sql, 'COMMIT');
  const insert = pool.calls.find(call => call.sql.startsWith('INSERT INTO market_data.securities'));
  assert.match(insert.sql, /ON CONFLICT \(ts_code\) DO UPDATE/); assert.doesNotMatch(insert.sql, /00700.HK|腾讯/);
  assert.deepEqual(insert.values, ['00700.HK', '腾讯控股', 'HK', null, '2004-06-16', null, 'L', 'tushare', fetchedAt]);
  assert.equal(pool.released, 1);
});

test('HK batched reference writes roll back together and redact database exception messages', async () => {
  let inserts = 0; const pool = mockPool(sql => sql.startsWith('INSERT') && ++inserts === 2), store = createHkSecuritiesStore({ pool });
  const rows = Array.from({ length: 501 }, (_, index) => security({ ts_code: `${String(index).padStart(5, '0')}.HK` }));
  await assert.rejects(store.upsertSecurities({ rows, fetchedAt }), error => {
    assert.equal(error.code, 'DATABASE_ERROR'); assert.equal(error.sqlState, '08006'); assert.doesNotMatch(error.message, /secret/); return true;
  });
  assert.equal(pool.calls.at(-1).sql, 'ROLLBACK'); assert.ok(!pool.calls.some(call => call.sql === 'COMMIT')); assert.equal(pool.released, 1);
});

test('invalid HK securities fail before any database transaction', async () => {
  const pool = mockPool(), store = createHkSecuritiesStore({ pool });
  for (const rows of [[], [security(), security()], [security({ ts_code: '600000.SH' })], [security({ name: '' })], [security({ list_status: 'X' })]]) {
    await assert.rejects(store.upsertSecurities({ rows, fetchedAt }), { code: 'VALIDATION_ERROR' });
  }
  assert.equal(pool.calls.length, 0);
});

test('HK reference CLI exposes help and rejects malformed arguments without disclosing secrets', () => {
  const script = fileURLToPath(new URL('../scripts/sync-hk-securities.mjs', import.meta.url));
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.match(help.stdout, /sync\|download\|import/);
  const invalid = spawnSync(process.execPath, [script, '--mode', 'bad'], { encoding: 'utf8', env: { ...process.env, TUSHARE_TOKEN: 'test-secret', DATABASE_URL: 'postgres://secret' } });
  assert.equal(invalid.status, 1); assert.match(invalid.stderr, /configuration_or_runtime/); assert.doesNotMatch(invalid.stderr, /postgres:\/\/|test-secret/);
});
