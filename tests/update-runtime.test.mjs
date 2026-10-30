import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarketUpdateRuntime } from '../backend/market-data/update-runtime.mjs';

function fixture({ markets, outcomes = {}, update, token = 'injected-token', hkProvider, hkPriceScope, hkValuationScope, hkForecastScope, newsEnabled = false, newsUpdate,
  hkValuationEnabled = true, hkValuationUpdate, hkValuationOutcome, hkValuationCollector,
  hkForecastEnabled = false, omitHkForecastEnabled = false, hkForecastUpdate, hkForecastOutcome, hkForecastCollector, topLevelHkForecastCollector,
  hkIndexEnabled = false, hkIndexUpdate, hkIndexOutcome } = {}) {
  const calls = [], newsCalls = [], hkValuationCalls = [], hkForecastCalls = [], hkIndexCalls = [], factories = [], closed = [], logs = [];
  let schedule;
  const createStore = name => options => {
    factories.push({ name, ...options });
    return { name, market: options.market, close: async () => closed.push(options.market ? `${name}:${options.market}` : name) };
  };
  const perform = async options => {
    calls.push(options);
    return update ? update(options) : { status: outcomes[options.market] ?? 'succeeded', runDate: options.runDate,
      windowStart: '20251019', windowEnd: '20261018', summary: { [options.market]: true },
      ...(['failed', 'partial'].includes(outcomes[options.market]) ? { errorCode: 'permission_denied' } : {}) };
  };
  const runtime = createMarketUpdateRuntime({ connectionString: 'injected-database', token, cacheDir: '/injected-cache',
    newsEnabled, hkValuationEnabled, hkIndexEnabled,
    ...(!omitHkForecastEnabled ? { hkForecastEnabled } : {}),
    ...(topLevelHkForecastCollector ? { hkForecastCollector: topLevelHkForecastCollector } : {}),
    ...(hkProvider ? { hkProvider } : {}),
    ...(hkPriceScope ? { hkPriceScope } : {}),
    ...(hkForecastScope ? { hkForecastScope } : {}),
    ...(hkValuationScope ? { hkValuationScope } : {}),
    ...(markets ? { markets } : {}), now: () => new Date('2026-10-19T01:00:00Z'), log: value => logs.push(value),
    dependencies: {
      createForecastStore: () => ({ close: async () => {} }),
      updateRollingForecasts: async () => ({ status: 'succeeded' }),
      createMarketStore: createStore('market'), createValuationStore: createStore('valuation'), createIndustryStore: createStore('industry'),
      createRollingUpdateStore: createStore('rolling'),
      createHkPoolStore: createStore('hkpool'),
      createHkMarketStore: createStore('hkmarket'),
      createHkValuationStore: createStore('hkvaluation'),
      createHkForecastStore: createStore('hkforecast'),
      createHkIndexStore: createStore('hkindex'),
      createNewsStore: createStore('news'), createDailyNewsUpdateStore: createStore('newsrun'),
      createTushareClient: options => { factories.push({ name: 'client', ...options }); return {}; },
      createDailyScheduler: options => {
        schedule = { ...options, starts: 0, stops: 0, nextRunAt: '2026-10-19T22:00:00.000Z',
          start() { this.starts++; }, stop() { this.stops++; } };
        return schedule;
      },
      updateRollingMarketData: perform, updateRollingHongKongPool: perform, updateRollingHongKongMarket: perform,
      hkValuationCollector,
      hkForecastCollector,
      updateRollingHkValuations: async options => {
        hkValuationCalls.push(options);
        return hkValuationUpdate ? hkValuationUpdate(options) : { status: hkValuationOutcome ?? outcomes.HK ?? 'succeeded',
          runDate: options.runDate, source: 'baidu', apiName: 'baidu_hk_valuation', summary: {} };
      },
      updateRollingHkForecasts: async options => {
        hkForecastCalls.push(options);
        return hkForecastUpdate ? hkForecastUpdate(options) : { status: hkForecastOutcome ?? outcomes.HK ?? 'succeeded',
          runDate: options.runDate, source: 'etnet', apiName: 'etnet_hk_profit_forecast', summary: {} };
      },
      updateDailyClsNews: async options => {
        newsCalls.push(options);
        return newsUpdate ? newsUpdate(options) : { status: 'succeeded', runDate: options.runDate, sourceApi: 'cls_web', summary: {} };
      },
      updateRollingHkIndex: async options => {
        hkIndexCalls.push(options);
        return hkIndexUpdate ? hkIndexUpdate(options) : { status: hkIndexOutcome ?? 'succeeded', runDate: options.runDate, source: 'tencent', apiName: 'tencent_hsi_daily', summary: {} };
      },
    },
  });
  return { runtime, calls, newsCalls, hkValuationCalls, hkForecastCalls, hkIndexCalls, factories, closed, logs, get schedule() { return schedule; } };
}

