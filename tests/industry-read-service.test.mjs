import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarketReadService } from '../backend/market-data/read-service.mjs';

const TICKER = '002920.SZ';
const AS_OF = '2026-10-14';
const INDEX = '801991.SI';
const L2_INDEX = '801990.SI';
const FETCHED_AT = '2026-10-14T01:02:03.000Z';
const member = overrides => ({ index_code: INDEX, catalog_index_code: INDEX,
  industry_name: '汽车电子', member_industry_name: '汽车电子', l2_code: null, member_l2_name: null,
  l2_catalog_index_code: null, l2_industry_name: null, l2_is_pub: null,
  is_pub: true, membership_fetched_at: new Date(FETCHED_AT), ...overrides });
const withL2 = overrides => member({ l2_code: L2_INDEX, member_l2_name: '汽车零部件',
  l2_catalog_index_code: L2_INDEX, l2_industry_name: '汽车零部件', l2_is_pub: true, ...overrides });
const row = (date, overrides = {}) => ({ trade_date: date, open: '98', high: '102', low: '96', close: '100',
  vol: '123.5', amount: '456.75', available_from: '2025-10-14', database_through: '2026-10-13',
  anchor_trade_date: '2026-10-13', anchor_factor: '4', adj_factor: '2', ...overrides });

function fixture({ prices = [row('2026-10-09'), row('2026-10-13', { close: '56', adj_factor: '4' })],
  members = [member()], indexPrices = [], indexPricesByCode = {}, failAt } = {}) {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      const kind = sql.includes('sw_industry_members') ? 'members' : sql.includes('sw_index_daily') ? 'index' : 'prices';
      if (kind === failAt) throw new Error('postgresql://account:secret-password@db/private missing relation');
      return { rows: kind === 'members' ? members : kind === 'index'
        ? indexPricesByCode[params[0]] ?? (params[0] === INDEX ? indexPrices : []) : prices };
    },
  };
  return { calls, service: createMarketReadService({ pool, now: () => new Date('2026-10-14T01:00:00Z') }) };
}

test('qfq scales every OHLC by its same-day factor divided by the cutoff anchor, retaining volume and amount', async () => {
  const { service, calls } = fixture();
  const result = await service.prices({ ticker: TICKER, asOf: AS_OF, adjustment: 'qfq', period: '1m' });
  assert.deepEqual(result.points[0], { date: '2026-10-09', open: 49, high: 51, low: 48, close: 50, volume: 123.5, amount: 456.75 });
  assert.equal(result.points[1].close, 56);
  assert.equal(result.meta.adjustment, 'qfq');
  assert.equal(result.meta.adjustmentStatus, 'available');
  assert.equal(result.meta.adjustmentAnchorDate, '2026-10-13');
  assert.equal(result.meta.adjustmentAnchorFactor, 4);
  assert.equal(result.meta.missingFactorCount, 0);
  assert.deepEqual(calls[0].params, [TICKER, '2026-09-14', AS_OF]);
  assert.match(calls[0].sql, /f\.ts_code = p\.ts_code AND f\.trade_date = p\.trade_date AND f\.adj_factor > 0/);
  assert.doesNotMatch(calls[0].sql, /f\.trade_date\s*(?:<|>)/);
  assert.equal(calls.length, 1);
});

test('qfq anchors on the latest stock session before the cutoff, independently of the display period', async () => {
  const { service, calls } = fixture({ prices: [row('2026-10-09', { anchor_trade_date: '2026-10-09', anchor_factor: '2' })] });
  const result = await service.prices({ ticker: TICKER, asOf: '2026-10-11', period: '1m', adjustment: 'qfq' });
  assert.equal(result.points[0].close, 100);
  assert.equal(result.meta.adjustmentAnchorDate, '2026-10-09');
  assert.deepEqual(calls[0].params, [TICKER, '2026-09-11', '2026-10-11']);
  const anchorSql = calls[0].sql.split('), anchor AS')[0].split('), anchor_price AS')[1];
  assert.match(anchorSql, /trade_date <= \$3::date/);
  assert.match(anchorSql, /ORDER BY trade_date DESC LIMIT 1/);
  assert.doesNotMatch(anchorSql, /BETWEEN|\$2/);
  assert.match(calls[0].sql, /p\.trade_date BETWEEN \$2::date AND \$3::date/);
  assert.match(calls[0].sql, /f\.trade_date = a\.trade_date/);
});

