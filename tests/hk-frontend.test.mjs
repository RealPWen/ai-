import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { adapters, assertPricesContext, assertQuoteContext } from '../frontend/src/services/adapters.js';
import { endpoints } from '../frontend/src/api/endpoints.js';
import { createResearchService } from '../frontend/src/services/research-service.js';
import { createCompanySession } from '../frontend/src/features/company-session.js';

const quote = () => ({ ticker: '00700.HK', market: 'HK', asOf: '2026-10-16', requestedAsOf: '2026-10-19', price: 500,
  change: 1, pctChange: 0.2, currency: 'HKD', volume: 1234567, volumeUnit: '股', amount: null, amountUnit: '港元',
  source: 'Tencent', sourceId: 'tencent', sourceApi: 'tencent_hk_daily', adjustment: 'none', peTtm: null, pb: null, valuationAsOf: null, valuationStatus: 'missing', valuationSource: null });
const series = period => ({ ticker: '00700.HK', points: [{ date: '2026-10-16', open: 499, close: 500, high: 501, low: 498,
  volume: 1234567, amount: null, source: 'Tencent', sourceApi: 'tencent_hk_daily' }],
  meta: { market: 'HK', currency: 'HKD', volumeUnit: '股', amountUnit: '港元', adjustment: 'none', period,
    requestedAsOf: '2026-10-19', source: 'Tencent', sourceId: 'tencent', sourceApi: 'tencent_hk_daily' } });

test('搜索适配接受A与五位港股，保留前导零并拒绝错误代码和市场', () => {
  const data = adapters.stocks({ data: [{ ticker: '00700.HK', name: ' 腾讯控股 ', market: 'HK' }, { ticker: '002920.SZ', name: '德赛西威', market: 'A' }] });
  assert.deepEqual(data, [{ ticker: '00700.HK', name: '腾讯控股', market: 'HK' }, { ticker: '002920.SZ', name: '德赛西威', market: 'A' }]);
  for (const item of [{ ticker: '0700.HK' }, { ticker: '00700.HK', market: 'A' }, { ticker: '002920.SZ', market: 'HK' }]) assert.throws(() => adapters.stocks([item]));
});

test('港股搜索与三个行情区间走数据库接口并传取消信号，HK不发送申万或前复权', async () => {
  const calls = [], signal = new AbortController().signal;
  const service = createResearchService({ config: { enabled: true }, routes: endpoints, mappers: adapters, client: {
    async get(path, options) { calls.push({ path, ...options }); return { data: path === '/api/stocks' ? [{ ticker: '00700.HK', name: '腾讯控股', market: 'HK' }] : series(options.query.period) }; },
  } });
  const stocks = await service.searchCompanies({ q: '00700', market: 'HK', limit: 50 }, { signal });
  assert.equal(stocks[0].ticker, '00700.HK'); assert.deepEqual(calls[0].query, { q: '00700', limit: 50, market: 'HK' });
  for (const period of ['1m', '6m', '1y']) {
    const params = { ticker: '00700.HK', asOf: '2026-10-19', period };
    const result = await service.load('prices', params, { signal }); assert.equal(result.status, 'ready');
    assert.equal(assertPricesContext(result.data, params).meta.adjustment, 'none');
    assert.deepEqual(calls.at(-1).query, { ...params, adjustment: 'none', benchmark: 'hsi' }); assert.equal(calls.at(-1).signal, signal);
    assert.equal(result.data.points[0].amount, null); assert.equal(result.data.points[0].sourceApi, 'tencent_hk_daily');
  }
  assert.equal(endpoints.prices({ ticker: '002920.SZ' }).query.adjustment, 'qfq');
  assert.equal(endpoints.prices({ ticker: '002920.SZ' }).query.benchmark, 'sw2021_l3');
});

test('HK快照保留真实来源与空成交额，错误单位、口径或身份不能串入当前标的', () => {
  const params = { ticker: '00700.HK', asOf: '2026-10-19' }, mapped = adapters.quote(quote());
  assert.equal(assertQuoteContext(mapped, params).currency, 'HKD'); assert.equal(mapped.amount, null);
  assert.equal(mapped.source, 'Tencent'); assert.equal(mapped.sourceApi, 'tencent_hk_daily'); assert.equal(mapped.valuationStatus, 'missing');
  for (const changes of [{ currency: 'CNY' }, { volumeUnit: '手' }, { amountUnit: '千元' }, { adjustment: 'qfq' }]) assert.throws(() => adapters.quote({ ...quote(), ...changes }));
  for (const changes of [{ ticker: '002920.SZ' }, { asOf: '2026-10-20' }, { requestedAsOf: '2026-10-18' }]) assert.throws(() => assertQuoteContext({ ...mapped, ...changes }, params));
});