test('默认每日北京时间 06:00 更新两地，A 当天已成功仍执行 HK，HK失败顶层退出失败且保留A成功详情', async () => {
  const f = fixture({ outcomes: { A: 'already_completed', HK: 'failed' } });
  f.runtime.start(); f.runtime.start();
  assert.equal(f.schedule.hour, 6); assert.equal(f.schedule.catchUp, true); assert.equal(f.schedule.starts, 1);
  assert.deepEqual(f.runtime.snapshot().markets, ['A', 'HK']);
  const result = await f.runtime.runOnce();
  assert.deepEqual(f.calls.map(call => call.market), ['A', 'HK']);
  assert.ok(f.calls.every(call => call.runDate === '2026-10-19' && call.store.market === call.market));
  assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'permission_denied');
  assert.equal(result.markets.A.status, 'already_completed'); assert.equal(result.markets.HK.status, 'failed');
  assert.deepEqual(result.summary, { A: true });
  assert.equal(f.runtime.snapshot().lastResult.markets.HK.errorCode, 'permission_denied');
  assert.deepEqual(f.factories.filter(item => item.name === 'rolling').map(item => item.market), ['A']);
  assert.equal(f.calls[1].store.name, 'hkpool'); assert.equal(f.calls[1].provider, 'eastmoney');
  assert.equal(f.factories.filter(item => item.name === 'client')[1].maxRetries, 0);
  await f.runtime.close();
  assert.deepEqual(f.closed.sort(), ['hkpool:HK', 'hkvaluation', 'industry', 'market', 'rolling:A', 'valuation']);
  assert.equal(f.schedule.stops, 1);
});

test('任一市场的异常不阻断另一市场执行，日志不泄露原始异常', async () => {
  const f = fixture({ markets: ['HK', 'A'], update: async ({ market }) => {
    if (market === 'HK') throw new Error('private upstream token');
    return { status: 'succeeded', summary: {}, runDate: '2026-10-19' };
  } });
  const result = await f.runtime.runOnce();
  assert.deepEqual(f.calls.map(call => call.market), ['HK', 'A']);
  assert.equal(result.markets.A.status, 'succeeded'); assert.equal(result.markets.HK.status, 'failed');
  assert.equal(result.status, 'failed'); assert.equal(JSON.stringify(f.logs).includes('private'), false);
  await f.runtime.close();
});

test('可以独立重试 HK，全部完成与锁忙状态会正确汇总', async () => {
  for (const outcome of ['succeeded', 'already_completed', 'busy']) {
    const f = fixture({ markets: ['HK'], outcomes: { HK: outcome } });
    const result = await f.runtime.runOnce({ runDate: '2026-10-19' });
    assert.equal(result.status, outcome); assert.deepEqual(Object.keys(result.markets), ['HK']);
    assert.equal(f.calls[0].market, 'HK'); assert.equal(f.calls[0].valuationStore, undefined);
    assert.equal(f.factories.some(item => item.name === 'valuation' || item.name === 'industry'), false);
    await f.runtime.close(); assert.deepEqual(f.closed.sort(), ['hkpool:HK', 'hkvaluation']);
  }
});

test('运行中调用复用同一任务，关闭等待两个市场并禁止新执行', async () => {
  let resolve;
  const f = fixture({ update: async ({ market }) => {
    if (market === 'A') await new Promise(done => { resolve = done; });
    return { status: 'succeeded', summary: {} };
  } });
  const first = f.runtime.runOnce(), second = f.runtime.runOnce();
  assert.equal(first, second); assert.equal(f.runtime.snapshot().running, true);
  const closing = f.runtime.close(); assert.equal(f.closed.length, 0);
  assert.equal((await f.runtime.runOnce()).status, 'disabled');
  resolve(); await closing;
  assert.equal(f.calls.length, 2); assert.equal(f.hkValuationCalls.length, 1); assert.equal(f.closed.length, 6); assert.equal(f.runtime.snapshot().running, false);
});

