import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { updateRollingHongKongPool, collectTushareHkPoolDaily } from '../backend/market-data/hk-pool-sync.mjs';
import { validateHongKongUniverse, loadHongKongUniverse } from '../backend/market-data/hk-pool-universe.mjs';
import { HK_POOL_PROVIDERS, missingHkPoolRanges, validateHkPoolRows } from '../backend/market-data/hk-pool-store.mjs';

const runDate = '2026-10-19', startDate = '20251019', endDate = '20261018';
function universe(tickers = ['00700.HK', '00941.HK', '00005.HK']) {
  return { version: 1, source: { path: '/workbook.xlsx', sheet: '合并价值投资池' }, securities: tickers.map((ticker, index) => ({ ticker, name: `证券 ${index}`, row: index + 2 })) };
}
function row(ticker, trade_date = '20261016') {
  return { ts_code: ticker, trade_date, open: '10.20', high: '10.40', low: '10.10', close: '10.30', pre_close: '10.10', change: '0.20', pct_chg: '1.98', vol: '1000200', amount: '10302060.25' };
}
function rangeRow({ ticker, startDate: start, endDate: end }) {
  return row(ticker, end < '20261016' ? end : start > '20261016' ? start : '20261016');
}
function memoryLedger() {
  const calls = [], runs = new Map(), ranges = new Map(), baselines = new Map();
  const key = value => [value.runDate, value.universeHash, value.source, value.apiName].join('/');
  const rangeKey = value => [value.universeHash, value.source, value.apiName, value.ticker].join('/');
  const baselineKey = value => `${rangeKey(value)}/${value.windowStart}`;
  return { calls, ranges, runs, baselines,
    migrate: async () => calls.push(['migrate']),
    withLock: async operation => operation({
      getRun: async options => runs.get(key(options)),
      beginRun: async options => { calls.push(['begin', options]); runs.set(key(options), { status: 'running' }); },
      getRanges: async options => ranges.get(rangeKey(options)) ?? [],
      getBaseline: async options => baselines.get(baselineKey(options)) ?? null,
      saveBaseline: async options => { calls.push(['baseline', options]); baselines.set(baselineKey(options), { baselineDate: options.rows[0]?.trade_date ?? null }); },
      saveRange: async options => {
        calls.push(['save', options]);
        ranges.set(rangeKey(options), [...(ranges.get(rangeKey(options)) ?? []), { startDate: options.startDate, endDate: options.endDate }]);
      },
      failRun: async options => { calls.push(['fail', options]); runs.set(key(options), { status: options.partial ? 'partial' : 'failed', summary: options.summary }); },
      finalize: async options => {
        calls.push(['finalize', options]); runs.set(key(options), { status: 'succeeded', summary: options.summary });
        for (const ticker of options.tickers) ranges.set(rangeKey({ ...options, ticker }), [{ startDate: options.windowStart, endDate: options.windowEnd }]);
        return { deleted: { daily_prices: 0, symbol_ranges: 0 } };
      },
    }),
  };
}
async function setup(t, extra = {}) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'hk-pool-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  return { cacheDir, store: memoryLedger(), universe: universe(), runDate, ...extra };
}

test('名单严格验证代码/唯一键并按股票成员生成稳定 hash，实际名单为 28 只', async () => {
  const original = universe(), reordered = { ...original, securities: [...original.securities].reverse() };
  assert.equal(validateHongKongUniverse(original).universeHash, validateHongKongUniverse(reordered).universeHash);
  assert.notEqual(validateHongKongUniverse(original).universeHash, validateHongKongUniverse(universe(['00700.HK'])).universeHash);
  for (const invalid of [universe([]), universe(['700.HK']), universe(['600519.SH']), universe(['00700.HK', '00700.HK']),
    { ...original, securities: [{ ticker: '00700.HK', name: '', row: 1 }] }]) assert.throws(() => validateHongKongUniverse(invalid), { code: 'VALIDATION_ERROR' });
  const actual = await loadHongKongUniverse(); assert.equal(actual.securities.length, 28); assert.equal(actual.tickers.length, 28);
});

