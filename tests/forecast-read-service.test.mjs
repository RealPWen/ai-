import assert from 'node:assert/strict';
import test from 'node:test';
import { createForecastReadService } from '../backend/market-data/forecast-read-service.mjs';

function fixture(rows = [], options = {}) {
  const calls = [], catalogCalls = [];
  const pool = {
    async query(sql, params) {
      if (sql.startsWith('SELECT ts_code, name FROM market_data.hk_listed_universe')) {
        catalogCalls.push({ sql, params });
        return { rows: (options.listings ?? [{ ticker: params[0], name: '当前上市公司' }]).filter(row => row.ticker === params[0] && row.active !== false).map(row => ({ ts_code: row.ticker, name: row.name })) };
      }
      calls.push({ sql, params }); return { rows };
    },
    async end() { calls.push({ end: true }); },
  };
  return { calls, catalogCalls, service: createForecastReadService({ pool, now: () => new Date('2026-10-14T01:00:00Z'), ...options }) };
}
const row = (id, broker, eps, extra = {}) => ({
  forecast_id: id, org_name: broker, eps, report_date: '2026-10-01', quarter: '2026Q4',
  report_title: '年度盈利预测', author_name: '分析师', np: '123.5', pe: '20.5', rating: '买入',
  available_from: '2025-10-14', database_through: '2026-10-13', fetched_at_max: '2026-10-14T01:00:00.000Z', ...extra,
});

test('forecast samples group annual EPS by year and count each broker once per year', async () => {
  const { service, calls } = fixture([
    row('1', '甲证券', '1.2'), row('2', '乙证券', '2.4'),
    row('3', '甲证券', '2.5', { quarter: '2027Q4' }),
    row('4', '丙证券', '3.2', { quarter: '2027Q4' }),
    row('5', '甲证券', '1', { quarter: '2026Q3' }),
    row('6', '甲证券', '0.9', { quarter: '2025Q4' }),
  ]);
  const result = await service.get({ ticker: ' 002920.sz ', asOf: '2026-10-14' });
  assert.deepEqual(calls[0].params, ['002920.SZ', '2026-07-17', '2026-10-14']);
  assert.match(calls[0].sql, /ts_code = \$1 AND source_api = 'report_rc'/);
  assert.match(calls[0].sql, /report_date BETWEEN \$2::date AND \$3::date/);
  assert.match(calls[0].sql, /LEFT JOIN forecasts/);
  assert.deepEqual(result.rows.map(item => item.fiscalYear), ['2026E', '2027E']);
  assert.equal(result.rows[0].sampleSize, 2);
  assert.ok(Math.abs(result.rows[0].consensus.value - 1.8) < 1e-12);
  assert.equal(result.rows[0].consensus.method, 'mean');
  assert.ok(Math.abs(result.rows[0].median - 1.8) < 1e-12);
  assert.equal(result.meta.brokerCount, 3);
  assert.equal(result.meta.rawRowCount, 6);
  assert.equal(result.meta.reportCount, 3);
  assert.equal(result.meta.coverageScope, 'stock');
  assert.equal(result.meta.availableFrom, '2025-10-14');
  assert.equal(result.meta.databaseThrough, '2026-10-13');
  assert.equal(result.meta.fetchedAt, '2026-10-14T01:00:00.000Z');
  assert.equal(result.currency, null);
  assert.match(result.basis, /待原文核验/);
  assert.equal(result.rows[0].samples[0].netProfit, 123.5);
  assert.equal(result.rows[0].samples[0].sourceUrl, null);
});

test('latest EPS replaces old EPS and latest missing EPS never falls back to an older forecast', async () => {
  const { service } = fixture([
    row('old-a', '甲证券', '1.1', { report_date: '2026-08-01' }),
    row('new-a', '甲证券', '1.6', { report_date: '2026-10-01' }),
    row('old-b', '乙证券', '2.4', { report_date: '2026-09-01' }),
    row('new-b', '乙证券', null, { report_date: '2026-10-02' }),
  ]);
  const result = await service.get({ ticker: '002920.SZ' });
  assert.equal(result.rows[0].sampleSize, 1);
  assert.equal(result.rows[0].consensus.value, 1.6);
  assert.deepEqual(result.rows[0].samples.map(item => item.id), ['new-a']);
  assert.equal(result.meta.excludedCount, 1);
});

