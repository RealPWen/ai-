import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { buildAttributionSnapshot } from '../backend/src/attribution-snapshot.mjs';
import { attributionSearchContext, attributionSearchPlan, auditAttributionAI, attributionRetrievalEvidence } from '../backend/src/attribution-ai-evidence.mjs';
import { createAttributionStore, validateAttributionReport } from '../backend/src/attribution-store.mjs';

const now = () => new Date('2026-10-20T06:00:00.000Z');
const ticker = '00700.HK', asOf = '2026-10-20';
const invalid = error => error?.code === 'INVALID_ATTRIBUTION_REPORT';
const sector = { name: '互联网服务', source: 'eastmoney', known: true,
  sourceUrl: 'https://datacenter.eastmoney.com/api/data/v1/get?reportName=RPT_HK_ORGPROFILE&filter=TENCENT' };
function snapshot(period = '6m') {
  return buildAttributionSnapshot({ ticker, period, asOf, profile: { ticker, name: '腾讯控股' }, sector,
    prices: { ticker, meta: { requestedAsOf: asOf, period, adjustment: 'none', currency: 'HKD' },
      points: [{ date: '2026-09-21', close: 100 }, { date: '2026-10-19', close: 110 }],
      benchmark: { status: 'available', system: 'HSI', indexCode: 'HSI', industryName: '恒生指数', level: 'market',
        points: [{ date: '2026-09-21', close: 1000 }, { date: '2026-10-19', close: 1040 }] } } });
}
function news(input, { snippet = true, boundary = true } = {}) {
  return [
    { kind: 'stock', results: [{ title: '腾讯控股经营与业绩新闻', url: 'https://example.com/tencent-results',
      date: boundary ? input.coverage.requestedFrom : '2026-10-10',
      ...(snippet ? { summary: '腾讯控股披露新产品推动营收增长20%，同时提醒后续需求和交付仍有不确定性。' }
        : { content: '腾讯控股披露新产品推动营收增长20%，同时提醒后续需求和交付仍有不确定性。' }) }] },
    { kind: 'sector', results: [{ title: '互联网服务板块需求观察', url: 'https://example.com/internet-demand',
      date: '2026-10-10', content: '互联网服务行业需求改善，竞争和盈利能力仍有不确定性，行业内公司表现出现分化。' }] },
  ];
}
function proposal(context) {
  return { summary: '新产品带动腾讯经营改善，互联网板块需求变化提供背景，可能共同影响相对恒指表现。',
    drivers: [{ title: '新产品与收入增长', category: 'company', direction: 'positive',
      explanation: '报道显示新产品带动营收增长20%，可能改善市场的盈利预期，但不能量化对应的股价贡献。',
      sourceIds: [context.sources.find(source => source.newsKinds.includes('stock')).id] },
    { title: '行业需求改善', category: 'industry', direction: 'positive',
      explanation: '板块需求改善可能支持行业情绪，仍不足以单独证明腾讯相对恒指的全部超额表现。',
      sourceIds: [context.sources.find(source => source.newsKinds.includes('sector')).id] }],
    limitations: ['公开新闻覆盖有限，未估算单项因素的涨跌贡献。'], corporateActionStatus: 'uncertain' };
}
function generated(input = snapshot(), options) {
  const context = attributionSearchContext(news(input, options), input, now().toISOString());
  const audited = auditAttributionAI(proposal(context), { snapshot: input, sources: context.sources });
  const { series, ...metrics } = input;
  // Keep the production service merge order: trusted snapshot metadata wins.
  return { ...audited, ...metrics, generatedAt: now().toISOString(), provider: 'deepseek', model: 'deepseek-test',
    promptVersion: 'return-attribution-news-integration-test',
    retrievalEvidence: attributionRetrievalEvidence(context, attributionSearchPlan(input).map(row => row.query)) };
}
const reordered = value => Array.isArray(value) ? value.map(reordered)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reordered(item)])) : value;

