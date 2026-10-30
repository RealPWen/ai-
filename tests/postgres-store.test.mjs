import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarketStore, normalizeTradeDate } from '../backend/market-data/postgres-store.mjs';

function mockPool({ failOn, resultRows = [] } = {}) {
  const calls = [];
  const pool = {
    calls,
    released: 0,
    ended: false,
    async query(sql, values) {
      calls.push({ sql, values });
      if (failOn?.(sql, values)) {
        const error = new Error('raw provider or PostgreSQL secret must not escape');
        error.code = '08006';
        throw error;
      }
      return { rows: resultRows };
    },
    async connect() { return { query: pool.query.bind(pool), release() { pool.released++; } }; },
    async end() { pool.ended = true; },
  };
  return pool;
}

const aRow = (overrides = {}) => ({
  ts_code: '002920.SZ', trade_date: '20261013', open: 100.12, high: 103, low: 99,
  close: 102, pre_close: 100, change: 2, pct_chg: 2, vol: 10000, amount: 100000,
  ...overrides,
});
const day = (overrides = {}) => ({ market: 'A', apiName: 'daily', tradeDate: '20261013', rows: [aRow()], ...overrides });

test('store validates calendar dates independently of host timezone', () => {
  assert.deepEqual(normalizeTradeDate('20261013'), { compact: '20261013', iso: '2026-10-13' });
  assert.deepEqual(normalizeTradeDate('2024-02-29'), { compact: '20240229', iso: '2024-02-29' });
  for (const date of ['20260229', '2026-02-30', '20261301', '2026-1-01', '20261013Z', null]) {
    assert.throws(() => normalizeTradeDate(date), { code: 'VALIDATION_ERROR' });
  }
});

test('store migrates without destructive SQL and closes its pool', async () => {
  const pool = mockPool();
  const store = createMarketStore({ pool });
  await store.migrate();
  assert.equal(pool.calls[0].sql, 'BEGIN');
  assert.match(pool.calls[1].sql, /CREATE TABLE IF NOT EXISTS market_data.daily_prices/);
  assert.doesNotMatch(pool.calls[1].sql, /\b(?:DROP\s+(?:TABLE|SCHEMA|DATABASE)|TRUNCATE|DELETE)\b/);
  assert.equal(pool.calls.at(-1).sql, 'COMMIT');
  assert.equal(pool.released, 1);
  await store.close();
  assert.equal(pool.ended, true);
});

test('saveDay preserves raw A-share numbers and units in a parameterized transaction', async () => {
  const pool = mockPool();
  const store = createMarketStore({ pool });
  const result = await store.saveDay(day({ runId: 'import-20261014' }));
  assert.deepEqual(result, { market: 'A', apiName: 'daily', tradeDate: '20261013', rowsCount: 1 });
  const price = pool.calls.find(call => call.sql.includes('INSERT INTO market_data.daily_prices'));
  assert.match(price.sql, /ON CONFLICT \(ts_code, trade_date\) DO UPDATE/);
  assert.ok(!price.sql.includes('002920.SZ'));
  assert.deepEqual(price.values, ['002920.SZ', '2026-10-13', 'A', '100.12', '103', '99', '102', '100', '2', '2', '10000', '100000', 'tushare', 'daily', 'none', 'lot', 'thousand_cny', 'CNY']);
  const completion = pool.calls.find(call => call.sql.includes('INSERT INTO market_data.sync_days'));
  assert.deepEqual(completion.values, ['A', 'daily', '2026-10-13', 1, 'import-20261014']);
  assert.equal(pool.calls.at(-1).sql, 'COMMIT');
});

test('saveDay preserves HK share and HKD units, nullable fields, and decimal strings', async () => {
  const pool = mockPool();
  const store = createMarketStore({ pool });
  await store.saveDay(day({ market: 'HK', apiName: 'hk_daily', rows: [aRow({ ts_code: '00700.HK', open: '412.120000000001', pct_chg: null, vol: '1234567', amount: '987654321.01' })] }));
  const values = pool.calls.find(call => call.sql.includes('INSERT INTO market_data.daily_prices')).values;
  assert.equal(values[3], '412.120000000001');
  assert.equal(values[9], null);
  assert.deepEqual(values.slice(10), ['1234567', '987654321.01', 'tushare', 'hk_daily', 'none', 'share', 'hkd', 'HKD']);
});

test('saveDay deduplicates a response, and subsequent writes retain the upsert key', async () => {
  const pool = mockPool();
  const store = createMarketStore({ pool });
  const result = await store.saveDay(day({ rows: [aRow(), aRow({ close: 104 })] }));
  assert.equal(result.rowsCount, 1);
  assert.equal(pool.calls.find(call => call.sql.includes('INSERT INTO market_data.daily_prices')).values[6], '104');
  await store.saveDay(day());
  assert.equal(pool.calls.filter(call => call.sql.includes('ON CONFLICT (ts_code, trade_date)')).length, 2);
});

test('saveDay batches a full market response within parameter limits', async () => {
  const pool = mockPool();
  const store = createMarketStore({ pool });
  const rows = Array.from({ length: 1001 }, (_, i) => aRow({ ts_code: `${String(i).padStart(6, '0')}.SZ` }));
  const result = await store.saveDay(day({ rows }));
  const writes = pool.calls.filter(call => call.sql.includes('INSERT INTO market_data.daily_prices'));
  assert.equal(writes.length, 2);
  assert.equal(writes[0].values.length, 18000);
  assert.equal(writes[1].values.length, 18);
  assert.equal(result.rowsCount, 1001);
});