test('未配置数据库或 token 不创建连接，拒绝无效市场', async () => {
  const runtime = createMarketUpdateRuntime();
  assert.equal(runtime.snapshot().enabled, false);
  assert.deepEqual(await runtime.runOnce(), { status: 'disabled', reason: 'not_configured' });
  await runtime.close();
  for (const markets of [[], ['US'], 'HK']) assert.throws(() => createMarketUpdateRuntime({ markets }), /市场无效/);
});

test('HK 名单默认东方财富，无 Tushare token 仍可运行且不创建 Tushare 客户端', async () => {
  const f = fixture({ markets: ['HK'], token: '' });
  assert.equal(f.runtime.snapshot().enabled, true); assert.equal(f.runtime.snapshot().hkProvider, 'eastmoney');
  assert.equal((await f.runtime.runOnce()).status, 'succeeded');
  assert.equal(f.calls[0].client, undefined); assert.equal(f.factories.some(item => item.name === 'client'), false);
  await f.runtime.close();
  const disabled = fixture({ markets: ['HK'], token: '', hkProvider: 'tushare' });
  const result = await disabled.runtime.runOnce();
  assert.equal(result.status, 'partial'); assert.equal(result.markets.HK.status, 'disabled');
  assert.equal(result.hkValuations.status, 'succeeded'); assert.equal(disabled.hkValuationCalls.length, 1);
  assert.equal(disabled.factories.some(item => item.name === 'client'), false); await disabled.runtime.close();
});

test('名单部分完成必须保留 partial，显式 Tushare 选择会传给名单采集器', async () => {
  const f = fixture({ outcomes: { A: 'already_completed', HK: 'partial' }, hkProvider: 'tushare' });
  const result = await f.runtime.runOnce();
  assert.equal(result.status, 'partial'); assert.equal(result.markets.HK.status, 'partial');
  assert.equal(f.calls[1].provider, 'tushare'); assert.equal(f.calls[1].store.name, 'hkpool');
  await f.runtime.close();
});

test('Yahoo 是显式第三来源且无需 Tushare token，仍只调用名单更新器', async () => {
  const f = fixture({ markets: ['HK'], hkProvider: 'yahoo', token: '' });
  assert.equal(f.runtime.snapshot().hkProvider, 'yahoo');
  assert.equal((await f.runtime.runOnce()).status, 'succeeded');
  assert.equal(f.calls[0].provider, 'yahoo'); assert.equal(f.calls[0].store.name, 'hkpool');
  assert.equal(f.factories.some(value => value.name === 'client'), false);
  await f.runtime.close();
});

test('Tencent 显式选择无需 Tushare token，其他来源默认保持东方财富', async () => {
  const f = fixture({ markets: ['HK'], hkProvider: 'tencent', token: '' });
  assert.equal(f.runtime.snapshot().hkProvider, 'tencent');
  assert.equal((await f.runtime.runOnce()).status, 'succeeded');
  assert.equal(f.calls[0].provider, 'tencent'); assert.equal(f.calls[0].store.name, 'hkpool');
  assert.equal(f.factories.some(value => value.name === 'client'), false);
  await f.runtime.close();
  const defaults = fixture({ markets: ['HK'], token: '' });
  assert.equal(defaults.runtime.snapshot().hkProvider, 'eastmoney'); await defaults.runtime.close();
});

test('全市场腾讯范围路由到独立store和更新器，PE/PB与EPS仍用原投资池任务', async () => {
  const f = fixture({ markets: ['HK'], hkPriceScope: 'all', hkProvider: 'tencent', hkForecastEnabled: true });
  const result = await f.runtime.runOnce();
  assert.equal(result.status, 'succeeded'); assert.equal(f.runtime.snapshot().hkPriceScope, 'all');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].store.name, 'hkmarket');
  assert.equal(f.calls[0].client !== undefined, true); assert.equal(f.calls[0].market, 'HK');
  assert.equal(f.factories.some(value => value.name === 'hkpool'), false);
  assert.equal(f.hkValuationCalls.length, 1); assert.equal(f.hkForecastCalls.length, 1);
  assert.equal(f.hkValuationCalls[0].universePath, undefined); assert.equal(f.hkForecastCalls[0].universePath, undefined);
  await f.runtime.close(); assert.deepEqual(f.closed.sort(), ['hkforecast', 'hkmarket:HK', 'hkvaluation']);
});