test('conflicting newest-date EPS is excluded without selecting a favourable duplicate', async () => {
  const { service } = fixture([
    row('a1', '甲证券', '1.1'), row('a2', '甲证券', '1.2'),
    row('b1', '乙证券', '2.4'), row('b2', '乙证券', null),
    row('c1', '丙证券', '1.5'),
  ]);
  const result = await service.get({ ticker: '002920.SZ' });
  assert.equal(result.rows[0].sampleSize, 1);
  assert.equal(result.rows[0].low.broker, '丙证券');
  assert.equal(result.meta.excludedCount, 2);
});

test('identical newest-date EPS duplicates use a deterministic representative', async () => {
  const records = [row('b', '甲证券', '1.5'), row('a', '甲证券', '1.5')];
  const result = await fixture(records).service.get({ ticker: '002920.SZ' });
  const reversed = await fixture([...records].reverse()).service.get({ ticker: '002920.SZ' });
  assert.equal(result.rows[0].sampleSize, 1);
  assert.equal(result.rows[0].samples[0].id, 'a');
  assert.deepEqual(result.rows, reversed.rows);
  assert.equal(result.meta.excludedCount, 0);
});

test('reviewed broker aliases deduplicate before latest-report selection and retain source names', async () => {
  const { service } = fixture([
    row('csc-old', '中信建投', '1.1', { report_date: '2026-09-01' }),
    row('csc-new', '中信建投证券', '1.3', { report_date: '2026-10-01' }),
    row('cicc-old', '中金公司', '2', { report_date: '2026-09-01' }),
    row('cicc-new', '中金', '2.2', { report_date: '2026-10-02' }),
    row('sws-old', '申万宏源证券', '3', { report_date: '2026-09-01' }),
    row('sws-new', '申万宏源研究', '3.3', { report_date: '2026-10-03' }),
    row('gt-old', '国泰海通证券', '4', { report_date: '2026-09-01' }),
    row('gt-new', '国泰海通', '4.4', { report_date: '2026-10-04' }),
  ]);
  const result = await service.get({ ticker: '002920.SZ' });
  assert.equal(result.meta.brokerCount, 4);
  assert.equal(result.rows[0].sampleSize, 4);
  const samples = result.rows[0].samples;
  assert.deepEqual(samples.map(sample => sample.id), ['csc-new', 'cicc-new', 'sws-new', 'gt-new']);
  assert.deepEqual(samples.map(sample => sample.broker), ['中信建投证券', '中金公司', '申万宏源证券', '国泰海通证券']);
  assert.deepEqual(samples.map(sample => sample.brokerOriginal), ['中信建投证券', '中金', '申万宏源研究', '国泰海通']);
  assert.equal(result.rows[0].consensus.value, 2.8);
});

test('latest missing EPS or same-date conflicting EPS across aliases exclude the canonical broker', async () => {
  const result = await fixture([
    row('cicc-old', '中金公司', 1, { report_date: '2026-09-01' }),
    row('cicc-new', '中金', null),
    row('csc-a', '中信建投', 1), row('csc-b', '中信建投证券', 1.1),
    row('valid', '华泰证券', 2),
  ]).service.get({ ticker: '002920.SZ' });
  assert.equal(result.rows[0].sampleSize, 1);
  assert.equal(result.rows[0].samples[0].broker, '华泰证券');
  assert.equal(result.meta.excludedCount, 2);
});