test('qfq removes dates with absent, zero, negative or invalid factors without substituting raw prices', async () => {
  const prices = [null, '0', '-1', 'NaN', '', false].map((factor, index) => row(`2026-10-${String(index + 1).padStart(2, '0')}`, { adj_factor: factor }));
  prices.push(row('2026-10-13', { adj_factor: '4' }));
  const { service } = fixture({ prices });
  const result = await service.prices({ ticker: TICKER, adjustment: 'qfq' });
  assert.deepEqual(result.points.map(point => point.date), ['2026-10-13']);
  assert.equal(result.meta.missingFactorCount, 6);
  assert.equal(result.meta.adjustmentStatus, 'partial');
  assert.equal(result.meta.pointCount, 1);
  assert.equal(result.meta.startDate, '2026-10-13');
});

test('qfq does not search backward for an older anchor factor when the latest stock session lacks one', async () => {
  for (const anchor of [null, '0', '-1', 'Infinity']) {
    const { service } = fixture({ prices: [row('2026-10-09', { anchor_factor: anchor }), row('2026-10-13', { anchor_factor: anchor, adj_factor: null })] });
    const result = await service.prices({ ticker: TICKER, adjustment: 'qfq' });
    assert.deepEqual(result.points, []);
    assert.equal(result.meta.adjustmentStatus, 'missing_anchor_factor');
    assert.equal(result.meta.adjustmentAnchorDate, '2026-10-13');
    assert.equal(result.meta.adjustmentAnchorFactor, null);
    assert.equal(result.meta.missingFactorCount, 1);
    assert.equal(result.meta.startDate, null);
    assert.equal(result.meta.endDate, null);
  }
});

test('qfq keeps coverage metadata when a stock has no sessions in the requested window', async () => {
  const { service } = fixture({ prices: [{ trade_date: null, anchor_trade_date: '2026-01-02', anchor_factor: '3',
    available_from: '2025-10-14', database_through: '2026-10-13' }] });
  const result = await service.prices({ ticker: TICKER, period: '1m', adjustment: 'qfq' });
  assert.deepEqual(result.points, []);
  assert.equal(result.meta.adjustmentStatus, 'no_prices');
  assert.equal(result.meta.adjustmentAnchorDate, '2026-01-02');
  assert.equal(result.meta.databaseThrough, '2026-10-13');
});

test('invalid adjustment, benchmark and unknown query fields reject before accessing PostgreSQL', async () => {
  const { service, calls } = fixture();
  for (const adjustment of ['', null, 'hfq', ['qfq'], 'QFQ']) {
    await assert.rejects(service.prices({ ticker: TICKER, adjustment }), { code: 'INVALID_ADJUSTMENT', status: 400 });
  }
  for (const benchmark of ['', null, 'sw2021_l2', ['sw2021_l3'], '__proto__']) {
    await assert.rejects(service.prices({ ticker: TICKER, benchmark }), { code: 'INVALID_BENCHMARK', status: 400 });
  }
  await assert.rejects(service.prices({ ticker: TICKER, unexpected: '1' }), { code: 'INVALID_PARAMETERS', status: 400 });
  assert.equal(calls.length, 0);
});

test('omitting adjustment preserves the original raw SQL, metadata and quote contract', async () => {
  const f = fixture();
  const raw = await f.service.prices({ ticker: TICKER });
  const explicit = await f.service.prices({ ticker: TICKER, adjustment: 'none' });
  assert.deepEqual(raw, explicit);
  assert.equal(raw.points[0].close, 100);
  assert.equal(raw.meta.adjustment, 'none');
  assert.equal(Object.hasOwn(raw.meta, 'adjustmentStatus'), false);
  assert.equal(Object.hasOwn(raw, 'benchmark'), false);
  assert.doesNotMatch(f.calls[0].sql, /stock_adj_factors|sw_/);
  const quote = await f.service.quote({ ticker: TICKER });
  assert.equal(quote.price, 100);
  assert.equal(quote.adjustment, 'none');
});