test('全市场目录刷新需要Tushare token，缺失时停用日线但独立估值继续且拒绝非腾讯来源', async () => {
  const f = fixture({ markets: ['HK'], hkPriceScope: 'all', hkProvider: 'tencent', token: '' });
  const result = await f.runtime.runOnce();
  assert.equal(result.status, 'partial'); assert.equal(result.markets.HK.status, 'disabled');
  assert.equal(f.calls.length, 0); assert.equal(f.factories.some(value => ['hkpool', 'hkmarket', 'client'].includes(value.name)), false);
  assert.equal(f.hkValuationCalls.length, 1); await f.runtime.close();
  for (const hkProvider of ['tushare', 'eastmoney', 'yahoo']) assert.throws(() => createMarketUpdateRuntime({ hkPriceScope: 'all', hkProvider }), /全市场日线仅支持腾讯/);
  assert.throws(() => createMarketUpdateRuntime({ hkPriceScope: 'invalid' }), /范围须为 pool 或 all/);
});

test('06点同一回调同时更新前一日新闻，市场当天完成也不会跳过新闻', async () => {
  const f = fixture({ newsEnabled: true, outcomes: { A: 'already_completed', HK: 'already_completed' } });
  f.runtime.start();
  assert.equal(f.schedule.hour, 6);
  const result = await f.schedule.run({ runDate: '2026-10-19' });
  assert.equal(f.newsCalls.length, 1);
  assert.equal(f.newsCalls[0].runDate, '2026-10-19');
  assert.equal(f.newsCalls[0].now.toISOString(), '2026-10-19T01:00:00.000Z');
  assert.equal(f.newsCalls[0].newsStore.name, 'news'); assert.equal(f.newsCalls[0].store.name, 'newsrun');
  assert.equal(f.newsCalls[0].cacheDir, '/injected-cache');
  assert.equal(result.marketStatus, 'already_completed'); assert.equal(result.news.status, 'succeeded');
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(f.runtime.snapshot().news, { enabled: true, sourceApi: 'cls_web', target: 'previous_calendar_day' });
  await f.runtime.close(); assert.ok(f.closed.includes('news')); assert.ok(f.closed.includes('newsrun'));
});

test('行情仍在等待时新闻可独立完成，重入和关闭仍覆盖两类任务', async () => {
  let finishMarket;
  const f = fixture({ newsEnabled: true, markets: ['A'], update: () => new Promise(resolve => { finishMarket = resolve; }) });
  const first = f.runtime.runOnce(), second = f.runtime.runOnce();
  assert.equal(first, second); assert.equal(f.newsCalls.length, 1);
  await Promise.resolve(); assert.equal(f.runtime.snapshot().running, true);
  const closing = f.runtime.close(); assert.equal(f.closed.length, 0);
  finishMarket({ status: 'failed', errorCode: 'permission_denied', summary: {} });
  await closing;
  assert.equal(f.runtime.snapshot().lastResult.news.status, 'succeeded');
  assert.equal(f.runtime.snapshot().lastResult.markets.A.status, 'failed');
  assert.equal(f.closed.length, 6);
});

test('新闻失败单独暴露安全错误且保留行情成功，不泄露异常详情', async () => {
  const f = fixture({ newsEnabled: true, newsUpdate: async () => { throw new Error('private upstream token'); } });
  const result = await f.runtime.runOnce();
  assert.equal(result.status, 'failed'); assert.equal(result.marketStatus, 'succeeded');
  assert.equal(result.markets.A.status, 'succeeded'); assert.equal(result.markets.HK.status, 'succeeded');
  assert.equal(result.news.status, 'failed'); assert.equal(result.errorCode, 'news_update_error');
  assert.doesNotMatch(JSON.stringify(f.logs), /private|upstream token/);
  await f.runtime.close();
});

