import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHkPoolStore, HK_POOL_LOCK_KEYS, normalizeHkPoolRange, validateHkPoolRows } from '../backend/market-data/hk-pool-store.mjs';
import { validateHongKongUniverse } from '../backend/market-data/hk-pool-universe.mjs';

const universe = validateHongKongUniverse({ version: 1, source: { path: '/workbook.xlsx', sheet: '合并价值投资池' },
  securities: [{ ticker: '00700.HK', name: '腾讯', row: 2 }, { ticker: '00941.HK', name: '中国移动', row: 3 }] });
const options = { runDate: '2026-10-19', windowStart: '20251019', windowEnd: '20261018', universeHash: universe.universeHash,
  tickers: universe.tickers, source: 'eastmoney', apiName: 'eastmoney_hk_daily' };
const running = { ...options, windowStart: '2025-10-19', windowEnd: '2026-10-18', status: 'running' };
const row = { ts_code: '00700.HK', trade_date: '20261016', open: '10.20', high: '10.40', low: '10.10', close: '10.30',
  pre_close: '10.10', change: '0.20', pct_chg: '1.98', vol: '1000200', amount: '10302060.25' };
function mockPool({ locked = true, run = running, missing = false, baseline = { baselineDate: '20251017' },
  ranges = [{ startDate: options.windowStart, endDate: options.windowEnd, rowsCount: 245 }], failOn } = {}) {
  const calls = [], releases = [], clients = [];
  return { calls, releases, clients,
    async connect() {
      const client = new EventEmitter();
      client.query = async (sql, values) => {
        calls.push({ sql, values });
        if (failOn?.(sql)) throw Object.assign(new Error('private-password@host'), { code: '08006' });
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked }] };
        if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
        if (sql.startsWith('SELECT') && sql.includes('FROM market_data.hk_pool_update_runs')) return { rows: run ? [run] : [] };
        if (sql.startsWith('SELECT') && sql.includes('FROM market_data.hk_pool_symbol_ranges')) return { rows: missing ? [] : ranges };
        if (sql.startsWith('SELECT') && sql.includes('FROM market_data.hk_pool_symbol_baselines')) return { rows: baseline ? [baseline] : [] };
        return { rows: [], rowCount: 2 };
      };
      client.release = error => releases.push(error); clients.push(client); return client;
    },
    end: async () => {},
  };
}
const range = { ...options, ticker: '00700.HK', startDate: options.windowStart, endDate: options.windowEnd, rows: [row] };

test('schema additive migration defines pool/provider run identity and per-ticker coverage without global sync_days', async () => {
  const pool = mockPool(); await createHkPoolStore({ pool }).migrate();
  const schema = pool.calls.find(call => call.sql.includes('CREATE TABLE IF NOT EXISTS market_data.hk_pool_update_runs')).sql;
  assert.match(schema, /PRIMARY KEY \(run_date, universe_hash, source, source_api\)/);
  assert.match(schema, /PRIMARY KEY \(universe_hash, ts_code, source, source_api, range_start, range_end\)/);
  assert.match(schema, /'running', 'succeeded', 'partial', 'failed'/);
  assert.doesNotMatch(schema, /CREATE TABLE.*sync_days/); assert.doesNotMatch(schema, /\b(?:DELETE|TRUNCATE)\b|DROP\s+TABLE/);
  assert.match(schema, /pg_get_constraintdef\(oid\) ~ '\\m366\\M'/);
  assert.match(schema, /ALTER TABLE %s DROP CONSTRAINT %I/);
  assert.match(schema, /window_end - window_start < 400/);
  assert.match(schema, /range_end - range_start < 400/);
  assert.match(schema, /rows_count >= 0 AND rows_count <= 400/);
  assert.equal(pool.calls[0].sql, 'BEGIN'); assert.equal(pool.calls.at(-1).sql, 'COMMIT');
});

