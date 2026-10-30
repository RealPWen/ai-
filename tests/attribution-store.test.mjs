import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { attributionInput, attributionWindow, buildAttributionSnapshot, publicAttributionMetrics } from '../backend/src/attribution-snapshot.mjs';
import { createAttributionStore, validateAttributionReport } from '../backend/src/attribution-store.mjs';

const now = () => new Date('2026-10-20T06:00:00Z');
const ticker = '002920.SZ', asOf = '2026-10-20';
function snapshot(period = '1m', extra = {}) {
  return buildAttributionSnapshot({ ticker, period, asOf, profile: { name: '德赛西威' }, prices: {
    ticker, meta: { requestedAsOf: asOf, period, adjustment: 'qfq', currency: 'CNY' },
    points: [{ date: '2026-09-21', close: 100 }, { date: '2026-10-19', close: 110 }],
    benchmark: { status: 'available', system: 'SW2021', indexCode: '801750.SI', industryName: '汽车零部件', level: 'L3',
      points: [{ date: '2026-09-21', close: 1000 }, { date: '2026-10-19', close: 1040 }] },
  }, ...extra });
}
function report(input = snapshot(), overrides = {}) {
  return { ...input, summary: '订单变化可能影响相对行业表现。', drivers: [{ title: '订单变化', category: 'company', direction: 'positive',
    explanation: '公司订单改善可能形成差异，但因果关系尚未证实。', evidence: [{ sourceId: 's1', quote: '德赛西威披露新增客户订单，仍需关注实际交付情况。', citationVerified: true }] }],
    limitations: ['公开检索覆盖有限。'], corporateActionStatus: 'not_identified', provider: 'deepseek', model: 'deepseek-test', promptVersion: 'attribution-v1',
    generatedAt: '2026-10-20T01:00:00Z', sources: [{ id: 's1', title: '订单情况公告', url: 'https://www.cninfo.com.cn/example', publishedAt: '2026-10-10', citationVerified: true }],
    retrievalEvidence: { origin: 'deepseek-search', sources: [{ id: 's1', title: '订单情况公告', url: 'https://www.cninfo.com.cn/example', publishedAt: '2026-10-10',
      readingScope: 'partial_text', eligibleForDriver: true, contentLength: 100, contentSha256: 'a'.repeat(64) }] }, ...overrides };
}
const invalid = error => error?.code === 'INVALID_ATTRIBUTION_REPORT';

test('归因输入限制A/HK、读取日期和生成周期，生成不允许历史日期', () => {
  assert.deepEqual(attributionInput({ ticker: ' 002920.sz ', periods: ['1y', '1m'] }, { now: now(), generate: true }), { ticker, asOf, periods: ['1m', '1y'] });
  assert.deepEqual(attributionInput({ ticker: '02359.HK', asOf: '2026-10-19' }, { now: now() }).periods, ['1m', '6m', '1y']);
  for (const raw of [{ ticker: 'AAPL' }, { ticker, asOf: '2026-10-19' }, { ticker, periods: ['1m', '1m'] }, { ticker, periods: [] }]) {
    assert.throws(() => attributionInput(raw, { now: now(), generate: true }), { code: 'INVALID_ATTRIBUTION_INPUT' });
  }
  assert.throws(() => attributionInput({ ticker, asOf: '2026-10-21' }, { now: now() }), { code: 'INVALID_ATTRIBUTION_INPUT' });
});

test('日历滚动窗口正确处理月底和闰年，拒绝未知周期', () => {
  assert.equal(attributionWindow('2026-03-31', '1m'), '2026-02-28');
  assert.equal(attributionWindow('2024-02-29', '1y'), '2023-02-28');
  assert.equal(attributionWindow('2026-10-20', '6m'), '2026-04-20');
  assert.throws(() => attributionWindow('2026-10-20', '90d'), { code: 'INVALID_ATTRIBUTION_INPUT' });
});

