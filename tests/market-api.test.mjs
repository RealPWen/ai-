import test from 'node:test';
import assert from 'node:assert/strict';
import { createResearchServer } from '../backend/app.mjs';
import { ResearchError } from '../backend/src/errors.mjs';
import { createResearchService } from '../frontend/src/services/research-service.js';
import { adapters } from '../frontend/src/services/adapters.js';
import { endpoints } from '../frontend/src/api/endpoints.js';

async function fixture(t, marketService) {
  let inferenceCalls = 0;
  const server = createResearchServer({ marketService, health: { status: 'ok' }, service: { generate() { inferenceCalls += 1; throw new Error('unexpected inference'); } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { base: `http://127.0.0.1:${server.address().port}`, get inferenceCalls() { return inferenceCalls; } };
}

test('股票/快照/日线 GET 接口分别路由，只读行情无需 ChatGPT 登录或推理', async t => {
  const calls = [];
  const service = Object.fromEntries(['search', 'profile', 'quote', 'prices'].map(method => [method, async params => { calls.push({ method, params }); return { result: method }; }]));
  const f = await fixture(t, service);
  for (const [route, query, method] of [['/api/stocks', 'q=德赛&limit=20', 'search'], ['/api/stocks/profile', 'ticker=002920.SZ', 'profile'], ['/api/market/quote', 'ticker=002920.SZ&asOf=2026-10-13', 'quote'], ['/api/market/prices', 'ticker=002920.SZ&asOf=2026-10-13&period=6m', 'prices']]) {
    const response = await fetch(`${f.base}${route}?${query}`, { headers: { Origin: 'http://127.0.0.1:8765' } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:8765');
    assert.deepEqual(await response.json(), { data: { result: method } });
  }
  assert.deepEqual(calls[0], { method: 'search', params: { q: '德赛', limit: '20' } });
  assert.deepEqual(calls[3].params, { ticker: '002920.SZ', asOf: '2026-10-13', period: '6m' });
  assert.equal(f.inferenceCalls, 0);
});

test('行情接口保留安全业务错误，未配置数据库不冒充空数据', async t => {
  const f = await fixture(t, { quote: async () => { throw new ResearchError('MARKET_NOT_SUPPORTED', '港股行情暂未入库', 400); } });
  const response = await fetch(`${f.base}/api/market/quote?ticker=02313.HK`);
  assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'MARKET_NOT_SUPPORTED');
  const missing = await fixture(t, undefined);
  assert.equal((await fetch(`${missing.base}/api/stocks`)).status, 503);
});

test('前端行情适配保留日期、数值、单位与数据范围，拒绝字符串价格及乱序', () => {
  const quote = adapters.quote({ data: { ticker: '002920.SZ', price: 76.96, asOf: '2026-10-13', requestedAsOf: '2026-10-14', change: -1.64, pctChange: -2.0865, volume: 45472.78, volumeUnit: '手', amount: 349824.18495, amountUnit: '千元', currency: 'CNY', databaseThrough: '2026-10-13' } });
  assert.equal(quote.volumeUnit, '手'); assert.equal(quote.amountUnit, '千元'); assert.equal(quote.pctChange, -2.0865); assert.equal(quote.requestedAsOf, '2026-10-14'); assert.equal(quote.pb, null);
  const series = adapters.prices({ data: { ticker: '002920.SZ', points: [{ date: '2026-10-12', close: 78.6 }, { date: '2026-10-13', close: 76.96 }], meta: { period: '1m', adjustment: 'none' } } });
  assert.equal(series.points[1].value, 76.96); assert.equal(series.meta.adjustment, 'none');
  assert.throws(() => adapters.prices({ data: { points: [{ date: '2026-10-13', close: '76.96' }] } }));
  assert.throws(() => adapters.prices({ data: { points: [...series.points].reverse() } }));
  assert.throws(() => adapters.stocks({ data: [{ ticker: '2313.HK', name: 'invalid HK code' }] }));
  const gap = adapters.prices({ data: { points: [{ date: '2026-10-13', open: null, high: null, low: null, close: null, volume: null, amount: null }] } });
  assert.equal(gap.points[0].close, null); assert.equal(gap.points[0].value, null);
});

test('前端搜索经独立接口层并传取消信号；空行情对象显示empty状态', async () => {
  const requests = [], controller = new AbortController();
  const service = createResearchService({ config: { enabled: true }, routes: endpoints, mappers: adapters,
    client: { get: async (path, options) => { requests.push({ path, ...options }); return path === '/api/stocks' ? { data: [{ ticker: '002920.SZ', name: '德赛西威' }] } : { data: { ticker: '002920.SZ', points: [], meta: {} } }; } } });
  const stocks = await service.searchCompanies({ q: '德赛', limit: 20 }, { signal: controller.signal });
  assert.equal(stocks[0].name, '德赛西威'); assert.equal(requests[0].path, '/api/stocks'); assert.equal(requests[0].signal, controller.signal);
  assert.equal((await service.load('prices', { ticker: '002920.SZ', period: '1m', asOf: '2026-10-13' })).status, 'empty');
});

test('港股查询参数透传只读路由，保持HK未复权/市场筛选与真实来源字段', async t => {
  const calls = [];
  const f = await fixture(t, {
    search: async params => { calls.push(['search', params]); return [{ ticker: '00700.HK', name: '腾讯控股', market: 'HK' }]; },
    quote: async params => { calls.push(['quote', params]); return { ticker: params.ticker, market: 'HK', currency: 'HKD', source: 'Tencent', sourceApi: 'tencent_hk_daily', price: 600, amount: null }; },
    prices: async params => { calls.push(['prices', params]); return { ticker: params.ticker, points: [], meta: { market: 'HK', currency: 'HKD', adjustment: 'none' } }; },
  });
  const stocks = await fetch(`${f.base}/api/stocks?q=腾讯&market=HK&limit=50`);
  assert.equal(stocks.status, 200); assert.equal((await stocks.json()).data[0].market, 'HK');
  const quote = await (await fetch(`${f.base}/api/market/quote?ticker=00700.HK&asOf=2026-10-13`)).json();
  assert.equal(quote.data.source, 'Tencent'); assert.equal(quote.data.sourceApi, 'tencent_hk_daily'); assert.equal(quote.data.amount, null);
  const prices = await fetch(`${f.base}/api/market/prices?ticker=00700.HK&period=1y&adjustment=none`);
  assert.equal(prices.status, 200);
  assert.deepEqual(calls[0], ['search', { q: '腾讯', market: 'HK', limit: '50' }]);
  assert.deepEqual(calls[2], ['prices', { ticker: '00700.HK', period: '1y', adjustment: 'none' }]);
  assert.equal(f.inferenceCalls, 0);
});

test('港股USD行情经适配保留美元柜台币种并拒绝港元成交额单位', () => {
  const quote = { ticker: '00770.HK', market: 'HK', currency: 'USD', amountUnit: '美元', volumeUnit: '股', adjustment: 'none', price: 0.27 };
  const adapted = adapters.quote(quote); assert.equal(adapted.currency, 'USD'); assert.equal(adapted.amountUnit, '美元');
  const prices = { ticker: '00770.HK', points: [], meta: { ...quote } };
  assert.equal(adapters.prices(prices).meta.currency, 'USD');
  for (const amountUnit of ['hkd', '港元']) {
    assert.throws(() => adapters.quote({ ...quote, amountUnit }), /单位或复权/);
    assert.throws(() => adapters.prices({ ...prices, meta: { ...prices.meta, amountUnit } }), /单位或复权/);
  }
  assert.throws(() => adapters.quote({ ...quote, currency: 'CNY' }), /单位或复权/);
});
