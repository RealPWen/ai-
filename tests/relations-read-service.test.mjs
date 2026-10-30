import assert from 'node:assert/strict';
import test from 'node:test';
import { createRelationsReadService } from '../backend/market-data/relations-read-service.mjs';

const NOW = () => new Date('2026-10-15T01:00:00Z');
const PERIODS = ['w1', 'm1', 'm6', 'y1', 'y3'];
const BASE_DATES = { w1: '2026-10-07', m1: '2026-09-15', m6: '2026-04-15', y1: '2025-10-15', y3: '2023-10-13' };
const related = (index, overrides = {}) => ({
  relatedTicker: `${String(index + 1).padStart(6, '0')}.SZ`, relatedName: `关联公司${index + 1}`,
  relationType: ['upstream', 'peer', 'downstream'][index % 3], evidenceType: 'business_comparable', rank: index + 1,
  rationale: '已核验的业务可比关系', actualEntity: `关联公司${index + 1}本体`, listedMappingBasis: '上市公司本体',
  notes: '业务可比不代表直接交易', verifiedAt: '2026-10-15T00:00:00Z',
  sources: [{ url: 'https://example.com/report.pdf', title: '年度报告', excerpt: '业务信息' }], ...overrides,
});
const job = (relations = [], overrides = {}) => ({
  available_from: '2026-10-15', database_through: '2026-10-15', known_ticker: '002920.SZ',
  subject_name: '德赛西威', run_id: 'frozen-20261015', relation_as_of: '2026-10-15',
  method_version: 'a-relations-v1', job_status: relations.length === 10 ? 'completed' : 'partial',
  gaps: [], published_relations: relations, draft_relations: [], archived_relations: [], ...overrides,
});
const price = (overrides = {}) => ({
  ts_code: '002920.SZ', market: 'A', trade_date: '2026-10-14', close: '120', pct_chg: '-1.25', adj_factor: '2',
  pe_ttm: '32.4', pb: '5.2', valuation_as_of: '2026-10-14', period: 'w1',
  base_date: '2026-10-07', base_close: '100', base_factor: '1', ...overrides,
});
function fixture(researchRows = [], priceRows = [], options = {}) {
  const calls = [];
  const pool = {
    async query(sql, params) { calls.push({ sql, params }); return { rows: calls.length === 1 ? researchRows : priceRows }; },
    async end() { calls.push({ end: true }); },
  };
  return { calls, service: createRelationsReadService({ pool, now: NOW, ...options }) };
}

test('reads published relationships and all eleven market snapshots in two parameterized read-only queries', async () => {
  const relations = Array.from({ length: 10 }, (_, index) => related(index));
  const prices = PERIODS.map(period => price({ period, base_date: BASE_DATES[period] }));
  prices.push(price({ ts_code: relations[0].relatedTicker, period: 'w1' }));
  const { service, calls } = fixture([job(relations)], prices);
  const result = await service.get({ ticker: ' 002920.sz ', asOf: '2026-10-15' });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.counts, { upstream: 4, peer: 3, downstream: 3, total: 10 });
  assert.equal(result.missing, 0);
  assert.equal(result.ticker, '002920.SZ');
  assert.equal(result.asOf, '2026-10-15');
  assert.equal(result.relationAsOf, '2026-10-15');
  assert.equal(result.methodVersion, 'a-relations-v1');
  assert.equal(result.runId, 'frozen-20261015');
  assert.equal(result.subject.name, '德赛西威');
  assert.equal(result.subject.market.close, 120);
  assert.equal(result.subject.market.changePct, -1.25);
  assert.equal(result.subject.market.peTtm, 32.4);
  assert.equal(result.subject.market.pb, 5.2);
  assert.equal(result.subject.market.tradeDate, '2026-10-14');
  assert.equal(result.subject.market.valuationAsOf, '2026-10-14');
  for (const period of PERIODS) {
    assert.ok(Math.abs(result.subject.market.returns[period] - 140) < 1e-10);
    assert.equal(result.subject.market.returnStatus[period], 'available');
  }
  assert.match(result.subject.market.returnBasis, /不含息/);
  assert.equal(result.subject.market.returnAdjustment, 'qfq');
  assert.equal(result.subject.market.adjustment, 'none');
  assert.equal(result.relations[0].market.close, 120);
  assert.equal(result.relations[1].market.close, null);
  assert.equal(result.relations[1].market.status, 'no_prices');
  assert.deepEqual(result.relations[0].sources, relations[0].sources);
  assert.equal(result.relations[0].actualEntity, '关联公司1本体');
  assert.equal(result.relations[0].verifiedAt, '2026-10-15T00:00:00.000Z');
  assert.equal(result.meta.relationSource, 'published');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].params, ['002920.SZ', '2026-10-15']);
  assert.deepEqual(calls[1].params, [
    ['002920.SZ', ...relations.map(row => row.relatedTicker)], '2026-10-15',
    '2026-09-15', '2026-04-15', '2025-10-15', '2023-10-15',
  ]);
  for (const { sql } of calls) {
    assert.ok(!/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|CALL)\b/i.test(sql));
  }
  assert.match(calls[0].sql, /j\.draft_relations/);
  assert.match(calls[0].sql, /j\.as_of <= \$2::date/);
  assert.match(calls[0].sql, /r\.as_of <= \$2::date/);
  assert.match(calls[1].sql, /unnest\(\$1::text\[\]\)/);
  assert.match(calls[1].sql, /OFFSET CASE WHEN h\.period = 'w1' THEN 5 ELSE 0 END/);
  assert.match(calls[1].sql, /WHERE p.ts_code = a.ts_code AND p.market = a.market AND p.close > 0/);
  assert.match(calls[1].sql, /v\.trade_date = p\.trade_date/);
});