test('新闻无需Tushare token，关闭新闻选项则不创建新闻连接', async () => {
  const f = fixture({ markets: ['A'], token: '', newsEnabled: true });
  assert.equal(f.runtime.snapshot().enabled, true);
  const result = await f.runtime.runOnce();
  assert.equal(result.markets.A.status, 'disabled'); assert.equal(result.news.status, 'succeeded');
  assert.equal(f.factories.some(item => item.name === 'client'), false);
  await f.runtime.close();
  const marketOnly = fixture({ markets: ['A'], newsEnabled: false });
  assert.equal((await marketOnly.runtime.runOnce()).news, undefined);
  assert.equal(marketOnly.runtime.snapshot().news.enabled, false);
  assert.equal(marketOnly.factories.some(item => item.name === 'news' || item.name === 'newsrun'), false);
  await marketOnly.runtime.close();
});

test('06点同一调度在HK价格已完成后仍更新独立估值，不需要Tushare token并传递注入采集器', async () => {
  const order = [], collector = async () => ({ rows: [] });
  const f = fixture({ markets: ['HK'], hkProvider: 'tencent', token: '', newsEnabled: true,
    hkValuationCollector: collector,
    update: async () => { order.push('prices'); return { status: 'already_completed', summary: { prices: 28 } }; },
    hkValuationUpdate: async options => { order.push('valuations'); assert.equal(options.collector, collector);
      return { status: 'succeeded', apiName: 'baidu_hk_valuation', summary: { rows: 6792 } }; },
  });
  f.runtime.start(); const result = await f.schedule.run({ runDate: '2026-10-19' });
  assert.equal(f.schedule.hour, 6); assert.deepEqual(order, ['prices', 'valuations']);
  assert.equal(f.hkValuationCalls.length, 1); assert.equal(f.hkValuationCalls[0].store.name, 'hkvaluation');
  assert.equal(f.hkValuationCalls[0].runDate, '2026-10-19'); assert.equal(f.hkValuationCalls[0].cacheDir, '/injected-cache');
  assert.equal(f.factories.some(value => value.name === 'client'), false);
  assert.equal(result.markets.HK.status, 'already_completed'); assert.deepEqual(result.markets.HK.summary, { prices: 28 });
  assert.equal(result.marketStatus, 'already_completed'); assert.equal(result.hkValuations.status, 'succeeded');
  assert.equal(result.news.status, 'succeeded'); assert.equal(result.status, 'succeeded');
  assert.deepEqual(f.runtime.snapshot().hkValuations, { enabled: true, sourceApi: 'baidu_hk_valuation', scope: 'pool', concurrency: 1 });
  await f.runtime.close(); assert.ok(f.closed.includes('hkvaluation'));
});

test('HK价格异常仍运行估值且保留A、HK、估值和新闻各自失败，不泄露原始异常', async () => {
  const f = fixture({ newsEnabled: true, update: async ({ market }) => {
    if (market === 'HK') throw new Error('private price token');
    return { status: 'failed', errorCode: 'permission_denied', summary: { A: true } };
  }, hkValuationUpdate: async () => { throw new Error('private valuation token'); },
  newsUpdate: async () => { throw new Error('private news token'); } });
  const result = await f.runtime.runOnce();
  assert.equal(f.hkValuationCalls.length, 1); assert.equal(f.newsCalls.length, 1);
  assert.equal(result.status, 'failed'); assert.equal(result.marketStatus, 'failed');
  assert.equal(result.markets.A.errorCode, 'permission_denied');
  assert.equal(result.markets.HK.errorCode, 'provider_error');
  assert.equal(result.hkValuations.errorCode, 'hk_valuation_update_error');
  assert.equal(result.news.errorCode, 'news_update_error');
  assert.doesNotMatch(JSON.stringify({ result, logs: f.logs }), /private|valuation token|price token|news token/);
  await f.runtime.close();
});

test('独立港股估值的失败、部分完成与锁忙都参与顶层结果，不覆盖价格结果', async () => {
  for (const status of ['failed', 'partial', 'busy', 'already_completed']) {
    const f = fixture({ markets: ['HK'], outcomes: { HK: 'already_completed' }, hkValuationOutcome: status });
    const result = await f.runtime.runOnce();
    assert.equal(result.status, status); assert.equal(result.marketStatus, 'already_completed');
    assert.equal(result.markets.HK.status, 'already_completed'); assert.equal(result.hkValuations.status, status);
    assert.equal(f.hkValuationCalls.length, 1); await f.runtime.close();
  }
});