test('buffered annual ranges allow up to 400 days while rejecting larger windows and duplicate or out-of-window rows', () => {
  const buffered = { ticker: row.ts_code, startDate: '20250919', endDate: '20261018' };
  assert.equal(normalizeHkPoolRange(buffered.startDate, buffered.endDate).start.compact, '20250919');
  assert.equal(validateHkPoolRows([{ ...row, trade_date: '20251017' }], buffered).length, 1);
  assert.equal(normalizeHkPoolRange('20250914', '20261018').start.compact, '20250914');
  assert.throws(() => normalizeHkPoolRange('20250913', '20261018'), { code: 'VALIDATION_ERROR' });
  assert.throws(() => validateHkPoolRows(Array(401).fill(row), buffered), { code: 'VALIDATION_ERROR' });
  assert.throws(() => validateHkPoolRows([row, row], buffered), { code: 'VALIDATION_ERROR' });
  assert.throws(() => validateHkPoolRows([{ ...row, trade_date: '20250918' }], buffered), { code: 'VALIDATION_ERROR' });
});

test('pool uses its own session lock, rejects released scope and handles connection errors safely', async () => {
  const pool = mockPool(), store = createHkPoolStore({ pool }); let scope;
  await store.withLock(value => { scope = value; });
  assert.deepEqual(pool.calls[0].values, HK_POOL_LOCK_KEYS);
  await assert.rejects(scope.getRun(options), { code: 'VALIDATION_ERROR' });
  const failed = mockPool(), failedStore = createHkPoolStore({ pool: failed });
  await assert.rejects(failedStore.withLock(async () => {
    failed.clients[0].emit('error', new Error('private-password@host')); return {};
  }), error => error.code === 'DATABASE_ERROR' && !/private-password|host/.test(error.message));
  assert.equal(failed.releases[0].code, 'DATABASE_ERROR'); assert.equal(failed.clients[0].listenerCount('error'), 0);
  const busy = mockPool({ locked: false });
  assert.deepEqual(await createHkPoolStore({ pool: busy }).withLock(() => assert.fail('busy')), { status: 'busy' });
  assert.equal(busy.calls.length, 1);
});

test('symbol observations and complete range commit in one transaction, preserving exact decimal strings/source', async () => {
  const pool = mockPool();
  await createHkPoolStore({ pool }).withLock(scope => scope.saveRange(range));
  const prices = pool.calls.find(call => call.sql.startsWith('INSERT INTO market_data.daily_prices'));
  assert.equal(prices.values[0], '00700.HK'); assert.equal(prices.values[1], '2026-10-16'); assert.equal(prices.values[2], 'HK');
  assert.ok(prices.values.includes('10.30')); assert.ok(prices.values.includes('10302060.25'));
  assert.deepEqual(prices.values.slice(-6), ['eastmoney', 'eastmoney_hk_daily', 'none', 'share', 'hkd', 'HKD']);
  const ledger = pool.calls.find(call => call.sql.startsWith('INSERT INTO market_data.hk_pool_symbol_ranges'));
  assert.deepEqual(ledger.values, [universe.universeHash, 'eastmoney', 'eastmoney_hk_daily', '00700.HK', '2025-10-19', '2026-10-18', 1]);
  assert.ok(pool.calls.findIndex(call => call.sql === 'BEGIN') < pool.calls.indexOf(prices));
  assert.ok(pool.calls.indexOf(ledger) < pool.calls.findIndex(call => call.sql === 'COMMIT'));
  assert.equal(pool.calls.some(call => call.sql.includes('sync_days')), false);
});

test('range ledger write failure rolls price inserts back, with no global day completion or deletion', async () => {
  const pool = mockPool({ failOn: sql => sql.startsWith('INSERT INTO market_data.hk_pool_symbol_ranges') });
  await assert.rejects(createHkPoolStore({ pool }).withLock(scope => scope.saveRange(range)), { code: 'DATABASE_ERROR' });
  assert.ok(pool.calls.some(call => call.sql.startsWith('INSERT INTO market_data.daily_prices')));
  assert.equal(pool.calls.at(-2).sql, 'ROLLBACK'); assert.equal(pool.calls.some(call => call.sql === 'COMMIT' || call.sql.startsWith('DELETE')), false);
});