test('exact aliases preserve tied min/max attribution without weighting one institution twice', async () => {
  const result = await fixture([
    row('cicc-a', '中金', 1), row('cicc-b', '中金公司', 1),
    row('csc-a', '中信建投', 1), row('csc-b', '中信建投证券', 1),
  ]).service.get({ ticker: '002920.SZ' });
  assert.equal(result.rows[0].sampleSize, 2);
  assert.deepEqual(new Set(result.rows[0].low.brokers), new Set(['中金公司', '中信建投证券']));
  assert.deepEqual(new Set(result.rows[0].high.brokers), new Set(['中金公司', '中信建投证券']));
});

test('unknown names, historical predecessors and international affiliates are not fuzzily merged', async () => {
  const brokers = ['中银国际', '中银证券', '国投证券', '安信证券', '民生证券', '国联民生证券', '群益证券', '群益证券(香港)', '新机构', '新机构证券'];
  const result = await fixture(brokers.map((broker, index) => row(String(index), broker, index))).service.get({ ticker: '002920.SZ' });
  assert.equal(result.rows[0].sampleSize, brokers.length);
  assert.equal(result.meta.brokerCount, brokers.length);
  assert.deepEqual(new Set(result.rows[0].samples.map(sample => sample.broker)), new Set(brokers));
});

test('min/max ties retain every broker, negative and zero EPS remain valid samples', async () => {
  const { service } = fixture([
    row('1', '甲证券', '-1'), row('2', '乙证券', '-1'),
    row('3', '丙证券', '0'), row('4', '丁证券', '2'), row('5', '戊证券', '2'),
  ]);
  const { rows: [year] } = await service.get({ ticker: '002920.SZ' });
  assert.equal(year.sampleSize, 5);
  assert.equal(year.low.value, -1);
  assert.deepEqual(new Set(year.low.brokers), new Set(['甲证券', '乙证券']));
  assert.equal(year.high.value, 2);
  assert.deepEqual(new Set(year.high.brokers), new Set(['丁证券', '戊证券']));
  assert.equal(year.median, 0);
  assert.equal(year.consensus.value, 0.4);
  assert.ok(year.samples.some(sample => sample.eps === 0));
});

test('unparseable EPS and missing broker identity are excluded rather than counted as zero', async () => {
  const { service } = fixture([
    row('a', '甲证券', ''), row('b', '乙证券', 'NaN'), row('c', '丙证券', 'Infinity'),
    row('d', '丁证券', false), row('e', ' ', 5), row('f', null, 4),
  ]);
  const result = await service.get({ ticker: '002920.SZ' });
  assert.deepEqual(result.rows, []);
  assert.equal(result.meta.brokerCount, 0);
  assert.equal(result.meta.excludedCount, 6);
});

test('future, too-old, invalid publication dates never enter stats; cutoff includes both boundaries', async () => {
  const { service } = fixture([
    row('start', '甲证券', 1, { report_date: '2026-07-17' }),
    row('end', '乙证券', 3, { report_date: '2026-10-14' }),
    row('old', '丙证券', 10, { report_date: '2026-07-16' }),
    row('future', '丁证券', 20, { report_date: '2026-10-15' }),
    row('invalid', '戊证券', 30, { report_date: '2026-02-30' }),
  ]);
  const result = await service.get({ ticker: '002920.SZ' });
  assert.equal(result.meta.rawRowCount, 2);
  assert.equal(result.rows[0].consensus.value, 2);
  assert.equal(result.rows[0].asOf, '2026-10-14');
});

test('empty window preserves stock metadata and never manufactures a sample', async () => {
  const { service } = fixture([{ forecast_id: null, report_date: null, available_from: '2025-10-14', database_through: '2026-07-01' }]);
  const result = await service.get({ ticker: '002920.SZ' });
  assert.deepEqual(result.rows, []);
  assert.equal(result.meta.rawRowCount, 0);
  assert.equal(result.meta.reportCount, 0);
  assert.equal(result.meta.excludedCount, 0);
  assert.equal(result.meta.databaseThrough, '2026-07-01');
  const empty = await fixture().service.get({ ticker: '002920.SZ' });
  assert.equal(empty.meta.availableFrom, null);
  assert.equal(empty.meta.fetchedAt, null);
});