test('估值运行中重入复用任务，关闭等待估值完成再关闭新store且拒绝新执行', async () => {
  let beginValuation, finishValuation;
  const began = new Promise(resolve => { beginValuation = resolve; });
  const f = fixture({ markets: ['HK'], hkValuationUpdate: async () => {
    beginValuation(); return new Promise(resolve => { finishValuation = resolve; });
  } });
  const first = f.runtime.runOnce(); await began;
  assert.equal(f.runtime.runOnce(), first); assert.equal(f.runtime.snapshot().running, true);
  const closing = f.runtime.close(); assert.equal(f.closed.length, 0);
  assert.equal((await f.runtime.runOnce()).status, 'disabled');
  finishValuation({ status: 'succeeded', summary: { rows: 6792 } }); await closing;
  assert.equal(f.runtime.snapshot().running, false); assert.equal(f.runtime.snapshot().lastResult.hkValuations.summary.rows, 6792);
  assert.deepEqual(f.closed.sort(), ['hkpool:HK', 'hkvaluation']); assert.equal(f.hkValuationCalls.length, 1);
});

test('关闭港股估值选项或只选择A股时不创建港股估值连接和任务', async () => {
  for (const options of [{ markets: ['HK'], hkValuationEnabled: false }, { markets: ['A'] }]) {
    const f = fixture(options), result = await f.runtime.runOnce();
    assert.equal(result.status, 'succeeded'); assert.equal(result.hkValuations, undefined);
    assert.equal(f.runtime.snapshot().hkValuations.enabled, false); assert.equal(f.hkValuationCalls.length, 0);
    assert.equal(f.factories.some(value => value.name === 'hkvaluation'), false); await f.runtime.close();
  }
  const f = fixture({ markets: ['HK'], hkProvider: 'tushare', token: '', hkValuationEnabled: false });
  assert.equal((await f.runtime.runOnce()).status, 'disabled'); assert.equal(f.factories.length, 0); await f.runtime.close();
});

test('港股EPS默认启用且无需token，在价格之后与估值独立采集并通过快照暴露来源', async () => {
  const order = [], collector = async () => ({ rows: [] });
  const f = fixture({ markets: ['HK'], token: '', hkProvider: 'tencent', newsEnabled: true,
    omitHkForecastEnabled: true, hkForecastCollector: collector,
    update: async () => { order.push('prices'); return { status: 'already_completed', summary: { prices: 28 } }; },
    hkValuationUpdate: async () => { order.push('valuations'); return { status: 'already_completed', summary: {} }; },
    hkForecastUpdate: async options => { order.push('forecasts'); assert.equal(options.collector, collector);
      return { status: 'succeeded', summary: { rows: 573 }, apiName: 'etnet_hk_profit_forecast' }; },
  });
  f.runtime.start(); const result = await f.schedule.run({ runDate: '2026-10-19' });
  assert.deepEqual(order, ['prices', 'valuations', 'forecasts']); assert.equal(f.schedule.hour, 6);
  assert.equal(f.hkForecastCalls.length, 1); assert.equal(f.hkForecastCalls[0].store.name, 'hkforecast');
  assert.equal(f.hkForecastCalls[0].runDate, '2026-10-19'); assert.equal(f.hkForecastCalls[0].cacheDir, '/injected-cache');
  assert.equal(f.factories.some(value => value.name === 'client'), false);
  assert.equal(result.marketStatus, 'already_completed'); assert.equal(result.hkForecasts.status, 'succeeded');
  assert.equal(result.hkValuations.status, 'already_completed'); assert.equal(result.news.status, 'succeeded'); assert.equal(result.status, 'succeeded');
  assert.deepEqual(f.runtime.snapshot().hkForecasts, { enabled: true, sourceApi: 'etnet_hk_profit_forecast', scope: 'pool', concurrency: 1 });
  await f.runtime.close(); assert.ok(f.closed.includes('hkforecast'));
});

test('HK价格和估值异常仍执行独立EPS，保留A、新闻和每类安全错误', async () => {
  const f = fixture({ hkForecastEnabled: true, newsEnabled: true, update: async ({ market }) => {
    if (market === 'HK') throw new Error('private price token');
    return { status: 'succeeded', summary: { A: true } };
  }, hkValuationUpdate: async () => { throw new Error('private valuation token'); },
  hkForecastUpdate: async () => { throw new Error('private forecast token'); } });
  const result = await f.runtime.runOnce();
  assert.equal(f.hkForecastCalls.length, 1); assert.equal(f.newsCalls.length, 1);
  assert.equal(result.status, 'failed'); assert.equal(result.markets.A.status, 'succeeded');
  assert.equal(result.markets.HK.errorCode, 'provider_error'); assert.equal(result.hkValuations.errorCode, 'hk_valuation_update_error');
  assert.equal(result.hkForecasts.errorCode, 'hk_forecast_update_error'); assert.equal(result.news.status, 'succeeded');
  assert.doesNotMatch(JSON.stringify({ result, logs: f.logs }), /private|forecast token|valuation token|price token/);
  await f.runtime.close();
});