test('共同交易日涨跌数值与图表一致，并先窗口筛选排序去重', () => {
  const input = snapshot(), normal = snapshot();
  assert.equal(input.stockReturn, 110 / 100 - 1); assert.equal(input.indexReturn, 1040 / 1000 - 1);
  assert.equal(input.excessPercentagePoints, ((110 / 100 - 1) - (1040 / 1000 - 1)) * 100);
  const prices = { ticker, meta: { requestedAsOf: asOf, period: '1m', adjustment: 'qfq', currency: 'CNY' },
    points: [{ date: '2026-10-21', close: 1000 }, { date: '2026-10-19', close: 110 }, { date: '2026-09-21', close: 99 },
      { date: '2026-09-21', close: 100 }, { date: '2026-08-01', close: 1 }, { date: '2026-10-18', close: 0 }],
    benchmark: { status: 'available', ...input.benchmark,
      points: [{ date: '2026-10-21', close: 1000 }, { date: '2026-10-19', close: 1040 }, { date: '2026-09-21', close: 1000 }, { date: '2026-08-01', close: 1 }] } };
  const normalized = snapshot('1m', { prices });
  assert.deepEqual(normalized, normal); assert.match(normalized.inputHash, /^[a-f0-9]{64}$/);
  const visible = publicAttributionMetrics(normalized); assert.equal(visible.from, '2026-09-21');
  assert.equal(Object.hasOwn(visible, 'series'), false); assert.equal(Object.hasOwn(visible, 'inputHash'), false);
});

test('港股仅使用恒生指数及未复权港元，缺比较数据时明确报错', () => {
  const base = snapshot(), prices = { ticker: '02359.HK', meta: { requestedAsOf: asOf, period: '1m', adjustment: 'none', currency: 'HKD' },
    points: base.series.map(point => ({ date: point.date, close: point.stockClose })),
    benchmark: { status: 'available', system: 'HSI', indexCode: 'HSI', industryName: '恒生指数', level: 'market',
      points: base.series.map(point => ({ date: point.date, close: point.indexClose })) } };
  const input = buildAttributionSnapshot({ ticker: '02359.HK', period: '1m', asOf, profile: { name: '药明康德' }, prices });
  assert.equal(input.currency, 'HKD'); assert.equal(input.adjustment, 'none'); assert.equal(input.benchmark.indexCode, 'HSI');
  prices.benchmark.indexCode = 'HSTECH';
  assert.throws(() => buildAttributionSnapshot({ ticker: '02359.HK', period: '1m', asOf, prices }), { code: 'ATTRIBUTION_BENCHMARK_MISSING' });
  prices.benchmark.indexCode = 'HSI'; prices.points = prices.points.slice(0, 1);
  assert.throws(() => buildAttributionSnapshot({ ticker: '02359.HK', period: '1m', asOf, prices }), { code: 'ATTRIBUTION_NO_COMMON_DATA' });
});

test('保存前绑定可信数值、身份、周期与基准，任何篡改均拒绝', () => {
  const input = snapshot(), original = report(input);
  assert.deepEqual(validateAttributionReport(original, input, now()), original);
  const reordered = { ...input, benchmark: Object.fromEntries(Object.entries(input.benchmark).reverse()), coverage: Object.fromEntries(Object.entries(input.coverage).reverse()) };
  assert.deepEqual(validateAttributionReport(original, reordered, now()), original);
  for (const [key, value] of [['ticker', '02359.HK'], ['period', '6m'], ['stockReturn', 999], ['indexReturn', 999], ['excessPercentagePoints', 999],
    ['inputHash', 'b'.repeat(64)], ['from', '2026-09-22'], ['adjustment', 'none'], ['currency', 'HKD'], ['companyName', '其他公司']]) {
    assert.throws(() => validateAttributionReport(report(input, { [key]: value }), input, now()), invalid);
  }
  assert.throws(() => validateAttributionReport(report(input, { benchmark: { ...input.benchmark, indexCode: 'other' } }), input, now()), invalid);
  assert.throws(() => validateAttributionReport(report(input, { coverage: { ...input.coverage, partial: true } }), input, now()), invalid);
});