test('window defaults to 90 days and handles Shanghai dates and leap-day subtraction', async () => {
  const { service, calls } = fixture([], { now: () => new Date('2026-10-13T16:01:00Z') });
  await service.get({ ticker: '002920.SZ' });
  assert.deepEqual(calls[0].params, ['002920.SZ', '2026-07-17', '2026-10-14']);
  const result = await service.get({ ticker: '002920.SZ', asOf: '2024-03-01', windowDays: '30' });
  assert.equal(result.windowStart, '2024-02-01');
  assert.equal(result.windowDays, 30);
});

test('invalid tickers, future or calendar-invalid dates and unreasonable windows fail before SQL', async () => {
  const { service, calls } = fixture();
  for (const ticker of [undefined, null, [], '002920', '002920.US', '700.HK', '007000.HK', "002920.SZ' OR 1=1"]) {
    await assert.rejects(service.get({ ticker }), { code: 'INVALID_TICKER', status: 400 });
  }
  for (const asOf of ['2026-10-15', '2026-02-30', '2025-02-29', '2026-2-01', '', 20261014]) {
    await assert.rejects(service.get({ ticker: '002920.SZ', asOf }), { code: 'INVALID_DATE', status: 400 });
  }
  for (const windowDays of [null, true, [], '', 0, 29, 366, 90.5, '90x', '90;DROP TABLE x']) {
    await assert.rejects(service.get({ ticker: '002920.SZ', windowDays }), { code: 'INVALID_WINDOW', status: 400 });
  }
  assert.equal(calls.length, 0);
});

const hkRow = (id, broker, eps, extra = {}) => ({
  forecast_id: id, org_name: broker, eps, report_date: '2026-10-01', fiscal_year: 2026,
  fiscal_period: '2026-12', snapshot_date: '2026-10-14',
  report_title: '港股年度盈利预测', author_name: '分析师', np: null, pe: null, rating: null,
  currency: 'CNY', eps_basis: '摊薄每股收益', source: 'eastmoney', source_api: 'hk_research',
  source_url: `https://data.eastmoney.com/report/${id}.html`,
  available_from: '2025-10-14', database_through: '2026-10-13', fetched_at_max: '2026-10-14T01:00:00.000Z', ...extra,
});

test('HK active company reads only local HK table with true source, currency, EPS basis and report URL', async () => {
  const { service, calls } = fixture([hkRow('hk-a', '甲证券国际', '1.2'), hkRow('hk-b', '乙证券', '2.4')]);
  const result = await service.get({ ticker: ' 00700.hk ' });
  assert.equal(result.ticker, '00700.HK');
  assert.equal(result.market, 'HK');
  assert.equal(result.rows[0].sampleSize, 2);
  assert.ok(Math.abs(result.rows[0].consensus.value - 1.8) < 1e-12);
  assert.equal(result.source, '东方财富 hk_research');
  assert.equal(result.currency, 'CNY');
  assert.equal(result.unit, '人民币元/股');
  assert.equal(result.basis, '摊薄每股收益');
  assert.equal(result.meta.status, 'available');
  assert.equal(result.meta.snapshotDate, '2026-10-14');
  assert.equal(result.meta.dateMeaning, 'broker_update_date');
  assert.equal(result.meta.historicalArchiveAvailable, false);
  assert.equal(result.rows[0].samples[0].sourceUrl, 'https://data.eastmoney.com/report/hk-a.html');
  assert.deepEqual(calls[0].params.slice(0, 3), ['00700.HK', '2026-07-17', '2026-10-14']);
  assert.equal(calls[0].params.length, 3);
  assert.match(calls[0].sql, /FROM market_data.hk_sell_side_forecasts/);
  assert.match(calls[0].sql, /run_date <= \$3::date/);
  assert.match(calls[0].sql, /f\.snapshot_date = s\.run_date/);
  assert.match(calls[0].sql, /f\.universe_hash = s\.universe_hash/);
  assert.doesNotMatch(calls[0].sql, /universe_hash = \$4/);
  assert.doesNotMatch(calls[0].sql, /FROM market_data.sell_side_forecasts|report_rc/);
});