test('真实新闻检索与AI审计产物：所选窗口早于共同行情，摘要和无quote仍可保存', () => {
  const input = snapshot(), report = generated(input);
  assert.equal(input.coverage.requestedFrom, '2026-04-20');
  assert.equal(input.from, '2026-09-21'); assert.equal(input.coverage.partial, true);
  assert.equal(report.newsWindow.from, input.coverage.requestedFrom);
  assert.equal(report.sources[0].publishedAt, '2026-04-20');
  assert.equal(report.sources[0].readingScope, 'search_snippet');
  assert.deepEqual(report.newsCoverage, { stock: 1, sector: 1 });
  assert.equal(report.drivers.length, 2);
  assert.ok(report.drivers.every(driver => driver.evidence.every(item => item.citationVerified === true && !Object.hasOwn(item, 'quote'))));
  assert.match(report.drivers[0].explanation, /增长20%/);
  assert.deepEqual(validateAttributionReport(report, input, now()), report);
});

test('有日期新闻允许summary paraphrase，正文摘要的阅读范围与检索凭据一致', () => {
  const input = snapshot('1m'), report = generated(input, { snippet: false, boundary: false });
  assert.equal(report.evidenceMode, 'news_summary');
  assert.equal(report.sources[0].readingScope, 'partial_text');
  assert.notEqual(report.drivers[0].explanation, news(input, { snippet: false, boundary: false })[0].results[0].content);
  assert.deepEqual(validateAttributionReport(report, input, now()), report);
  const snippet = generated(input, { snippet: true, boundary: false });
  const source = snippet.sources[0], retrieval = snippet.retrievalEvidence.sources.find(item => item.id === source.id);
  assert.equal(source.readingScope, 'search_snippet'); assert.equal(source.readingScope, retrieval.readingScope);
  assert.deepEqual(source.newsKinds, retrieval.newsKinds);
  assert.match(retrieval.contentSha256, /^[a-f0-9]{64}$/);
  assert.ok(retrieval.contentLength >= 8);
  assert.deepEqual(validateAttributionReport(snippet, input, now()), snippet);
});

test('JSONB对象键重排不影响新闻metadata、sector来源URL及数值校验', () => {
  const input = snapshot(), report = generated(input), jsonbSnapshot = reordered(input);
  assert.deepEqual(report.sector, sector); assert.equal(report.sector.sourceUrl, sector.sourceUrl);
  assert.deepEqual(validateAttributionReport(report, jsonbSnapshot, now()), report);
  assert.deepEqual(validateAttributionReport(reordered(report), input, now()), report);
  const forged = structuredClone(report); forged.sector.sourceUrl = 'https://example.com/forged-profile';
  assert.throws(() => validateAttributionReport(forged, input, now()), invalid);
});

test('新闻模式仍拒绝外窗日期、伪造URL、分类与阅读范围不一致、未验证引用', () => {
  const input = snapshot();
  for (const mutate of [
    value => { value.newsWindow.from = '2026-04-19'; },
    value => { value.sources[0].publishedAt = '2026-04-19'; value.retrievalEvidence.sources[0].publishedAt = '2026-04-19'; },
    value => { value.sources[0].publishedAt = '2026-10-20'; value.retrievalEvidence.sources[0].publishedAt = '2026-10-20'; },
    value => { value.sources[0].url = 'https://example.com/forged-news'; },
    value => { value.sources[0].newsKinds = ['sector']; },
    value => { value.sources[0].newsKinds = ['stock', 'stock']; value.retrievalEvidence.sources[0].newsKinds = ['stock', 'stock']; },
    value => { value.sources[0].readingScope = 'partial_text'; },
    value => { value.drivers[0].evidence[0].citationVerified = false; },
    value => { value.drivers[0].evidence[0].sourceId = 'invented'; },
    value => { value.newsCoverage = { stock: 999, sector: 999 }; },
  ]) {
    const report = generated(input); mutate(report);
    assert.throws(() => validateAttributionReport(report, input, now()), invalid);
  }
});