test('EPS独立汇总 failed/partial/busy/already_completed，不覆盖HK价格和估值结果', async () => {
  for (const status of ['failed', 'partial', 'busy', 'already_completed']) {
    const f = fixture({ markets: ['HK'], outcomes: { HK: 'already_completed' }, hkForecastEnabled: true, hkForecastOutcome: status });
    const result = await f.runtime.runOnce();
    assert.equal(result.status, status); assert.equal(result.marketStatus, 'already_completed');
    assert.equal(result.markets.HK.status, 'already_completed'); assert.equal(result.hkValuations.status, 'already_completed');
    assert.equal(result.hkForecasts.status, status); assert.equal(f.hkForecastCalls.length, 1); await f.runtime.close();
  }
});

test('EPS运行期间重入复用并且close等其完成后关闭新增store，顶层collector优先', async () => {
  let beginForecast, finishForecast;
  const began = new Promise(resolve => { beginForecast = resolve; }), firstCollector = () => {}, topCollector = () => {};
  const f = fixture({ markets: ['HK'], hkForecastEnabled: true, hkForecastCollector: firstCollector, topLevelHkForecastCollector: topCollector,
    hkForecastUpdate: async options => { assert.equal(options.collector, topCollector); beginForecast();
      return new Promise(resolve => { finishForecast = resolve; }); },
  });
  const first = f.runtime.runOnce(); await began; assert.equal(f.runtime.runOnce(), first);
  const closing = f.runtime.close(); assert.equal(f.closed.length, 0); assert.equal((await f.runtime.runOnce()).status, 'disabled');
  finishForecast({ status: 'succeeded', summary: { rows: 573 } }); await closing;
  assert.equal(f.runtime.snapshot().lastResult.hkForecasts.summary.rows, 573); assert.equal(f.runtime.snapshot().running, false);
  assert.deepEqual(f.closed.sort(), ['hkforecast', 'hkpool:HK', 'hkvaluation']);
});

test('关闭EPS或只选择A时无新增连接；HK即使Tushare行情缺token也能单独更新EPS', async () => {
  for (const options of [{ markets: ['HK'], hkForecastEnabled: false }, { markets: ['A'], hkForecastEnabled: true }]) {
    const f = fixture(options), result = await f.runtime.runOnce();
    assert.equal(result.hkForecasts, undefined); assert.equal(f.runtime.snapshot().hkForecasts.enabled, false);
    assert.equal(f.hkForecastCalls.length, 0); assert.equal(f.factories.some(value => value.name === 'hkforecast'), false);
    await f.runtime.close();
  }
  const f = fixture({ markets: ['HK'], hkProvider: 'tushare', token: '', hkValuationEnabled: false, hkForecastEnabled: true });
  const result = await f.runtime.runOnce();
  assert.equal(result.status, 'partial'); assert.equal(result.markets.HK.status, 'disabled'); assert.equal(result.hkForecasts.status, 'succeeded');
  assert.deepEqual(f.factories.map(value => value.name), ['hkforecast']); await f.runtime.close();
});

test('全市场EPS范围独立于价格范围，传入名册客户端并暴露三并发配置', async () => {
  const f = fixture({ markets: ['HK'], hkPriceScope: 'pool', hkForecastScope: 'all', hkForecastEnabled: true });
  const result = await f.runtime.runOnce();
  assert.equal(result.hkForecasts.status, 'succeeded');
  assert.equal(f.hkForecastCalls[0].scope, 'all'); assert.equal(f.hkForecastCalls[0].concurrency, 3);
  assert.ok(f.hkForecastCalls[0].client);
  assert.deepEqual(f.runtime.snapshot().hkForecasts, { enabled: true, sourceApi: 'etnet_hk_profit_forecast', scope: 'all', concurrency: 3 });
  await f.runtime.close();
  assert.throws(() => createMarketUpdateRuntime({ hkForecastScope: 'invalid' }), /预测更新范围/);
});