test('HK keeps mainland and international entities and exact source broker names distinct', async () => {
  const brokers = ['中金', '中金公司', '中金国际', '群益证券', '群益证券(香港)'];
  const result = await fixture(brokers.map((broker, index) => hkRow(String(index), broker, index))).service.get({ ticker: '02313.HK' });
  assert.equal(result.meta.brokerCount, 5);
  assert.equal(result.rows[0].sampleSize, 5);
  assert.deepEqual(new Set(result.rows[0].samples.map(sample => sample.brokerOriginal)), new Set(brokers));
});

test('HK newer missing EPS and newest-date numerical or currency/basis conflicts never revive old samples', async () => {
  const result = await fixture([
    hkRow('old-a', '甲证券', 1, { report_date: '2026-09-01' }), hkRow('new-a', '甲证券', null),
    hkRow('old-b', '乙证券', 2, { report_date: '2026-09-01' }), hkRow('new-b', '乙证券', 3), hkRow('new-b2', '乙证券', 4),
    hkRow('c', '丙证券', 5), hkRow('c2', '丙证券', 5, { currency: 'HKD' }),
    hkRow('d', '丁证券', 6), hkRow('d2', '丁证券', 6, { eps_basis: '基本每股收益' }),
    hkRow('valid', '戊证券', -1),
  ]).service.get({ ticker: '00700.HK' });
  assert.equal(result.meta.excludedCount, 4);
  assert.equal(result.rows[0].sampleSize, 1);
  assert.equal(result.rows[0].samples[0].id, 'valid');
  assert.equal(result.rows[0].consensus.value, -1);
});

test('HK aggregates each forecast year, currency and EPS basis independently without conversion', async () => {
  const result = await fixture([
    hkRow('cny-a', '甲证券', 1), hkRow('cny-b', '乙证券', 3),
    hkRow('hkd', '丙证券', 99, { currency: 'HKD' }),
    hkRow('usd', '丁证券', 1000, { currency: 'USD' }),
    hkRow('basic', '戊证券', 20, { eps_basis: '基本每股收益' }),
    hkRow('next', '甲证券', 5, { fiscal_year: 2027, fiscal_period: '2027-12' }),
  ]).service.get({ ticker: '00700.HK' });
  assert.equal(result.rows.length, 5);
  const cnyDiluted = result.rows.find(item => item.fiscalYear === '2026E' && item.currency === 'CNY' && item.basis === '摊薄每股收益');
  assert.equal(cnyDiluted.sampleSize, 2);
  assert.equal(cnyDiluted.consensus.value, 2);
  assert.equal(result.currency, null);
  assert.equal(result.unit, '按各预测行标注');
  assert.match(result.basis, /分别统计/);
  assert.equal(result.rows.find(item => item.currency === 'HKD').unit, '港元/股');
  assert.equal(result.rows.find(item => item.currency === 'USD').unit, '美元/股');
});

test('HK does not average unknown currency observations across institutions', async () => {
  const result = await fixture([
    hkRow('a', '甲证券', 1, { currency: null, eps_basis: null }),
    hkRow('b', '乙证券', 100, { currency: null, eps_basis: null }),
  ]).service.get({ ticker: '00700.HK' });
  assert.equal(result.rows.length, 2);
  assert.ok(result.rows.every(item => item.sampleSize === 1 && item.currency === null && item.unit === '币种未提供/股'));
  assert.deepEqual(result.rows.map(item => item.consensus.value).sort((a, b) => a - b), [1, 100]);
});

