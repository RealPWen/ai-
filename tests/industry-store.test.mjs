import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndustryStore, createAdjustmentStore, validateIndustries, validateMembers, validateClassification, validateL2Membership, validateL2Members, validateL2MembersSnapshot, validateIndexDailyRows, validateAdjustmentRows } from '../backend/market-data/industry-store.mjs';

const date = '20261013', fetchedAt = '2026-10-14T02:00:00.000Z';
const industry = (overrides = {}) => ({ index_code: '850731.SI', industry_name: '汽车电子', parent_code: '801093.SI', industry_code: '730103', level: 'L3', src: 'SW2021', is_pub: 1, ...overrides });
const l2Industry = (overrides = {}) => industry({ index_code: '801093.SI', industry_name: '汽车零部件', parent_code: '801880.SI', industry_code: '730100', level: 'L2', ...overrides });
const member = (overrides = {}) => ({ ts_code: '002920.SZ', name: '德赛西威', l1_code: '801880.SI', l1_name: '汽车', l2_code: '801093.SI', l2_name: '汽车零部件', l3_code: '850731.SI', l3_name: '汽车电子', in_date: '20211213', out_date: null, is_new: 'Y', ...overrides });
const index = (overrides = {}) => ({ ts_code: '850731.SI', trade_date: date, open: 100, high: 110, low: 98, close: 105, pct_change: -0.5, vol: null, amount: 800, ...overrides });
const factor = (overrides = {}) => ({ ts_code: '002920.SZ', trade_date: date, adj_factor: 2.1, ...overrides });
const snapshot = (overrides = {}) => ({ industries: [industry()], members: [member()], fetchedAt, completedCodes: ['850731.SI'], ...overrides });
function mockPool({ failOn, rows = [] } = {}) {
  const calls = [], pool = { calls, released: 0,
    async query(sql, values) { calls.push({ sql, values }); if (failOn?.(sql)) throw Object.assign(new Error('postgres://password-secret@host'), { code: '08006' }); return { rows }; },
    async connect() { return { query: pool.query, release() { pool.released++; } }; }, async end() {},
  }; return pool;
}