test('HK估值匹配当前收盘日及真实来源，历史研究不能读入跨日或未来估值', () => {
  const params = { ticker: '00700.HK', asOf: '2026-10-19' };
  const valuationMeta = { source: 'Example HK provider', sourceId: 'hk_provider', sourceApi: 'hk_valuations' };
  const mapped = adapters.quote({ ...quote(), peTtm: 18.4, pb: 3.2, valuationAsOf: '2026-10-16', valuationStatus: 'available', valuationSource: 'Example HK provider', valuationMeta });
  assert.equal(mapped.asOf, '2026-10-16');
  assert.equal(assertQuoteContext(mapped, params).valuationAsOf, '2026-10-16');
  assert.equal(mapped.peTtm, 18.4); assert.equal(mapped.pb, 3.2);
  assert.deepEqual(mapped.valuationMeta, valuationMeta); assert.notEqual(mapped.valuationMeta, valuationMeta);
  for (const valuationAsOf of ['2026-10-15', '2026-10-19', '2026-10-20', '2026-02-30', '20261019']) assert.throws(() => assertQuoteContext({ ...mapped, valuationAsOf }, params));
  assert.throws(() => adapters.quote({ ...quote(), valuationAsOf: '2026-02-30' }));
});

test('HK价格上下文按none口径校验，快速A/H切换取消旧请求和不支持的旧模块', async () => {
  const params = { ticker: '00700.HK', asOf: '2026-10-19', period: '1m' };
  const valid = adapters.prices(series('1m')); assert.equal(assertPricesContext(valid, params), valid);
  for (const mutate of [data => { data.ticker = '002920.SZ'; }, data => { data.meta.period = '1y'; }, data => { data.meta.requestedAsOf = '2026-10-18'; }, data => { data.meta.adjustment = 'qfq'; }, data => { data.points[0].date = '2026-10-20'; }, data => { data.benchmark = {}; }]) {
    const data = structuredClone(valid); mutate(data); assert.throws(() => assertPricesContext(data, params));
  }
  const session = createCompanySession({ ticker: '002920.SZ' }), old = ['quote', 'prices', 'forecasts', 'bands', 'events', 'relations'].map(module => session.begin(module));
  session.select({ ticker: '00700.HK', name: '腾讯控股' }); assert.ok(old.every(request => request.signal.aborted && !request.isCurrent()));
  const active = session.begin('prices'); session.select({ ticker: '002920.SZ' }); assert.equal(active.isCurrent(), false);
  const main = await readFile(new URL('../frontend/src/main.js', import.meta.url), 'utf8');
  assert.match(main, /request\.ticker\.endsWith\('\.HK'\) && module === 'events'/);
  assert.doesNotMatch(main, /\['forecasts', 'events'\]\.includes\(module\)/);
  assert.doesNotMatch(main, /\['forecasts', 'bands', 'events'\]\.includes\(module\)/);
  assert.ok(main.indexOf('if (!request.isCurrent()) return;') < main.indexOf('assertQuoteContext(result.data, params)'));
});


test('港股恒指适配保留对齐点位、真实最新值与HSI身份，拒绝跨市场基准', () => {
  const source = series('1m');
  source.benchmark = { status: 'available', system: 'HSI', level: null, membershipBasis: 'index', membershipFetchedAt: null,
    indexCode: 'HSI', industryName: '恒生指数', baseDate: '2026-10-16', baseStockClose: 500, baseIndexClose: 25000,
    latest: { date: '2026-10-19', close: 25100 }, points: [{ date: '2026-10-16', close: 25000, scaledClose: 500 }] };
  const mapped = adapters.prices(source);
  assert.deepEqual(mapped.benchmark, source.benchmark);
  assert.equal(assertPricesContext(mapped, { ticker: source.ticker, asOf: '2026-10-19', period: '1m' }), mapped);
  for (const changes of [{ system: 'SW2021' }, { level: 3 }, { membershipBasis: 'latest' }, { indexCode: 'HSTECH' }, { membershipFetchedAt: '2026-10-19T00:00:00Z' }]) {
    assert.throws(() => adapters.prices({ ...source, benchmark: { ...source.benchmark, ...changes } }));
  }
  const wrongMarket = { ...source, ticker: '002920.SZ', meta: { ...source.meta, market: 'A', adjustment: 'qfq' } };
  assert.throws(() => adapters.prices(wrongMarket));
});