test('partial research retains relationships, its evidence, and explicit missing market values and gaps', async () => {
  const { service } = fixture([job([related(0), related(1)], { gaps: ['下游证据不足，未补齐'], job_status: 'partial' })]);
  const result = await service.get({ ticker: '002920.SZ' });
  assert.equal(result.status, 'complete');
  assert.equal(result.missing, 0);
  assert.equal(result.counts.total, 2);
  assert.deepEqual(result.gaps, ['下游证据不足，未补齐']);
  assert.equal(result.relations.length, 2);
  assert.equal(result.relations[0].market.tradeDate, null);
  assert.deepEqual(result.relations[0].market.returns, { w1: null, m1: null, m6: null, y1: null, y3: null });
  assert.equal(result.relations[0].market.returnStatus.w1, 'no_prices');
  assert.equal(result.meta.knownTicker, true);
});

test('a newer partial snapshot replaces older research without filling omissions from it', async () => {
  const drafts = [7, 3, 1].map(index => related(index, { rank: undefined }));
  const newer = job([], {
    run_id: 'newer-partial', draft_relations: drafts,
    job_status: 'partial', gaps: ['已核实三家上游，下游及同行待补齐'],
  });
  const older = job(Array.from({ length: 10 }, (_, index) => related(index)), {
    run_id: 'older-complete', relation_as_of: '2026-10-14',
  });
  const { service, calls } = fixture([newer, older]);
  const result = await service.get({ ticker: '002920.SZ' });
  assert.equal(result.status, 'complete');
  assert.equal(result.runId, 'newer-partial');
  assert.equal(result.meta.relationSource, 'draft');
  assert.equal(result.meta.researchJobStatus, 'partial');
  assert.equal(result.counts.total, 3);
  assert.equal(result.missing, 0);
  assert.deepEqual(result.relations.map(row => row.relatedTicker), drafts.map(row => row.relatedTicker));
  assert.deepEqual(result.relations.map(row => row.rank), [1, 2, 3]);
  assert.deepEqual(result.gaps, ['已核实三家上游，下游及同行待补齐']);
  assert.deepEqual(result.relations[0].sources, drafts[0].sources);
  assert.deepEqual(calls[1].params[0], ['002920.SZ', ...drafts.map(row => row.relatedTicker)]);
});

test('drafts require a valid verification timestamp no later than the Shanghai request day and usable source dates', async () => {
  const drafts = [
    related(0, { verifiedAt: '2026-10-15T15:59:59Z' }),
    related(1, { verifiedAt: '2026-10-15T16:00:00Z' }),
    related(2, { verifiedAt: null }),
    related(3, { verifiedAt: '2026-02-30T00:00:00Z' }),
    related(4, { verifiedAt: '2026-10-15' }),
    related(5, { verifiedAt: '2026-10-15T24:00:00Z' }),
    related(6, { sources: [{ publishedAt: '2026-10-16', url: 'https://example.com/future' }] }),
    related(7, { sources: [] }),
    related(8, { relatedTicker: '002920.SZ' }),
    related(9, { relatedTicker: related(0).relatedTicker }),
    related(10, { sources: [{ publishedAt: '2026-10-15', url: 'https://example.com/today' }] }),
  ];
  const result = await fixture([job([], { draft_relations: drafts })]).service.get({ ticker: '002920.SZ' });
  assert.equal(result.status, 'complete');
  assert.equal(result.counts.total, 2);
  assert.equal(result.missing, 0);
  assert.equal(result.meta.relationSource, 'draft');
  assert.deepEqual(result.relations.map(row => row.relatedTicker), [related(0).relatedTicker, related(10).relatedTicker]);
  assert.equal(result.relations[0].verifiedAt, '2026-10-15T15:59:59.000Z');
});

test('a newer draft with no relationships available at the cutoff falls back to the latest usable older snapshot', async () => {
  const newer = job([], {
    run_id: 'future-verification', draft_relations: [related(1, { verifiedAt: '2026-10-16T00:00:00Z' })],
    gaps: ['newer hidden gap'],
  });
  const older = job([], {
    run_id: 'older-verified', relation_as_of: '2026-10-14',
    archived_relations: [related(0, { verifiedAt: '2026-10-14T03:00:00Z' })], gaps: ['older available gap'],
  });
  const result = await fixture([newer, older]).service.get({ ticker: '002920.SZ' });
  assert.equal(result.runId, 'older-verified');
  assert.equal(result.meta.relationSource, 'archive');
  assert.deepEqual(result.gaps, ['older available gap']);
  assert.deepEqual(result.relations.map(row => row.relatedTicker), [related(0).relatedTicker]);
});