test('SW2021 L3 rebases at the earliest common positive close and aligns gaps to actual stock dates', async () => {
  const { service, calls } = fixture({ prices: [row('2026-10-09'), row('2026-10-12'), row('2026-10-13')],
    indexPrices: [{ trade_date: '2026-10-09', close: '1000' }, { trade_date: '2026-10-13', close: '1050' }] });
  const result = await service.prices({ ticker: TICKER, asOf: AS_OF, period: '1m', benchmark: 'sw2021_l3' });
  assert.deepEqual(result.benchmark, {
    status: 'available', system: 'SW2021', level: 3, membershipBasis: 'latest', membershipFetchedAt: FETCHED_AT,
    classification: { l3Code: INDEX, l3Name: '汽车电子', l2Code: null, l2Name: null }, fallbackReason: null,
    indexCode: INDEX, industryName: '汽车电子', baseDate: '2026-10-09', baseStockClose: 100, baseIndexClose: 1000,
    latest: { date: '2026-10-13', close: 1050 },
    points: [{ date: '2026-10-09', close: 1000, scaledClose: 100 }, { date: '2026-10-12', close: null, scaledClose: null },
      { date: '2026-10-13', close: 1050, scaledClose: 105 }],
  });
  assert.equal(result.points.length, 3);
  assert.match(calls[1].sql, /m\.is_new = 'Y'/);
  assert.match(calls[1].sql, /i\.src = 'SW2021'/);
  assert.doesNotMatch(calls[1].sql, /in_date|out_date/);
  assert.match(calls[1].sql, /sw_industries_l2 i2 ON i2\.index_code = m\.l2_code AND i2\.src = 'SW2021'/);
  assert.deepEqual(calls[1].params, [TICKER]);
  assert.deepEqual(calls[2].params, [INDEX, '2026-09-14', AS_OF]);
  assert.match(calls[2].sql, /index_code = \$1 AND trade_date BETWEEN \$2::date AND \$3::date/);
});

test('latest index points retain the actual later session while the suspended stock ends earlier', async () => {
  const { service } = fixture({ prices: [row('2026-10-09')],
    indexPrices: [{ trade_date: '2026-10-09', close: '1000' }, { trade_date: '2026-10-13', close: '1050' },
      { trade_date: '2026-10-14', close: null }, { trade_date: '2026-10-15', close: '1100' }] });
  const result = await service.prices({ ticker: TICKER, asOf: AS_OF, benchmark: 'sw2021_l3' });
  assert.equal(result.points.at(-1).date, '2026-10-09');
  assert.deepEqual(result.benchmark.latest, { date: '2026-10-13', close: 1050 });
  assert.deepEqual(result.benchmark.points, [{ date: '2026-10-09', close: 1000, scaledClose: 100 }]);
});

test('SW industry rebasing uses qfq stock closes and excludes dates removed for missing factors', async () => {
  const { service } = fixture({ prices: [row('2026-10-08', { adj_factor: null }), row('2026-10-09'), row('2026-10-13', { adj_factor: '4' })],
    indexPrices: [{ trade_date: '2026-10-08', close: '900' }, { trade_date: '2026-10-09', close: '1000' }, { trade_date: '2026-10-13', close: '1200' }] });
  const result = await service.prices({ ticker: TICKER, adjustment: 'qfq', benchmark: 'sw2021_l3' });
  assert.equal(result.benchmark.baseStockClose, 50);
  assert.equal(result.benchmark.baseDate, '2026-10-09');
  assert.deepEqual(result.benchmark.points.map(point => point.date), result.points.map(point => point.date));
  assert.equal(result.benchmark.points[1].scaledClose, 60);
});

test('the industry base is the first shared usable date, not the first stock date or a filled index value', async () => {
  const { service } = fixture({ indexPrices: [{ trade_date: '2026-10-09', close: null }, { trade_date: '2026-10-13', close: '1000' }] });
  const result = await service.prices({ ticker: TICKER, benchmark: 'sw2021_l3' });
  assert.equal(result.benchmark.baseDate, '2026-10-13');
  assert.equal(result.benchmark.baseStockClose, 56);
  assert.equal(result.benchmark.points[0].close, null);
  assert.equal(result.benchmark.points[1].scaledClose, 56);
});

test('unmapped, ambiguous and unavailable classifications retain stock prices when there is no unique L2 parent', async () => {
  for (const [members, status] of [
    [[], 'unmapped'], [[member(), member({ index_code: '801992.SI', membership_fetched_at: '2026-10-14T02:00:00Z' })], 'ambiguous_membership'],
    [[member({ is_pub: false })], 'unpublished'], [[member({ is_pub: null, industry_name: null })], 'missing_classification'],
  ]) {
    const { service, calls } = fixture({ members });
    const result = await service.prices({ ticker: TICKER, benchmark: 'sw2021_l3' });
    assert.equal(result.benchmark.status, status);
    assert.equal(result.points.length, 2);
    assert.equal(result.benchmark.baseDate, null);
    assert.equal(result.benchmark.latest, null);
    assert.equal(result.benchmark.membershipBasis, 'latest');
    assert.deepEqual(result.benchmark.points.map(point => point.date), result.points.map(point => point.date));
    assert.ok(result.benchmark.points.every(point => point.close === null && point.scaledClose === null));
    assert.equal(calls.length, 2);
    if (status === 'ambiguous_membership') {
      assert.equal(result.benchmark.indexCode, null);
      assert.equal(result.benchmark.membershipFetchedAt, '2026-10-14T02:00:00.000Z');
    }
  }
});