test('单股票年度响应接受精确小数字符串，拒绝错代码、日期重复/越界、字段缺失和截断', () => {
  const options = { ticker: '00700.HK', startDate, endDate }, value = row(options.ticker);
  assert.equal(validateHkPoolRows([value], options)[0].close, '10.30');
  for (const rows of [[{ ...value, ts_code: '00941.HK' }], [value, value], [{ ...value, trade_date: '20251018' }],
    [{ ...value, close: Infinity }], [{ ...value, vol: '-1' }], [{ ...value, open: undefined }], Array(5000).fill(value)]) {
    assert.throws(() => validateHkPoolRows(rows, options), { code: 'VALIDATION_ERROR' });
  }
  assert.throws(() => validateHkPoolRows([], { ...options, allowEmpty: false }), { kind: 'no_data' });
  assert.deepEqual(missingHkPoolRanges([{ startDate, endDate: '20261017' }], startDate, endDate), [{ startDate: '20261018', endDate: '20261018' }]);
});

test('Tushare 每只股票只请求一次年度范围，未请求全市场或额外尾页', async () => {
  const calls = [];
  const response = await collectTushareHkPoolDaily({ ticker: '00700.HK', startDate, endDate, client: { query: async (...args) => { calls.push(args); return [row('00700.HK')]; } } });
  assert.equal(calls.length, 1); assert.equal(calls[0][0], 'hk_daily');
  assert.deepEqual(calls[0][1], { ts_code: '00700.HK', start_date: startDate, end_date: endDate, limit: 5000 });
  assert.equal(response.source, 'tushare'); assert.equal(response.apiName, 'hk_daily');
});

test('只下载名单股票并按 symbol 范围写入，保留供应商原始缓存与真实来源', async t => {
  const options = await setup(t), calls = [];
  options.collector = async args => {
    calls.push(args); return { ...HK_POOL_PROVIDERS.eastmoney, rows: [rangeRow(args)], raw: { upstream: 'raw csv' } };
  };
  const result = await updateRollingHongKongPool(options);
  assert.equal(result.status, 'succeeded'); assert.deepEqual(calls.filter(call => call.endDate === endDate).map(call => call.ticker), options.universe.securities.map(item => item.ticker));
  assert.ok(calls.every(call => (call.startDate === startDate && call.endDate === endDate) || (call.startDate === '20250919' && call.endDate === '20251018')));
  assert.equal(result.summary.completedTickers, 3); assert.equal(options.store.calls.filter(call => call[0] === 'save').length, 3);
  const cached = JSON.parse(gunzipSync(await readFile(join(options.cacheDir, 'HK-pool', result.universeHash, 'eastmoney', '00700.HK', `${startDate}-${endDate}.json.gz`))).toString());
  assert.equal(cached.source, 'eastmoney'); assert.equal(cached.rows[0].amount, '10302060.25'); assert.equal(cached.raw.upstream, 'raw csv');
  assert.equal((await updateRollingHongKongPool(options)).status, 'already_completed'); assert.equal(calls.length, 6);
});

test('一个 symbol 限流后立即停止；失败重试跳过已完成 symbol，再完成剩余名单', async t => {
  const options = await setup(t), calls = [];
  options.collector = async args => {
    const { ticker } = args;
    calls.push(ticker); if (ticker === '00941.HK') { const error = new Error('private token'); error.kind = 'rate_limit'; throw error; }
    return { ...HK_POOL_PROVIDERS.eastmoney, rows: [rangeRow(args)] };
  };
  const partial = await updateRollingHongKongPool(options);
  assert.equal(partial.status, 'partial'); assert.equal(partial.errorCode, 'rate_limited'); assert.equal(partial.summary.completedTickers, 1);
  assert.deepEqual(calls, ['00700.HK', '00700.HK', '00941.HK']); assert.equal(options.store.calls.some(call => call[0] === 'finalize'), false);
  assert.equal(JSON.stringify(partial).includes('private'), false);
  options.collector = async args => { calls.push(args.ticker); return { ...HK_POOL_PROVIDERS.eastmoney, rows: [rangeRow(args)] }; };
  const retried = await updateRollingHongKongPool(options);
  assert.equal(retried.status, 'succeeded'); assert.equal(retried.summary.skippedTickers, 1);
  assert.deepEqual(calls, ['00700.HK', '00700.HK', '00941.HK', '00941.HK', '00941.HK', '00005.HK', '00005.HK']);
});