test('invalid dates, mismatched codes, and nonnumeric values fail before database work', async () => {
  const pool = mockPool();
  const store = createMarketStore({ pool });
  for (const request of [
    day({ market: 'US' }), day({ apiName: 'daily;DROP TABLE x' }),
    day({ tradeDate: '2026-02-30' }), day({ rows: [aRow({ ts_code: '00700.HK' })] }),
    day({ rows: [aRow({ trade_date: '20261012' })] }), day({ rows: [aRow({ vol: Infinity })] }),
    day({ rows: [aRow({ close: '1; DELETE' })] }), day({ rows: [aRow({ high: '' })] }),
  ]) await assert.rejects(store.saveDay(request), { code: 'VALIDATION_ERROR' });
  assert.equal(pool.calls.length, 0);
});

test('price write failure rolls back without marking the day completed or leaking raw messages', async () => {
  const pool = mockPool({ failOn: sql => sql.includes('INSERT INTO market_data.daily_prices') });
  const store = createMarketStore({ pool });
  await assert.rejects(store.saveDay(day()), error => {
    assert.equal(error.code, 'DATABASE_ERROR');
    assert.equal(error.sqlState, '08006');
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
  assert.equal(pool.calls.at(-1).sql, 'ROLLBACK');
  assert.ok(!pool.calls.some(call => call.sql.includes('INSERT INTO market_data.sync_days')));
  assert.ok(!pool.calls.some(call => call.sql === 'COMMIT'));
  assert.equal(pool.released, 1);
});

test('completion write failure rolls back prices as part of the same transaction', async () => {
  const pool = mockPool({ failOn: sql => sql.includes('INSERT INTO market_data.sync_days') });
  const store = createMarketStore({ pool });
  await assert.rejects(store.saveDay(day()), { code: 'DATABASE_ERROR' });
  assert.equal(pool.calls.at(-1).sql, 'ROLLBACK');
  assert.ok(!pool.calls.some(call => call.sql === 'COMMIT'));
});

test('an empty successful day is tracked without a malformed INSERT', async () => {
  const pool = mockPool();
  const store = createMarketStore({ pool });
  assert.equal((await store.saveDay(day({ rows: [] }))).rowsCount, 0);
  assert.ok(!pool.calls.some(call => call.sql.includes('INSERT INTO market_data.daily_prices')));
  assert.equal(pool.calls.find(call => call.sql.includes('INSERT INTO market_data.sync_days')).values[3], 0);
});

test('failed day recording stores only fixed error codes and preserves completed markers', async () => {
  const pool = mockPool();
  const store = createMarketStore({ pool });
  await store.markFailedDay({ market: 'A', apiName: 'daily', tradeDate: '20261013', errorCode: 'provider message token=do-not-store' });
  assert.deepEqual(pool.calls[0].values, ['A', 'daily', '2026-10-13', 'unknown_error']);
  assert.match(pool.calls[0].sql, /WHERE market_data.sync_days.status <> 'completed'/);
  await store.markFailedDay({ market: 'HK', apiName: 'hk_daily', tradeDate: '2026-10-13', errorCode: 'RATE_LIMITED' });
  assert.equal(pool.calls[1].values[3], 'rate_limited');
});

test('resume queries isolate daily progress from daily_basic valuations in the requested range', async () => {
  const pool = mockPool({ resultRows: [{ trade_date: '20261012' }, { trade_date: '20261013' }] });
  const store = createMarketStore({ pool });
  const dates = await store.getCompletedDays({ market: 'A', startDate: '20251014', endDate: '2026-10-13' });
  assert.deepEqual(dates, new Set(['20261012', '20261013']));
  assert.match(pool.calls[0].sql, /status = 'completed'/);
  assert.match(pool.calls[0].sql, /source_api = \$4/);
  assert.deepEqual(pool.calls[0].values, ['A', '2025-10-14', '2026-10-13', 'daily']);
  await store.getCompletedDays({ market: 'HK', startDate: '20251014', endDate: '20261013' });
  assert.equal(pool.calls[1].values[3], 'hk_daily');
  await assert.rejects(store.getCompletedDays({ market: 'A', startDate: '20261014', endDate: '20261013' }), { code: 'VALIDATION_ERROR' });
});

test('summary reports numeric market counts and aggregate market-day totals', async () => {
  const pool = mockPool({ resultRows: [
    { market: 'A', rows_count: '11000', ticker_count: '5500', trade_date_count: '2', min_date: '2026-10-12', max_date: '2026-10-13', completed_days: '2', failed_days: '0' },
    { market: 'HK', rows_count: '2600', ticker_count: '2600', trade_date_count: '1', min_date: '2026-10-13', max_date: '2026-10-13', completed_days: '1', failed_days: '1' },
  ] });
  const store = createMarketStore({ pool });
  const summary = await store.summary({ startDate: '20251014', endDate: '20261013' });
  assert.equal(summary.markets[0].rows_count, 11000);
  assert.deepEqual(summary.totals, { rows_count: 13600, ticker_count: 8100, trade_date_count: 3, completed_days: 3, failed_days: 1 });
  assert.equal(summary.startDate, '2025-10-14');
  assert.equal(summary.endDate, '2026-10-13');
});
