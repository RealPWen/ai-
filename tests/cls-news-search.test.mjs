import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clsPublicSearchRequest, normalizeClsSearchRows, syncClsNewsSearch } from '../backend/market-data/cls-news-search.mjs';
import { clsPublicChecksum } from '../backend/market-data/cls-news-list.mjs';

const start = '2026-07-18T16:00:00.000Z', end = '2026-10-19T08:00:00.000Z';
const firstSecond = Date.parse(start) / 1000, lastSecond = Date.parse(end) / 1000;
const row = (id, time, extra = {}) => ({ id, time, title: '德赛西威<em>财联社</em>报道', descr: '<em>智能驾驶</em>订单增长 &amp; 利润改善', stocks: null, external_link: '', ...extra });
const body = rows => ({ errno: 0, data: { depth: { total_num: 224549, data: rows } } });
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: new Map(), text: async () => JSON.stringify(data) });
const fakeStore = () => {
  const articles = new Map(), links = new Map(), statuses = [];
  return { articles, links, statuses, getSecurities: async () => [{ ticker: '002920.SZ', name: '德赛西威' }],
    saveArticles: async input => { for (const article of input.articles) articles.set(article.id, article); for (const link of input.links) links.set(`${link.articleId}/${link.ticker}`, link); return { rowsCount: input.articles.length, matchedCount: input.links.length }; },
    setSourceStatus: async value => statuses.push(value), saveWindow: async () => assert.fail('Search indexing cannot mark complete windows') };
};
async function fixture(operation) { const cacheDir = await mkdtemp(join(tmpdir(), 'cls-search-')); try { await operation(cacheDir); } finally { await rm(cacheDir, { recursive: true, force: true }); } }
const options = cacheDir => ({ cacheDir, store: fakeStore(), startDate: start, endDate: end, now: new Date(end), sleep: async () => {}, clock: () => 0 });

test('CLS public search request uses anonymous fixed POST endpoint and signs only public URL parameters', () => {
  const request = clsPublicSearchRequest({ page: 100 });
  const url = new URL(request.url); assert.equal(url.origin, 'https://www.cls.cn'); assert.equal(url.pathname, '/api/sw');
  assert.equal(url.searchParams.get('sign'), clsPublicChecksum({ app: 'CailianpressWeb', os: 'web', sv: '8.7.9' }));
  assert.deepEqual(request.body, { type: 'depth', keyword: '财联社', rn: 20, page: 100, app: 'CailianpressWeb', os: 'web', sv: '8.7.9' });
  for (const params of [{ keyword: '' }, { keyword: '  ' }, { keyword: 'x\u0000' }, { page: -1 }, { page: 0.5 }]) assert.throws(() => clsPublicSearchRequest(params));
});

test('CLS search summaries remove highlighting, use stable IDs, validate tags, and honor exact date boundaries', () => {
  const normalized = normalizeClsSearchRows([row(1, firstSecond, { stocks: [{ stock_id: 'sz002920' }] }), row(2, firstSecond - 1), row(3, lastSecond),
    row(4, lastSecond - 1, { descr: '' }), row(5, lastSecond - 2, { external_link: 'https://other.test/x' })], { start, end, fetchedAt: end });
  assert.equal(normalized.records.length, 2); assert.equal(normalized.outOfRange, 2); assert.equal(normalized.skipped, 1);
  const record = normalized.records[0]; assert.equal(record.article.content, '智能驾驶订单增长 & 利润改善'); assert.equal(record.article.contentKind, 'summary');
  assert.equal(record.article.title, '德赛西威财联社报道'); assert.equal(record.article.id, createHash('sha256').update(JSON.stringify(['cls_web', '1'])).digest('hex'));
  assert.equal(record.stockIds[0], 'sz002920'); assert.equal(normalized.records[1].article.contentKind, 'none');
});

test('CLS search saves pages before advancing and resumes original range and next page', async () => fixture(async cacheDir => {
  const store = fakeStore(), calls = [];
  const first = await syncClsNewsSearch({ ...options(cacheDir), store, maxPages: 1, fetchImpl: async (url, init) => { calls.push(JSON.parse(init.body).page); assert.equal(init.method, 'POST'); return response(body([row(1, lastSecond - 1), row(2, lastSecond - 2)])); } });
  assert.equal(first.nextPage, 1); assert.equal(first.completedPages, 1); assert.equal(first.runSaved, 2);
  const resumed = await syncClsNewsSearch({ cacheDir, store, resume: true, now: new Date('2026-11-01T00:00:00Z'), maxPages: 1,
    fetchImpl: async (url, init) => { calls.push(JSON.parse(init.body).page); return response(body([row(3, lastSecond - 3)])); } });
  assert.deepEqual(calls, [0, 1]); assert.equal(resumed.start, start); assert.equal(resumed.end, end); assert.equal(resumed.nextPage, 2); assert.equal(resumed.scope.keyword, '财联社');
  assert.equal(resumed.coverageVerified, false); assert.equal(resumed.historicalPointInTime, false); assert.equal(store.articles.size, 3);
}));

