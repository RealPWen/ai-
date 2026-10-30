import test from 'node:test';
import assert from 'node:assert/strict';
import { createForecastStore, validateForecastRows, forecastIdentity, FORECAST_FIELDS } from '../backend/market-data/forecast-store.mjs';

const row = (overrides = {}) => ({ ...Object.fromEntries(FORECAST_FIELDS.split(',').map(key => [key, null])), ts_code: '002920.SZ', name: '德赛西威', report_date: '20261013', report_title: '公司跟踪', org_name: '甲证券', author_name: null, quarter: '2027Q4', eps: '3.123456789', np: 10000, pe: -2.1, rating: '买入', imp_dg: '普通关注度', create_time: '2026-10-13 10:20:30', ...overrides });
function mockPool({ failOn, resultRows = [] } = {}) {
  const calls = [];
  const pool = { calls, released: 0,
    async query(sql, values) { calls.push({ sql, values }); if (failOn?.(sql)) throw Object.assign(new Error('postgres://secret:password@host'), { code: '08006' }); return { rows: resultRows }; },
    async connect() { return { query: pool.query, release() { pool.released++; } }; }, async end() {},
  }; return pool;
}
test('forecast validation accepts empty calendar ranges, nullable fields, signed EPS and distinct broker/author/forecast periods', () => {
  assert.deepEqual(validateForecastRows([], '20261001', '20261031'), []);
  const rows = [row(), row({ org_name: '乙证券' }), row({ author_name: '分析师' }), row({ quarter: '2028Q4', eps: -1.4 }), row({ report_title: '另一篇报告', eps: null })];
  assert.equal(validateForecastRows(rows, '20261001', '20261031').length, 5);
  assert.equal(validateForecastRows([row({ org_name: null, quarter: null, eps: null })], '20261013', '20261013').length, 1);
});
test('forecast identity survives numeric corrections and includes every report author/classification/period field', () => {
  const source = row(), identity = forecastIdentity(source);
  assert.match(identity, /^[a-f0-9]{64}$/);
  assert.equal(identity, forecastIdentity(row({ eps: 9.99, np: 3, pe: 2 })));
  for (const change of [{ ts_code: '600519.SH' }, { report_date: '20261012' }, { org_name: '乙证券' }, { author_name: '某分析师' }, { report_title: '另一报告' }, { report_type: '更新' }, { classify: '公司' }, { quarter: '2028Q4' }, { create_time: '2026-10-14 00:00:00' }]) assert.notEqual(identity, forecastIdentity(row(change)));
  assert.equal(identity, forecastIdentity(row({ report_date: '2026-10-13' })));
});
test('identical duplicate observations are explicit; conflicting same-identity observations are rejected', () => {
  const validated = validateForecastRows([row(), { ...row() }], '20261001', '20261031');
  assert.equal(validated.length, 1); assert.equal(validated[0].duplicateCount, 2); assert.deepEqual(validated[0].row, row());
  assert.throws(() => validateForecastRows([row(), row({ eps: 8 })], '20261001', '20261031'), { code: 'VALIDATION_ERROR' });
});
test('forecast validation rejects non A shares, missing fields, date escapes, malformed types and nonfinite numbers', () => {
  const missing = row(); delete missing.eps;
  for (const rows of [null, [missing], [row({ ts_code: '00700.HK' })], [row({ report_date: '20261032' })], [row({ report_date: '20260930' })], [row({ eps: Infinity })], [row({ eps: '' })], [row({ org_name: 123 })], [row({ np: 'secret' })]]) assert.throws(() => validateForecastRows(rows, '20261001', '20261031'), { code: 'VALIDATION_ERROR' });
});
test('forecast additive migration creates raw observations and independent zero-row completion ledger', async () => {
  const pool = mockPool(); await createForecastStore({ pool }).migrate();
  const sql = pool.calls[1].sql;
  assert.match(sql, /CREATE TABLE IF NOT EXISTS market_data.sell_side_forecasts/); assert.match(sql, /raw_data jsonb/); assert.match(sql, /source_create_time text/);
  assert.match(sql, /forecast_sync_ranges/); assert.doesNotMatch(sql, /\b(?:DROP|TRUNCATE|DELETE)\b/); assert.equal(pool.calls.at(-1).sql, 'COMMIT');
});
test('forecast save preserves raw JSON, decimal source precision and fetched time using parameterized upsert', async () => {
  const pool = mockPool(), store = createForecastStore({ pool }), source = row({ report_title: "x'); DROP TABLE test; --" }), fetchedAt = '2026-10-14T01:02:03.000Z';
  const saved = await store.saveRange({ startDate: '20261001', endDate: '20261031', rows: [source, { ...source }], fetchedAt });
  assert.deepEqual(saved, { startDate: '20261001', endDate: '20261031', rowsCount: 1, rawRowsCount: 2, duplicateRows: 1 });
  const write = pool.calls.find(call => call.sql.includes('INSERT INTO market_data.sell_side_forecasts'));
  assert.match(write.sql, /ON CONFLICT \(forecast_id\) DO UPDATE/); assert.doesNotMatch(write.sql, /DROP TABLE test/);
  assert.equal(write.values[0], forecastIdentity(source)); assert.equal(write.values[10], '3.123456789'); assert.equal(write.values[16], source.create_time);
  assert.deepEqual(JSON.parse(write.values[19]), source); assert.equal(write.values[20], 2); assert.equal(write.values[21], fetchedAt); assert.equal(write.values[22], 2);
  const completed = pool.calls.find(call => call.sql.includes('INSERT INTO market_data.forecast_sync_ranges'));
  assert.deepEqual(completed.values, ['2026-10-01', '2026-10-31', 1, 2, null]); assert.equal(pool.calls.at(-1).sql, 'COMMIT'); assert.equal(pool.released, 1);
});
test('forecast save can complete an empty report range without inserting fabricated rows', async () => {
  const pool = mockPool(); const saved = await createForecastStore({ pool }).saveRange({ startDate: '20261010', endDate: '20261011', rows: [] });
  assert.equal(saved.rowsCount, 0); assert.ok(!pool.calls.some(call => call.sql.includes('INSERT INTO market_data.sell_side_forecasts')));
  const ledger = pool.calls.find(call => call.sql.includes('INSERT INTO market_data.forecast_sync_ranges')); assert.equal(ledger.values[2], 0); assert.equal(ledger.values[3], 0); assert.equal(pool.calls.at(-1).sql, 'COMMIT');
});
test('forecast write and completion failures each roll back the whole partition and hide connection strings', async () => {
  for (const target of ['INSERT INTO market_data.sell_side_forecasts', 'INSERT INTO market_data.forecast_sync_ranges']) {
    const pool = mockPool({ failOn: sql => sql.includes(target) });
    await assert.rejects(createForecastStore({ pool }).saveRange({ startDate: '20261001', endDate: '20261031', rows: [row()] }), error => error.code === 'DATABASE_ERROR' && error.sqlState === '08006' && !/secret|password/.test(error.message));
    assert.equal(pool.calls.at(-1).sql, 'ROLLBACK'); assert.ok(!pool.calls.some(call => call.sql === 'COMMIT'));
  }
});
test('forecast conflicts and invalid fetchedAt fail before database transaction', async () => {
  const pool = mockPool(), store = createForecastStore({ pool });
  await assert.rejects(store.saveRange({ startDate: '20261001', endDate: '20261031', rows: [row(), row({ eps: 10 })] }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(store.saveRange({ startDate: '20261001', endDate: '20261031', rows: [row()], fetchedAt: 'not-date' }), { code: 'VALIDATION_ERROR' });
  assert.equal(pool.calls.length, 0);
});
test('forecast resume includes completed empty ranges and filters the independent report API ledger', async () => {
  const pool = mockPool({ resultRows: [{ start_date: '20261010', end_date: '20261011' }] });
  const ranges = await createForecastStore({ pool }).getCompletedRanges({ startDate: '20251014', endDate: '20261013' });
  assert.deepEqual(ranges, new Set(['20261010-20261011'])); assert.match(pool.calls[0].sql, /source_api = 'report_rc'/); assert.doesNotMatch(pool.calls[0].sql, /rows_count > 0/);
});
test('forecast failed ledger uses fixed error codes and cannot overwrite completed ranges', async () => {
  const pool = mockPool(); await createForecastStore({ pool }).markFailedRange({ startDate: '20261001', endDate: '20261031', errorCode: 'token=secret' });
  assert.equal(pool.calls[0].values[2], 'unknown_error'); assert.match(pool.calls[0].sql, /WHERE market_data.forecast_sync_ranges.status <> 'completed'/);
});
test('forecast summary converts count types and uses report dates instead of trading dates', async () => {
  const pool = mockPool({ resultRows: [{ rows_count: '12', ticker_count: '2', broker_count: '3', report_date_count: '4', eps_count: '10', min_date: '2026-10-10', max_date: '2026-10-13' }] });
  const summary = await createForecastStore({ pool }).summary({ startDate: '20261001', endDate: '20261031' });
  assert.equal(summary.rows_count, 12); assert.equal(summary.eps_count, 10); assert.equal(summary.market, 'A'); assert.match(pool.calls[0].sql, /report_date BETWEEN/);
});

test('source create_time versions remain separate observations even with identical report fields', () => {
  const versions = [row({ create_time: '2026-01-18 18:08:22' }), row({ create_time: '2026-01-19 18:08:22' })];
  assert.equal(validateForecastRows(versions, '20261001', '20261031').length, 2);
  assert.notEqual(forecastIdentity(versions[0]), forecastIdentity(versions[1]));
});
test('v1 identity migration rekeys through Node hashes in the schema transaction without changing source rows or counts', async () => {
  const legacy = { forecast_id: 'a'.repeat(64), ...row() }, calls = []; let selected = false;
  const pool = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('WHERE identity_version = 1')) { if (!selected) { selected = true; return { rows: [legacy] }; } return { rows: [] }; }
      return { rows: [] };
    },
    async connect() { return { query: pool.query, release() {} }; }, async end() {},
  };
  await createForecastStore({ pool }).migrate();
  const rekey = calls.find(call => call.sql.includes('SET forecast_id = migrated.new_id'));
  assert.deepEqual(rekey.values, [legacy.forecast_id, forecastIdentity(legacy)]);
  assert.match(rekey.sql, /identity_version = 2/); assert.doesNotMatch(rekey.sql, /raw_data|eps|np|DELETE/);
  assert.equal(calls[0].sql, 'BEGIN'); assert.equal(calls.at(-1).sql, 'COMMIT');
});