test('HK newest currency change supersedes old currency, boundaries and future fiscal year filtering remain strict', async () => {
  const result = await fixture([
    hkRow('old', '甲证券', 100, { report_date: '2026-09-01', currency: 'USD' }),
    hkRow('new', '甲证券', 0, { report_date: '2026-10-14', currency: 'CNY' }),
    hkRow('start', '乙证券', 2, { report_date: '2026-07-17' }),
    hkRow('early', '丙证券', 10, { report_date: '2026-07-16' }),
    hkRow('future', '丁证券', 20, { report_date: '2026-10-15' }),
    hkRow('old-year', '戊证券', 20, { fiscal_year: 2025 }),
    hkRow('bad-year', '己证券', 20, { fiscal_year: '2026Q4' }),
  ]).service.get({ ticker: '00700.HK' });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].sampleSize, 2);
  assert.equal(result.rows[0].consensus.value, 1);
  assert.equal(result.rows[0].currency, 'CNY');
  assert.equal(result.meta.rawRowCount, 5);
});

test('HK empty or nonvalid windows retain real stock bounds and distinguish the absence of samples', async () => {
  const populated = await fixture([{ forecast_id: null, report_date: null, snapshot_date: '2026-10-14', available_from: '2025-10-14', database_through: '2026-07-01' }]).service.get({ ticker: '00700.HK' });
  assert.deepEqual(populated.rows, []);
  assert.equal(populated.meta.status, 'empty_window');
  assert.equal(populated.meta.databaseThrough, '2026-07-01');
  assert.equal(populated.source, null);
  const missing = await fixture().service.get({ ticker: '00700.HK' });
  assert.equal(missing.meta.status, 'not_downloaded');
  const invalid = await fixture([hkRow('null', '甲证券', null)]).service.get({ ticker: '00700.HK' });
  assert.equal(invalid.meta.status, 'no_valid_samples');
});

test('HK successful zero-row query is no_coverage, distinct from uncollected, running and failed collection', async () => {
  const empty = await fixture([{ snapshot_date: '2026-10-14', snapshot_rows_count: 0, fetched_at_max: '2026-10-14T01:00:00Z' }]).service.get({ ticker: '00002.HK' });
  assert.deepEqual(empty.rows, []); assert.equal(empty.meta.status, 'no_coverage'); assert.equal(empty.meta.updateStatus, 'succeeded');
  assert.equal(empty.meta.snapshotRowCount, 0); assert.match(empty.meta.coverageNote, /已查询经济通.*暂无公开/);
  for (const [attemptStatus, expected] of [['running', 'collecting'], ['failed', 'collection_failed']]) {
    const result = await fixture([{ last_attempt_date: '2026-10-14', last_attempt_status: attemptStatus, last_attempt_at: '2026-10-14T02:00:00Z' }]).service.get({ ticker: '00002.HK' });
    assert.equal(result.meta.status, expected); assert.equal(result.meta.snapshotDate, null); assert.equal(result.meta.updateStatus, attemptStatus);
    assert.equal(result.meta.brokerCount, 0); assert.deepEqual(result.rows, []);
  }
  const notYet = await fixture([{ last_attempt_date: '2026-10-15', last_attempt_status: 'failed' }]).service.get({ ticker: '00002.HK' });
  assert.equal(notYet.meta.status, 'not_downloaded'); assert.equal(notYet.meta.lastAttemptDate, null); assert.equal(notYet.meta.updateStatus, null);
});