test('industry schema adds independent L2 directory without relaxing L3 constraints or removing existing data', async () => {
  const pool = mockPool(); await createIndustryStore({ pool }).migrate();
  assert.equal(pool.calls[0].sql, 'BEGIN'); const sql = pool.calls[1].sql;
  for (const table of ['sw_industries', 'sw_industries_l2', 'sw_industry_members', 'sw_industry_members_l2', 'sw_index_daily', 'stock_adj_factors']) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS market_data\\.${table}`));
  assert.match(sql, /PRIMARY KEY \(ts_code, l2_code, l3_code\)/);
  assert.match(sql, /DEFAULT 'L2' CHECK \(level = 'L2'\)/); assert.match(sql, /DEFAULT 'L3' CHECK \(level = 'L3'\)/); assert.match(sql, /sw_industry_members_l2_idx/);
  assert.match(sql, /PRIMARY KEY \(ts_code, l3_code\)/); assert.match(sql, /adj_factor > 0/); assert.match(sql, /not a historical classification/); assert.doesNotMatch(sql, /\b(?:DROP|DELETE|TRUNCATE)\b/); assert.equal(pool.calls.at(-1).sql, 'COMMIT');
});
test('L2 directory and membership validation checks every member label, preserving strict default L3 validation', () => {
  assert.equal(validateIndustries([l2Industry({ is_pub: '0' })], { level: 'L2' })[0].is_pub, false);
  assert.equal(validateL2Membership([l2Industry()], [member()]).length, 1);
  for (const rows of [[member({ l2_code: '801095.SI' })], [member({ l2_name: '乘用车' })], [member(), null]]) assert.throws(() => validateL2Membership([l2Industry()], rows), { code: 'VALIDATION_ERROR' });
  assert.throws(() => validateIndustries([l2Industry()]), { code: 'VALIDATION_ERROR' });
  assert.throws(() => validateIndustries([industry()], { level: 'L2' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => validateIndustries([industry()], { level: 'L1' }), { code: 'VALIDATION_ERROR' });
});
test('L2 directory replacement is independently validated, atomic, and leaves L3 member and price tables alone', async () => {
  const pool = mockPool(), store = createIndustryStore({ pool });
  assert.deepEqual(await store.replaceL2Classification({ industries: [l2Industry({ is_pub: '0' })], fetchedAt }), { industries: 1, fetchedAt });
  assert.equal(pool.calls[0].sql, 'BEGIN'); assert.equal(pool.calls[1].sql, 'DELETE FROM market_data.sw_industries_l2');
  const write = pool.calls.find(call => call.sql.startsWith('INSERT INTO market_data.sw_industries_l2'));
  assert.equal(write.values[2], false); assert.equal(write.values[4], 'L2'); assert.equal(write.values.at(-1), fetchedAt); assert.equal(pool.calls.at(-1).sql, 'COMMIT');
  assert.ok(pool.calls.every(call => !/sw_industry_members|daily_prices|sw_index_daily|sw_industries \(/.test(call.sql)));
  const invalidPool = mockPool(); await assert.rejects(createIndustryStore({ pool: invalidPool }).replaceL2Classification({ industries: [industry()], fetchedAt }), { code: 'VALIDATION_ERROR' }); assert.equal(invalidPool.calls.length, 0);
});
test('L2 directory insertion failure rolls back old complete directory deletion', async () => {
  const pool = mockPool({ failOn: sql => sql.startsWith('INSERT INTO market_data.sw_industries_l2') });
  await assert.rejects(createIndustryStore({ pool }).replaceL2Classification({ industries: [l2Industry()], fetchedAt }), error => error.code === 'DATABASE_ERROR' && !/secret/.test(error.message));
  assert.equal(pool.calls.at(-1).sql, 'ROLLBACK'); assert.ok(pool.calls.every(call => call.sql !== 'COMMIT'));
});
test('independent L2 members retain unknown source L3 codes, validate full coverage, and reject aliases for publication', () => {
  const unknown = member({ l3_code: '850412.SI', l3_name: '特钢Ⅲ' });
  assert.equal(validateL2Members([unknown], '801093.SI').length, 1);
  const data = { industries: [l2Industry()], members: [unknown], fetchedAt, completedCodes: ['801093.SI'] };
  assert.equal(validateL2MembersSnapshot(data).members[0].l3_code, '850412.SI');
  assert.throws(() => validateL2MembersSnapshot({ ...data, completedCodes: [] }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => validateL2MembersSnapshot({ ...data, members: [unknown, unknown] }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => validateL2MembersSnapshot({ ...data, members: [member({ ts_code: 'T00018.SH' })] }), { code: 'VALIDATION_ERROR' });
  assert.equal(validateL2Members([member({ ts_code: 'T00018.SH' })], '801093.SI', { allowHistoricalAliases: true }).length, 1);
});
test('L2 member snapshot replacement preserves source fields and timestamps in its own atomic table', async () => {
  const pool = mockPool(), store = createIndustryStore({ pool });
  const data = { industries: [l2Industry()], members: [member({ l3_code: '850412.SI' })], fetchedAt, completedCodes: ['801093.SI'] };
  assert.deepEqual(await store.replaceL2Members(data), { members: 1, fetchedAt });
  assert.equal(pool.calls[1].sql, 'DELETE FROM market_data.sw_industry_members_l2');
  const write = pool.calls.find(call => call.sql.startsWith('INSERT INTO market_data.sw_industry_members_l2'));
  assert.match(write.sql, /ON CONFLICT \(ts_code, l2_code, l3_code\)/); assert.equal(write.values[1], '850412.SI'); assert.equal(write.values[10], 'Y'); assert.equal(write.values[11], fetchedAt); assert.equal(pool.calls.at(-1).sql, 'COMMIT');
  const broken = mockPool({ failOn: sql => sql.startsWith('INSERT INTO market_data.sw_industry_members_l2') });
  await assert.rejects(createIndustryStore({ pool: broken }).replaceL2Members(data), { code: 'DATABASE_ERROR' }); assert.equal(broken.calls.at(-1).sql, 'ROLLBACK');
});
test('classification validators normalize publication flags, require full directory coverage and retain conflicting L3 assignments', () => {
  assert.equal(validateIndustries([industry({ is_pub: '0' })])[0].is_pub, false);
  const second = industry({ index_code: '850732.SI', is_pub: 0 });
  const data = snapshot({ industries: [industry(), second], members: [member(), member({ l3_code: second.index_code })], completedCodes: ['850731.SI', '850732.SI'] });
  assert.equal(validateClassification(data).members.length, 2);
  assert.throws(() => validateClassification({ ...data, completedCodes: ['850731.SI'] }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => validateMembers([member(), member()], '850731.SI'), { code: 'VALIDATION_ERROR' });
  for (const bad of [industry({ is_pub: 'Y' }), industry({ level: 'L2' }), industry({ src: 'SW2014' }), industry({ index_code: 'bad' })]) assert.throws(() => validateIndustries([bad]), { code: 'VALIDATION_ERROR' });
});
test('historical member aliases are allowed only for full source-cache validation; published snapshots and ordinary invalid codes remain strict', () => {
  const alias = member({ ts_code: 'T00018.SH', name: '上港集箱(退市)' });
  assert.throws(() => validateMembers([alias], '850731.SI'), { code: 'VALIDATION_ERROR' });
  assert.equal(validateMembers([alias], '850731.SI', { allowHistoricalAliases: true }).length, 1);
  assert.throws(() => validateClassification(snapshot({ members: [alias] })), { code: 'VALIDATION_ERROR' });
  for (const bad of [member({ ts_code: 'BAD_CODE' }), member({ ts_code: 'T600018.SH' }), member({ ts_code: 'T00018.HK' }), { ...alias, is_new: 'N' }, { ...alias, l3_code: '850732.SI' }, { ...alias, l1_name: '' }]) assert.throws(() => validateMembers([bad], '850731.SI', { allowHistoricalAliases: true }), { code: 'VALIDATION_ERROR' });
});
test('reference snapshot replacement validates before transaction then atomically replaces both tables, keeping dates and source timestamp', async () => {
  const pool = mockPool(), store = createIndustryStore({ pool });
  assert.deepEqual(await store.replaceClassification(snapshot()), { industries: 1, members: 1, fetchedAt });
  assert.equal(pool.calls[0].sql, 'BEGIN'); assert.equal(pool.calls[1].sql, 'DELETE FROM market_data.sw_industry_members'); assert.equal(pool.calls[2].sql, 'DELETE FROM market_data.sw_industries');
  const write = pool.calls.find(call => call.sql.includes('INSERT INTO market_data.sw_industry_members'));
  assert.match(write.sql, /ON CONFLICT \(ts_code, l3_code\)/); assert.equal(write.values[8], '2021-12-13'); assert.equal(write.values[9], null); assert.equal(write.values[11], fetchedAt); assert.equal(pool.calls.at(-1).sql, 'COMMIT');
  const invalidPool = mockPool(); await assert.rejects(createIndustryStore({ pool: invalidPool }).replaceClassification(snapshot({ members: [] })), { code: 'VALIDATION_ERROR' }); assert.equal(invalidPool.calls.length, 0);
});
test('reference snapshot insertion failure rolls back deletions and hides database configuration', async () => {
  const pool = mockPool({ failOn: sql => sql.includes('INSERT INTO market_data.sw_industry_members') });
  await assert.rejects(createIndustryStore({ pool }).replaceClassification(snapshot()), error => error.code === 'DATABASE_ERROR' && error.sqlState === '08006' && !/secret|password/.test(error.message));
  assert.equal(pool.calls.at(-1).sql, 'ROLLBACK'); assert.ok(!pool.calls.some(call => call.sql === 'COMMIT'));
});
test('classification resume preserves individual directory and member source timestamps', async () => {
  const pool = mockPool(), sourceTime = '2026-10-13T00:00:00.000Z';
  await createIndustryStore({ pool }).replaceClassification(snapshot({ industries: [industry({ fetched_at: sourceTime })], members: [member({ fetched_at: sourceTime })] }));
  assert.equal(pool.calls.find(call => call.sql.includes('INSERT INTO market_data.sw_industries')).values.at(-1), sourceTime);
  assert.equal(pool.calls.find(call => call.sql.includes('INSERT INTO market_data.sw_industry_members')).values.at(-1), sourceTime);
});
test('industry and factor validation reject empty, invalid, duplicate or cross-date rows and preserve source decimals and nulls', () => {
  assert.equal(validateIndexDailyRows([index({ close: '105.00000001', open: null })], date).length, 1);
  assert.equal(validateAdjustmentRows([factor({ adj_factor: '2.1000000001' })], date).length, 1);
  for (const rows of [[], [index(), index()], [index({ trade_date: '20261012' })], [index({ close: null })], [index({ close: 0 })], [index({ vol: -2 })], [index({ high: Infinity })]]) assert.throws(() => validateIndexDailyRows(rows, date), { code: 'VALIDATION_ERROR' });
  for (const rows of [[], [factor(), factor()], [factor({ adj_factor: 0 })], [factor({ adj_factor: -2 })], [factor({ ts_code: '00700.HK' })], [factor({ trade_date: '20261012' })]]) assert.throws(() => validateAdjustmentRows(rows, date), { code: 'VALIDATION_ERROR' });
});
test('industry and factor data upserts commit their separate completion records in the same transaction', async () => {
  for (const apiName of ['sw_daily', 'adj_factor']) {
    const pool = mockPool(), store = apiName === 'sw_daily' ? createIndustryStore({ pool }) : createAdjustmentStore({ pool });
    assert.equal((await store.saveDay({ tradeDate: date, rows: [apiName === 'sw_daily' ? index() : factor()], fetchedAt })).rowsCount, 1);
    const write = pool.calls.find(call => call.sql.includes(`INSERT INTO market_data.${apiName === 'sw_daily' ? 'sw_index_daily' : 'stock_adj_factors'}`));
    assert.match(write.sql, /ON CONFLICT/); assert.equal(write.values.at(-1), fetchedAt);
    assert.deepEqual(pool.calls.find(call => call.sql.includes('INSERT INTO market_data.sync_days')).values, ['A', apiName, '2026-10-13', 1, null]); assert.equal(pool.calls.at(-1).sql, 'COMMIT');
  }
});
test('a data or ledger failure rolls back and never commits a partially completed day', async () => {
  for (const table of ['stock_adj_factors', 'sync_days']) {
    const pool = mockPool({ failOn: sql => sql.includes(`INSERT INTO market_data.${table}`) });
    await assert.rejects(createAdjustmentStore({ pool }).saveDay({ tradeDate: date, rows: [factor()] }), { code: 'DATABASE_ERROR' });
    assert.equal(pool.calls.at(-1).sql, 'ROLLBACK'); assert.ok(!pool.calls.some(call => call.sql === 'COMMIT'));
    assert.ok(pool.calls.some(call => call.sql === 'DELETE FROM market_data.stock_adj_factors WHERE trade_date = $1'));
  }
});
test('refresh atomically replaces the complete day when source rows shrink, and failed refresh preserves old rows', async () => {
  let committed = new Map(), transactionRows, failLedger = false, ledgerCount = 0;
  const pool = { async connect() { return { async query(sql, params) {
    if (sql === 'BEGIN') transactionRows = new Map(committed);
    else if (sql.startsWith('DELETE FROM market_data.stock_adj_factors')) { for (const [key, row] of transactionRows) if (row[1] === params[0]) transactionRows.delete(key); }
    else if (sql.startsWith('INSERT INTO market_data.stock_adj_factors')) { for (let i = 0; i < params.length; i += 4) transactionRows.set(`${params[i]}:${params[i + 1]}`, params.slice(i, i + 4)); }
    else if (sql.startsWith('INSERT INTO market_data.sync_days')) { if (failLedger) throw Object.assign(new Error('secret'), { code: '08006' }); ledgerCount = params[3]; }
    else if (sql === 'COMMIT') committed = transactionRows;
    return { rows: [] };
  }, release() {} }; } };
  const store = createAdjustmentStore({ pool });
  await store.saveDay({ tradeDate: date, rows: [factor(), factor({ ts_code: '000001.SZ' })] }); assert.equal(committed.size, 2);
  failLedger = true; await assert.rejects(store.saveDay({ tradeDate: date, rows: [factor()] }), { code: 'DATABASE_ERROR' }); assert.equal(committed.size, 2);
  failLedger = false; await store.saveDay({ tradeDate: date, rows: [factor()] }); assert.equal(committed.size, 1); assert.equal(ledgerCount, 1);
});
test('resumption filters API and nonempty completion; failure ledger uses fixed codes and preserves old completions', async () => {
  const pool = mockPool({ rows: [{ trade_date: date }] }), store = createIndustryStore({ pool });
  assert.deepEqual(await store.getCompletedDays({ apiName: 'adj_factor', startDate: date, endDate: date }), new Set([date]));
  assert.deepEqual(pool.calls[0].values, ['A', 'adj_factor', '2026-10-13', '2026-10-13']); assert.match(pool.calls[0].sql, /rows_count > 0/);
  await store.markFailedDay({ tradeDate: date, errorCode: 'token-secret' }); assert.equal(pool.calls.at(-1).values[3], 'unknown_error'); assert.match(pool.calls.at(-1).sql, /WHERE market_data.sync_days.status <> 'completed'/);
});
test('summary counts observations within range and selected API', async () => {
  const pool = mockPool({ rows: [{ rows_count: '21', ticker_count: '3', completed_days: '7' }] });
  const summary = await createAdjustmentStore({ pool }).summary({ startDate: date, endDate: date });
  assert.equal(summary.totals.rows_count, 21); assert.equal(summary.totals.completed_days, 7); assert.equal(pool.calls[0].values[2], 'adj_factor'); assert.match(pool.calls[0].sql, /market_data.stock_adj_factors/);
});