test('draft visibility has a ten-company maximum and excludes another subject or future research run', async () => {
  const all = Array.from({ length: 12 }, (_, index) => related(index));
  const { service, calls } = fixture([
    job([], { subject_ticker: '601127.SH', run_id: 'other-subject', draft_relations: [related(15)] }),
    job([], { relation_as_of: '2026-10-16', run_id: 'future-run', draft_relations: [related(14)] }),
    job([], { subject_ticker: '002920.SZ', run_id: 'requested-subject', draft_relations: all }),
  ]);
  const result = await service.get({ ticker: '002920.SZ' });
  assert.equal(result.runId, 'requested-subject');
  assert.equal(result.meta.relationSource, 'draft');
  assert.equal(result.status, 'complete');
  assert.equal(result.relations.length, 10);
  assert.equal(result.missing, 0);
  assert.equal(result.meta.targetCount, null);
  assert.deepEqual(calls[1].params[0], ['002920.SZ', ...all.slice(0, 10).map(row => row.relatedTicker)]);
});

test('known unresearched and unknown securities are distinguishable without fabricating relations', async () => {
  const known = await fixture([job([], { job_status: 'pending' })]).service.get({ ticker: '002920.SZ' });
  assert.equal(known.status, 'not_researched');
  assert.equal(known.meta.knownTicker, true);
  assert.equal(known.meta.researchJobStatus, 'pending');
  assert.deepEqual(known.relations, []);
  assert.equal(known.missing, 0);
  const unknown = await fixture([{ subject_name: '999999.SZ', known_ticker: null, available_from: null }]).service.get({ ticker: '999999.SZ' });
  assert.equal(unknown.status, 'not_researched');
  assert.equal(unknown.meta.knownTicker, false);
  assert.equal(unknown.relationAsOf, null);
  assert.equal(unknown.runId, null);
  assert.deepEqual(unknown.relations, []);
});

test('a frozen run later than requested asOf never leaks relationship payloads or gaps', async () => {
  // Also guards against an injected pool accidentally ignoring the SQL cutoff.
  const { service, calls } = fixture([job([related(0, { rationale: 'future secret' })], { gaps: ['future gap'] })]);
  const result = await service.get({ ticker: '002920.SZ', asOf: '2026-10-14' });
  assert.equal(result.status, 'not_available_as_of');
  assert.equal(result.relationAsOf, null);
  assert.equal(result.runId, null);
  assert.equal(result.methodVersion, null);
  assert.deepEqual(result.relations, []);
  assert.deepEqual(result.gaps, []);
  assert.ok(!JSON.stringify(result).includes('future'));
  assert.deepEqual(calls[1].params[0], ['002920.SZ']);
});

test('the newest available published or archived snapshot survives a newer unresearched run', async () => {
  const older = job([], {
    run_id: 'older-archive', relation_as_of: '2026-09-30',
    archived_relations: [related(0, { verifiedAt: '2026-09-30T03:00:00Z' })], gaps: ['旧研究缺口'],
  });
  const newer = job([], { job_status: 'pending' });
  const result = await fixture([newer, older]).service.get({ ticker: '002920.SZ' });
  assert.equal(result.relationAsOf, '2026-09-30');
  assert.equal(result.runId, 'older-archive');
  assert.equal(result.status, 'complete');
  assert.equal(result.meta.relationSource, 'archive');
  assert.deepEqual(result.gaps, ['旧研究缺口']);
  assert.equal(result.relations.length, 1);
  const historical = await fixture([newer, older]).service.get({ ticker: '002920.SZ', asOf: '2026-10-01' });
  assert.equal(historical.runId, 'older-archive');
});

test('return factors and baseline gaps remain null with explicit statuses, with no raw-price fallback', async () => {
  const rows = [
    price({ period: 'w1', adj_factor: null }),
    price({ period: 'm1', base_date: null }),
    price({ period: 'm6', base_date: BASE_DATES.m6, base_factor: null }),
    price({ period: 'y1', base_date: BASE_DATES.y1, base_close: '0' }),
    price({ period: 'y3', base_date: '2026-10-16' }),
  ];
  const result = await fixture([job([related(0)])], rows).service.get({ ticker: '002920.SZ' });
  assert.deepEqual(result.subject.market.returns, { w1: null, m1: null, m6: null, y1: null, y3: null });
  assert.deepEqual(result.subject.market.returnStatus, {
    w1: 'missing_anchor_factor', m1: 'insufficient_history', m6: 'missing_base_factor',
    y1: 'invalid_base_price', y3: 'insufficient_history',
  });
  assert.equal(result.subject.market.returnBaseDates.y3, null);
});

test('stale anchor prices and sources later than the request never become period returns or historical evidence', async () => {
  const futureSource = related(1, { sources: [{ publishedAt: '2026-10-16', url: 'https://example.com/future' }] });
  const result = await fixture([job([related(0), futureSource])], [
    price({ period: 'm1', trade_date: '2026-01-15', base_date: '2026-01-14' }),
    price({ period: 'm6', trade_date: '2026-01-15', base_date: '2026-01-14' }),
  ]).service.get({ ticker: '002920.SZ' });
  assert.equal(result.relations.length, 1);
  assert.equal(result.relations[0].relatedTicker, related(0).relatedTicker);
  assert.equal(result.subject.market.returns.m1, null);
  assert.equal(result.subject.market.returnStatus.m1, 'insufficient_history');
  assert.equal(result.subject.market.returns.m6, null);
  assert.equal(result.subject.market.returnStatus.m6, 'insufficient_history');
});

