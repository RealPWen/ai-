import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarketReadService } from '../backend/market-data/read-service.mjs';

function fixture(rows = [], options = {}) {
  const calls = [], catalogCalls = [];
  const listings = options.listings ?? options.hkUniverse?.securities ?? [{ ticker: '00700.HK', name: '腾讯控股' }];
  const pool = {
    async query(sql, params) {
      if (sql.startsWith('SELECT ts_code, name, currency FROM market_data.hk_listed_universe')) {
        catalogCalls.push({ sql, params });
        return { rows: listings.filter(row => row.ticker === params[0] && row.active !== false).map(row => ({ ts_code: row.ticker, name: row.name, currency: row.currency ?? 'HKD' })) };
      }
      calls.push({ sql, params }); return { rows };
    },
    async end() { calls.push({ end: true }); },
  };
  return { calls, catalogCalls, service: createMarketReadService({ pool, now: () => new Date('2026-10-14T01:00:00Z'), ...options }) };
}

test('A-only search parameterizes query, treats wildcard characters literally and preserves existing SQL contract', async () => {
  const { service, calls } = fixture([{ ts_code: '002920.SZ', name: '德赛西威' }, { ts_code: '600000.SH', name: '' }]);
  assert.deepEqual(await service.search({ q: " %_!'-- ", limit: '5', market: 'A' }), [
    { ticker: '002920.SZ', name: '德赛西威', market: 'A' },
    { ticker: '600000.SH', name: '600000.SH', market: 'A' },
  ]);
  assert.deepEqual(calls[0].params, ["%!%!_!!'--%", "%_!'--", "%_!'--", 5]);
  assert.ok(!calls[0].sql.includes("%_!'--"));
  assert.match(calls[0].sql, /daily_prices WHERE market = 'A'/);
  assert.match(calls[0].sql, /s\.market = 'A'/);
  assert.match(calls[0].sql, /ESCAPE '!'/);
  assert.match(calls[0].sql, /ORDER BY CASE WHEN s\.list_status = 'L'/);
});

test('search validates query and limit without issuing SQL', async () => {
  const { service, calls } = fixture();
  for (const limit of [0, 51, 1.5, null, true, [], '', '1; DROP TABLE x']) {
    await assert.rejects(service.search({ limit }), { code: 'INVALID_LIMIT', status: 400 });
  }
  await assert.rejects(service.search({ q: [] }), { code: 'INVALID_SEARCH' });
  await assert.rejects(service.search({ q: 'x'.repeat(101) }), { code: 'INVALID_SEARCH' });
  await assert.rejects(service.search({ market: 'US' }), { code: 'INVALID_MARKET' });
  assert.equal(calls.length, 0);
  assert.deepEqual(await service.search(), []);
  assert.equal(calls[0].params[3], 20);
});

test('profile returns only classified business information and uses name fallback', async () => {
  const { service, calls } = fixture([{ ts_code: '002920.SZ', name: '德赛西威', industry: '汽车零部件' }]);
  assert.deepEqual(await service.profile({ ticker: ' 002920.sz ' }), {
    ticker: '002920.SZ', name: '德赛西威', description: '行业分类：汽车零部件。公司业务简介待补充。',
    businesses: ['汽车零部件'], sourceUrl: 'https://tushare.pro', market: 'A',
  });
  assert.deepEqual(calls[0].params, ['002920.SZ']);
  assert.match(calls[0].sql, /daily_prices WHERE ts_code = \$1 AND market = 'A'/);
  const emptyName = fixture([{ ts_code: '600000.SH', name: null, industry: null }]);
  const profile = await emptyName.service.profile({ ticker: '600000.SH' });
  assert.equal(profile.name, '600000.SH');
  assert.deepEqual(profile.businesses, []);
  assert.equal(await fixture().service.profile({ ticker: '600000.SH' }), null);
});

test('quote reads latest available close on or before cutoff, keeps null fields and reports real units', async () => {
  const { service, calls } = fixture([{
    ts_code: '002920.SZ', trade_date: '2026-10-13', close: '100.25', open: '99', high: '101.5', low: null,
    pre_close: '100', change: '0.25', pct_chg: '0.25', vol: '2156.5', amount: '215650', database_through: '2026-10-13',
  }]);
  const quote = await service.quote({ ticker: '002920.sz', asOf: '2026-10-14' });
  assert.deepEqual(quote, {
    ticker: '002920.SZ', asOf: '2026-10-13', requestedAsOf: '2026-10-14', price: 100.25, open: 99,
    high: 101.5, low: null, previousClose: 100, change: 0.25, pctChange: 0.25,
    volume: 2156.5, volumeUnit: '手', amount: 215650, amountUnit: '千元', currency: 'CNY',
    source: 'Tushare', adjustment: 'none', peTtm: null, pb: null,
    valuationAsOf: null, valuationStatus: 'missing', valuationSource: null, databaseThrough: '2026-10-13',
  });
  assert.deepEqual(calls[0].params, ['002920.SZ', '2026-10-14']);
  assert.match(calls[0].sql, /p\.market = 'A' AND p\.trade_date <= \$2::date/);
  assert.match(calls[0].sql, /ORDER BY p\.trade_date DESC LIMIT 1/);
  assert.equal(await fixture().service.quote({ ticker: '002920.SZ' }), null);
});

