import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rollingWindowForDate, updateRollingMarketData, ROLLING_APIS, HK_ROLLING_APIS } from '../backend/market-data/rolling-update.mjs';
import { expandPriceHistoryWindow, PRICE_HISTORY_LOOKBACK_DAYS, PRICE_HISTORY_EXTRA_TRADING_DAYS } from '../backend/market-data/price-history-window.mjs';

const runDate = '2026-10-15';
const openDates = ['20261012', '20261013', '20261014'];
const window = rollingWindowForDate(runDate);
const lookupWindow = expandPriceHistoryWindow(window);
const historyWindow = expandPriceHistoryWindow(window, '20251014');
function fullCalendar(startDate = '2025-09-15', dates = ['20250915', '20251014', ...openDates]) {
  const result = [];
  for (let cursor = Date.parse(`${startDate}T00:00:00Z`); cursor <= Date.parse('2026-10-14T00:00:00Z'); cursor += 86_400_000) {
    const cal_date = new Date(cursor).toISOString().slice(0, 10).replaceAll('-', '');
    result.push({ cal_date, is_open: dates.includes(cal_date) ? 1 : 0 });
  }
  return result;
}
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'rolling-update-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return directory;
}
function ledger({ previous = null, busy = false, finalError = null } = {}) {
  const calls = [], state = { previous };
  return {
    calls,
    migrate: async () => calls.push(['migrate']),
    withLock: async operation => {
      calls.push(['lock']);
      if (busy) return { status: 'busy' };
      try { return await operation({
        getRun: async date => { calls.push(['getRun', date]); return state.previous; },
        beginRun: async args => calls.push(['begin', args]),
        failRun: async args => calls.push(['fail', args]),
        finalize: async args => {
          calls.push(['finalize', args]);
          if (finalError) throw finalError;
          const deleted = { daily_prices: 2, daily_valuations: 2, stock_adj_factors: 2, sw_index_daily: 1, sync_days: 4 };
          state.previous = { ...window, status: 'succeeded', summary: { ...args.summary, deleted } };
          return { ...args, deleted };
        },
      }); } finally { calls.push(['unlock']); }
    },
  };
}
function completedReport(apiName, count = openDates.length) {
  const detail = { market: 'A', apiName, status: 'completed', plannedDays: count, completedDays: count, failedDates: [], rows: 3 };
  return apiName === 'daily' ? { status: 'completed', markets: [detail] } : detail;
}
function injectedCollectors(calls = []) {
  return Object.fromEntries([['daily', 'daily'], ['valuations', 'daily_basic'], ['adjustments', 'adj_factor'], ['industries', 'sw_daily']].map(([name, api]) => [name, async options => {
    calls.push({ api, options }); return completedReport(api, openDates.length + (['daily', 'adj_factor'].includes(api) ? 1 : 0));
  }]));
}
function options(cacheDir, store = ledger(), calendar = fullCalendar()) {
  return { runDate, cacheDir, store, marketStore: {}, valuationStore: {}, industryStore: {},
    client: { query: async () => calendar }, collectors: injectedCollectors() };
}

test('自然年窗口截至昨天，跨月、年和闰日均不受主机时区影响', () => {
  assert.deepEqual(window, { runDate: '2026-10-15', windowStart: '20251015', windowEnd: '20261014' });
  assert.deepEqual(rollingWindowForDate('20260101'), { runDate: '2026-01-01', windowStart: '20250101', windowEnd: '20251231' });
  assert.deepEqual(rollingWindowForDate('2024-02-29'), { runDate: '2024-02-29', windowStart: '20230228', windowEnd: '20240228' });
  assert.deepEqual(rollingWindowForDate('2025-03-01'), { runDate: '2025-03-01', windowStart: '20240301', windowEnd: '20250228' });
  assert.throws(() => rollingWindowForDate('2026-02-29'));
});