test('market data does not cross the request cutoff or fill valuation from another trading date', async () => {
  const result = await fixture([job([])], [
    price({ valuation_as_of: '2026-10-13' }),
    price({ ts_code: '000001.SZ', trade_date: '2026-10-16' }),
    price({ ts_code: '002920.SZ', trade_date: '2026-10-16', close: '9999' }),
  ]).service.get({ ticker: '002920.SZ' });
  assert.equal(result.subject.market.close, 120);
  assert.equal(result.subject.market.peTtm, null);
  assert.equal(result.subject.market.pb, null);
  assert.equal(result.subject.market.valuationAsOf, null);
  assert.equal(result.subject.market.valuationStatus, 'missing');
  assert.equal(result.relations.length, 0);
});

test('Shanghai default date and calendar month/year subtraction handle month ends and leap years', async () => {
  const f = fixture([], [], { now: () => new Date('2026-10-14T16:01:00Z') });
  await f.service.get({ ticker: '002920.SZ' });
  assert.deepEqual(f.calls[0].params, ['002920.SZ', '2026-10-15']);
  const leap = fixture();
  await leap.service.get({ ticker: '002920.SZ', asOf: '2024-03-31' });
  assert.deepEqual(leap.calls[1].params.slice(1), ['2024-03-31', '2024-02-29', '2023-09-30', '2023-03-31', '2021-03-31']);
});

test('invalid inputs are rejected before SQL', async () => {
  const { service, calls } = fixture();
  for (const params of [null, [], '002920.SZ', { ticker: '002920.SZ', runId: 'anything' }]) {
    await assert.rejects(service.get(params), { code: 'INVALID_PARAMETERS', status: 400 });
  }

  for (const ticker of [undefined, null, [], '002920', '700.HK', '000700.HK', '002920.US', "002920.SZ' OR 1=1"]) {
    await assert.rejects(service.get({ ticker }), { code: 'INVALID_TICKER', status: 400 });
  }
  for (const asOf of ['2026-10-16', '2026-02-30', '2025-02-29', '2026-2-01', '', 20261015]) {
    await assert.rejects(service.get({ ticker: '002920.SZ', asOf }), { code: 'INVALID_DATE', status: 400 });
  }
  assert.equal(calls.length, 0);
});

test('database and close errors are sanitized and a supplied pool is released', async () => {
  const secret = 'SELECT private FROM secrets; postgresql://user:password@private';
  const service = createRelationsReadService({ now: NOW, pool: {
    async query() { throw new Error(secret); }, async end() { throw new Error(secret); },
  } });
  for (const action of [() => service.get({ ticker: '002920.SZ' }), () => service.close()]) {
    await assert.rejects(action(), error => {
      assert.equal(error.code, 'RELATIONS_DATABASE_UNAVAILABLE');
      assert.equal(error.status, 503);
      assert.equal(error.cause, undefined);
      assert.ok(!error.message.includes('postgresql'));
      assert.ok(!error.message.includes('SELECT'));
      return true;
    });
  }
  assert.throws(() => createRelationsReadService(), { code: 'RELATIONS_DATABASE_UNAVAILABLE', status: 503 });
  const f = fixture();
  await f.service.close();
  assert.deepEqual(f.calls, [{ end: true }]);
});


test('HK subject reads local HK prices and valuations with explicit raw-price changes alongside adjusted A counterparties', async () => {
  const relations = [related(0), related(1, { relatedTicker: '02313.HK' })];
  const prices = PERIODS.map(period => price({
    ts_code: '00700.HK', market: 'HK', period, base_date: BASE_DATES[period],
    source: 'tencent', source_api: 'tencent_hk_daily', valuation_source: 'baidu', valuation_source_api: 'baidu_hk_valuation',
    adj_factor: null, base_factor: null,
  }));
  prices.push(price({ ts_code: '000001.SZ' }));
  const f = fixture([job(relations, { subject_ticker: '00700.HK', subject_name: '腾讯控股', known_ticker: null })], prices);
  const result = await f.service.get({ ticker: ' 00700.hk ' });
  assert.equal(result.subject.name, '腾讯控股');
  assert.equal(result.counts.total, 1);
  assert.equal(result.subject.market.close, 120);
  assert.equal(result.subject.market.peTtm, 32.4);
  assert.equal(result.subject.market.pb, 5.2);
  assert.equal(result.subject.market.valuationAsOf, '2026-10-14');
  assert.equal(result.subject.market.currency, 'HKD');
  assert.equal(result.subject.market.status, 'available');
  assert.equal(result.subject.market.source, 'tencent');
  assert.equal(result.subject.market.sourceApi, 'tencent_hk_daily');
  assert.equal(result.subject.market.valuationSource, 'baidu');
  assert.equal(result.subject.market.valuationSourceApi, 'baidu_hk_valuation');
  assert.equal(result.subject.market.adjustment, 'none');
  assert.equal(result.subject.market.returnAdjustment, 'none');
  assert.match(result.subject.market.returnBasis, /未复权.*非投资总回报/);
  for (const period of PERIODS) {
    assert.ok(Math.abs(result.subject.market.returns[period] - 20) < 1e-10);
    assert.equal(result.subject.market.returnStatus[period], 'available');
    assert.equal(result.subject.market.returnBaseDates[period], BASE_DATES[period]);
  }
  assert.equal(result.relations[0].market.close, 120);
  assert.ok(Math.abs(result.relations[0].market.returns.w1 - 140) < 1e-10);
  assert.equal(result.relations[0].market.returnAdjustment, 'qfq');
  assert.deepEqual(f.calls[1].params[0], ['00700.HK', '000001.SZ']);
  assert.match(f.calls[0].sql, /WHERE j.ticker = \$1 AND j.is_subject/);
  assert.match(f.calls[1].sql, /market = r\.market/);
  assert.match(f.calls[1].sql, /p\.market = a\.market/);
  assert.match(f.calls[1].sql, /market_data\.hk_daily_valuations hv/);
  assert.match(f.calls[1].sql, /hv\.trade_date = p\.trade_date/);
  assert.match(result.meta.returnBasis, /A股：.*前复权.*港股：.*未复权/);
  assert.equal(result.meta.currency, 'mixed');
});