test('quote exposes only the valuation row for the exact same stock, market and price session', async () => {
  const { service, calls } = fixture([{
    ts_code: '002920.SZ', trade_date: '2026-10-09', close: '100.25',
    pe_ttm: '22.15', pb: '3.5678', valuation_as_of: '2026-10-09', database_through: '2026-10-13',
  }]);
  const quote = await service.quote({ ticker: '002920.SZ', asOf: '2026-10-11' });
  assert.equal(quote.asOf, '2026-10-09');
  assert.equal(quote.requestedAsOf, '2026-10-11');
  assert.equal(quote.peTtm, 22.15);
  assert.equal(quote.pb, 3.5678);
  assert.equal(quote.valuationAsOf, '2026-10-09');
  assert.equal(quote.valuationStatus, 'available');
  assert.equal(quote.valuationSource, 'Tushare daily_basic');
  assert.deepEqual(calls[0].params, ['002920.SZ', '2026-10-11']);
  const sql = calls[0].sql;
  assert.match(sql, /LEFT JOIN market_data\.daily_valuations v/);
  assert.match(sql, /ON v\.ts_code = p\.ts_code AND v\.trade_date = p\.trade_date AND v\.market = p\.market/);
  assert.match(sql, /WHERE p\.ts_code = \$1 AND p\.market = 'A' AND p\.trade_date <= \$2::date/);
  assert.doesNotMatch(sql, /v\.trade_date\s*(?:<=|>=|<|>)/);
  assert.doesNotMatch(sql, /(?:WHERE|AND)\s+v\.(?:pe_ttm|pb)\s+IS NOT NULL/i);
});

test('same-day missing PE retains PB without deriving PE or treating null as zero', async () => {
  const { service } = fixture([{
    ts_code: '600000.SH', trade_date: '2026-10-13', close: '10', pe_ttm: null, pb: '0.52', valuation_as_of: '2026-10-13',
  }]);
  const quote = await service.quote({ ticker: '600000.SH' });
  assert.equal(quote.price, 10);
  assert.equal(quote.peTtm, null);
  assert.equal(quote.pb, 0.52);
  assert.equal(quote.valuationAsOf, '2026-10-13');
  assert.equal(quote.valuationStatus, 'loss_or_unavailable');
  assert.equal(quote.valuationSource, 'Tushare daily_basic');
});

test('source negative PE and PB are preserved rather than recomputed or replaced', async () => {
  const { service } = fixture([{
    ts_code: '600000.SH', trade_date: '2026-10-13', close: '10', pe_ttm: '-12.3', pb: '-0.52', valuation_as_of: '2026-10-13',
  }]);
  const quote = await service.quote({ ticker: '600000.SH' });
  assert.equal(quote.peTtm, -12.3);
  assert.equal(quote.pb, -0.52);
  assert.equal(quote.valuationStatus, 'available');
});

test('historical price remains available when its session has no matching valuation', async () => {
  const { service, calls } = fixture([{
    ts_code: '002920.SZ', trade_date: '2025-10-14', close: '100',
    pe_ttm: null, pb: null, valuation_as_of: null, database_through: '2026-10-13',
  }]);
  const quote = await service.quote({ ticker: '002920.SZ', asOf: '2025-10-14' });
  assert.equal(quote.price, 100);
  assert.equal(quote.asOf, '2025-10-14');
  assert.equal(quote.valuationAsOf, null);
  assert.equal(quote.valuationStatus, 'missing');
  assert.equal(quote.valuationSource, null);
  assert.equal(quote.peTtm, null);
  assert.equal(quote.pb, null);
  assert.deepEqual(calls[0].params, ['002920.SZ', '2025-10-14']);
  // Exact equality joins cannot borrow a later available valuation or one from
  // another stock/market; the price cutoff remains the only date parameter.
  assert.match(calls[0].sql, /v\.ts_code = p\.ts_code AND v\.trade_date = p\.trade_date AND v\.market = p\.market/);
});

test('a missing valuation table fails safely instead of silently claiming valuations are absent', async () => {
  const pool = { async query() { throw Object.assign(new Error('relation market_data.daily_valuations does not exist'), { code: '42P01' }); } };
  const service = createMarketReadService({ pool });
  await assert.rejects(service.quote({ ticker: '002920.SZ' }), error => {
    assert.equal(error.code, 'MARKET_DATABASE_UNAVAILABLE');
    assert.equal(error.status, 503);
    assert.ok(!error.message.includes('daily_valuations'));
    return true;
  });
});

