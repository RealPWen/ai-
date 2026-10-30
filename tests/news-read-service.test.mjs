import test from 'node:test';
import assert from 'node:assert/strict';
import { createNewsReadService, newsWindowCoverage } from '../backend/market-data/news-read-service.mjs';

const id = 'a'.repeat(64), now = () => new Date('2026-10-15T00:30:00Z');
const relation = (extra = {}) => ({ relatedTicker: '300750.SZ', relatedName: '宁德时代', relationType: 'upstream', verifiedAt: '2026-10-14T01:00:00.000Z', sources: [{ publishedAt: '2026-09-01' }], ...extra });
const article = (extra = {}) => ({ article_id: id, title: '公司公开资讯', content: '新闻原文', published_at: '2026-10-14T10:00:00.000Z', source_api: 'major_news', source_name: '公开渠道', url: null, category: '公司', related_companies: [{ ticker: '601127.SH', name: '赛力斯', relationType: 'company', matchType: 'name', matchedTerms: ['赛力斯'] }], ...extra });
function fixture({ research = [], sources = [], windows = [], rows = [], total = rows.length, fail = false } = {}) {
  const calls = [], pool = { async query(sql, values) {
    calls.push({ sql, values }); if (fail) throw new Error('postgres://user:secret@host');
    if (sql.startsWith('WITH jobs')) return { rows: research };
    if (sql.includes('FROM market_data.news_source_status')) return { rows: sources };
    if (sql.startsWith('SELECT source_api, source_name, window_start')) return { rows: windows };
    if (sql.includes('SELECT count(*) AS total')) return { rows: [{ total: String(total) }] };
    return { rows };
  }, async end() {} };
  return { calls, service: createNewsReadService({ pool, now }) };
}
test('news is readonly, natural-three-month and Shanghai-day bounded with parameterized pagination and category echo', async () => {
  const { calls, service } = fixture({ research: [{ subject_name: '赛力斯' }], rows: [article()], total: 22 });
  const result = await service.get({ ticker: ' 601127.sh ', asOf: '2026-10-15', limit: '20', offset: '0', category: '全部' });
  assert.equal(result.from, '2026-07-15'); assert.equal(result.category, '全部'); assert.equal(result.items[0].content, '新闻原文'); assert.equal(result.hasMore, true);
  const news = calls.find(call => call.sql.includes('LIMIT $5 OFFSET $6'));
  assert.deepEqual(news.values.slice(1), ['2026-07-14T16:00:00.000Z', '2026-10-15T00:30:00.000Z', '全部', 20, 0]);
  assert.match(news.sql, /GROUP BY a.article_id/); assert.match(news.sql, /a.published_at >= \$2::timestamptz AND a.published_at < \$3::timestamptz/);
  assert.ok(calls.every(call => !/\b(?:INSERT|UPDATE|DELETE)\b/.test(call.sql)));
});
test('three-month subtraction clamps month ends and accepts late-Shanghai-day data before its UTC end', async () => {
  const { calls, service } = fixture({ rows: [article({ published_at: '2026-05-31T15:59:59Z' })] });
  const result = await service.get({ ticker: '601127.SH', asOf: '2026-05-31' }); assert.equal(result.from, '2026-02-28'); assert.equal(result.items.length, 1);
  assert.equal(calls.find(call => call.sql.includes('LIMIT $5')).values[2], '2026-05-31T16:00:00.000Z');
});
test('source permission and not-yet-synced states survive empty company news without inventing events', async () => {
  const { service } = fixture({ sources: [{ source_api: 'news', status: 'permission_denied', error_code: 'permission_denied', updated_at: new Date('2026-10-15T00:00:00Z') }] });
  const result = await service.get({ ticker: '601127.SH' }); assert.equal(result.total, 0); assert.deepEqual(result.items, []);
  assert.equal(result.meta.sources.length, 4); assert.equal(result.meta.sources.find(row => row.sourceApi === 'news').status, 'permission_denied'); assert.equal(result.meta.sources.find(row => row.sourceApi === 'major_news').status, 'not_synced');
});
test('verified partial relationship snapshots retain current draft associations and reject future verification or source dates', async () => {
  const { calls, service } = fixture({ research: [{ subject_name: '赛力斯', relation_as_of: '2026-10-15', draft_relations: [relation(), relation({ relatedTicker: '002920.SZ', verifiedAt: '2026-10-16T01:00:00Z' }), relation({ relatedTicker: '600519.SH', sources: [{ publishedAt: '2026-10-16' }] })], published_relations: [relation({ relatedTicker: '600399.SH' })] }], rows: [article({ category: '上游', related_companies: [{ ticker: '300750.SZ', matchType: 'name', matchedTerms: ['宁德时代'] }] })] });
  const result = await service.get({ ticker: '601127.SH', category: '上游' });
  assert.equal(result.meta.relatedCompanyCount, 1); assert.equal(result.items[0].relatedCompanies[0].ticker, '300750.SZ');
  const companies = JSON.parse(calls.find(call => call.sql.includes('LIMIT $5')).values[0]); assert.deepEqual(companies.map(item => item.ticker), ['601127.SH', '300750.SZ']);
  assert.equal(result.meta.relationAsOf, '2026-10-15');
});
test('article cutoffs, category and unrelated-company checks remain safe even if injected pool returns invalid rows', async () => {
  const { service } = fixture({ rows: [article(), article({ article_id: 'b', published_at: '2026-10-15T16:00:00Z' }), article({ article_id: 'c', published_at: '2026-07-14T15:59:59Z' }), article({ article_id: 'd', related_companies: [{ ticker: '600519.SH' }] }), article({ article_id: 'e', category: '政策' })] });
  const result = await service.get({ ticker: '601127.SH' }); assert.deepEqual(result.items.map(row => row.id), [id]);
});
test('missing URLs remain null and unsafe provider URLs never become frontend links', async () => {
  const { service } = fixture({ rows: [article({ url: 'javascript:alert(1)' })] }); assert.equal((await service.get({ ticker: '601127.SH' })).items[0].url, null);
});
test('input rejects non-A shares, future or impossible dates, unsupported keys and malformed pagination before any query', async () => {
  for (const input of [{ ticker: '00700.HK' }, { ticker: 'unsafe' }, { ticker: '601127.SH', asOf: '2026-10-16' }, { ticker: '601127.SH', asOf: '2026-02-30' }, { ticker: '601127.SH', limit: 51 }, { ticker: '601127.SH', offset: -1 }, { ticker: '601127.SH', category: '投资建议' }, { ticker: '601127.SH', malicious: true }]) {
    const { calls, service } = fixture(); await assert.rejects(service.get(input), error => error.status === 400); assert.equal(calls.length, 0);
  }
});
test('database errors have stable unavailable status and never disclose driver credentials', async () => {
  await assert.rejects(fixture({ fail: true }).service.get({ ticker: '601127.SH' }), error => error.code === 'NEWS_DATABASE_UNAVAILABLE' && error.status === 503 && !/secret|postgres:\/\//.test(error.message));
});

const coverageRow = (start, end, extra = {}) => ({ source_api: 'major_news', source_name: '', status: 'completed', window_start: start, window_end: end, ...extra });
test('completed coverage unions adjacent and overlapping windows, clips request bounds and ignores failed windows', () => {
  const from = '2026-10-01T00:00:00Z', through = '2026-10-03T00:00:00Z';
  const coverage = newsWindowCoverage([
    coverageRow('2026-09-30T00:00:00Z', '2026-10-02T12:00:00Z'),
    coverageRow('2026-10-02T00:00:00Z', '2026-10-04T00:00:00Z'),
    coverageRow('2026-10-01T00:00:00Z', '2026-10-03T00:00:00Z', { status: 'failed' }),
  ], from, through);
  assert.equal(coverage.coveredSeconds, 172800); assert.equal(coverage.totalSeconds, 172800);
  assert.equal(coverage.complete, true); assert.equal(coverage.status, 'complete'); assert.equal(coverage.mergedWindowCount, 1);
  assert.equal(coverage.coveredThrough, '2026-10-03T00:00:00.000Z');
});
test('min and max windows do not conceal gaps; coveredThrough stops at the first gap', () => {
  const coverage = newsWindowCoverage([
    coverageRow('2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z'),
    coverageRow('2026-10-03T00:00:00Z', '2026-10-04T00:00:00Z'),
  ], '2026-10-01T00:00:00Z', '2026-10-04T00:00:00Z');
  assert.equal(coverage.complete, false); assert.equal(coverage.status, 'partial'); assert.equal(coverage.coveredSeconds, 172800);
  assert.equal(coverage.coveredThrough, '2026-10-02T00:00:00.000Z'); assert.equal(coverage.latestCoveredAt, '2026-10-04T00:00:00.000Z'); assert.equal(coverage.mergedWindowCount, 2);
  const later = newsWindowCoverage([coverageRow('2026-10-03T00:00:00Z', '2026-10-04T00:00:00Z')], '2026-10-01T00:00:00Z', '2026-10-04T00:00:00Z');
  assert.equal(later.coveredThrough, null); assert.equal(later.coveredFrom, '2026-10-03T00:00:00.000Z');
});
test('read returns partial coverage while retaining existing articles and today cutoff stops at current second', async () => {
  const { calls, service } = fixture({ rows: [article()], windows: [coverageRow('2026-07-14T16:00:00Z', '2026-07-16T04:00:00Z')] });
  const result = await service.get({ ticker: '601127.SH', asOf: '2026-10-15' });
  assert.equal(result.items.length, 1); assert.equal(result.meta.coverage.status, 'partial'); assert.equal(result.meta.coverage.complete, false);
  assert.equal(result.meta.coverage.coveredSeconds, 129600); assert.equal(result.meta.coverage.coveredThrough, '2026-07-16T04:00:00.000Z');
  assert.equal(result.meta.coverage.requestedThrough, '2026-10-15T00:30:00.000Z');
  assert.equal(result.meta.sources.find(row => row.sourceApi === 'news').coverage.coveredSeconds, 0);
  assert.equal(result.meta.sources.find(row => row.sourceApi === 'major_news').coverage.coveredSeconds, 129600);
  assert.match(calls.find(call => call.sql.startsWith('SELECT source_api, source_name, window_start')).sql, /WHERE status = 'completed'/);
});
test('empty completed coverage is not synced and article presence alone never counts as complete', async () => {
  const result = await fixture({ rows: [article()] }).service.get({ ticker: '601127.SH' });
  assert.equal(result.items.length, 1); assert.equal(result.meta.coverage.status, 'not_synced'); assert.equal(result.meta.coverage.coveredSeconds, 0); assert.equal(result.meta.coverage.complete, false);
});

test('website source is read alongside Tushare without turning article dates into complete coverage', async () => {
  const { calls, service } = fixture({
    sources: [{ source_api: 'cls_web', status: 'available', article_count: '7', first_published_at: '2026-08-01T00:00:00Z', latest_published_at: '2026-10-14T00:00:00Z' }],
    rows: [article({ source_api: 'cls_web', source_name: 'wrong label', related_companies: [{ ticker: '601127.SH', matchType: 'source_tag', matchedTerms: ['SH601127'] }] })],
  });
  const result = await service.get({ ticker: '601127.SH' });
  assert.equal(result.items[0].sourceApi, 'cls_web'); assert.equal(result.items[0].sourceName, '财联社官网');
  assert.equal(result.items[0].relatedCompanies[0].matchType, 'source_tag');
  const source = result.meta.sources.find(row => row.sourceApi === 'cls_web');
  assert.equal(source.articleCount, 7); assert.equal(source.firstPublishedAt, '2026-08-01T00:00:00.000Z');
  assert.equal(source.coverage.complete, false); assert.equal(source.coverage.coveredSeconds, 0);
  assert.equal(result.meta.source, '财联社官网'); assert.equal(result.meta.coverage.complete, false);
  const query = calls.find(call => call.sql.includes('FROM market_data.news_source_status'));
  assert.match(query.sql, /UNION SELECT source_api FROM market_data.news_articles/);
  assert.match(query.sql, /published_at >= \$1 AND published_at < \$2/);
});

test('stored brief kind survives the read API and legacy content kinds are inferred for older rows', async () => {
  for (const [content, kind, expected] of [['公开摘要', 'summary', 'summary'], ['原始正文', 'fulltext', 'fulltext'], ['', 'none', 'none'], ['旧版接口正文', undefined, 'fulltext'], ['', undefined, 'none']]) {
    const { service } = fixture({ rows: [article({ content, content_kind: kind })] });
    const result = await service.get({ ticker: '601127.SH' });
    assert.equal(result.items[0].content, content); assert.equal(result.items[0].contentKind, expected);
  }
});

const manual = (extra = {}) => ({ relatedTicker: '300750.SZ', relatedName: '宁德时代', action: 'upsert', relationType: 'peer',
  rationale: '', revision: '1', effectiveDate: '2026-10-15', manualUpdatedAt: '2026-10-15T00:00:00Z', ...extra });

test('news categories use the same effective manual overlays and removal tombstones as the relation panel', async () => {
  const { service, calls } = fixture({ research: [{ subject_name: '赛力斯', relation_as_of: '2026-10-15',
    draft_relations: [relation(), relation({ relatedTicker: '002920.SZ', relatedName: '德赛西威' })],
    manual_revision: '4', manual_events: [manual(), manual({ action: 'remove', relatedTicker: '002920.SZ', relatedName: '德赛西威', relationType: null }),
      manual({ relatedTicker: '600519.SH', relatedName: '未来证券', effectiveDate: '2026-10-16' })] }],
    rows: [article({ category: '同行', related_companies: [{ ticker: '300750.SZ', matchType: 'name' }] })] });
  const result = await service.get({ ticker: '601127.SH', category: '同行' });
  const companies = JSON.parse(calls.find(call => call.sql.includes('LIMIT $5')).values[0]);
  assert.deepEqual(companies.map(row => row.ticker), ['601127.SH', '300750.SZ']);
  assert.equal(companies[1].category, '同行'); assert.equal(companies[1].relation_type, 'peer');
  assert.equal(result.items[0].relatedCompanies[0].relationType, 'peer');
  assert.equal(result.meta.manualRevision, '4'); assert.equal(result.meta.hasManualChanges, true);
  assert.match(calls[0].sql, /j\.is_subject/); assert.match(calls[0].sql, /effective_date <= \$2::date/);
});

test('news restore returns classification to AI and manual-only relations work without an AI snapshot', async () => {
  const restored = fixture({ research: [{ subject_name: '赛力斯', relation_as_of: '2026-10-15', draft_relations: [relation()],
    manual_revision: '2', manual_events: [manual({ action: 'restore', relationType: null })] }] });
  await restored.service.get({ ticker: '601127.SH' });
  const restoredCompanies = JSON.parse(restored.calls.find(call => call.sql.includes('LIMIT $5')).values[0]);
  assert.equal(restoredCompanies[1].category, '上游');
  const custom = fixture({ research: [{ subject_name: '赛力斯', manual_revision: '1', manual_events: [manual()] }] });
  const result = await custom.service.get({ ticker: '601127.SH' });
  assert.equal(result.meta.relatedCompanyCount, 1); assert.equal(result.meta.relationAsOf, null);
  const before = await custom.service.get({ ticker: '601127.SH', asOf: '2026-10-14' });
  assert.equal(before.meta.relatedCompanyCount, 0); assert.equal(before.meta.hasManualChanges, false);
});
