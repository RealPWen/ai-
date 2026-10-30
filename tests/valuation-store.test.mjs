import test from 'node:test';
import assert from 'node:assert/strict';
import { createValuationStore, validateValuationRows } from '../backend/market-data/valuation-store.mjs';
const row = (overrides = {}) => ({ ts_code: '002920.SZ', trade_date: '20261013', close: 76.96, pe: null, pe_ttm: 30.4, pb: 4.2, total_mv: 2200000, circ_mv: 1900000, turnover_rate: 0.5, total_share: 30000, float_share: 27000, ...overrides });
function mockPool({ failOn, resultRows = [] } = {}) {
  const calls = [];
  const pool = { calls, released: 0,
    async query(sql, values) { calls.push({ sql, values }); if (failOn?.(sql)) { const error = new Error('postgres://secret:password@host'); error.code = '08006'; throw error; } return { rows: resultRows }; },
    async connect() { return { query: pool.query, release() { pool.released++; } }; }, async end() {},
  }; return pool;
}
test('valuation validation requires all columns, unique A-share keys, matching dates and finite values while preserving nulls', () => {
  assert.deepEqual(validateValuationRows([row({ pe_ttm: null, pb: null, close: null })], '20261013'), [row({ pe_ttm: null, pb: null, close: null })]);
  assert.equal(validateValuationRows([row({ pe: -3, pb: -1, close: '76.9600001' })], '20261013').length, 1);
  const missing = row(); delete missing.pb;
  for (const rows of [[], [missing], [row(), row()], [row({ ts_code: '00700.HK' })], [row({ trade_date: '20261012' })], [row({ pe_ttm: Infinity })], [row({ close: -1 })], [row({ turnover_rate: -1 })], [row({ pe_ttm: '' })]]) assert.throws(() => validateValuationRows(rows, '20261013'), { code: 'VALIDATION_ERROR' });
});
test('valuation migration is additive and documents raw units', async () => {
  const pool = mockPool(), store = createValuationStore({ pool }); await store.migrate();
  assert.equal(pool.calls[0].sql, 'BEGIN'); assert.match(pool.calls[1].sql, /CREATE TABLE IF NOT EXISTS market_data.daily_valuations/);
  assert.match(pool.calls[1].sql, /ten thousand CNY/); assert.match(pool.calls[1].sql, /NULL/); assert.doesNotMatch(pool.calls[1].sql, /\b(?:DROP|TRUNCATE|DELETE)\b/); assert.equal(pool.calls.at(-1).sql, 'COMMIT');
});
test('valuation save keeps null and decimal source values and commits data and API-specific completion atomically', async () => {
  const pool = mockPool(), store = createValuationStore({ pool });
  const result = await store.saveDay({ tradeDate: '20261013', rows: [row({ close: '76.96000001', pe_ttm: null })] });
  assert.equal(result.rowsCount, 1);
  const write = pool.calls.find(call => call.sql.includes('INSERT INTO market_data.daily_valuations'));
  assert.match(write.sql, /ON CONFLICT \(ts_code, trade_date\) DO UPDATE/);
  assert.deepEqual(write.values, ['002920.SZ', '2026-10-13', 'A', '76.96000001', null, null, '4.2', '2200000', '1900000', '0.5', '30000', '27000', 'tushare', 'daily_basic']);
  const completed = pool.calls.find(call => call.sql.includes('INSERT INTO market_data.sync_days'));
  assert.deepEqual(completed.values, ['A', 'daily_basic', '2026-10-13', 1, null]); assert.equal(pool.calls.at(-1).sql, 'COMMIT'); assert.equal(pool.released, 1);
});
test('valuation save rejects empty/duplicate/missing-column days before opening transaction', async () => {
  const pool = mockPool(), store = createValuationStore({ pool }); const missing = row(); delete missing.pe;
  for (const rows of [[], [row(), row()], [missing]]) await assert.rejects(store.saveDay({ tradeDate: '20261013', rows }), { code: 'VALIDATION_ERROR' });
  assert.equal(pool.calls.length, 0);
});
test('valuation write failure rolls back, does not complete the day and hides DSN', async () => {
  const pool = mockPool({ failOn: sql => sql.includes('INSERT INTO market_data.daily_valuations') }), store = createValuationStore({ pool });
  await assert.rejects(store.saveDay({ tradeDate: '20261013', rows: [row()] }), error => error.code === 'DATABASE_ERROR' && error.sqlState === '08006' && !/secret|password/.test(error.message));
  assert.equal(pool.calls.at(-1).sql, 'ROLLBACK'); assert.ok(!pool.calls.some(call => call.sql.includes('INSERT INTO market_data.sync_days')));
});
test('valuation completion failure rolls back the whole transaction', async () => {
  const pool = mockPool({ failOn: sql => sql.includes('INSERT INTO market_data.sync_days') }), store = createValuationStore({ pool });
  await assert.rejects(store.saveDay({ tradeDate: '20261013', rows: [row()] }), { code: 'DATABASE_ERROR' });
  assert.equal(pool.calls.at(-1).sql, 'ROLLBACK'); assert.ok(!pool.calls.some(call => call.sql === 'COMMIT'));
});
test('valuation resume explicitly filters daily_basic so ordinary daily completion cannot skip valuations', async () => {
  const pool = mockPool({ resultRows: [{ trade_date: '20261013' }] }), store = createValuationStore({ pool });
  const days = await store.getCompletedDays({ startDate: '20251014', endDate: '20261013' });
  assert.deepEqual(days, new Set(['20261013'])); assert.match(pool.calls[0].sql, /source_api = \$2/); assert.match(pool.calls[0].sql, /rows_count > 0/);
  assert.deepEqual(pool.calls[0].values, ['A', 'daily_basic', '2025-10-14', '2026-10-13']);
});
test('valuation failure ledger permits only fixed errors and preserves completed dates', async () => {
  const pool = mockPool(), store = createValuationStore({ pool });
  await store.markFailedDay({ tradeDate: '20261013', errorCode: 'token=secret' });
  assert.equal(pool.calls[0].values[3], 'unknown_error'); assert.equal(pool.calls[0].values[1], 'daily_basic'); assert.match(pool.calls[0].sql, /WHERE market_data.sync_days.status <> 'completed'/);
});
test('valuation summary separates source API and converts counts', async () => {
  const pool = mockPool({ resultRows: [{ market: 'A', rows_count: '2', ticker_count: '2', trade_date_count: '1', pe_ttm_count: '1', pb_count: '2', completed_days: '1', failed_days: '0' }] });
  const summary = await createValuationStore({ pool }).summary({ startDate: '20261013', endDate: '20261013' });
  assert.equal(summary.totals.pe_ttm_count, 1); assert.equal(summary.totals.rows_count, 2); assert.match(pool.calls[0].sql, /source_api = 'daily_basic'/);
});