test('HK price changes retain missing-history, invalid-price and cutoff guards without borrowing A factors or valuations', async () => {
  const hkPrice = overrides => price({ ts_code: '02313.HK', market: 'HK', adj_factor: '100', base_factor: '1', ...overrides });
  const f = fixture([job([], { subject_ticker: '02313.HK' })], [
    hkPrice({ period: 'w1', close: '80', valuation_as_of: '2026-10-13' }),
    hkPrice({ period: 'm1', close: '80', base_date: null, valuation_as_of: '2026-10-13' }),
    hkPrice({ period: 'm6', close: '80', base_date: BASE_DATES.m6, base_close: '0', valuation_as_of: '2026-10-13' }),
    hkPrice({ period: 'y1', close: '80', base_date: '2026-10-15', valuation_as_of: '2026-10-13' }),
    hkPrice({ period: 'y3', close: '9999', trade_date: '2026-10-16' }),
    hkPrice({ period: 'w1', close: '9999', market: 'A' }),
  ]);
  const result = await f.service.get({ ticker: '02313.HK' });
  assert.equal(result.subject.market.close, 80);
  assert.ok(Math.abs(result.subject.market.returns.w1 + 20) < 1e-10);
  assert.deepEqual(result.subject.market.returnStatus, {
    w1: 'available', m1: 'insufficient_history', m6: 'invalid_base_price', y1: 'insufficient_history', y3: 'no_prices',
  });
  assert.deepEqual(result.subject.market.returns, { w1: result.subject.market.returns.w1, m1: null, m6: null, y1: null, y3: null });
  assert.equal(result.subject.market.peTtm, null);
  assert.equal(result.subject.market.pb, null);
  assert.equal(result.subject.market.valuationAsOf, null);
  assert.equal(result.subject.market.valuationStatus, 'missing');
  const missing = await fixture([job([], { subject_ticker: '02313.HK' })]).service.get({ ticker: '02313.HK' });
  assert.equal(missing.subject.market.status, 'no_prices');
  assert.ok(Object.values(missing.subject.market.returns).every(value => value === null));
  assert.equal(missing.subject.market.returnAdjustment, 'none');
  assert.match(missing.subject.market.returnBasis, /未复权/);
});

test('USD HK subjects retain actual quote currency and catalog currency when no quote exists', async () => {
  for (const trade_date of ['2026-10-14', null]) {
    const f=fixture([job([], { subject_ticker:'00770.HK',subject_name:'SHANGHAI GROWTH',known_ticker:'00770.HK' })],
      [price({ts_code:'00770.HK',market:'HK',currency:'USD',trade_date,source:'tencent',source_api:'tencent_hk_daily'})]);
    const result=await f.service.get({ticker:'00770.HK'});
    assert.equal(result.subject.market.currency,'USD');
    assert.equal(result.subject.market.status,trade_date?'available':'no_prices');
    assert.match(f.calls[1].sql,/coalesce\(p.currency,r.currency\) AS currency/);
  }
});

const manualEvent = (index, overrides = {}) => ({
  relatedTicker: `${String(index + 1).padStart(6, '0')}.SZ`, relatedName: `本地证券${index + 1}`,
  action: 'upsert', relationType: 'peer', rationale: '', revision: '1',
  effectiveDate: '2026-10-15', manualUpdatedAt: '2026-10-15T00:30:00.000Z', ...overrides,
});