test('missing or invalid industry closes and no shared date have distinct statuses', async () => {
  for (const indexPrices of [[], [{ trade_date: '2026-10-09', close: '0' }, { trade_date: '2026-10-13', close: '-1' }],
    [{ trade_date: '2026-10-09', close: null }, { trade_date: '2026-10-13', close: 'NaN' }]]) {
    const result = await fixture({ indexPrices }).service.prices({ ticker: TICKER, benchmark: 'sw2021_l3' });
    assert.equal(result.benchmark.status, 'missing_prices');
    assert.equal(result.benchmark.latest, null);
    assert.equal(result.points.length, 2);
  }
  const result = await fixture({ indexPrices: [{ trade_date: '2026-10-12', close: '1000' }] }).service.prices({ ticker: TICKER, benchmark: 'sw2021_l3' });
  assert.equal(result.benchmark.status, 'no_common_date');
  assert.equal(result.benchmark.baseDate, null);
  assert.deepEqual(result.benchmark.latest, { date: '2026-10-12', close: 1000 });
  assert.equal(result.points.length, 2);
});

test('industry series does not use future rows or rows outside the requested interval', async () => {
  const { service } = fixture({ indexPrices: [{ trade_date: '2025-01-01', close: '800' }, { trade_date: '2026-10-15', close: '1000' }] });
  const result = await service.prices({ ticker: TICKER, asOf: AS_OF, period: '1m', benchmark: 'sw2021_l3' });
  assert.equal(result.benchmark.status, 'missing_prices');
  assert.equal(result.benchmark.latest, null);
  assert.ok(result.benchmark.points.every(point => point.close === null));
});

test('a usable L3 remains preferred, including gaps, without reading or mixing its L2 parent', async () => {
  const { service, calls } = fixture({ members: [withL2()], prices: [row('2026-10-09'), row('2026-10-12'), row('2026-10-13')],
    indexPrices: [{ trade_date: '2026-10-09', close: '1000' }],
    indexPricesByCode: { [L2_INDEX]: [{ trade_date: '2026-10-09', close: '5000' }, { trade_date: '2026-10-12', close: '5100' }] } });
  const { benchmark } = await service.prices({ ticker: TICKER, benchmark: 'sw2021_l3' });
  assert.equal(benchmark.status, 'available');
  assert.equal(benchmark.level, 3);
  assert.equal(benchmark.indexCode, INDEX);
  assert.equal(benchmark.fallbackReason, null);
  assert.equal(benchmark.classification.l2Code, L2_INDEX);
  assert.deepEqual(benchmark.points.map(point => point.close), [1000, null, null]);
  assert.deepEqual(calls.filter(call => call.sql.includes('sw_index_daily')).map(call => call.params[0]), [INDEX]);
});

test('unpublished, missing L3 prices, missing L3 catalog and unknown publication flags fall back to the unique L2', async () => {
  for (const [overrides, reason] of [
    [{ is_pub: false }, 'unpublished'],
    [{}, 'missing_prices'],
    [{ catalog_index_code: null, is_pub: null }, 'missing_classification'],
    [{ is_pub: null }, 'missing_classification'],
  ]) {
    const { service, calls } = fixture({ members: [withL2(overrides)],
      indexPricesByCode: { [L2_INDEX]: [{ trade_date: '2026-10-09', close: '5000' }, { trade_date: '2026-10-13', close: '5500' }] } });
    const { benchmark } = await service.prices({ ticker: TICKER, asOf: AS_OF, period: '1m', adjustment: 'qfq', benchmark: 'sw2021_l3' });
    assert.equal(benchmark.status, 'available');
    assert.equal(benchmark.level, 2);
    assert.equal(benchmark.indexCode, L2_INDEX);
    assert.equal(benchmark.industryName, '汽车零部件');
    assert.equal(benchmark.fallbackReason, reason);
    assert.deepEqual(benchmark.classification, { l3Code: INDEX, l3Name: '汽车电子', l2Code: L2_INDEX, l2Name: '汽车零部件' });
    assert.equal(benchmark.baseDate, '2026-10-09');
    assert.equal(benchmark.baseStockClose, 50);
    assert.equal(benchmark.baseIndexClose, 5000);
    assert.deepEqual(benchmark.points.map(point => point.scaledClose), [50, 55.00000000000001]);
    assert.deepEqual(benchmark.latest, { date: '2026-10-13', close: 5500 });
    assert.deepEqual(calls.at(-1).params, [L2_INDEX, '2026-09-14', AS_OF]);
  }
});