test('numeric conversion does not turn null, blank or invalid numeric values into zeros', async () => {
  const { service } = fixture([{
    trade_date: '2026-10-13', close: null, open: '', high: 'Infinity', low: 'NaN', pre_close: false,
    change: '0', pct_chg: -0.5, vol: '1.2e3', amount: undefined,
  }]);
  const quote = await service.quote({ ticker: '002920.SZ' });
  for (const field of ['price', 'open', 'high', 'low', 'previousClose', 'amount']) assert.equal(quote[field], null);
  assert.equal(quote.change, 0);
  assert.equal(quote.pctChange, -0.5);
  assert.equal(quote.volume, 1200);
});

test('cutoff defaults to Shanghai today and rejects calendar-invalid and future dates before SQL', async () => {
  const { service, calls } = fixture([], { now: () => new Date('2026-10-13T16:01:00Z') });
  await service.quote({ ticker: '002920.SZ' });
  assert.equal(calls[0].params[1], '2026-10-14');
  for (const asOf of ['2026-10-15', '2026-02-30', '2025-02-29', '2026-2-01', '', 20261014]) {
    await assert.rejects(service.quote({ ticker: '002920.SZ', asOf }), { code: 'INVALID_DATE', status: 400 });
    await assert.rejects(service.prices({ ticker: '002920.SZ', asOf }), { code: 'INVALID_DATE', status: 400 });
  }
  assert.equal(calls.length, 1);
});

test('ticker validation checks current HK listing membership and rejects malformed codes before SQL', async () => {
  const { service, calls, catalogCalls } = fixture();
  for (const method of ['quote', 'prices', 'profile']) {
    await assert.rejects(service[method]({ ticker: '09999.hk' }), { code: 'MARKET_NOT_IN_UNIVERSE', status: 404 });
    for (const ticker of ['002920', '002920.HK;--', "002920.SZ' OR 1=1", undefined, '123456.US', '0700.HK']) {
      await assert.rejects(service[method]({ ticker }), { code: 'INVALID_TICKER', status: 400 });
    }
  }
  assert.equal(calls.length, 0);
  assert.equal(catalogCalls.length, 3);
  assert.ok(catalogCalls.every(call => call.sql.includes('active = true') && call.params[0] === '09999.HK'));
});

test('price periods subtract natural months with end-of-month and leap-year clamping', async () => {
  const { service, calls } = fixture();
  for (const [asOf, period, from] of [
    ['2026-03-31', '1m', '2026-02-28'], ['2024-03-31', '1m', '2024-02-29'],
    ['2026-08-31', '6m', '2026-02-28'], ['2024-02-29', '1y', '2023-02-28'],
  ]) {
    await service.prices({ ticker: '002920.SZ', asOf, period });
    assert.deepEqual(calls.at(-1).params, ['002920.SZ', from, asOf]);
  }
  await assert.rejects(service.prices({ ticker: '002920.SZ', period: '7d' }), { code: 'INVALID_PERIOD' });
  await assert.rejects(service.prices({ ticker: '002920.SZ', period: '__proto__' }), { code: 'INVALID_PERIOD' });
  await assert.rejects(service.prices({ ticker: '002920.SZ', period: ['1y'] }), { code: 'INVALID_PERIOD' });
  assert.equal(calls.length, 4);
});

test('prices are ordered by actual sessions with coverage metadata, no filled missing days', async () => {
  const { service, calls } = fixture([
    { trade_date: '2026-10-09', close: '100', open: '99', high: '101', low: '98', vol: '5', amount: '500', available_from: '2025-10-14', database_through: '2026-10-13' },
    { trade_date: '2026-10-13', close: '102', open: null, high: '103', low: '100', vol: '6', amount: '600', available_from: '2025-10-14', database_through: '2026-10-13' },
  ]);
  const prices = await service.prices({ ticker: '002920.SZ', asOf: '2026-10-14' });
  assert.deepEqual(prices.points.map(point => point.date), ['2026-10-09', '2026-10-13']);
  assert.equal(prices.points[1].close, 102);
  assert.equal(prices.points[1].open, null);
  assert.deepEqual(prices.meta, {
    source: 'Tushare', currency: 'CNY', adjustment: 'none', requestedAsOf: '2026-10-14', period: '1y',
    availableFrom: '2025-10-14', databaseThrough: '2026-10-13', startDate: '2026-10-09', endDate: '2026-10-13', pointCount: 2,
  });
  assert.match(calls[0].sql, /market = 'A' AND trade_date BETWEEN \$2::date AND \$3::date/);
  assert.match(calls[0].sql, /ORDER BY p.trade_date ASC/);
});

test('empty price window still returns database coverage and does not manufacture a price', async () => {
  const { service } = fixture([{ trade_date: null, available_from: '2025-10-14', database_through: '2026-10-13' }]);
  const result = await service.prices({ ticker: '600000.SH' });
  assert.deepEqual(result.points, []);
  assert.equal(result.meta.startDate, null);
  assert.equal(result.meta.endDate, null);
  assert.equal(result.meta.pointCount, 0);
  assert.equal(result.meta.databaseThrough, '2026-10-13');
});