test('manual overlays are merged after the strict AI snapshot and use A/HK market rows without invented citations', async () => {
  const base = Array.from({ length: 10 }, (_, index) => related(index));
  const events = [manualEvent(0, { relationType: 'downstream', rationale: '人工调整类别' }),
    manualEvent(1, { action: 'remove', relationType: null }),
    manualEvent(20, { relatedTicker: '00700.HK', relatedName: '腾讯控股' })];
  const { service, calls } = fixture([job(base, { manual_revision: '7', manual_events: events })]);
  const result = await service.get({ ticker: '002920.SZ' });
  assert.equal(result.status, 'customized'); assert.equal(result.meta.manualRevision, '7');
  assert.equal(result.meta.hasManualChanges, true); assert.deepEqual(result.meta.manualCounts, { upsert: 2, remove: 1, total: 3 });
  assert.equal(result.counts.total, 10); assert.equal(result.missing, 0);
  const adjusted = result.relations.find(row => row.relatedTicker === base[0].relatedTicker);
  assert.equal(adjusted.relationType, 'downstream'); assert.equal(adjusted.evidenceType, 'manual'); assert.equal(adjusted.origin, 'manual');
  assert.deepEqual(adjusted.sources, []); assert.equal(adjusted.verifiedAt, null); assert.equal(adjusted.manualEffectiveDate, '2026-10-15');
  assert.equal(adjusted.manualUpdatedAt, '2026-10-15T00:30:00.000Z');
  assert.deepEqual(result.relations.find(row => row.relatedTicker === base[2].relatedTicker).sources, base[2].sources);
  assert.equal(result.relations.find(row => row.relatedTicker === '00700.HK').market.currency, 'HKD');
  assert.equal(result.meta.currency, 'mixed');
  assert.ok(!calls[1].params[0].includes(base[1].relatedTicker)); assert.ok(calls[1].params[0].includes('00700.HK'));
  assert.equal(result.meta.removedRelations[0].relatedTicker, base[1].relatedTicker);
  assert.equal(result.meta.removedRelations[0].relatedName, events[1].relatedName);
  assert.match(calls[0].sql, /effective_date <= \$2::date/); assert.match(calls[0].sql, /effective_date DESC, revision DESC/);
});

test('the final manual overlay remains capped at ten and may remove every AI row', async () => {
  const additions = Array.from({ length: 10 }, (_, index) => manualEvent(index + 100));
  const added = await fixture([job([], { manual_revision: '1', manual_events: additions })]).service.get({ ticker: '002920.SZ' });
  assert.equal(added.relations.length, 10); assert.equal(added.status, 'customized'); assert.equal(added.missing, 0);
  assert.deepEqual(added.relations.map(row => row.rank), Array.from({ length: 10 }, (_, index) => index + 1));
  const removed = await fixture([job(Array.from({ length: 10 }, (_, index) => related(index)), {
    manual_revision: '2', manual_events: Array.from({ length: 10 }, (_, index) => manualEvent(index, { action: 'remove', relationType: null })),
  })]).service.get({ ticker: '002920.SZ' });
  assert.equal(removed.relations.length, 0); assert.equal(removed.status, 'customized'); assert.equal(removed.meta.removedRelations.length, 10);
  assert.equal(removed.meta.manualCounts.remove, 10); assert.equal(removed.counts.total, 0);
});

test('manual history selects effective dates before revisions, restore follows AI and future events never leak', async () => {
  const base = related(0), events = [manualEvent(0, { effectiveDate: '2026-10-13', revision: '99', rationale: '后录入的历史修正' }),
    manualEvent(0, { effectiveDate: '2026-10-14', revision: '2', relationType: 'downstream' }),
    manualEvent(0, { effectiveDate: '2026-10-16', revision: '100', rationale: 'future secret' })];
  const result = await fixture([job([base], { manual_revision: '100', manual_events: events })]).service.get({ ticker: '002920.SZ' });
  assert.equal(result.relations[0].relationType, 'downstream'); assert.equal(result.meta.manualRevision, '100');
  assert.ok(!JSON.stringify(result).includes('future secret'));
  const restored = await fixture([job([base], { manual_revision: '101', manual_events: [...events,
    manualEvent(0, { effectiveDate: '2026-10-15', revision: '101', action: 'restore', relationType: null })] })]).service.get({ ticker: '002920.SZ' });
  assert.equal(restored.meta.hasManualChanges, false); assert.deepEqual(restored.meta.removedRelations, []);
  assert.equal(restored.relations[0].evidenceType, 'business_comparable'); assert.deepEqual(restored.relations[0].sources, base.sources);
  assert.equal(restored.status, 'complete'); assert.equal(restored.meta.manualRevision, '101');
  const older = await fixture([job([], { manual_revision: '100', manual_events: events })]).service.get({ ticker: '002920.SZ', asOf: '2026-10-12' });
  assert.deepEqual(older.relations, []); assert.equal(older.meta.hasManualChanges, false); assert.equal(older.meta.manualRevision, '100');
});

test('new automated runs cannot resurrect an explicitly removed pair or claim a manual row as AI evidence', async () => {
  const tombstone = manualEvent(0, { action: 'remove', relationType: null, effectiveDate: '2026-10-01' });
  const result = await fixture([job([related(0), related(1)], { run_id: 'new-AI-publication', manual_revision: '1', manual_events: [tombstone] })]).service.get({ ticker: '002920.SZ' });
  assert.equal(result.runId, 'new-AI-publication'); assert.deepEqual(result.relations.map(row => row.relatedTicker), [related(1).relatedTicker]);
  assert.equal(result.status, 'customized'); assert.equal(result.meta.removedRelations.length, 1);
  const plain = await fixture([job([related(0)])]).service.get({ ticker: '002920.SZ' });
  assert.equal(plain.meta.manualRevision, '0'); assert.equal(plain.meta.hasManualChanges, false);
});