test('30天仅用于UTC日历查找，实际价格窗口只扩到指定前置交易日', () => {
  for (const [date, start] of [['2026-10-19', '20250919'], ['2024-02-29', '20230129'], ['2025-03-01', '20240131']]) {
    const annual = { ...rollingWindowForDate(date), source: 'test' };
    const history = expandPriceHistoryWindow(annual);
    assert.equal(history.windowStart, start); assert.equal(history.windowEnd, annual.windowEnd);
    assert.equal(history.runDate, annual.runDate); assert.equal(history.source, 'test');
    assert.equal(annual.windowStart, rollingWindowForDate(date).windowStart);
  }
  assert.equal(PRICE_HISTORY_LOOKBACK_DAYS, 30); assert.equal(PRICE_HISTORY_EXTRA_TRADING_DAYS, 1);
  assert.equal(expandPriceHistoryWindow(rollingWindowForDate('2026-10-19'), '2025-10-16').windowStart, '20251016');
  assert.throws(() => expandPriceHistoryWindow(window, window.windowStart));
});

test('旧版当天成功记录会重开以补齐基准价格和因子，完成后再次调用才跳过', async t => {
  const store = ledger({ previous: { ...window, status: 'succeeded', summary: { daily: { completedDays: 3 } } } });
  const calls = [], opts = options(await temporary(t), store);
  opts.collectors = injectedCollectors(calls);
  assert.equal((await updateRollingMarketData(opts)).status, 'succeeded');
  assert.equal(store.calls.find(call => call[0] === 'begin')[1].reopen, true);
  assert.equal(calls.find(call => call.api === 'daily').options.startDate, historyWindow.windowStart);
  assert.equal(calls.find(call => call.api === 'adj_factor').options.startDate, historyWindow.windowStart);
  assert.equal((await updateRollingMarketData(opts)).status, 'already_completed');
  assert.equal(calls.length, 4);
});

test('周年日遇周末或长假时，前一交易日纳入价格/因子采集和最终完整性验证', async t => {
  for (const [date, baseline, latest] of [['2026-10-19', '20251017', '20261016'], ['2026-10-08', '20250930', '20260930']]) {
    const annual = rollingWindowForDate(date), history = expandPriceHistoryWindow(annual);
    const calendar = [];
    for (let cursor = Date.parse(`${history.windowStart.slice(0, 4)}-${history.windowStart.slice(4, 6)}-${history.windowStart.slice(6)}T00:00:00Z`);
      cursor <= Date.parse(`${annual.windowEnd.slice(0, 4)}-${annual.windowEnd.slice(4, 6)}-${annual.windowEnd.slice(6)}T00:00:00Z`); cursor += 86_400_000) {
      const cal_date = new Date(cursor).toISOString().slice(0, 10).replaceAll('-', '');
      calendar.push({ cal_date, is_open: [baseline, latest].includes(cal_date) ? 1 : 0 });
    }
    const store = ledger(), calls = [];
    const opts = { ...options(await temporary(t), store, calendar), runDate: date };
    opts.collectors = Object.fromEntries([['daily', 'daily'], ['valuations', 'daily_basic'], ['adjustments', 'adj_factor'], ['industries', 'sw_daily']]
      .map(([name, api]) => [name, async args => {
        calls.push({ api, startDate: args.startDate });
        return completedReport(api, ['daily', 'adj_factor'].includes(api) ? 2 : 1);
      }]));
    assert.equal((await updateRollingMarketData(opts)).status, 'succeeded');
    const finalize = store.calls.find(call => call[0] === 'finalize')[1];
    assert.deepEqual(finalize.expectedDates, [latest]);
    assert.deepEqual(finalize.priceHistoryExpectedDates, [baseline, latest]);
    assert.ok(calls.filter(call => ['daily', 'adj_factor'].includes(call.api)).every(call => call.startDate === baseline));
  }
});

test('少报额外前置交易日的采集器不能触发清理', async t => {
  const store = ledger(), opts = options(await temporary(t), store, fullCalendar('2025-09-15', ['20250930', ...openDates]));
  // The old one-year-only report misses the extra trading day in the buffer.
  opts.collectors = injectedCollectors();
  opts.collectors.daily = async () => completedReport('daily');
  const result = await updateRollingMarketData(opts);
  assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'validation_error');
  assert.equal(store.calls.some(call => call[0] === 'finalize'), false);
});