test('database errors and close failures are sanitized into safe 503 errors', async () => {
  const secret = 'postgresql://account:secret-password@db/private';
  const pool = { async query() { throw new Error(secret); }, async end() { throw new Error(secret); } };
  const service = createMarketReadService({ pool });
  for (const action of [
    () => service.search(), () => service.profile({ ticker: '002920.SZ' }),
    () => service.quote({ ticker: '002920.SZ' }), () => service.prices({ ticker: '002920.SZ' }), () => service.close(),
  ]) {
    await assert.rejects(action(), error => {
      assert.equal(error.code, 'MARKET_DATABASE_UNAVAILABLE');
      assert.equal(error.status, 503);
      assert.ok(!error.message.includes('secret-password'));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  assert.throws(() => createMarketReadService(), { code: 'MARKET_DATABASE_UNAVAILABLE', status: 503 });
});

test('close releases the provided pool', async () => {
  const { service, calls } = fixture();
  await service.close();
  assert.deepEqual(calls, [{ end: true }]);
});

const hkUniverse = { version: 1, source: { path: '/pool.xlsx', sheet: '合并价值投资池' }, securities: [
  { ticker: '00700.HK', name: '腾讯控股', row: 2 }, { ticker: '02020.HK', name: '安踏体育', row: 3 },
] };

test('mixed search uses all active HK company listings including companies outside the investment pool and with no local prices', async () => {
  const f = fixture([{ ts_code: '002920.SZ', name: '德赛西威', market: 'A' },
    { ts_code: '00700.HK', name: '腾讯控股', market: 'HK' }, { ts_code: '09999.HK', name: '名单外', market: 'HK' }], { hkUniverse });
  assert.deepEqual(await f.service.search({ limit: 20 }), [
    { ticker: '002920.SZ', name: '德赛西威', market: 'A' }, { ticker: '00700.HK', name: '腾讯控股', market: 'HK' },
    { ticker: '09999.HK', name: '名单外', market: 'HK' },
  ]);
  assert.deepEqual(f.calls[0].params, ['%%', '', '', 20]);
  assert.match(f.calls[0].sql, /daily_prices WHERE market = 'A' UNION ALL/);
  assert.match(f.calls[0].sql, /FROM market_data\.hk_listed_universe WHERE active = true/);
  assert.match(f.calls[0].sql, /row_number\(\) OVER \(PARTITION BY market/);
  assert.match(f.calls[0].sql, /ORDER BY exact_rank, market_rank, market, ts_code LIMIT \$4/);
  const hk = await f.service.search({ q: '腾讯', market: 'HK', limit: 50 });
  assert.deepEqual(hk, [{ ticker: '00700.HK', name: '腾讯控股', market: 'HK' }, { ticker: '09999.HK', name: '名单外', market: 'HK' }]);
  assert.match(f.calls[1].sql, /FROM market_data\.hk_listed_universe WHERE active = true/);
  assert.doesNotMatch(f.calls[1].sql, /daily_prices|ANY\(/);
  assert.doesNotMatch(f.calls[1].sql, /market = 'A'/); assert.equal(f.calls[1].params[3], 50);
});

test('HK profile uses current catalog name, actual price provider and HK units, without an A-share industry', async () => {
  const f = fixture([{ ts_code: '00700.HK', name: '腾讯控股', industry: '不应出现的申万行业',
    source: 'tencent', source_api: 'tencent_hk_daily', currency: 'HKD', volume_unit: 'share', amount_unit: 'hkd' }], { hkUniverse });
  assert.deepEqual(await f.service.profile({ ticker: '00700.hk' }), {
    ticker: '00700.HK', name: '腾讯控股', description: '公司业务简介待补充。', businesses: [], scope: 'hk_listed_universe', sourceUrl: 'https://gu.qq.com/hk00700',
    market: 'HK', currency: 'HKD', volumeUnit: '股', amountUnit: '港元', source: 'Tencent', sourceId: 'tencent', sourceApi: 'tencent_hk_daily',
  });
  assert.deepEqual(f.calls[0].params, ['00700.HK']); assert.match(f.calls[0].sql, /market = 'HK'/);
  assert.doesNotMatch(f.calls[0].sql, /s\.industry|market = 'A'/);
});

test('HK quote reads the exact closing-session valuation while retaining truthful price units and source', async () => {
  const f = fixture([{ ts_code: '00700.HK', trade_date: '2026-10-13', close: '600.25', open: '599', high: '601', low: '598',
    pre_close: '600', change: '0.25', pct_chg: '0.0416', vol: '1234567', amount: null, source: 'tencent', source_api: 'tencent_hk_daily',
    currency: 'HKD', volume_unit: 'share', amount_unit: 'hkd', database_through: '2026-10-13', pe_ttm: '22.5', pb: '3.75',
    valuation_as_of: '2026-10-13', valuation_source: 'baidu', valuation_source_api: 'baidu_hk_valuation' }], { hkUniverse });
  const quote = await f.service.quote({ ticker: '00700.HK', asOf: '2026-10-14' });
  assert.equal(quote.market, 'HK'); assert.equal(quote.currency, 'HKD'); assert.equal(quote.price, 600.25);
  assert.equal(quote.volume, 1234567); assert.equal(quote.volumeUnit, '股'); assert.equal(quote.amount, null); assert.equal(quote.amountUnit, '港元');
  assert.equal(quote.source, 'Tencent'); assert.equal(quote.sourceId, 'tencent'); assert.equal(quote.sourceApi, 'tencent_hk_daily');
  assert.equal(quote.peTtm, 22.5); assert.equal(quote.pb, 3.75); assert.equal(quote.valuationAsOf, '2026-10-13'); assert.equal(quote.valuationStatus, 'available');
  assert.equal(quote.valuationSource, '百度股市通');
  assert.deepEqual(quote.valuationMeta, { source: '百度股市通', sourceId: 'baidu', sourceApi: 'baidu_hk_valuation' });
  assert.equal(quote.databaseThrough, '2026-10-13');
  assert.deepEqual(f.calls[0].params, ['00700.HK', '2026-10-14']);
  assert.match(f.calls[0].sql, /JOIN market_data\.hk_listed_universe c ON c\.ts_code = d\.ts_code AND c\.active = true WHERE d\.market = 'HK'/);
  assert.match(f.calls[0].sql, /p\.market = 'HK' AND p\.trade_date <= \$2::date/);
  assert.match(f.calls[0].sql, /LEFT JOIN market_data\.hk_daily_valuations v ON v\.ts_code = p\.ts_code AND v\.trade_date = p\.trade_date/);
  assert.doesNotMatch(f.calls[0].sql, /market_data\.daily_valuations|market = 'A'|LEFT JOIN LATERAL/);
  await assert.rejects(f.service.quote({ ticker: '00700.HK', adjustment: 'qfq' }), { code: 'ADJUSTMENT_NOT_SUPPORTED' });
  await assert.rejects(f.service.quote({ ticker: '00700.HK', benchmark: 'sw2021_l3' }), { code: 'BENCHMARK_NOT_SUPPORTED' });
  assert.equal(f.calls.length, 1);
});

test('HK latest valuation keeps missing or negative metrics and never searches for an older positive observation', async () => {
  for (const [pe, pb, expectedStatus] of [[null, '0.8', 'loss_or_unavailable'], ['-12.3', null, 'available'], [null, null, 'loss_or_unavailable']]) {
    const f = fixture([{ ts_code: '00700.HK', trade_date: '2026-10-13', close: '600', pe_ttm: pe, pb,
      valuation_as_of: '2026-10-13', valuation_source: 'baidu', valuation_source_api: 'baidu_hk_valuation' }], { hkUniverse });
    const quote = await f.service.quote({ ticker: '00700.HK' });
    assert.equal(quote.peTtm, pe === null ? null : Number(pe)); assert.equal(quote.pb, pb === null ? null : Number(pb));
    assert.equal(quote.valuationStatus, expectedStatus); assert.equal(quote.valuationAsOf, '2026-10-13');
    assert.equal(quote.valuationSource, '百度股市通');
    assert.doesNotMatch(f.calls[0].sql, /(?:WHERE|AND)\s+(?:v\.)?(?:pe_ttm|pb)\s*(?:IS NOT NULL|>|>=)/i);
  }
  const missing = await fixture([{ trade_date: '2025-10-20', close: '100', valuation_as_of: null }], { hkUniverse })
    .service.quote({ ticker: '00700.HK', asOf: '2025-10-20' });
  assert.equal(missing.peTtm, null); assert.equal(missing.pb, null); assert.equal(missing.valuationStatus, 'missing');
  assert.equal(missing.valuationSource, null); assert.equal(missing.valuationMeta, null);
  const stale = await fixture([{ trade_date: '2026-10-13', close: '100', pe_ttm: 10, pb: 1, valuation_as_of: '2026-10-09' }], { hkUniverse }).service.quote({ ticker: '00700.HK' });
  assert.equal(stale.peTtm, null); assert.equal(stale.pb, null); assert.equal(stale.valuationAsOf, null); assert.equal(stale.valuationStatus, 'missing');
});

test('HK daily prices expose source per point and HK-only coverage, never read factors or industry benchmarks', async () => {
  const f = fixture([
    { trade_date: '2026-10-09', open: '600', high: '610', low: '590', close: '605', vol: '100000', amount: null,
      source: 'tencent', source_api: 'tencent_hk_daily', currency: 'HKD', volume_unit: 'share', amount_unit: 'hkd', available_from: '2025-10-20', database_through: '2026-10-13' },
    { trade_date: '2026-10-13', open: '606', high: '610', low: '602', close: '608', vol: '110000', amount: null,
      source: 'tencent', source_api: 'tencent_hk_daily', currency: 'HKD', volume_unit: 'share', amount_unit: 'hkd', available_from: '2025-10-20', database_through: '2026-10-13' },
  ], { hkUniverse });
  const prices = await f.service.prices({ ticker: '00700.HK', period: '6m', adjustment: 'none' });
  assert.equal(prices.points.length, 2); assert.equal(prices.points[0].close, 605); assert.equal(prices.points[0].amount, null);
  assert.equal(prices.points[1].source, 'Tencent'); assert.equal(prices.points[1].sourceApi, 'tencent_hk_daily');
  assert.equal(prices.meta.market, 'HK'); assert.equal(prices.meta.currency, 'HKD'); assert.equal(prices.meta.volumeUnit, '股'); assert.equal(prices.meta.amountUnit, '港元');
  assert.equal(prices.meta.source, 'Tencent'); assert.equal(prices.meta.sourceApi, 'tencent_hk_daily'); assert.equal(prices.meta.adjustment, 'none');
  assert.equal(prices.meta.databaseThrough, '2026-10-13'); assert.equal(prices.meta.availableFrom, '2025-10-20');
  assert.deepEqual(f.calls[0].params, ['00700.HK', '2026-04-14', '2026-10-14']);
  assert.match(f.calls[0].sql, /JOIN market_data\.hk_listed_universe c ON c\.ts_code = d\.ts_code AND c\.active = true WHERE d\.market = 'HK'/);
  assert.doesNotMatch(f.calls[0].sql, /market = 'A'|stock_adj_factors|sw_/);
  await assert.rejects(f.service.prices({ ticker: '00700.HK', adjustment: 'qfq' }), { code: 'ADJUSTMENT_NOT_SUPPORTED', status: 400 });
  await assert.rejects(f.service.prices({ ticker: '00700.HK', benchmark: 'sw2021_l3' }), { code: 'BENCHMARK_NOT_SUPPORTED', status: 400 });
  assert.equal(f.calls.length, 1);
});

test('HK显式hsi基准读取本地恒指且保留none价格，A股拒绝恒指基准', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('SELECT ts_code, name, currency')) return { rows: [{ ts_code: '00700.HK', name: '腾讯控股', currency: 'HKD' }] };
    if (sql.includes('FROM market_data.hk_index_daily')) return { rows: [{ trade_date: '2026-10-13', close: '24000' }] };
    return { rows: [{ trade_date: '2026-10-13', open: '600', high: '610', low: '590', close: '605', vol: '100000', amount: null,
      source: 'tencent', source_api: 'tencent_hk_daily', currency: 'HKD', volume_unit: 'share', amount_unit: 'hkd' }] };
  }, end: async () => {} };
  const service = createMarketReadService({ pool, now: () => new Date('2026-10-20T00:00:00Z') });
  const response = await service.prices({ ticker: '00700.HK', asOf: '2026-10-19', period: '1m', benchmark: 'hsi' });
  assert.equal(response.meta.adjustment, 'none'); assert.equal(response.points[0].close, 605);
  assert.equal(response.benchmark.status, 'available'); assert.equal(response.benchmark.indexCode, 'HSI');
  assert.equal(response.benchmark.baseStockClose, 605); assert.equal(response.benchmark.points[0].scaledClose, 605);
  assert.deepEqual(calls.at(-1).params, ['HSI', '2026-09-19', '2026-10-19']);
  assert.equal(calls.some(({ sql }) => sql.includes('stock_adj_factors') || sql.includes('sw_index_daily')), false);
  await assert.rejects(service.prices({ ticker: '002920.SZ', benchmark: 'hsi' }), { code: 'BENCHMARK_NOT_SUPPORTED' });
});

test('HK mixed providers remain explicit and an empty HK window has no invented price/provider', async () => {
  const mixed = fixture([{ trade_date: '2026-10-09', close: '100', source: 'tencent', source_api: 'tencent_hk_daily' },
    { trade_date: '2026-10-13', close: '102', source: 'eastmoney', source_api: 'eastmoney_hk_daily' }], { hkUniverse });
  const series = await mixed.service.prices({ ticker: '00700.HK' });
  assert.equal(series.meta.source, '混合来源'); assert.equal(series.meta.sourceApi, null); assert.equal(series.meta.sources.length, 2);
  assert.deepEqual(series.points.map(point => point.source), ['Tencent', 'Eastmoney']);
  const empty = await fixture([{ trade_date: null, available_from: '2025-10-20', database_through: '2026-10-13' }], { hkUniverse }).service.prices({ ticker: '00700.HK' });
  assert.deepEqual(empty.points, []); assert.equal(empty.meta.source, null); assert.equal(empty.meta.databaseThrough, '2026-10-13');
});

test('HK empty bands read the stock price/valuation intersection and do not depend on obsolete pool manifests', async () => {
  const f = fixture([], { hkUniverse });
  const bands = await f.service.bands({ ticker: '00700.HK' });
  assert.equal(bands.market, 'HK'); assert.equal(bands.source, null); assert.equal(bands.status, 'no_data');
  assert.equal(bands.peTtm.status, 'no_data'); assert.deepEqual(bands.peTtm.points, []); assert.deepEqual(bands.pb.points, []);
  assert.deepEqual(bands.sources, []); assert.equal(f.calls.length, 1);
  assert.equal(bands.coverageStatus, 'no_price_data');
  assert.match(f.calls[0].sql, /FROM market_data\.daily_prices p LEFT JOIN market_data\.hk_daily_valuations v/);
  assert.deepEqual(f.calls[0].params, ['00700.HK', '2025-10-14', '2026-10-14']);
  assert.doesNotMatch(f.calls[0].sql, /market_data\.daily_valuations|market = 'A'/);
  for (const method of ['profile', 'quote', 'prices', 'bands']) await assert.rejects(f.service[method]({ ticker: '00941.HK' }), { code: 'MARKET_NOT_IN_UNIVERSE', status: 404 });
  assert.equal(f.calls.length, 1);
  const broken = fixture([], { hkUniverse: { version: 1, securities: [] }, listings: [{ ticker: '00700.HK', name: '腾讯控股' }] });
  assert.deepEqual(await broken.service.search({ market: 'HK' }), []);
  assert.equal((await broken.service.bands({ ticker: '00700.HK' })).coverageStatus, 'no_price_data');
  assert.deepEqual(await broken.service.search({ market: 'A' }), []);
  assert.equal(await broken.service.quote({ ticker: '002920.SZ' }), null);
});

test('HK all-market valuation history preserves price-day gaps and legacy values without a universe-hash filter', async () => {
  const data = [
    { trade_date: '2026-10-09', pe_ttm: '10', pb: '1.5', source: 'baidu', source_api: 'baidu_hk_valuation' },
    { trade_date: '2026-10-13', pe_ttm: null, pb: null, source: null, source_api: null },
  ].map(row => ({ ...row, price_count: '2', valuation_count: '1', last_attempt_date: '2026-10-14', last_attempt_status: 'failed', error_code: 'incomplete_window' }));
  const f = fixture(data, { listings: [{ ticker: '00001.HK', name: '长和' }] });
  const bands = await f.service.bands({ ticker: '00001.HK' });
  assert.deepEqual(bands.peTtm.points, [{ date: '2026-10-09', value: 10 }, { date: '2026-10-13', value: null }]);
  assert.equal(bands.peTtm.latest.value, null); assert.equal(bands.peTtm.latest.date, '2026-10-13');
  assert.equal(bands.coverageStatus, 'collection_failed'); assert.equal(bands.meta.retainedHistory, true); assert.equal(bands.meta.missingPriceCount, 1);
  assert.equal(bands.source, '百度股市通'); assert.equal(bands.coverageScope, 'hk_listed_universe');
  assert.match(f.calls[0].sql, /FROM market_data\.daily_prices p LEFT JOIN market_data\.hk_daily_valuations v/);
  assert.match(f.calls[0].sql, /v\.ts_code = p\.ts_code AND v\.trade_date = p\.trade_date/);
  assert.doesNotMatch(f.calls[0].sql, /universe_hash\s*=|hk_valuation_update_runs|\$4/);
});

test('HK valuation collection states distinguish uncollected, running, explicit source empty, failed, and no local price data', async () => {
  for (const [attempt, priceCount, expected] of [
    [null, 2, 'not_downloaded'], ['running', 2, 'collecting'], ['no_data', 2, 'no_data'], ['failed', 2, 'collection_failed'], ['no_price_data', 0, 'no_price_data'],
  ]) {
    const record = { trade_date: null, price_count: priceCount, valuation_count: 0,
      last_attempt_date: attempt ? '2026-10-14' : null, last_attempt_status: attempt, error_code: attempt === 'failed' ? 'network_error' : null };
    const bands = await fixture([record]).service.bands({ ticker: '00700.HK' });
    assert.equal(bands.coverageStatus, expected); assert.equal(bands.meta.retainedHistory, false);
    assert.equal(bands.meta.priceCount, priceCount); assert.equal(bands.peTtm.latest.value, null);
  }
  const past = await fixture([{ trade_date: null, price_count: 2, valuation_count: 0,
    last_attempt_date: '2026-10-15', last_attempt_status: 'failed', source_coverage: { kind: 'no_data' } }]).service.bands({ ticker: '00700.HK' });
  assert.equal(past.coverageStatus, 'not_downloaded'); assert.equal(past.meta.lastAttemptDate, null); assert.deepEqual(past.meta.sourceCoverage, {});
});

test('HK successful partial-metric query retains its original PE/PB empty evidence rather than inventing a failed run', async () => {
  const sourceCoverage = { kind: 'partial_metrics', metricStatus: { pe_ttm: 'available', pb: 'no_data' } };
  const bands = await fixture([{ trade_date: '2026-10-13', pe_ttm: 12, pb: null, source: 'baidu', source_api: 'baidu_hk_valuation',
    price_count: 1, valuation_count: 1, last_attempt_date: '2026-10-14', last_attempt_status: 'succeeded', source_coverage: sourceCoverage }]).service.bands({ ticker: '00700.HK' });
  assert.equal(bands.coverageStatus, 'available'); assert.deepEqual(bands.meta.sourceCoverage, sourceCoverage);
  assert.equal(bands.pb.latest.value, null); assert.equal(bands.peTtm.latest.value, 12); assert.equal(bands.meta.updateStatus, 'succeeded');
});

test('an active HK company outside the investment pool has a profile before its first local price and explicit absent valuations', async () => {
  const listing = { ticker: '00001.HK', name: '长和' };
  const profile = fixture([{ ts_code: listing.ticker, name: listing.name, source: 'hkex', source_api: 'hkex_listed_companies', currency: 'HKD' }], { listings: [listing], hkUniverse });
  const data = await profile.service.profile({ ticker: listing.ticker });
  assert.equal(data.name, '长和'); assert.equal(data.scope, 'hk_listed_universe'); assert.equal(data.sourceId, 'hkex');
  assert.equal(data.sourceUrl, null); assert.equal(data.currency, 'HKD');
  assert.match(profile.calls[0].sql, /FROM market_data\.hk_listed_universe c LEFT JOIN LATERAL/);
  assert.match(profile.calls[0].sql, /WHERE c\.ts_code = \$1 AND c\.active = true/);

  const empty = fixture([], { listings: [listing], hkUniverse });
  assert.equal(await empty.service.quote({ ticker: listing.ticker }), null);
  const prices = await empty.service.prices({ ticker: listing.ticker });
  assert.deepEqual(prices.points, []); assert.equal(prices.meta.pointCount, 0); assert.equal(prices.meta.source, null);
  const queryCount = empty.calls.length;
  const bands = await empty.service.bands({ ticker: listing.ticker });
  assert.equal(bands.status, 'no_data'); assert.equal(bands.coverageStatus, 'no_price_data');
  assert.equal(bands.coverageScope, 'hk_listed_universe'); assert.deepEqual(bands.peTtm.points, []);
  assert.equal(empty.calls.length, queryCount + 1, 'all active companies query their local valuations without a pool gate');
});

test('HK listing membership is reread per request, delisted companies are rejected, and A does not query the catalog', async () => {
  const listing = { ticker: '00001.HK', name: '长和', active: true };
  const f = fixture([], { listings: [listing] });
  assert.equal(await f.service.quote({ ticker: listing.ticker }), null);
  listing.active = false;
  await assert.rejects(f.service.prices({ ticker: listing.ticker }), { code: 'MARKET_NOT_IN_UNIVERSE', status: 404 });
  assert.equal(f.catalogCalls.length, 2);
  await f.service.quote({ ticker: '002920.SZ' });
  assert.equal(f.catalogCalls.length, 2);
});

test('a USD-listed HK company keeps its actual currency for prices, quotes, profile and absent coverage', async () => {
  const listings = [{ ticker: '00770.HK', name: '楠爵资本', currency: 'USD' }];
  const rows = [{ ts_code: '00770.HK', name: '楠爵资本', trade_date: '2026-10-13', open: '0.25', high: '0.3', low: '0.2', close: '0.27',
    vol: '1000', amount: null, currency: 'USD', volume_unit: 'share', amount_unit: 'usd', source: 'tencent', source_api: 'tencent_hk_daily' }];
  const f = fixture(rows, { listings, hkUniverse });
  for (const response of [await f.service.profile({ ticker: '00770.HK' }), await f.service.quote({ ticker: '00770.HK' })]) {
    assert.equal(response.currency, 'USD'); assert.equal(response.amountUnit, '美元'); assert.equal(response.volumeUnit, '股');
  }
  const prices = await f.service.prices({ ticker: '00770.HK' }); assert.equal(prices.meta.currency, 'USD'); assert.equal(prices.meta.amountUnit, '美元');
  const empty = fixture([], { listings, hkUniverse });
  assert.equal((await empty.service.prices({ ticker: '00770.HK' })).meta.currency, 'USD');
  assert.equal((await empty.service.prices({ ticker: '00770.HK' })).meta.amountUnit, '美元');
  assert.equal((await empty.service.bands({ ticker: '00770.HK' })).currency, 'USD');
});

test('missing or failed current HK catalog fails safely and does not grant access to historical stale references', async () => {
  const secret = 'postgresql://account:secret-password@private/catalog';
  const service = createMarketReadService({ pool: { async query() { throw new Error(secret); } } });
  for (const action of [() => service.search({ market: 'HK' }), () => service.profile({ ticker: '00001.HK' })]) {
    await assert.rejects(action(), error => error.code === 'MARKET_DATABASE_UNAVAILABLE' && error.status === 503 && !error.message.includes('secret-password'));
  }
});