test('全市场估值独立范围与三并发透传，估值仍在运行时EPS可独立完成', async () => {
  let finishValuations, beginEPS;
  const epsStarted = new Promise(resolve => { beginEPS = resolve; });
  const f = fixture({ markets: ['HK'], hkPriceScope: 'pool', hkValuationScope: 'all', hkForecastScope: 'all', hkForecastEnabled: true,
    hkValuationUpdate: options => {
      assert.equal(options.scope, 'all'); assert.equal(options.concurrency, 3); assert.ok(options.client);
      return new Promise(resolve => { finishValuations = resolve; });
    }, hkForecastUpdate: async options => { assert.equal(options.scope, 'all'); beginEPS(); return { status: 'succeeded', summary: { rows: 12 } }; },
  });
  const updating = f.runtime.runOnce(); await epsStarted;
  assert.equal(f.runtime.snapshot().running, true);
  assert.equal(f.hkForecastCalls.length, 1);
  assert.deepEqual(f.runtime.snapshot().hkValuations, { enabled: true, sourceApi: 'baidu_hk_valuation', scope: 'all', concurrency: 3 });
  const closing = f.runtime.close(); assert.equal(f.closed.length, 0);
  finishValuations({ status: 'succeeded', summary: { rows: 245 } });
  const result = await updating; await closing;
  assert.equal(result.hkForecasts.summary.rows, 12); assert.equal(result.hkValuations.summary.rows, 245);
  assert.ok(f.closed.includes('hkforecast')); assert.ok(f.closed.includes('hkvaluation'));
  assert.throws(() => createMarketUpdateRuntime({ hkValuationScope: 'invalid' }), /估值更新范围/);
});

test('恒指每日06点与行情并行启动，不等待港股价格/估值/EPS长任务，关闭等待全部任务', async () => {
  let finishMarket, indexDone;
  const indexed = new Promise(resolve => { indexDone = resolve; });
  const f = fixture({ markets: ['HK'], hkIndexEnabled: true, hkForecastEnabled: true,
    update: () => new Promise(resolve => { finishMarket = resolve; }),
    hkIndexUpdate: async options => { assert.equal(options.runDate, '2026-10-20'); assert.equal(options.store.name, 'hkindex'); indexDone(); return { status: 'succeeded', summary: { rows: 245 } }; },
  });
  f.runtime.start(); assert.equal(f.schedule.hour, 6);
  const updating = f.schedule.run({ runDate: '2026-10-20' }); await indexed;
  assert.equal(f.hkValuationCalls.length, 0); assert.equal(f.hkForecastCalls.length, 0);
  assert.equal(f.runtime.snapshot().running, true);
  const closing = f.runtime.close(); assert.equal(f.closed.length, 0);
  finishMarket({ status: 'succeeded', summary: {} });
  const result = await updating; await closing;
  assert.equal(result.hkIndex.summary.rows, 245); assert.equal(result.status, 'succeeded');
  assert.ok(f.closed.includes('hkindex')); assert.equal(f.hkIndexCalls.length, 1);
  assert.deepEqual(f.runtime.snapshot().hkIndex, { enabled: true, sourceApi: 'tencent_hsi_daily', indexCode: 'HSI', target: 'previous_calendar_day' });
});

test('恒指无需Tushare token且失败独立汇总，不泄露原异常', async () => {
  const f = fixture({ markets: ['HK'], token: '', hkProvider: 'tushare', hkValuationEnabled: false, hkIndexEnabled: true,
    hkIndexUpdate: async () => { throw new Error('private index token'); } });
  const result = await f.runtime.runOnce();
  assert.equal(result.markets.HK.status, 'disabled'); assert.equal(result.hkIndex.errorCode, 'hk_index_update_error');
  assert.equal(result.status, 'failed'); assert.deepEqual(f.factories.map(item => item.name), ['hkindex']);
  assert.doesNotMatch(JSON.stringify({ result, logs: f.logs }), /private index token/); await f.runtime.close();
  const a = fixture({ markets: ['A'], hkIndexEnabled: true }); await a.runtime.runOnce();
  assert.equal(a.hkIndexCalls.length, 0); assert.equal(a.runtime.snapshot().hkIndex.enabled, false); await a.runtime.close();
});