test('日更只补昨天，年度范围删除旧日后仍连续；换名单不复用其他名单完成状态', async t => {
  const options = await setup(t, { universe: universe(['00700.HK']) }), calls = [];
  options.collector = async ({ ticker, startDate: start, endDate: end }) => {
    calls.push([ticker, start, end]); return { ...HK_POOL_PROVIDERS.eastmoney, rows: [row(ticker, end < '20261016' ? end : start > '20261016' ? start : '20261016')] };
  };
  assert.equal((await updateRollingHongKongPool(options)).status, 'succeeded');
  assert.equal((await updateRollingHongKongPool({ ...options, runDate: '2026-10-20' })).status, 'succeeded');
  assert.deepEqual(calls[2], ['00700.HK', '20261019', '20261019']);
  assert.equal((await updateRollingHongKongPool({ ...options, runDate: '2026-10-21' })).status, 'succeeded');
  assert.deepEqual(calls[4], ['00700.HK', '20261020', '20261020']);
  const changed = await updateRollingHongKongPool({ ...options, universe: universe(['00700.HK', '00941.HK']) });
  assert.equal(changed.status, 'succeeded'); assert.equal(changed.summary.skippedTickers, 0);
  assert.deepEqual(calls.slice(-4).map(value => value.slice(1)), [[startDate, endDate], ['20250919', '20251018'], [startDate, endDate], ['20250919', '20251018']]);
});

test('切回来源时即使 run 成功，只要实际覆盖失效便重开并可从原缓存恢复', async t => {
  const options = await setup(t, { universe: universe(['00700.HK']) }), calls = [];
  options.collector = async args => { calls.push(args.ticker); return { ...HK_POOL_PROVIDERS.eastmoney, rows: [rangeRow(args)] }; };
  assert.equal((await updateRollingHongKongPool(options)).status, 'succeeded');
  // A different provider overwrote the observations: store coverage no longer
  // matches its recorded row count, so it excludes that stale range.
  options.store.ranges.clear();
  const restored = await updateRollingHongKongPool(options);
  assert.equal(restored.status, 'succeeded'); assert.equal(restored.summary.cachedRanges, 1);
  assert.equal(calls.length, 2); assert.equal(options.store.calls.filter(call => call[0] === 'begin').at(-1)[1].reopen, true);
});

test('初次空库只保存一条前置价格；旧成功记录缺基准会重开而不声明30天年度覆盖', async t => {
  const options = await setup(t, { universe: universe(['00700.HK']) }), calls = [];
  options.collector = async ({ ticker, startDate: start, endDate: end }) => {
    calls.push([start, end]);
    return { ...HK_POOL_PROVIDERS.eastmoney, rows: end < '20261016'
      ? [row(ticker, '20250919'), row(ticker, '20251016'), row(ticker, '20251017')]
      : [row(ticker)] };
  };
  assert.equal((await updateRollingHongKongPool(options)).status, 'succeeded');
  options.store.baselines.clear();
  const restored = await updateRollingHongKongPool(options);
  assert.equal(restored.status, 'succeeded'); assert.equal(restored.windowStart, '20251019');
  assert.deepEqual(calls, [[startDate, endDate], ['20250919', '20251018']]);
  assert.equal(options.store.calls.filter(call => call[0] === 'begin').at(-1)[1].reopen, true);
  const saved = options.store.calls.filter(call => call[0] === 'baseline').at(-1)[1];
  assert.deepEqual(saved.rows.map(row => row.trade_date), ['20251017']);
  assert.equal(options.store.calls.filter(call => call[0] === 'save').length, 1);
  assert.equal(options.store.calls.filter(call => call[0] === 'finalize').at(-1)[1].windowStart, '20251019');
});