test('an L3 with no shared date falls back to a parent that has a common session', async () => {
  const { service } = fixture({ members: [withL2()], indexPrices: [{ trade_date: '2026-10-12', close: '1000' }],
    indexPricesByCode: { [L2_INDEX]: [{ trade_date: '2026-10-09', close: '5000' }, { trade_date: '2026-10-14', close: '5100' },
      { trade_date: '2026-10-15', close: '9999' }] } });
  const { benchmark } = await service.prices({ ticker: TICKER, asOf: AS_OF, benchmark: 'sw2021_l3' });
  assert.equal(benchmark.level, 2);
  assert.equal(benchmark.status, 'available');
  assert.equal(benchmark.fallbackReason, 'no_common_date');
  assert.equal(benchmark.baseDate, '2026-10-09');
  assert.deepEqual(benchmark.latest, { date: '2026-10-14', close: 5100 });
  assert.deepEqual(benchmark.points.map(point => point.close), [5000, null]);
});

test('conflicting L3 memberships use only a unanimously shared L2 parent', async () => {
  const l2Prices = [{ trade_date: '2026-10-09', close: '5000' }];
  const { service, calls } = fixture({ members: [withL2(), withL2({ index_code: '801992.SI', member_industry_name: '其他零部件' })],
    indexPricesByCode: { [L2_INDEX]: l2Prices } });
  const { benchmark } = await service.prices({ ticker: TICKER, benchmark: 'sw2021_l3' });
  assert.equal(benchmark.status, 'available');
  assert.equal(benchmark.level, 2);
  assert.equal(benchmark.fallbackReason, 'ambiguous_membership');
  assert.deepEqual(benchmark.classification, { l3Code: null, l3Name: null, l2Code: L2_INDEX, l2Name: '汽车零部件' });
  assert.deepEqual(calls.filter(call => call.sql.includes('sw_index_daily')).map(call => call.params[0]), [L2_INDEX]);

  for (const l2_code of [null, '801880.SI']) {
    const f = fixture({ members: [withL2(), withL2({ index_code: '801992.SI', l2_code })], indexPricesByCode: { [L2_INDEX]: l2Prices } });
    const result = await f.service.prices({ ticker: TICKER, benchmark: 'sw2021_l3' });
    assert.equal(result.benchmark.status, 'ambiguous_membership');
    assert.equal(result.benchmark.indexCode, null);
    assert.equal(result.benchmark.classification.l2Code, null);
    assert.equal(f.calls.length, 2);
  }
});

test('duplicate records for the same classification do not cause a false membership conflict', async () => {
  const { service } = fixture({ members: [withL2(), withL2()], indexPrices: [{ trade_date: '2026-10-09', close: '1000' }] });
  const { benchmark } = await service.prices({ ticker: TICKER, benchmark: 'sw2021_l3' });
  assert.equal(benchmark.status, 'available');
  assert.equal(benchmark.level, 3);
});

test('a missing L3 classification can use a known L2 without fabricating a third-level label', async () => {
  const { service } = fixture({ members: [withL2({ index_code: null, member_industry_name: null, industry_name: null,
    catalog_index_code: null, is_pub: null })], indexPricesByCode: { [L2_INDEX]: [{ trade_date: '2026-10-09', close: '5000' }] } });
  const { benchmark } = await service.prices({ ticker: TICKER, benchmark: 'sw2021_l3' });
  assert.equal(benchmark.status, 'available');
  assert.equal(benchmark.level, 2);
  assert.equal(benchmark.fallbackReason, 'missing_classification');
  assert.equal(benchmark.classification.l3Code, null);
  assert.equal(benchmark.classification.l3Name, null);
});