test('on-demand AI snapshots support A/HK counterparts and preserve manual precedence without mutating old research', async () => {
  const hk = related(7, { relatedTicker: '00700.HK', relatedName: '腾讯控股' });
  const metadata = job([related(0)], {
    relation_as_of: '2026-10-14', research_created_at: '2026-10-14T01:00:00Z',
    ai_job_id: 'on-demand-job', ai_as_of: '2026-10-15', ai_subject_name: '德赛西威',
    ai_method_version: 'ah-relations-ai-v1', ai_created_at: '2026-10-15T01:00:00Z',
    ai_relations: [hk, related(1)], ai_gaps: ['只确认两家公司，其他关系证据不足。'],
    ai_latest_job: { jobId: 'on-demand-job', status: 'succeeded', relationCount: 2 },
    manual_revision: '1', manual_events: [manualEvent(1, { action: 'remove', relationType: null })],
  });
  const { service, calls } = fixture([metadata]);
  const result = await service.get({ ticker: '002920.SZ' });
  assert.equal(result.runId, 'on-demand-job'); assert.equal(result.methodVersion, 'ah-relations-ai-v1');
  assert.equal(result.meta.relationSource, 'ai'); assert.equal(result.status, 'customized');
  assert.deepEqual(result.relations.map(row => row.relatedTicker), ['00700.HK']);
  assert.equal(result.relations[0].market.currency, 'HKD');
  assert.deepEqual(result.gaps, ['只确认两家公司，其他关系证据不足。']);
  assert.equal(result.meta.aiJob.relationCount, 2);
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /company_relation_ai_jobs/);
  assert.match(calls[0].sql, /as_of <= \$2::date AND status = 'succeeded'/);
});

test('empty and failed AI attempts retain the last good relations and explicitly explain the preserved result', async () => {
  for (const latest of [{ status: 'succeeded', relationCount: 0, gaps: ['无可验证的关系'] }, { status: 'failed', relationCount: 0 }]) {
    const result = await fixture([job([related(0)], { ai_latest_job: latest })]).service.get({ ticker: '002920.SZ' });
    assert.equal(result.relations.length, 1); assert.equal(result.meta.relationSource, 'published');
    assert.match(result.meta.aiResultNote, /保留此前关系/);
    assert.deepEqual(result.meta.aiJob, latest);
  }
  const empty = await fixture([{ known_ticker: '00700.HK', subject_name: '腾讯控股',
    ai_latest_job: { status: 'succeeded', relationCount: 0 } }]).service.get({ ticker: '00700.HK' });
  assert.equal(empty.status, 'not_researched'); assert.deepEqual(empty.relations, []);
  assert.match(empty.meta.aiResultNote, /未填充未经证实/);
});

test('a newer single researcher snapshot replaces old AI and future AI cannot leak into historical reads', async () => {
  const current = job([related(0)], { research_created_at: '2026-10-15T03:00:00Z',
    ai_job_id: 'older-AI', ai_as_of: '2026-10-15', ai_relations: [related(1)], ai_created_at: '2026-10-15T01:00:00Z' });
  const result = await fixture([current]).service.get({ ticker: '002920.SZ' });
  assert.equal(result.meta.relationSource, 'published'); assert.deepEqual(result.relations.map(row => row.relatedTicker), [related(0).relatedTicker]);
  const past = await fixture([job([related(0)], { ai_job_id: 'future-AI', ai_as_of: '2026-10-16',
    ai_relations: [related(1, { rationale: 'future secret' })] })]).service.get({ ticker: '002920.SZ' });
  assert.equal(past.meta.relationSource, 'published'); assert.ok(!JSON.stringify(past).includes('future secret'));
});

const current = (relations, overrides = {}) => ({
  current_ticker: '002920.SZ', current_subject_name: '德赛西威', current_as_of: '2026-10-15',
  current_relations: relations, current_gaps: [], current_researched_at: '2026-10-15T01:00:00Z',
  current_method_version: 'ah-relations-ai-v3', current_source: 'ai', current_run_id: 'current-job',
  current_updated_at: '2026-10-15T01:00:00Z', ...overrides,
});

test('the canonical current row is the sole saved result and never fills omissions from legacy or earlier AI research', async () => {
  const old = Array.from({ length: 10 }, (_, index) => related(index));
  const fresh = [related(10, { rationale: '本次完整替换的关系', verifiedAt: '2026-10-15T01:00:00Z' })];
  const row = job(old, { ...current(fresh, { current_gaps: ['本次只找到一家'] }),
    ai_job_id: 'older-ai', ai_as_of: '2026-10-15', ai_relations: [related(11)], ai_created_at: '2026-10-15T00:00:00Z' });
  const { service, calls } = fixture([row]);
  const result = await service.get({ ticker: '002920.SZ' });
  assert.equal(result.runId, 'current-job');
  assert.equal(result.methodVersion, 'ah-relations-ai-v3');
  assert.equal(result.meta.storageMode, 'single_current');
  assert.equal(result.meta.relationSource, 'ai');
  assert.equal(result.meta.updatedAt, '2026-10-15T01:00:00Z');
  assert.deepEqual(result.relations.map(row => row.relatedTicker), [fresh[0].relatedTicker]);
  assert.deepEqual(result.relations[0].sources, fresh[0].sources);
  assert.equal(result.relations[0].rationale, '本次完整替换的关系');
  assert.deepEqual(result.gaps, ['本次只找到一家']);
  assert.equal(result.meta.sourceSnapshots, undefined);
  assert.equal(result.relations[0].researchSources, undefined);
  assert.deepEqual(calls[1].params[0], ['002920.SZ', fresh[0].relatedTicker]);
  assert.match(calls[0].sql, /company_relation_current/);
  assert.match(calls[0].sql, /NOT EXISTS \(SELECT 1 FROM current_state\)/);
  assert.doesNotMatch(calls[0].sql, /ai_history|ai_saved/);
});