test('价格和复权只多采集前一个交易日，估值和行业仍一年，全部完成才原子收尾', async t => {
  const cacheDir = await temporary(t), store = ledger(), calls = [], opts = options(cacheDir, store);
  opts.collectors = injectedCollectors(calls);
  opts.client.query = async (api, params, fields) => {
    assert.equal(api, 'trade_cal'); assert.equal(params.exchange, 'SSE'); assert.equal(fields, 'cal_date,is_open');
    assert.equal(Object.hasOwn(params, 'is_open'), false);
    assert.equal(params.start_date, lookupWindow.windowStart); assert.equal(params.end_date, window.windowEnd);
    return fullCalendar().reverse();
  };
  const result = await updateRollingMarketData(opts);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(calls.map(call => call.api), ROLLING_APIS);
  assert.ok(calls.every(call => call.options.startDate === (['daily', 'adj_factor'].includes(call.api) ? historyWindow.windowStart : window.windowStart)
    && call.options.endDate === window.windowEnd && call.options.mode === 'sync'));
  assert.equal(calls[0].options.store, opts.marketStore); assert.deepEqual(calls[0].options.markets, ['A']);
  assert.equal(calls[1].options.store, opts.valuationStore); assert.equal(calls[2].options.store, opts.industryStore);
  assert.equal(calls[3].options.refresh, false);
  const finalize = store.calls.find(call => call[0] === 'finalize')[1];
  assert.deepEqual(finalize.expectedDates, openDates); assert.deepEqual(finalize.apis, ROLLING_APIS);
  assert.deepEqual(finalize.priceHistoryExpectedDates, ['20251014', ...openDates]);
  assert.equal(result.summary.priceHistoryWindowStart, historyWindow.windowStart);
  assert.equal(result.summary.priceHistoryExtraTradingDays, PRICE_HISTORY_EXTRA_TRADING_DAYS);
  assert.equal(Object.hasOwn(result.summary, 'priceHistoryBufferDays'), false);
  assert.equal(result.summary.deleted.daily_prices, 2);
  const calendar = JSON.parse(await readFile(join(cacheDir, 'A', `calendar-${window.windowStart}-${window.windowEnd}.json`), 'utf8'));
  assert.deepEqual(calendar.dates, openDates);
  const historyCalendar = JSON.parse(await readFile(join(cacheDir, 'A', `calendar-${historyWindow.windowStart}-${window.windowEnd}.json`), 'utf8'));
  assert.deepEqual(historyCalendar.dates, ['20251014', ...openDates]);
  const again = await updateRollingMarketData(opts);
  assert.equal(again.status, 'already_completed'); assert.equal(calls.length, 4);
  assert.equal(store.calls.filter(call => call[0] === 'finalize').length, 1);
});

test('跨进程锁忙时不触发下载或清理', async t => {
  const opts = options(await temporary(t), ledger({ busy: true }));
  opts.client.query = async () => assert.fail('busy must not call provider');
  assert.deepEqual(await updateRollingMarketData(opts), { status: 'busy', ...window, summary: {} });
  assert.equal(opts.store.calls.some(call => call[0] === 'begin'), false);
});

for (const [name, transform] of [
  ['空响应', () => []], ['少一个休市日', rows => rows.slice(1)], ['重复日', rows => [...rows, rows[0]]],
  ['非法开市标记', rows => rows.map((row, index) => index ? row : { ...row, is_open: null })],
  ['全关闭', rows => rows.map(row => ({ ...row, is_open: 0 }))],
]) {
  test(`交易日历${name}不能授权删除旧数据`, async t => {
    const store = ledger(), calls = [], opts = options(await temporary(t), store, transform(fullCalendar()));
    opts.collectors = injectedCollectors(calls);
    const result = await updateRollingMarketData(opts);
    assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'validation_error');
    assert.equal(calls.length, 0); assert.equal(store.calls.some(call => call[0] === 'finalize'), false);
    assert.equal(store.calls.find(call => call[0] === 'fail')[1].errorCode, 'validation_error');
  });
}