test('independent L2 memberships fill L3 source omissions while retaining source third-level labels', async () => {
  // The L2 member endpoint returns this code even though the L3 catalog uses
  // another code. Preserve the supplied label; do not invent a catalog match.
  const { service, calls } = fixture({ members: [withL2({ index_code: '850412.SI', member_industry_name: '特钢Ⅲ',
    catalog_index_code: null, industry_name: null, is_pub: null, l2_code: '801045.SI', member_l2_name: '特钢Ⅱ',
    l2_catalog_index_code: '801045.SI', l2_industry_name: '特钢Ⅱ' })],
    indexPricesByCode: { '801045.SI': [{ trade_date: '2026-10-09', close: '3000' }, { trade_date: '2026-10-13', close: '3300' }] } });
  const { benchmark } = await service.prices({ ticker: TICKER, asOf: AS_OF, benchmark: 'sw2021_l3' });
  assert.equal(benchmark.status, 'available');
  assert.equal(benchmark.level, 2);
  assert.equal(benchmark.indexCode, '801045.SI');
  assert.equal(benchmark.industryName, '特钢Ⅱ');
  assert.equal(benchmark.fallbackReason, 'missing_classification');
  assert.deepEqual(benchmark.classification, { l3Code: '850412.SI', l3Name: '特钢Ⅲ', l2Code: '801045.SI', l2Name: '特钢Ⅱ' });
  assert.equal(benchmark.membershipFetchedAt, FETCHED_AT);
  const membershipQuery = calls.find(call => call.sql.includes('sw_industry_members'));
  assert.deepEqual(membershipQuery.params, [TICKER]);
  assert.match(membershipQuery.sql, /WITH preferred_members AS \([\s\S]*FROM market_data\.sw_industry_members m[\s\S]*WHERE m\.ts_code = \$1 AND m\.is_new = 'Y'/);
  assert.match(membershipQuery.sql, /UNION ALL[\s\S]*FROM market_data\.sw_industry_members_l2 m[\s\S]*WHERE m\.ts_code = \$1 AND m\.is_new = 'Y'[\s\S]*AND NOT EXISTS \(SELECT 1 FROM preferred_members\)/);
  assert.match(membershipQuery.sql, /FROM selected_members m/);
  assert.equal(calls.filter(call => call.sql.includes('sw_index_daily')).length, 1);
});

test('an unavailable L2 reports its actual failure separately from the L3 fallback reason', async () => {
  for (const [overrides, status, indexPricesByCode] of [
    [{}, 'missing_prices', {}],
    [{ l2_is_pub: false }, 'unpublished', {}],
    [{ l2_catalog_index_code: null, l2_is_pub: null }, 'missing_classification', {}],
    [{}, 'no_common_date', { [L2_INDEX]: [{ trade_date: '2026-10-12', close: '5000' }] }],
  ]) {
    const { service } = fixture({ members: [withL2({ is_pub: false, ...overrides })], indexPricesByCode });
    const { benchmark } = await service.prices({ ticker: TICKER, benchmark: 'sw2021_l3' });
    assert.equal(benchmark.level, 2);
    assert.equal(benchmark.indexCode, L2_INDEX);
    assert.equal(benchmark.status, status);
    assert.equal(benchmark.fallbackReason, 'unpublished');
    assert.equal(benchmark.baseDate, null);
    assert.ok(benchmark.points.every(point => point.close === null && point.scaledClose === null));
  }
});

test('an empty stock series preserves existing index data instead of labeling it as missing prices', async () => {
  for (const parentPrices of [[], [{ trade_date: '2026-10-13', close: '5000' }]]) {
    const { service } = fixture({ members: [withL2()], prices: [], indexPrices: [{ trade_date: '2026-10-13', close: '1000' }],
      indexPricesByCode: { [L2_INDEX]: parentPrices } });
    const { benchmark } = await service.prices({ ticker: TICKER, asOf: AS_OF, benchmark: 'sw2021_l3' });
    assert.equal(benchmark.status, 'no_common_date');
    assert.equal(benchmark.level, 3);
    assert.equal(benchmark.fallbackReason, null);
    assert.deepEqual(benchmark.latest, { date: '2026-10-13', close: 1000 });
    assert.deepEqual(benchmark.points, []);
  }
});

test('new table read failures produce the same sanitized database 503 as existing market reads', async () => {
  for (const [failAt, params] of [['prices', { adjustment: 'qfq' }], ['members', { benchmark: 'sw2021_l3' }], ['index', { benchmark: 'sw2021_l3' }]]) {
    const { service } = fixture({ failAt });
    await assert.rejects(service.prices({ ticker: TICKER, ...params }), error => {
      assert.equal(error.code, 'MARKET_DATABASE_UNAVAILABLE');
      assert.equal(error.status, 503);
      assert.doesNotMatch(error.message, /secret-password|postgresql|relation/);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});