test('a cutoff earlier than the current row returns no relations and never replays older saved versions or manual history', async () => {
  const old = related(0, { verifiedAt: '2026-10-14T00:00:00Z' });
  const row = job([old], { relation_as_of: '2026-10-14', ...current([related(1)]),
    manual_revision: '1', manual_events: [manualEvent(2, { effectiveDate: '2026-10-14' })] });
  const result = await fixture([row]).service.get({ ticker: '002920.SZ', asOf: '2026-10-14' });
  assert.equal(result.status, 'not_available_as_of');
  assert.deepEqual(result.relations, []);
  assert.equal(result.relationAsOf, null);
  assert.equal(result.runId, null);
  assert.deepEqual(result.gaps, []);
  assert.equal(result.meta.updatedAt, null);
  assert.equal(result.meta.hasManualChanges, false);
  assert.equal(result.meta.availableFrom, '2026-10-15');
});

test('failed and empty AI attempts leave the canonical report visible without restoring superseded relations', async () => {
  for (const attempt of [{ status: 'failed', relationCount: 0 }, { status: 'succeeded', relationCount: 0 }]) {
    const saved = related(7);
    const result = await fixture([job([related(0)], { ...current([saved]), ai_latest_job: attempt })]).service.get({ ticker: '002920.SZ' });
    assert.deepEqual(result.relations.map(row => row.relatedTicker), [saved.relatedTicker]);
    assert.equal(result.runId, 'current-job');
    assert.match(result.meta.aiResultNote, /保留此前关系/);
  }
  const corruptEmpty = await fixture([job([related(0)], current([]))]).service.get({ ticker: '002920.SZ' });
  assert.deepEqual(corruptEmpty.relations, []);
  assert.equal(corruptEmpty.runId, 'current-job');
});

test('a canonical report supports A and HK rows, preserves source dates and is capped at ten without A/H history merging', async () => {
  const rows = Array.from({ length: 12 }, (_, index) => related(index));
  rows[1] = related(1, { relatedTicker: '02333.HK', relatedName: '长城汽车' });
  rows[2] = related(2, { relatedTicker: '601633.SH', relatedName: '长城汽车' });
  const result = await fixture([job([], current(rows))]).service.get({ ticker: '002920.SZ' });
  assert.equal(result.relations.length, 10);
  assert.deepEqual(result.relations.map(row => row.relatedTicker), rows.slice(0, 10).map(row => row.relatedTicker));
  assert.equal(result.relations[1].market.currency, 'HKD');
  assert.equal(result.relations[1].alternateTickers, undefined);
  assert.equal(result.meta.targetCount, null);
  assert.equal(result.missing, 0);
});

test('manual changes override canonical research and invalid stored overflow is explicit rather than silently truncated', async () => {
  const rows = Array.from({ length: 9 }, (_, index) => related(index));
  const event = manualEvent(20, { relatedName: '人工新增公司', rationale: '人工确认' });
  const result = await fixture([job([], { ...current(rows), manual_revision: '1', manual_events: [event] })]).service.get({ ticker: '002920.SZ' });
  assert.equal(result.relations.length, 10);
  assert.equal(result.status, 'customized');
  assert.equal(result.relations.at(-1).relatedTicker, event.relatedTicker);
  assert.equal(result.relations.at(-1).evidenceType, 'manual');
  assert.deepEqual(result.relations.at(-1).sources, []);
  assert.match(result.meta.replacementNote, /优先保留已有公司/);
  const overflow = fixture([job([], { ...current([...rows, related(9)]), manual_revision: '1', manual_events: [event] })]);
  await assert.rejects(overflow.service.get({ ticker: '002920.SZ' }), { code: 'RELATIONS_LIMIT_EXCEEDED', status: 409 });
});

test('superseded nonempty successful AI activity is hidden while current, running, failed and empty attempts remain visible', async () => {
  const saved = related(0);
  const obsolete = { jobId: 'old-ai', status: 'succeeded', relationCount: 4 };
  const result = await fixture([job([], { ...current([saved]), ai_latest_job: obsolete })]).service.get({ ticker: '002920.SZ' });
  assert.equal(result.meta.aiJob, null);
  for (const activity of [{ jobId: 'current-job', status: 'succeeded', relationCount: 1 },
    { jobId: 'running', status: 'running', relationCount: 0 }, { jobId: 'failed', status: 'failed', relationCount: 0 },
    { jobId: 'empty', status: 'succeeded', relationCount: 0 }]) {
    const visible = await fixture([job([], { ...current([saved]), ai_latest_job: activity })]).service.get({ ticker: '002920.SZ' });
    assert.deepEqual(visible.meta.aiJob, activity);
  }
});

test('legacy compatibility selects only one same-run draft, publication or archive when no canonical stock exists', async () => {
  const archive = Array.from({ length: 10 }, (_, index) => related(index));
  const result = await fixture([job([related(10)], { archived_relations: archive,
    draft_relations: [related(11, { rationale: '最新草稿' })] })]).service.get({ ticker: '002920.SZ' });
  assert.equal(result.relations.length, 1);
  assert.equal(result.relations[0].rationale, '最新草稿');
  assert.equal(result.meta.relationSource, 'draft');
});