test('任一采集器失败立即停止并保留旧数据，不泄露供应商异常', async t => {
  const store = ledger(), opts = options(await temporary(t), store), calls = [];
  opts.collectors = injectedCollectors(calls);
  opts.collectors.valuations = async () => ({ status: 'incomplete', blockedBy: 'permission', failedDates: [] });
  const result = await updateRollingMarketData(opts);
  assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'permission_denied');
  assert.deepEqual(calls.map(call => call.api), ['daily']);
  assert.equal(store.calls.some(call => call[0] === 'finalize'), false);
  assert.equal(store.calls.at(-1)[0], 'unlock');
});

test('同一天失败后允许重试成功，成功后不重复下载或清理', async t => {
  const store = ledger(), opts = options(await temporary(t), store);
  opts.collectors.valuations = async () => ({ status: 'incomplete', blockedBy: 'rate_limit' });
  assert.equal((await updateRollingMarketData(opts)).errorCode, 'rate_limited');
  opts.collectors = injectedCollectors();
  assert.equal((await updateRollingMarketData(opts)).status, 'succeeded');
  assert.equal((await updateRollingMarketData(opts)).status, 'already_completed');
  assert.equal(store.calls.filter(call => call[0] === 'begin').length, 2);
  assert.equal(store.calls.filter(call => call[0] === 'finalize').length, 1);
});

test('昨天是休市日时只验证已有开市日，仍可正常滚动清理', async t => {
  const calendar = fullCalendar().map(row => row.cal_date === '20261014' ? { ...row, is_open: 0 } : row);
  const store = ledger(), opts = options(await temporary(t), store, calendar);
  opts.collectors = Object.fromEntries([['daily', 'daily'], ['valuations', 'daily_basic'], ['adjustments', 'adj_factor'], ['industries', 'sw_daily']].map(([name, api]) => [name, async () => completedReport(api, ['daily', 'adj_factor'].includes(api) ? 3 : 2)]));
  const result = await updateRollingMarketData(opts);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(store.calls.find(call => call[0] === 'finalize')[1].expectedDates, ['20261012', '20261013']);
  assert.equal(result.windowEnd, '20261014');
});

test('最终数据库完整性检查失败保留旧数据并记录可重试的失败状态', async t => {
  const error = new Error('secret provider detail'); error.kind = 'incomplete_window';
  const store = ledger({ finalError: error }), opts = options(await temporary(t), store);
  const result = await updateRollingMarketData(opts);
  assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'incomplete_window');
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(store.calls.filter(call => call[0] === 'fail').length, 1);
});

test('抛出网络异常时只返回固定错误码，日志异常不影响运行', async t => {
  const opts = options(await temporary(t));
  opts.log = () => { throw new Error('logger error'); };
  opts.client.query = async () => { const error = new Error('secret access token'); error.kind = 'network'; throw error; };
  const result = await updateRollingMarketData(opts);
  assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'network_error');
  assert.equal(JSON.stringify(result).includes('token'), false);
});