test('CLS moving live index overlaps warn and continue when oldest time still descends', async () => fixture(async cacheDir => {
  let calls = 0; const store = fakeStore();
  const result = await syncClsNewsSearch({ ...options(cacheDir), store, maxPages: 2, fetchImpl: async () => response(body(calls++ === 0
    ? [row(1, lastSecond - 1), row(2, lastSecond - 3)] : [row(2, lastSecond - 3 + 1), row(3, lastSecond - 4)])) });
  assert.equal(result.completedPages, 2); assert.equal(result.warnings[0].kind, 'live_index_overlap'); assert.equal(result.coverageVerified, false); assert.equal(store.articles.size, 3);
}));

test('CLS search detects non-monotonic pages, repeated pages and oldest time that does not advance', async () => {
  for (const mode of ['non_monotonic_page', 'repeated_page', 'oldest_time_not_descending']) await fixture(async cacheDir => {
    let calls = 0; const initial = [row(1, lastSecond - 1), row(2, lastSecond - 3)];
    const result = await syncClsNewsSearch({ ...options(cacheDir), maxPages: 5, fetchImpl: async () => {
      const rows = calls++ === 0 ? initial : mode === 'repeated_page' ? initial : mode === 'non_monotonic_page'
        ? [row(3, lastSecond - 5), row(4, lastSecond - 4)] : [row(3, lastSecond - 1), row(4, lastSecond - 2)];
      return response(body(rows));
    } });
    assert.equal(calls, 2); assert.equal(result.completedPages, 1); assert.equal(result.nextPage, 1); assert.equal(result.stopReason, mode); assert.equal(result.coverageVerified, false);
  });
});

test('CLS range start is confirmed by a following fully earlier page, not a total count or the first crossing', async () => fixture(async cacheDir => {
  let calls = 0; const result = await syncClsNewsSearch({ ...options(cacheDir), maxPages: 10, fetchImpl: async () => response(body(calls++ === 0
    ? [row(1, firstSecond + 2), row(2, firstSecond - 1)] : [row(3, firstSecond - 2)])) });
  assert.equal(calls, 2); assert.equal(result.rangeReachedStart, true); assert.equal(result.status, 'range_reached'); assert.equal(result.runSaved, 1); assert.equal(result.coverageVerified, false);
  const resumed = await syncClsNewsSearch({ cacheDir, store: fakeStore(), resume: true, fetchImpl: async () => assert.fail('Finished range does not need refetching') });
  assert.equal(resumed.stopReason, 'range_already_reached'); assert.equal(resumed.requests, 0);
}));

test('CLS empty search before requested start remains partial and does not imply all site history was collected', async () => fixture(async cacheDir => {
  const result = await syncClsNewsSearch({ ...options(cacheDir), fetchImpl: async () => response(body([])) });
  assert.equal(result.stopReason, 'search_index_exhausted'); assert.equal(result.rangeReachedStart, false); assert.equal(result.status, 'partial'); assert.equal(result.coverageVerified, false);
}));

test('CLS different article IDs on same-second search pages may progress with an explicit boundary warning', async () => fixture(async cacheDir => {
  let calls = 0;
  const result = await syncClsNewsSearch({ ...options(cacheDir), maxPages: 2, fetchImpl: async () => response(body(calls++ === 0
    ? [row(1, lastSecond - 1), row(2, lastSecond - 2)] : [row(3, lastSecond - 2), row(4, lastSecond - 2)])) });
  assert.equal(result.completedPages, 2); assert.equal(result.nextPage, 2); assert.equal(result.warnings[0].kind, 'same_timestamp_boundary'); assert.equal(result.coverageVerified, false);
}));

test('CLS search stops immediately on HTTP permission/rate limits or business captcha errors', async () => {
  for (const [status, value, kind] of [[403, {}, 'permission'], [429, {}, 'rate_limit'], [200, { errno: 2, msg: '没有权限' }, 'permission'], [200, { errno: 3, msg: '请输入验证码' }, 'captcha']]) {
    await fixture(async cacheDir => { let calls = 0; const store = fakeStore(); const result = await syncClsNewsSearch({ ...options(cacheDir), store,
      fetchImpl: async () => { calls++; return response(value, status); } });
      assert.equal(calls, 1); assert.equal(result.stopReason, kind); assert.equal(result.nextPage, 0); assert.notEqual(store.statuses.at(-1).status, 'available');
    });
  }
});

test('CLS search network retries are finite and a failed database page is safely restored from cache', async () => fixture(async cacheDir => {
  const store = fakeStore(); let calls = 0, failOnce = true; const save = store.saveArticles;
  store.saveArticles = async input => { if (failOnce) { failOnce = false; throw Object.assign(new Error('secret-database-error'), { kind: 'database' }); } return save(input); };
  const first = await syncClsNewsSearch({ ...options(cacheDir), store, maxPages: 1, fetchImpl: async () => { calls++; if (calls === 1) throw new Error('secret-network-error'); return response(body([row(1, lastSecond - 1)])); } });
  assert.equal(calls, 2); assert.equal(first.nextPage, 0); assert.equal(first.stopReason, 'database'); assert.doesNotMatch(JSON.stringify(first), /secret-/);
  const resumed = await syncClsNewsSearch({ cacheDir, store, resume: true, maxPages: 1, fetchImpl: async () => assert.fail('Use cached body') });
  assert.equal(resumed.cachedPages, 1); assert.equal(resumed.nextPage, 1); assert.equal(store.articles.size, 1);
}));