test('HK selects the stock success snapshot across universe changes and binds every row to that hash/date without fusing old and new sets', async () => {
  const oldHash = 'a'.repeat(64), newerHash = 'b'.repeat(64);
  const rows = [hkRow('old-pool', '旧28覆盖券商', 2, { snapshot_universe_hash: oldHash, forecast_universe_hash: oldHash }),
    hkRow('other-hash', '同日新名册券商', 200, { snapshot_universe_hash: oldHash, forecast_universe_hash: newerHash }),
    hkRow('future-day', '未来快照券商', 300, { snapshot_date: '2026-10-15', snapshot_universe_hash: oldHash, forecast_universe_hash: oldHash })];
  const f = fixture(rows), result = await f.service.get({ ticker: '00700.HK' });
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].consensus.value, 2);
  assert.equal(result.rows[0].sampleSize, 1); assert.equal(result.meta.snapshotUniverseHash, oldHash);
  const selected = f.calls[0].sql.split('availability AS')[0];
  assert.match(selected, /WHERE ts_code = \$1 AND status = 'succeeded' AND run_date <= \$3::date/);
  assert.match(selected, /ORDER BY run_date DESC, fetched_at DESC, universe_hash ASC/);
  assert.doesNotMatch(selected, /universe_hash =/);
  assert.match(f.calls[0].sql, /f\.universe_hash = s\.universe_hash AND f\.snapshot_date = s\.run_date/);
  assert.match(f.calls[0].sql, /hk_forecast_symbol_attempts WHERE ts_code = \$1 AND run_date <= \$3::date/);
  assert.doesNotMatch(f.calls[0].sql, /hk_forecast_update_runs/);
});

test('HK reads do not load obsolete investment-pool configuration and recheck current active catalog each time', async () => {
  const listings = [{ ticker: '00700.HK', active: true }];
  const { service, calls, catalogCalls } = fixture([], { listings, hkUniverse: { invalid: 'obsolete pool must be irrelevant' } });
  assert.equal((await service.get({ ticker: '00700.HK' })).meta.status, 'not_downloaded');
  listings[0].active = false;
  await assert.rejects(service.get({ ticker: '00700.HK' }), { code: 'MARKET_NOT_IN_UNIVERSE', status: 404 });
  assert.equal(catalogCalls.length, 2); assert.equal(calls.length, 1);
});

test('an active HK company outside the former pool reads available EPS and an uncollected stock remains explicitly uncollected', async () => {
  const f = fixture([hkRow('unrelated', '甲证券', 123)], { listings: [{ ticker: '00001.HK', name: '长和' }] });
  const result = await f.service.get({ ticker: '00001.HK' });
  assert.equal(result.rows[0].consensus.value, 123); assert.equal(result.meta.status, 'available');
  assert.equal(result.meta.coverageScope, 'stock'); assert.equal(result.meta.eligibleUniverse, 'hk_listed_universe');
  assert.equal(f.calls.length, 1); assert.equal(f.catalogCalls.length, 1);
  assert.match(f.catalogCalls[0].sql, /active = true/); assert.deepEqual(f.catalogCalls[0].params, ['00001.HK']);
  const uncollected = await fixture().service.get({ ticker: '00002.HK' });
  assert.equal(uncollected.meta.status, 'not_downloaded'); assert.match(uncollected.meta.coverageNote, /尚未完成/);
});

test('all HK forecasts including former pool members require current active membership and sanitize catalog failures', async () => {
  const inactive = fixture([], { listings: [{ ticker: '00001.HK', name: '长和', active: false }] });
  await assert.rejects(inactive.service.get({ ticker: '00001.HK' }), { code: 'MARKET_NOT_IN_UNIVERSE', status: 404 });
  const formerPool = fixture([hkRow('old', '券商', 1)], { listings: [] });
  await assert.rejects(formerPool.service.get({ ticker: '00700.HK' }), { code: 'MARKET_NOT_IN_UNIVERSE', status: 404 });
  assert.equal(formerPool.calls.length, 0);
  const service = createForecastReadService({ pool: { async query() { throw new Error('postgresql://account:secret-password@private/catalog'); } } });
  await assert.rejects(service.get({ ticker: '00001.HK' }), error => error.code === 'FORECAST_DATABASE_UNAVAILABLE'
    && error.status === 503 && !error.message.includes('secret-password'));
});