test('旧成功范围补缓冲失败时保留原覆盖，不提前执行清理或标记本次成功', async t => {
  const options = await setup(t, { universe: universe(['00700.HK']) });
  options.collector = async args => ({ ...HK_POOL_PROVIDERS.eastmoney, rows: [rangeRow(args)] });
  assert.equal((await updateRollingHongKongPool(options)).status, 'succeeded');
  options.store.baselines.clear();
  options.collector = async () => { const error = new Error('unavailable'); error.kind = 'network'; throw error; };
  await rm(join(options.cacheDir, 'HK-pool'), { recursive: true, force: true });
  const retried = await updateRollingHongKongPool(options);
  assert.equal(retried.status, 'failed'); assert.equal(retried.errorCode, 'network_error');
  assert.equal(options.store.calls.filter(call => call[0] === 'begin').at(-1)[1].reopen, true);
  assert.equal(options.store.calls.filter(call => call[0] === 'finalize').length, 1);
  for (const ranges of options.store.ranges.values()) assert.deepEqual(ranges, [{ startDate: '20251019', endDate }]);
});

test('年度起点跨过周末后仍保存最近周五的一条基准，下一日不会把它视作年度覆盖', async t => {
  const options = await setup(t, { universe: universe(['00700.HK']), runDate: '2026-10-18' });
  options.collector = async args => ({ ...HK_POOL_PROVIDERS.eastmoney,
    rows: [args.endDate < '20260101' ? row(args.ticker, '20251017') : rangeRow(args)] });
  assert.equal((await updateRollingHongKongPool(options)).status, 'succeeded');
  assert.equal((await updateRollingHongKongPool({ ...options, runDate: '2026-10-19' })).status, 'succeeded');
  assert.equal((await updateRollingHongKongPool({ ...options, runDate: '2026-10-20' })).status, 'succeeded');
  const baselines = options.store.calls.filter(call => call[0] === 'baseline').map(call => call[1]);
  assert.deepEqual(baselines.map(call => call.windowStart), ['20251018', '20251019', '20251020']);
  assert.ok(baselines.every(call => call.rows.length === 1 && call.rows[0].trade_date === '20251017'));
  assert.deepEqual([...options.store.ranges.values()], [[{ startDate: '20251020', endDate: '20261019' }]]);
});

test('查找不到前置真实行情只记录空基准，不捏造价格且不把年度空响应当完整数据', async t => {
  const options = await setup(t, { universe: universe(['00700.HK']) });
  options.collector = async args => {
    if (args.endDate < startDate) { const error = new Error('no prior quote'); error.kind = 'no_data'; throw error; }
    return { ...HK_POOL_PROVIDERS.eastmoney, rows: [rangeRow(args)] };
  };
  assert.equal((await updateRollingHongKongPool(options)).status, 'succeeded');
  const baseline = options.store.calls.find(call => call[0] === 'baseline')[1];
  assert.deepEqual(baseline.rows, []); assert.equal(baseline.windowStart, startDate);
  assert.equal((await updateRollingHongKongPool(options)).status, 'already_completed');
  const empty = await setup(t, { universe: universe(['00700.HK']), collector: async () => ({ ...HK_POOL_PROVIDERS.eastmoney, rows: [] }) });
  assert.equal((await updateRollingHongKongPool(empty)).status, 'failed');
  assert.equal(empty.store.calls.some(call => call[0] === 'finalize'), false);
});