test('未来来源、未知日期、未验证引用、虚构URL和无正文审计不可写入', () => {
  const input = snapshot();
  for (const mutate of [
    value => { value.sources[0].publishedAt = '2026-10-20'; },
    value => { value.sources[0].publishedAt = null; },
    value => { value.sources[0].citationVerified = false; },
    value => { value.drivers[0].evidence[0].citationVerified = false; },
    value => { value.drivers[0].evidence[0].sourceId = 'unknown'; },
    value => { value.sources[0].url = 'https://example.com/forged'; },
    value => { value.sources[0].title = '伪造标题'; },
    value => { value.retrievalEvidence.sources[0].contentSha256 = ''; },
    value => { value.retrievalEvidence.sources[0].readingScope = 'search_snippet'; },
    value => { value.retrievalEvidence.sources[0].eligibleForDriver = false; },
    value => { value.retrievalEvidence.sources = []; },
    value => { value.sources.push(structuredClone(value.sources[0])); },
    value => { value.sources[0].url = 'https://user:secret@example.com/doc'; },
  ]) { const value = report(input); mutate(value); assert.throws(() => validateAttributionReport(value, input, now()), invalid); }
});

test('没有数据库配置直接报错，无文件存储fallback；数据库错误不泄漏凭据', async () => {
  assert.throws(() => createAttributionStore(), { code: 'ATTRIBUTION_DATABASE_UNAVAILABLE' });
  const pool = { async query() { throw new Error('postgres://private:secret@host/db'); }, async end() { throw new Error('secret'); } };
  const store = createAttributionStore({ pool });
  await assert.rejects(store.listReports(ticker), error => error.code === 'ATTRIBUTION_DATABASE_UNAVAILABLE' && !/secret|postgres|private/.test(error.message));
  await assert.rejects(store.close(), error => error.code === 'ATTRIBUTION_DATABASE_UNAVAILABLE' && !error.message.includes('secret'));
});

test('迁移只创建数据库唯一约束及任务表，非法job在执行SQL前拒绝', async () => {
  const calls = [], store = createAttributionStore({ pool: { async query(sql) { calls.push(sql); return { rows: [] }; } } });
  await store.migrate(); assert.equal(calls.length, 1);
  assert.match(calls[0], /PRIMARY KEY\(ticker,period\)/); assert.match(calls[0], /stock_return_attribution_one_running/);
  assert.doesNotMatch(calls[0], /(?:^|[;\n])\s*(?:DROP|TRUNCATE|DELETE)\b/i);
  const bad = [ { ticker, asOf, periods: ['1m', '1m'], snapshots: { '1m': snapshot() } },
    { ticker, asOf, periods: ['1m'], snapshots: {} }, { ticker, asOf, periods: ['1m'], snapshots: { '1m': { ...snapshot(), ticker: '02359.HK' } } } ];
  for (const value of bad) await assert.rejects(store.createJob(value), invalid);
  assert.equal(calls.length, 1);
});

