import test from 'node:test';
import assert from 'node:assert/strict';
import { createNewsStore, newsInstant, safeNewsUrl } from '../backend/market-data/news-store.mjs';

const id = 'a'.repeat(64), start = '2026-10-13T16:00:00.000Z', end = '2026-10-14T16:00:00.000Z';
const article = (extra = {}) => ({ id, sourceApi: 'major_news', sourceName: '公开渠道', title: '德赛西威签订合同', content: '保留公开原文。', publishedAt: '2026-10-14T10:00:00+08:00', url: null, ...extra });
const link = (extra = {}) => ({ ticker: '002920.SZ', articleId: id, matchType: 'name', matchedTerms: ['德赛西威'], ...extra });
const args = (extra = {}) => ({ sourceApi: 'major_news', sourceName: '', start, end, articles: [article()], links: [link()], fetchedAt: '2026-10-15T00:00:00.000Z', ...extra });
function fixture({ rows = [], failOn } = {}) {
  const calls = [], pool = { released: 0,
    async query(sql, values) { calls.push({ sql, values }); if (failOn?.(sql)) throw Object.assign(new Error('postgres://user:secret@localhost'), { code: '08006' }); return { rows: typeof rows === 'function' ? rows(sql) : rows }; },
    async connect() { return { query: pool.query, release() { pool.released++; } }; }, async end() {},
  };
  return { calls, pool, store: createNewsStore({ pool }) };
}
test('news UTC instants preserve Shanghai boundaries and reject normalized impossible dates', () => {
  assert.equal(newsInstant('2026-10-14T00:00:00+08:00'), start);
  for (const value of ['2026-02-30T00:00:00Z', '2026-10-14 00:00:00', '2026-10-14T24:00:00Z', new Date('invalid')]) assert.throws(() => newsInstant(value), { code: 'VALIDATION_ERROR' });
  assert.equal(safeNewsUrl('javascript:alert(1)'), null); assert.equal(safeNewsUrl('https://user:password@host/'), null); assert.equal(safeNewsUrl('https://example.com/article'), 'https://example.com/article');
});
test('news migration is additive and creates raw articles, associations, empty-window ledger and source statuses', async () => {
  const { calls, store } = fixture(); await store.migrate();
  assert.equal(calls[0].sql, 'BEGIN'); assert.equal(calls.at(-1).sql, 'COMMIT');
  for (const table of ['news_articles', 'stock_news_links', 'news_sync_windows', 'news_source_status']) assert.match(calls[1].sql, new RegExp(`CREATE TABLE IF NOT EXISTS market_data.${table}`));
  assert.doesNotMatch(calls[1].sql, /\b(?:DROP\s+(?:TABLE|SCHEMA)|TRUNCATE|DELETE)\b/);
  for (const table of ['news_articles', 'news_sync_windows', 'news_source_status']) {
    assert.match(calls[1].sql, new RegExp(`ALTER TABLE market_data.${table} DROP CONSTRAINT IF EXISTS ${table}_source_api_check`));
    assert.match(calls[1].sql, new RegExp(String.raw`ADD CONSTRAINT ${table}_source_api_check CHECK \(source_api IN \([^;]*'cls_web'`));
  }
  assert.match(calls[1].sql, /ADD CONSTRAINT stock_news_links_match_type_check CHECK \(match_type IN \([^;]*'source_tag'/);
  assert.match(calls[1].sql, /ADD COLUMN IF NOT EXISTS content_kind text/);
  assert.match(calls[1].sql, /UPDATE market_data.news_articles SET content_kind = CASE WHEN content = '' THEN 'none' ELSE 'fulltext' END WHERE content_kind IS NULL/);
  assert.match(calls[1].sql, /ADD CONSTRAINT news_articles_content_kind_check CHECK \(content_kind IN \('fulltext', 'summary', 'none'\)\)/);
});
test('news rows and associations deduplicate independently and only write parameterized raw source values', async () => {
  const { calls, store } = fixture(), raw = article({ title: "x'); DROP TABLE anything; --" });
  const result = await store.saveWindow(args({ articles: [raw, raw], links: [link(), link({ matchedTerms: ['002920'] }), link({ ticker: '600519.SH' })] }));
  assert.equal(result.rowsCount, 1); assert.equal(result.matchedCount, 2);
  const articles = calls.find(call => call.sql.includes('INSERT INTO market_data.news_articles'));
  assert.equal(articles.values[3], raw.title); assert.equal(articles.values[4], raw.content); assert.equal(articles.values[5], '2026-10-14T02:00:00.000Z'); assert.doesNotMatch(articles.sql, /DROP TABLE anything/);
  const associations = calls.find(call => call.sql.includes('INSERT INTO market_data.stock_news_links'));
  assert.deepEqual(JSON.parse(associations.values[3]), ['002920', '德赛西威']); assert.equal(calls.at(-1).sql, 'COMMIT');
});
test('completed empty windows persist without fabricated articles; failed windows cannot overwrite completion', async () => {
  const { calls, store } = fixture(); await store.saveWindow(args({ articles: [], links: [] }));
  assert.ok(!calls.some(call => call.sql.includes('INSERT INTO market_data.news_articles')));
  const completed = calls.find(call => call.sql.includes('INSERT INTO market_data.news_sync_windows'));
  assert.deepEqual(completed.values.slice(2), [start, end, 0, 0]);
  await store.markFailedWindow({ sourceApi: 'major_news', start, end, errorCode: 'secret=token' });
  assert.equal(calls.at(-1).values.at(-1), 'unknown_error'); assert.match(calls.at(-1).sql, /WHERE market_data.news_sync_windows.status <> 'completed'/);
});
test('invalid article cutoffs and orphan links fail before a transaction starts', async () => {
  for (const extra of [{ articles: [article({ publishedAt: end })] }, { articles: [article({ publishedAt: '2026-10-13T15:59:59Z' })] }, { links: [link({ articleId: 'b'.repeat(64) })] }, { articles: [article(), article({ content: '冲突' })] }, { links: [link({ matchType: 'inferred' })] }]) {
    const { calls, store } = fixture(); await assert.rejects(store.saveWindow(args(extra)), { code: 'VALIDATION_ERROR' }); assert.equal(calls.length, 0);
  }
});
test('article/link/completion failures roll back all writes and sanitize database errors', async () => {
  for (const target of ['INSERT INTO market_data.news_articles', 'INSERT INTO market_data.stock_news_links', 'INSERT INTO market_data.news_sync_windows']) {
    const { calls, pool, store } = fixture({ failOn: sql => sql.includes(target) });
    await assert.rejects(store.saveWindow(args()), error => error.code === 'DATABASE_ERROR' && error.sqlState === '08006' && !/secret|postgres:\/\//.test(error.message));
    assert.equal(calls.at(-1).sql, 'ROLLBACK'); assert.equal(pool.released, 1); assert.ok(!calls.some(call => call.sql === 'COMMIT'));
  }
});
test('resume returns completed zero-row ISO window keys and securities use real quoted A shares only', async () => {
  const { calls, store } = fixture({ rows: [{ window_start: new Date(start), window_end: new Date(end) }] });
  assert.deepEqual(await store.getCompletedWindows({ sourceApi: 'major_news', from: start, to: end }), new Set([`${start}|${end}`]));
  assert.match(calls[0].sql, /status = 'completed'/); assert.doesNotMatch(calls[0].sql, /rows_count > 0/);
  await store.getSecurities(); assert.match(calls[1].sql, /s.market = 'A'/); assert.match(calls[1].sql, /EXISTS \(SELECT 1 FROM market_data.daily_prices/);
});
test('source permission metadata is explicit and summary counts an article once across many stocks', async () => {
  const { calls, store } = fixture({ rows: sql => sql.includes('GROUP BY status') ? [{ status: 'completed', count: '3' }] : [{ article_count: '2', link_count: '8', ticker_count: '4', linked_articles: '1' }] });
  await store.setSourceStatus({ sourceApi: 'news', status: 'permission_denied', errorCode: 'permission_denied' });
  assert.deepEqual(calls[0].values, ['news', 'permission_denied', 'permission_denied']);
  const summary = await store.summary({ from: start, to: end });
  assert.equal(summary.articleCount, 2); assert.equal(summary.linkCount, 8); assert.equal(summary.completedWindows, 3);
  assert.match(calls[1].sql, /count\(DISTINCT a.article_id\) AS article_count/);
});

test('website articles save atomically and idempotently without claiming completed time coverage', async () => {
  const { store, calls } = fixture();
  const raw = article({ sourceApi: 'cls_web', sourceName: '财联社官网', url: 'https://www.cls.cn/detail/12345' });
  const input = { sourceApi: 'cls_web', sourceName: '财联社官网', articles: [raw, raw], links: [link(), link({ matchType: 'source_tag', matchedTerms: ['SZ002920'] })], fetchedAt: end };
  assert.deepEqual(await store.saveArticles(input), { rowsCount: 1, matchedCount: 1 });
  assert.deepEqual(await store.saveArticles(input), { rowsCount: 1, matchedCount: 1 });
  assert.equal(calls.filter(call => call.sql === 'COMMIT').length, 2);
  assert.ok(calls.every(call => !call.sql.includes('news_sync_windows')));
  const articles = calls.find(call => call.sql.includes('INSERT INTO market_data.news_articles'));
  assert.equal(articles.values[1], 'cls_web'); assert.equal(articles.values[2], '财联社官网');
  assert.match(articles.sql, /ON CONFLICT \(article_id\) DO UPDATE/);
  const associations = calls.find(call => call.sql.includes('INSERT INTO market_data.stock_news_links'));
  assert.equal(associations.values[2], 'source_tag'); assert.deepEqual(JSON.parse(associations.values[3]), ['SZ002920', '德赛西威']);
});
test('website import validates associations before writing and rolls back article/link failures', async () => {
  const raw = article({ sourceApi: 'cls_web', sourceName: '财联社官网' });
  const input = { sourceApi: 'cls_web', sourceName: '财联社官网', articles: [raw], links: [link()] };
  const invalid = fixture();
  await assert.rejects(invalid.store.saveArticles({ ...input, links: [link({ articleId: 'b'.repeat(64) })] }), { code: 'VALIDATION_ERROR' });
  assert.equal(invalid.calls.length, 0);
  const failed = fixture({ failOn: sql => sql.includes('INSERT INTO market_data.stock_news_links') });
  await assert.rejects(failed.store.saveArticles(input), { code: 'DATABASE_ERROR' });
  assert.equal(failed.calls.at(-1).sql, 'ROLLBACK'); assert.ok(!failed.calls.some(call => call.sql === 'COMMIT'));
  assert.ok(!failed.calls.some(call => call.sql.includes('news_sync_windows')));
});

test('article imports infer legacy content kinds and parameterize explicit briefs separately from full text', async () => {
  for (const [content, contentKind, expected] of [['完整正文', undefined, 'fulltext'], ['', undefined, 'none'], ["摘要 ' || malicious", 'summary', 'summary'], ['后来获得的全文', 'fulltext', 'fulltext']]) {
    const { store, calls } = fixture();
    await store.saveArticles({ sourceApi: 'cls_web', sourceName: '财联社官网', articles: [article({ sourceApi: 'cls_web', sourceName: '财联社官网', content, ...(contentKind ? { contentKind } : {}) })], links: [] });
    const insertion = calls.find(call => call.sql.includes('INSERT INTO market_data.news_articles'));
    assert.equal(insertion.values[4], content); assert.equal(insertion.values[8], expected);
    assert.match(insertion.sql, /fetched_at, content_kind/);
    assert.doesNotMatch(insertion.sql, /malicious|完整正文|后来获得的全文/);
  }
});
test('website upserts preserve full text against brief/empty imports while keeping content and kind in sync', async () => {
  const { store, calls } = fixture();
  await store.saveArticles({ sourceApi: 'cls_web', sourceName: '财联社官网', articles: [article({ sourceApi: 'cls_web', sourceName: '财联社官网', content: '列表摘要', contentKind: 'summary' })], links: [link({ matchType: 'name' })] });
  const insertion = calls.find(call => call.sql.includes('INSERT INTO market_data.news_articles'));
  const guard = /EXCLUDED\.source_api = 'cls_web' AND \(EXCLUDED\.content_kind = 'none'\s+OR \(market_data\.news_articles\.content_kind = 'fulltext' AND EXCLUDED\.content_kind <> 'fulltext'\)\)/g;
  assert.equal([...insertion.sql.matchAll(guard)].length, 2);
  assert.match(insertion.sql, /THEN market_data\.news_articles\.content ELSE EXCLUDED\.content END/);
  assert.match(insertion.sql, /THEN market_data\.news_articles\.content_kind ELSE EXCLUDED\.content_kind END/);
  const association = calls.find(call => call.sql.includes('INSERT INTO market_data.stock_news_links'));
  assert.match(association.sql, /WHEN market_data\.stock_news_links\.match_type = 'source_tag' THEN 'source_tag' ELSE EXCLUDED\.match_type END/);
  assert.match(association.sql, /SELECT DISTINCT term FROM jsonb_array_elements_text\(market_data\.stock_news_links\.matched_terms \|\| EXCLUDED\.matched_terms\)/);
  assert.equal(association.values[2], 'name'); assert.deepEqual(JSON.parse(association.values[3]), ['德赛西威']);
  assert.ok(calls.every(call => !call.sql.includes('news_sync_windows')));
});
test('Tushare article/link imports retain ordinary replacements and reject inconsistent content kinds before writing', async () => {
  const { store, calls } = fixture();
  await store.saveWindow(args({ articles: [article({ content: '' })] }));
  assert.equal(calls.find(call => call.sql.includes('INSERT INTO market_data.news_articles')).values[8], 'none');
  const association = calls.find(call => call.sql.includes('INSERT INTO market_data.stock_news_links'));
  assert.match(association.sql, /DO UPDATE SET match_type = EXCLUDED\.match_type, matched_terms = EXCLUDED\.matched_terms$/);
  assert.doesNotMatch(association.sql, /CASE|jsonb_array_elements_text/);
  for (const extra of [{ content: '', contentKind: 'summary' }, { content: '有内容', contentKind: 'none' }, { contentKind: 'unknown' }]) {
    const invalid = fixture();
    await assert.rejects(invalid.store.saveWindow(args({ articles: [article(extra)] })), { code: 'VALIDATION_ERROR' });
    assert.equal(invalid.calls.length, 0);
  }
});