test('HK fiscal periods ending in different months remain separate even for the same broker and year', async () => {
  const result = await fixture([
    hkRow('june-a', '甲证券', 1, { fiscal_period: '2026-06' }),
    hkRow('dec-a', '甲证券', 3, { fiscal_period: '2026-12' }),
    hkRow('june-b', '乙证券', 5, { fiscal_period: '2026-06' }),
  ]).service.get({ ticker: '00700.HK' });
  assert.deepEqual(result.rows.map(item => item.fiscalPeriod), ['2026-06', '2026-12']);
  assert.deepEqual(result.rows.map(item => item.sampleSize), [2, 1]);
  assert.deepEqual(result.rows.map(item => item.consensus.value), [3, 3]);
  assert.equal(result.rows[0].samples[0].period, '2026-06');
});

test('HK currently observed estimates cannot leak into an earlier research cutoff through old broker dates', async () => {
  const result = await fixture([
    hkRow('known-later', '甲证券', 5, { report_date: '2026-09-01', snapshot_date: '2026-10-14' }),
  ]).service.get({ ticker: '00700.HK', asOf: '2026-10-13' });
  assert.deepEqual(result.rows, []);
  assert.equal(result.meta.snapshotDate, null);
  assert.equal(result.meta.status, 'not_downloaded');
});

test('HK reports a stale successful snapshot after a newer failed update without treating other-ticker failure as its own', async () => {
  const stale = await fixture([
    hkRow('old-known', '甲证券', 1, { snapshot_date: '2026-10-13', last_attempt_date: '2026-10-14', last_attempt_status: 'failed' }),
  ]).service.get({ ticker: '00700.HK' });
  assert.equal(stale.rows[0].consensus.value, 1);
  assert.equal(stale.meta.stale, true);
  assert.equal(stale.meta.updateStatus, 'failed');
  assert.equal(stale.meta.lastAttemptDate, '2026-10-14');
  const current = await fixture([
    hkRow('fresh', '甲证券', 2, { last_attempt_date: '2026-10-14', last_attempt_status: 'partial' }),
  ]).service.get({ ticker: '00700.HK' });
  assert.equal(current.meta.stale, false);
  assert.equal(current.meta.updateStatus, 'succeeded');
});

test('HK same-day later failure preserves successful predictions but reports failure; older failures cannot shadow newer success', async () => {
  const failed = await fixture([hkRow('retained', '券商甲', 2, { fetched_at_max: new Date('2026-10-14T01:00:00.001Z'),
    last_attempt_date: '2026-10-14', last_attempt_status: 'failed', last_attempt_at: new Date('2026-10-14T01:00:00.002Z') })]).service.get({ ticker: '00700.HK' });
  assert.equal(failed.rows[0].consensus.value, 2); assert.equal(failed.meta.updateStatus, 'failed'); assert.equal(failed.meta.stale, true);
  const fresh = await fixture([hkRow('latest', '券商甲', 3, { fetched_at_max: '2026-10-14T02:00:00Z',
    last_attempt_date: '2026-10-14', last_attempt_status: 'failed', last_attempt_at: '2026-10-14T01:00:00Z' })]).service.get({ ticker: '00700.HK' });
  assert.equal(fresh.meta.updateStatus, 'succeeded'); assert.equal(fresh.meta.stale, false);
});

test('database and close errors never expose SQL or connection details', async () => {
  const secret = 'postgresql://account:secret-password@db/private';
  const pool = { async query() { throw new Error(secret); }, async end() { throw new Error(secret); } };
  const service = createForecastReadService({ pool });
  for (const action of [() => service.get({ ticker: '002920.SZ' }), () => service.close()]) {
    await assert.rejects(action(), error => {
      assert.equal(error.code, 'FORECAST_DATABASE_UNAVAILABLE');
      assert.equal(error.status, 503);
      assert.ok(!error.message.includes('secret-password'));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  assert.throws(() => createForecastReadService(), { code: 'FORECAST_DATABASE_UNAVAILABLE', status: 503 });
});

test('close releases the provided pool', async () => {
  const { service, calls } = fixture();
  await service.close();
  assert.deepEqual(calls, [{ end: true }]);
});