test('真实采集器只补缺失交易日，并保留个股缺行和估值 NULL，不要求每家公司每天有数据', async t => {
  const cacheDir = await temporary(t), store = ledger(), opts = options(cacheDir, store);
  const snapshotDir = join(cacheDir, 'industries', 'SW2021');
  await mkdir(snapshotDir, { recursive: true });
  const fetchedAt = '2026-10-14T00:00:00.000Z';
  await writeFile(join(snapshotDir, 'snapshot.json'), JSON.stringify({ version: 1, source: 'tushare', src: 'SW2021', status: 'completed', snapshotId: 'test', fetchedAt,
    industries: [{ index_code: '851251.SI', industry_name: '白酒', parent_code: '801120.SI', level: 'L3', industry_code: '1234', is_pub: true, src: 'SW2021' }],
    members: [{ l1_code: '801120.SI', l1_name: '食品饮料', l2_code: '801124.SI', l2_name: '白酒', l3_code: '851251.SI', l3_name: '白酒', ts_code: '600519.SH', name: '贵州茅台', in_date: '20210101', out_date: null, is_new: 'Y' }],
    completedCodes: ['851251.SI'],
  }));
  await writeFile(join(snapshotDir, 'snapshot-l2.json'), JSON.stringify({ version: 1, source: 'tushare', src: 'SW2021', level: 'L2', status: 'completed', snapshotId: 'test-l2', fetchedAt,
    industries: [{ index_code: '801124.SI', industry_name: '白酒', parent_code: '801120.SI', level: 'L2', industry_code: '1230', is_pub: true, src: 'SW2021' }],
  }));
  await writeFile(join(snapshotDir, 'snapshot-l2-members.json'), JSON.stringify({ version: 1, source: 'tushare', src: 'SW2021', level: 'L2', status: 'completed', snapshotId: 'test-l2-members', industrySnapshotId: 'test-l2', fetchedAt,
    industries: [{ index_code: '801124.SI', industry_name: '白酒', parent_code: '801120.SI', level: 'L2', industry_code: '1230', is_pub: true, src: 'SW2021' }],
    members: [{ l1_code: '801120.SI', l1_name: '食品饮料', l2_code: '801124.SI', l2_name: '白酒', l3_code: '851251.SI', l3_name: '白酒', ts_code: '600519.SH', name: '贵州茅台', in_date: '20210101', out_date: null, is_new: 'Y' }],
    completedCodes: ['801124.SI'], sourceMembers: 1, unsupportedHistoricalAliases: 0,
  }));
  const saved = [], completed = Object.fromEntries(ROLLING_APIS.map(api => [api, new Set(['20261012'])]));
  const observationStore = {
    migrate: async () => {}, replaceClassification: async () => {}, replaceL2Classification: async () => {}, replaceL2Members: async () => {}, summary: async () => ({}),
    getCompletedDays: async ({ apiName = 'daily' }) => completed[apiName],
    saveDay: async args => { saved.push(args); completed[args.apiName].add(args.tradeDate); },
    markFailedDay: async () => assert.fail('no source day is expected to fail'),
  };
  opts.marketStore = opts.valuationStore = opts.industryStore = observationStore;
  delete opts.collectors;
  const queried = [];
  opts.client.queryAll = async (apiName, { trade_date }) => {
    queried.push([apiName, trade_date]);
    const base = { ts_code: '600519.SH', trade_date };
    if (apiName === 'daily') return [{ ...base, open: 70, high: 72, low: 69, close: 71, pre_close: 70, change: 1, pct_chg: 1, vol: null, amount: null }];
    if (apiName === 'daily_basic') return [{ ...base, close: 71, pe: null, pe_ttm: null, pb: null, total_mv: 1, circ_mv: 1, turnover_rate: null, total_share: 1, float_share: 1 }];
    if (apiName === 'adj_factor') return [{ ...base, adj_factor: 1 }];
    if (apiName === 'sw_daily') return ['851251.SI', '801124.SI'].map(ts_code => ({ ...base, ts_code, open: 100, high: 105, low: 99, close: 103, pct_change: 1, vol: null, amount: null }));
    assert.fail(`unexpected API ${apiName}`);
  };
  const result = await updateRollingMarketData(opts);
  assert.equal(result.status, 'succeeded'); assert.equal(queried.length, 10); assert.equal(saved.length, 10);
  assert.ok(queried.every(([api, date]) => date === '20261013' || date === '20261014' || (['daily', 'adj_factor'].includes(api) && date === '20251014')));
  assert.ok(saved.filter(args => args.apiName === 'daily_basic').every(args => args.rows[0].eps === undefined && args.rows[0].pe_ttm === null));
  assert.ok(saved.filter(args => args.apiName === 'sw_daily').every(args => args.rows.length === 2 && args.rows.some(row => row.ts_code === '801124.SI')));
  assert.ok(ROLLING_APIS.every(api => result.summary[api].skippedDays === 1 && result.summary[api].importedDays === (['daily', 'adj_factor'].includes(api) ? 3 : 2)));
});