test('周末增量确认零覆盖且完全不请求行情；含工作日的空响应保守失败', async t => {
  const options = await setup(t, { universe: universe(['00700.HK']), runDate: '2026-10-17' });
  options.collector = async args => ({ ...HK_POOL_PROVIDERS.eastmoney, rows: [rangeRow(args)] });
  assert.equal((await updateRollingHongKongPool(options)).status, 'succeeded');
  options.collector = async args => { assert.ok(args.endDate < startDate, '仅允许查前置基准，周末年度增量不应请求行情'); return { ...HK_POOL_PROVIDERS.eastmoney, rows: [rangeRow(args)] }; };
  const weekend = await updateRollingHongKongPool({ ...options, runDate: '2026-10-19' });
  assert.equal(weekend.status, 'succeeded'); assert.equal(weekend.summary.rows, 1);
  options.collector = async () => { const error = new Error('no data'); error.kind = 'no_data'; throw error; };
  const weekday = await updateRollingHongKongPool({ ...options, runDate: '2026-10-20' });
  assert.equal(weekday.status, 'failed'); assert.equal(weekday.errorCode, 'no_data');
});

test('工作日空增量必须经完整 hk_tradecal 全休市确认，开放/缺失日历不授权完成', async t => {
  const options = await setup(t, { universe: universe(['00700.HK']) });
  options.collector = async args => ({ ...HK_POOL_PROVIDERS.eastmoney, rows: [rangeRow(args)] });
  assert.equal((await updateRollingHongKongPool(options)).status, 'succeeded');
  options.collector = async () => { const error = new Error('no data'); error.kind = 'no_data'; throw error; };
  const calls = [];
  options.client = { query: async (...args) => { calls.push(args); return [{ cal_date: '20261019', is_open: 1 }]; } };
  assert.equal((await updateRollingHongKongPool({ ...options, runDate: '2026-10-20' })).status, 'failed');
  options.client.query = async (...args) => { calls.push(args); return [{ cal_date: '20261019', is_open: 0 }]; };
  assert.equal((await updateRollingHongKongPool({ ...options, runDate: '2026-10-20' })).status, 'succeeded');
  assert.equal(calls[0][0], 'hk_tradecal'); assert.deepEqual(calls[0][1], { start_date: '20261019', end_date: '20261019' });
});

test('Yahoo 独立来源身份可保留未知成交额，不能伪装成默认东方财富来源', async t => {
  const options = await setup(t, { universe: universe(['00700.HK']), provider: 'yahoo' });
  options.collector = async args => ({ ...HK_POOL_PROVIDERS.yahoo, rows: [{ ...rangeRow(args), amount: null, pre_close: null, change: null, pct_chg: null }] });
  const result = await updateRollingHongKongPool(options);
  assert.equal(result.status, 'succeeded'); assert.equal(result.source, 'yahoo'); assert.equal(result.apiName, 'yahoo_hk_daily');
  const saved = options.store.calls.find(call => call[0] === 'save')[1];
  assert.equal(saved.source, 'yahoo'); assert.equal(saved.rows[0].amount, null);
  const mismatch = await setup(t, { universe: universe(['00700.HK']), provider: 'eastmoney', collector: options.collector });
  const rejected = await updateRollingHongKongPool(mismatch);
  assert.equal(rejected.status, 'failed'); assert.equal(rejected.errorCode, 'validation_error');
  assert.equal(mismatch.store.calls.some(call => call[0] === 'save'), false);
});

test('Tencent 第四来源按真实身份写范围，未知字段保留 null', async t => {
  const options = await setup(t, { universe: universe(['00700.HK']), provider: 'tencent' });
  options.collector = async args => ({ ...HK_POOL_PROVIDERS.tencent, rows: [{ ...rangeRow(args), amount: null, pre_close: null, change: null, pct_chg: null }] });
  const result = await updateRollingHongKongPool(options);
  assert.equal(result.status, 'succeeded'); assert.equal(result.source, 'tencent'); assert.equal(result.apiName, 'tencent_hk_daily');
  const saved = options.store.calls.find(call => call[0] === 'save')[1];
  assert.equal(saved.source, 'tencent'); assert.equal(saved.apiName, 'tencent_hk_daily'); assert.equal(saved.rows[0].amount, null);
});
