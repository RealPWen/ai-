import test from 'node:test';
import assert from 'node:assert/strict';
import { createTencentHkIndexClient, validateHkIndexRows } from '../backend/market-data/hk-index-client.mjs';
import { createHkIndexStore } from '../backend/market-data/hk-index-store.mjs';
import { updateRollingHkIndex } from '../backend/market-data/hk-index-sync.mjs';
import { readHkIndexBenchmark } from '../backend/market-data/hk-index-read.mjs';

const bar = (date, close = 24000) => ({ index_code: 'HSI', trade_date: date, open: close, high: close + 10, low: close - 10, close, vol: 123456.125 });
const annualBars = () => {
  const rows = [];
  for (let time = Date.parse('2025-10-20'); time <= Date.parse('2026-10-16'); time += 86400000) {
    const date = new Date(time); if (![0, 6].includes(date.getUTCDay())) rows.push(bar(date.toISOString().slice(0, 10).replaceAll('-', '')));
  }
  return rows;
};
const body = () => { const qt = Array(76).fill(''); Object.assign(qt, { 0: '100', 1: '恒生指数', 2: 'HSI', 63: 'ZS', 75: 'HKD' });
  return { code: 0, data: { hkHSI: { qt: { hkHSI: qt }, day: [['2026-10-16', '24000', '24005', '24010', '23990', '123456.125']] } } }; };
const options = { startDate: '20261001', endDate: '20261019' };

test('腾讯恒指验证指数身份、币种与未复权day，保留小数成交量', async () => {
  let url;
  const client = createTencentHkIndexClient({ fetchImpl: async input => { url = String(input); return { ok: true, json: async () => body() }; } });
  const result = await client.getDaily(options);
  assert.match(url, /hkHSI%2Cday%2C2026-10-01%2C2026-10-19/);
  assert.equal(result.rows[0].index_code, 'HSI'); assert.equal(result.rows[0].vol, 123456.125); assert.equal(result.coverage.lastDate, '20261016');
});

test('腾讯恒指拒绝错误身份/市场/币种/复权替代、重复日期和实时越界日期', async () => {
  const mutations = [b => { b.data.hkHSI.qt.hkHSI[2] = '00700'; }, b => { b.data.hkHSI.qt.hkHSI[0] = '51'; },
    b => { b.data.hkHSI.qt.hkHSI[63] = 'GP'; }, b => { b.data.hkHSI.qt.hkHSI[75] = 'USD'; },
    b => { b.data.hkHSI.qfqday = b.data.hkHSI.day; delete b.data.hkHSI.day; },
    b => { b.data.hkHSI.day.push([...b.data.hkHSI.day[0]]); }, b => { b.data.hkHSI.day[0][0] = '2026-10-20'; },
    b => { b.data.hkHSI.day[0][0] = '2026-09-30'; }, b => { b.data.hkHSI.day[0][0] = '2026-02-30'; },
    b => { b.data.hkHSI.day[0][2] = '99999'; }];
  for (const mutate of mutations) {
    const value = body(); mutate(value);
    const client = createTencentHkIndexClient({ fetchImpl: async () => ({ ok: true, json: async () => value }) });
    await assert.rejects(client.getDaily(options), { kind: 'validation' });
  }
  assert.throws(() => validateHkIndexRows([bar('20261016'), bar('20261016')], options));
  assert.throws(() => validateHkIndexRows([{ ...bar('20261016'), index_code: 'HSCEI' }], options));
});

test('恒指read使用共同基准日、原始指数及缩放值，缺失日期不填充', async () => {
  let sql;
  const stockPoints = [{ date: '2026-10-13', close: 10 }, { date: '2026-10-14', close: 11 }, { date: '2026-10-15', close: 12 }, { date: '2026-10-16', close: 13 }];
  const result = await readHkIndexBenchmark({ from: '2026-10-01', asOf: '2026-10-19', stockPoints,
    query: async input => { sql = input; return { rows: [{ trade_date: '2026-10-14', close: '20000' }, { trade_date: '2026-10-16', close: '22000' }, { trade_date: '2026-10-20', close: 99999 }] }; } });
  assert.match(sql, /hk_index_daily/); assert.equal(result.system, 'HSI'); assert.equal(result.level, null);
  assert.equal(result.status, 'available'); assert.equal(result.baseDate, '2026-10-14'); assert.equal(result.baseStockClose, 11);
  assert.deepEqual(result.latest, { date: '2026-10-16', close: 22000 });
  assert.equal(result.points[0].close, null); assert.equal(result.points[2].scaledClose, null); assert.equal(result.points[3].scaledClose, 12.100000000000001);
});