test('source-specific row count verifies coverage so changing price provider invalidates old range', async () => {
  const pool = mockPool();
  await createHkPoolStore({ pool }).withLock(scope => scope.getRanges(range));
  const query = pool.calls.find(call => call.sql.includes('FROM market_data.hk_pool_symbol_ranges'));
  assert.match(query.sql, /rows_count = \(SELECT count\(\*\) FROM market_data\.daily_prices/);
  assert.match(query.sql, /prices\.source = coverage\.source AND prices\.source_api = coverage\.source_api/);
  assert.match(query.sql, /prices\.trade_date BETWEEN coverage\.range_start AND coverage\.range_end/);
  assert.deepEqual(query.values, [universe.universeHash, 'eastmoney', 'eastmoney_hk_daily', '00700.HK', '2025-10-19', '2026-10-18']);
});

test('finalize verifies every ticker before scoped retention, compacts annual coverage after pruning, commits outcome atomically', async () => {
  const pool = mockPool();
  const result = await createHkPoolStore({ pool }).withLock(scope => scope.finalize({ ...options, summary: { completedTickers: 2 } }));
  assert.equal(result.deleted.daily_prices, 2);
  const deletes = pool.calls.filter(call => call.sql.startsWith('DELETE'));
  assert.equal(deletes.length, 2);
  assert.match(deletes[0].sql, /market = 'HK' AND trade_date < \$1/);
  assert.match(deletes[0].sql, /ts_code = ANY\(\$2::text\[\]\) AND source = \$3 AND source_api = \$4/);
  assert.match(deletes[0].sql, /trade_date IS DISTINCT FROM \(SELECT max\(prior.trade_date\)/);
  assert.deepEqual(deletes[0].values, ['2025-10-19', universe.tickers, 'eastmoney', 'eastmoney_hk_daily']);
  assert.match(deletes[1].sql, /universe_hash = \$1 AND source = \$2 AND source_api = \$3/);
  assert.deepEqual(deletes[1].values, [universe.universeHash, 'eastmoney', 'eastmoney_hk_daily', universe.tickers]);
  const coverage = pool.calls.filter(call => call.sql.startsWith('SELECT') && call.sql.includes('FROM market_data.hk_pool_symbol_ranges'));
  assert.equal(coverage.length, 2); assert.ok(pool.calls.indexOf(coverage.at(-1)) < pool.calls.indexOf(deletes[0]));
  const rebuilt = pool.calls.filter(call => call.sql.startsWith('INSERT INTO market_data.hk_pool_symbol_ranges'));
  assert.equal(rebuilt.length, 2); assert.ok(pool.calls.indexOf(rebuilt[0]) > pool.calls.indexOf(deletes[0]));
  assert.match(rebuilt[0].sql, /count\(\*\) FROM market_data\.daily_prices/);
  assert.deepEqual(rebuilt[0].values.slice(-2), ['2025-10-19', '2026-10-18']);
  const success = pool.calls.find(call => call.sql.startsWith('UPDATE market_data.hk_pool_update_runs'));
  assert.match(success.sql, /status='succeeded'/); assert.ok(pool.calls.indexOf(success) > pool.calls.indexOf(rebuilt.at(-1)));
  assert.equal(pool.calls.at(-2).sql, 'COMMIT'); assert.equal(pool.calls.some(call => call.sql.includes('sync_days')), false);
});

test('incomplete ticker or failed retention cannot authorize successful outcome', async () => {
  const missing = mockPool({ missing: true });
  await assert.rejects(createHkPoolStore({ pool: missing }).withLock(scope => scope.finalize(options)), { kind: 'incomplete_window' });
  assert.equal(missing.calls.some(call => call.sql.startsWith('DELETE')), false);
  const noBaseline = mockPool({ baseline: null });
  await assert.rejects(createHkPoolStore({ pool: noBaseline }).withLock(scope => scope.finalize(options)), { kind: 'incomplete_window' });
  assert.equal(noBaseline.calls.some(call => call.sql.startsWith('DELETE')), false);
  const failure = mockPool({ failOn: sql => sql.startsWith('UPDATE market_data.hk_pool_update_runs') });
  await assert.rejects(createHkPoolStore({ pool: failure }).withLock(scope => scope.finalize(options)), { code: 'DATABASE_ERROR' });
  assert.equal(failure.calls.at(-2).sql, 'ROLLBACK'); assert.equal(failure.calls.some(call => call.sql === 'COMMIT'), false);
});

test('annual finalization retains exactly the preceding real price without expanding annual coverage to the lookup window', async () => {
  const pool = mockPool();
  await createHkPoolStore({ pool }).withLock(scope => scope.finalize(options));
  const deletion = pool.calls.find(call => call.sql.startsWith('DELETE FROM market_data.daily_prices'));
  assert.equal(deletion.values[0], '2025-10-19');
  assert.match(deletion.sql, /prior\.ts_code=expired\.ts_code AND prior\.source=expired\.source AND prior\.source_api=expired\.source_api/);
  assert.match(deletion.sql, /prior\.trade_date < \$1 AND prior\.close > 0/);
  const rebuilt = pool.calls.filter(call => call.sql.startsWith('INSERT INTO market_data.hk_pool_symbol_ranges'));
  assert.ok(rebuilt.every(call => call.values.at(-2) === '2025-10-19'));
  assert.ok(pool.calls.some(call => call.sql.startsWith('UPDATE market_data.hk_pool_update_runs') && call.sql.includes("status='succeeded'")));
});

test('baseline checkpoint saves one preceding price atomically and never creates annual range coverage', async () => {
  const pool = mockPool();
  await createHkPoolStore({ pool }).withLock(async scope => {
    await scope.saveBaseline({ ...options, ticker: row.ts_code, startDate: '20250919', endDate: '20251018', rows: [{ ...row, trade_date: '20251017' }] });
    await scope.getBaseline({ ...options, ticker: row.ts_code });
  });
  const price = pool.calls.find(call => call.sql.startsWith('INSERT INTO market_data.daily_prices'));
  assert.equal(price.values[1], '2025-10-17');
  assert.ok(pool.calls.some(call => call.sql.startsWith('INSERT INTO market_data.hk_pool_symbol_baselines')));
  assert.equal(pool.calls.some(call => call.sql.startsWith('INSERT INTO market_data.hk_pool_symbol_ranges')), false);
  const checked = pool.calls.find(call => call.sql.startsWith('SELECT') && call.sql.includes('FROM market_data.hk_pool_symbol_baselines'));
  assert.match(checked.sql, /baseline_date IS NOT DISTINCT FROM \(SELECT max\(prices.trade_date\)/);
  const invalid = mockPool();
  await assert.rejects(createHkPoolStore({ pool: invalid }).withLock(scope => scope.saveBaseline({ ...options, ticker: row.ts_code,
    startDate: '20250919', endDate: '20251018', rows: [{ ...row, trade_date: '20251016' }, { ...row, trade_date: '20251017' }] })), { code: 'VALIDATION_ERROR' });
  assert.equal(invalid.calls.some(call => call.sql.startsWith('INSERT')), false);
});

test('cannot save a ticker outside current pool; safe failed/partial states and explicit stale-success reopening', async () => {
  const pool = mockPool(), store = createHkPoolStore({ pool });
  await store.withLock(async scope => {
    await assert.rejects(scope.saveRange({ ...range, ticker: '00005.HK', rows: [{ ...row, ts_code: '00005.HK' }] }), { code: 'VALIDATION_ERROR' });
    await scope.beginRun({ ...options, reopen: true });
    await scope.failRun({ ...options, partial: true, errorCode: 'private token', summary: { completedTickers: 1 } });
  });
  assert.equal(pool.calls.some(call => call.sql.startsWith('INSERT INTO market_data.daily_prices')), false);
  const begin = pool.calls.find(call => call.sql.startsWith('INSERT INTO market_data.hk_pool_update_runs'));
  assert.match(begin.sql, /status <> 'succeeded' OR \$8::boolean/); assert.equal(begin.values[7], true);
  const fail = pool.calls.find(call => call.sql.startsWith('UPDATE market_data.hk_pool_update_runs'));
  assert.equal(fail.values[4], 'partial'); assert.equal(fail.values[5], 'provider_error');
});