test('旧模式保存仍要求逐字quote及正文，新闻模式不会悄悄放宽旧报告', () => {
  const input = snapshot('1m'), report = generated(input, { snippet: false, boundary: false });
  delete report.evidenceMode; delete report.newsWindow; delete report.newsCoverage;
  for (const driver of report.drivers) for (const evidence of driver.evidence) evidence.quote = '腾讯控股披露新产品推动营收增长20%。';
  assert.deepEqual(validateAttributionReport(report, input, now()), report);
  delete report.drivers[0].evidence[0].quote;
  assert.throws(() => validateAttributionReport(report, input, now()), invalid);
  const snippet = generated(input, { snippet: true, boundary: false }); delete snippet.evidenceMode;
  for (const driver of snippet.drivers) for (const evidence of driver.evidence) evidence.quote = '存在引用也不能把摘要当成旧模式全文证据。';
  assert.throws(() => validateAttributionReport(snippet, input, now()), invalid);
});

const dbEnabled = process.env.ATTRIBUTION_DATABASE_TESTS === '1' && Boolean(process.env.DATABASE_URL);
test('隔离PostgreSQL：真实新闻总结completePeriod成功写入、重读metadata、覆盖后每股周期仅一条', { skip: !dbEnabled }, async () => {
  const schema = `attribution_news_test_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^attribution_news_test_[a-f0-9]{32}$/);
  const raw = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  const rewrite = sql => sql.replaceAll('market_data.', `${schema}.`).replaceAll('CREATE SCHEMA IF NOT EXISTS market_data', `CREATE SCHEMA IF NOT EXISTS ${schema}`);
  const pool = { query: (sql, values) => raw.query(rewrite(sql), values), async connect() {
    const client = await raw.connect(); return { query: (sql, values) => client.query(rewrite(sql), values), release: () => client.release() };
  }, async end() {} };
  const store = createAttributionStore({ pool, now }), input = snapshot();
  const params = { ticker, asOf, periods: ['6m'], snapshots: { '6m': input } };
  try {
    await store.migrate();
    const first = await store.createJob(params), firstReport = generated(input);
    await store.completePeriod({ jobId: first.job.jobId, period: '6m', report: firstReport });
    assert.equal((await store.finishJob(first.job.jobId)).status, 'succeeded');
    const stored = (await store.listReports(ticker))['6m'];
    assert.deepEqual(stored, firstReport); assert.equal(stored.sources[0].readingScope, 'search_snippet');
    assert.equal(stored.sector.sourceUrl, sector.sourceUrl); assert.deepEqual(stored.newsCoverage, { stock: 1, sector: 1 });
    const second = await store.createJob(params), replacement = generated(input);
    replacement.summary = '更新后的新闻归纳：仍按所选半年窗口解释相对恒指表现。';
    await store.completePeriod({ jobId: second.job.jobId, period: '6m', report: replacement });
    await store.finishJob(second.job.jobId);
    assert.deepEqual((await store.listReports(ticker))['6m'], replacement);
    const count = await raw.query(`SELECT count(*)::int AS n FROM ${schema}.stock_return_attributions WHERE ticker=$1 AND period='6m'`, [ticker]);
    assert.equal(count.rows[0].n, 1);
    const failed = await store.createJob(params), invalidReport = generated(input);
    invalidReport.sources[0].url = 'https://example.com/forged';
    await assert.rejects(store.completePeriod({ jobId: failed.job.jobId, period: '6m', report: invalidReport }), invalid);
    assert.deepEqual((await store.listReports(ticker))['6m'], replacement);
    await store.failPeriod({ jobId: failed.job.jobId, period: '6m', error: { code: 'TEST_INVALID_SOURCE', message: '模拟来源校验失败' } });
    await store.finishJob(failed.job.jobId);
  } finally {
    try { await raw.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await raw.end(); }
  }
});