test('恒指无价格与无共同日期均明确返回，保留真实最后指数交易日', async () => {
  for (const [rows, expected] of [[[], 'missing_prices'], [[{ trade_date: '2026-10-16', close: 23000 }], 'no_common_date']]) {
    const result = await readHkIndexBenchmark({ from: '2026-10-01', asOf: '2026-10-19', stockPoints: [{ date: '2026-10-15', close: 10 }], query: async () => ({ rows }) });
    assert.equal(result.status, expected); assert.equal(result.points[0].close, null);
    if (rows.length) assert.equal(result.latest.date, '2026-10-16');
  }
});

function syncFixture({ existing = [], response, prior, failSave = false } = {}) {
  const calls = [], scope = {
    getRun: async () => prior ?? null, beginRun: async value => calls.push(['begin', value]), get: async () => existing,
    finalize: async value => { calls.push(['save', value]); if (failSave) throw Object.assign(new Error('private db'), { kind: 'database' }); return { rows: value.rows.length, deleted: 1 }; },
    failRun: async value => calls.push(['failed', value]),
  };
  const store = { migrate: async () => {}, withLock: async operation => operation(scope) };
  const client = { getDaily: async input => { calls.push(['request', input]); return { rows: response ?? annualBars() }; } };
  return { store, client, calls };
}

test('恒指首次回填一年且截止昨日，后续只回取10天交叠并保留一年', async () => {
  const first = syncFixture(); const result = await updateRollingHkIndex({ ...first, runDate: '2026-10-20' });
  assert.equal(result.status, 'succeeded'); assert.equal(result.windowEnd, '20261019');
  assert.deepEqual(first.calls.find(([type]) => type === 'request')[1], { indexCode: 'HSI', startDate: '20251020', endDate: '20261019' });
  const next = syncFixture({ existing: annualBars(), response: [bar('20261016'), bar('20261019')] });
  const daily = await updateRollingHkIndex({ ...next, runDate: '2026-10-20' });
  assert.equal(daily.status, 'succeeded'); assert.equal(daily.summary.fullBackfill, false);
  assert.equal(next.calls.find(([type]) => type === 'request')[1].startDate, '20261006');
  assert.equal(next.calls.find(([type]) => type === 'save')[1].windowStart, '20251020');
});

test('恒指拒绝实时当日/重复/截断数据，失败不写行情或清理旧数据；完成后不重复请求', async () => {
  for (const response of [[bar('20251020'), bar('20261020')], [bar('20251020'), bar('20251020')], [bar('20261019')], [bar('20251020'), bar('20261019')]]) {
    const f = syncFixture({ response }); const result = await updateRollingHkIndex({ ...f, runDate: '2026-10-20' });
    assert.equal(result.status, 'failed'); assert.equal(f.calls.some(([type]) => type === 'save'), false); assert.equal(f.calls.at(-1)[0], 'failed');
  }
  const done = syncFixture({ prior: { status: 'succeeded', summary: { rows: 245 } } });
  assert.equal((await updateRollingHkIndex({ ...done, runDate: '2026-10-20' })).status, 'already_completed'); assert.equal(done.calls.length, 0);
  const fail = syncFixture({ failSave: true }); assert.equal((await updateRollingHkIndex({ ...fail, runDate: '2026-10-20' })).errorCode, 'database_error');
});

test('恒指PG upsert验证后事务内覆盖和滚动清理，驱动异常回滚且不泄露', async () => {
  const calls = [], client = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [], rowCount: 1 }; }, release() { calls.push({ sql: 'release' }); } };
  const store = createHkIndexStore({ pool: { connect: async () => client, end: async () => {} } });
  await store.upsert({ rows: [bar('20261016')], ...options, retentionStart: '20251020' });
  assert.equal(calls[0].sql, 'BEGIN'); assert.match(calls[1].sql, /ON CONFLICT\(index_code,trade_date\)/); assert.match(calls[2].sql, /DELETE FROM market_data.hk_index_daily/); assert.equal(calls[3].sql, 'COMMIT');
  calls.length = 0;
  await assert.rejects(store.upsert({ rows: [bar('20261020')], ...options }), { kind: 'validation' });
  assert.equal(calls.some(({ sql }) => sql.includes('INSERT')), false); assert.equal(calls[1].sql, 'ROLLBACK');
  client.query = async sql => { calls.push({ sql }); if (sql.includes('INSERT')) throw new Error('private database credentials'); return { rows: [] }; };
  await assert.rejects(store.upsert({ rows: [bar('20261016')], ...options }), error => error.kind === 'database' && !error.message.includes('private'));
  assert.equal(calls.at(-2).sql, 'ROLLBACK');
});