test('港股独立使用完整 hk_tradecal 与 HK 缓存，只采集 hk_daily 并保持一自然年窗口', async t => {
  const cacheDir = await temporary(t), store = ledger(), calls = [];
  const result = await updateRollingMarketData({ runDate, cacheDir, store, market: 'HK', marketStore: {},
    client: { query: async (api, params, fields) => {
      assert.equal(api, 'hk_tradecal'); assert.equal(fields, 'cal_date,is_open');
      assert.deepEqual(params, { start_date: window.windowStart, end_date: window.windowEnd });
      return fullCalendar('2025-10-15');
    } },
    collectors: { daily: async options => {
      calls.push(options);
      return { status: 'completed', markets: [{ ...completedReport('daily').markets[0], market: 'HK', apiName: 'hk_daily' }] };
    } },
  });
  assert.equal(result.status, 'succeeded'); assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].markets, ['HK']); assert.equal(calls[0].mode, 'sync');
  const finalize = store.calls.find(call => call[0] === 'finalize')[1];
  assert.deepEqual(finalize.apis, HK_ROLLING_APIS); assert.deepEqual(finalize.expectedDates, openDates);
  assert.deepEqual(Object.keys(finalize.summary), ['hk_daily']);
  const calendar = JSON.parse(await readFile(join(cacheDir, 'HK', `calendar-${window.windowStart}-${window.windowEnd}.json`), 'utf8'));
  assert.equal(calendar.market, 'HK'); assert.deepEqual(calendar.dates, openDates);
});

test('港股权限或限流失败记录可重试状态，不允许清理历史数据或误读 A 股结果', async t => {
  for (const blockedBy of ['permission', 'rate_limit']) {
    const store = ledger(), opts = options(await temporary(t), store);
    opts.market = 'HK'; delete opts.valuationStore; delete opts.industryStore;
    opts.client.query = async () => fullCalendar('2025-10-15');
    opts.collectors = { daily: async () => ({ status: 'incomplete', markets: [{ market: 'HK', apiName: 'hk_daily', status: 'incomplete', blockedBy }] }) };
    const result = await updateRollingMarketData(opts);
    assert.equal(result.status, 'failed'); assert.equal(result.errorCode, blockedBy === 'permission' ? 'permission_denied' : 'rate_limited');
    assert.equal(store.calls.some(call => call[0] === 'finalize'), false);
    assert.equal(store.calls.find(call => call[0] === 'fail')[1].errorCode, result.errorCode);
  }
});

test('港股真实采集器按 HK 完成记录增量补齐，正常保留停牌个股的缺行', async t => {
  const cacheDir = await temporary(t), store = ledger(), saved = [], queries = [];
  const marketStore = {
    migrate: async () => {},
    getCompletedDays: async args => { assert.equal(args.market, 'HK'); return new Set(['20261012']); },
    saveDay: async args => saved.push(args),
    markFailedDay: async () => assert.fail('港股交易日应完整完成'), summary: async () => ({}),
  };
  const result = await updateRollingMarketData({ runDate, cacheDir, market: 'HK', store, marketStore,
    client: { query: async api => { assert.equal(api, 'hk_tradecal'); return fullCalendar('2025-10-15'); },
      queryAll: async (api, { trade_date }) => {
        queries.push([api, trade_date]);
        return [{ ts_code: '00700.HK', trade_date, open: 70, high: 72, low: 69, close: 71, pre_close: 70, change: 1, pct_chg: 1, vol: null, amount: null }];
      } },
  });
  assert.equal(result.status, 'succeeded'); assert.deepEqual(queries, [['hk_daily', '20261014'], ['hk_daily', '20261013']]);
  assert.equal(saved.length, 2); assert.ok(saved.every(day => day.market === 'HK' && day.apiName === 'hk_daily'));
  assert.equal(result.summary.hk_daily.skippedDays, 1); assert.equal(result.summary.hk_daily.importedDays, 2);
});