const dbEnabled = process.env.ATTRIBUTION_DATABASE_TESTS === '1' && Boolean(process.env.DATABASE_URL);
test('隔离PostgreSQL：每股周期唯一、同股job去重、异股busy、事务失败及校验失败保旧、终结周期不可再写', { skip: !dbEnabled }, async () => {
  const schema = `attribution_test_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^attribution_test_[a-f0-9]{32}$/);
  const raw = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
  const rewrite = sql => sql.replaceAll('market_data.', `${schema}.`).replaceAll('CREATE SCHEMA IF NOT EXISTS market_data', `CREATE SCHEMA IF NOT EXISTS ${schema}`);
  let failPeriodUpdate = false;
  const execute = async (client, sql, values) => {
    if (failPeriodUpdate && sql.startsWith('UPDATE market_data.stock_return_attribution_jobs SET periods=')) throw new Error('postgres://private:secret@host/db');
    return client.query(rewrite(sql), values);
  };
  const pool = { async query(sql, values) { return execute(raw, sql, values); }, async connect() {
    const client = await raw.connect(); return { query: (sql, values) => execute(client, sql, values), release: () => client.release() };
  }, async end() {} };
  const store = createAttributionStore({ pool, now }), input = snapshot();
  const params = { ticker, asOf, periods: ['1m'], snapshots: { '1m': input } };
  try {
    await store.migrate(); await store.migrate(); assert.deepEqual(await store.listReports(ticker), {});
    const pair = await Promise.all([store.createJob(params), store.createJob(params)]);
    assert.equal(pair.filter(item => item.created).length, 1); assert.equal(pair[0].job.jobId, pair[1].job.jobId);
    const first = pair[0].job;
    const hkInput = { ...snapshot(), ticker: '02359.HK', companyName: '药明康德', adjustment: 'none', currency: 'HKD' };
    await assert.rejects(store.createJob({ ticker: '02359.HK', asOf, periods: ['1m'], snapshots: { '1m': hkInput } }), { code: 'ATTRIBUTION_BUSY' });
    await store.updateProgress({ jobId: first.jobId, period: '1m', stage: 'searching' });
    await store.completePeriod({ jobId: first.jobId, period: '1m', report: report(input) });
    await assert.rejects(store.completePeriod({ jobId: first.jobId, period: '1m', report: report(input, { summary: '不得在已完成周期再次覆盖' }) }), { code: 'ATTRIBUTION_JOB_CONFLICT' });
    assert.equal((await store.finishJob(first.jobId)).status, 'succeeded');
    assert.equal((await store.getJob(first.jobId)).periods['1m'].status, 'succeeded');
    const second = (await store.createJob(params)).job;
    await assert.rejects(store.completePeriod({ jobId: second.jobId, period: '1m', report: report(input, { stockReturn: 999 }) }), invalid);
    assert.equal((await store.listReports(ticker))['1m'].summary, report().summary);
    failPeriodUpdate = true;
    await assert.rejects(store.completePeriod({ jobId: second.jobId, period: '1m', report: report(input, { summary: '此写入必须回滚' }) }), error => error.code === 'ATTRIBUTION_DATABASE_UNAVAILABLE' && !/secret|private|postgres/.test(error.message));
    failPeriodUpdate = false;
    assert.equal((await store.listReports(ticker))['1m'].summary, report().summary);
    assert.equal((await store.getJob(second.jobId)).periods['1m'].status, 'queued');
    await store.completePeriod({ jobId: second.jobId, period: '1m', report: report(input, { summary: '更新成功后单条替换' }) });
    await store.finishJob(second.jobId);
    const all = { '1m': input, '6m': snapshot('6m'), '1y': snapshot('1y') };
    const third = (await store.createJob({ ticker, asOf, periods: ['1m', '6m', '1y'], snapshots: all })).job;
    for (const period of ['1m', '6m', '1y']) await store.completePeriod({ jobId: third.jobId, period, report: report(all[period], { summary: `${period}最新报告` }) });
    await store.finishJob(third.jobId);
    const counts = await raw.query(`SELECT ticker,period,count(*)::int AS n FROM ${schema}.stock_return_attributions GROUP BY ticker,period ORDER BY period`);
    assert.equal(counts.rows.length, 3); assert.equal(counts.rows.every(row => row.n === 1), true);
    assert.deepEqual(Object.keys(await store.listReports(ticker)).sort(), ['1m', '1y', '6m']);
    assert.equal((await store.getLatestJob(ticker)).jobId, third.jobId);
    const failed = (await store.createJob(params)).job;
    await store.failPeriod({ jobId: failed.jobId, period: '1m', error: { code: 'TEST_FAILURE', message: '模拟推理失败' } });
    assert.equal((await store.finishJob(failed.jobId)).status, 'failed');
    assert.equal((await store.listReports(ticker))['1m'].summary, '1m最新报告');
    await store.close();
  } finally {
    try { await raw.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await raw.end(); }
  }
});
