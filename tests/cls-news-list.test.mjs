import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clsPublicChecksum, clsPublicListUrl, normalizeClsList, syncClsNewsList } from '../backend/market-data/cls-news-list.mjs';

const start = '2026-07-18T16:00:00.000Z', end = '2026-10-19T08:00:00.000Z';
const startSeconds = Date.parse(start) / 1000, endSeconds = Date.parse(end) / 1000;
const row = (id, ctime, extra = {}) => ({ id, ctime, title: '德赛西威发布公告', brief: '<p>智能驾驶业务增长 &amp; 订单增加</p>', is_ad: 0, external_link: '', ...extra });
const envelope = (rows, bootstrap = false) => ({ errno: 0, data: bootstrap ? { depth_list: rows } : rows });
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: new Map(), text: async () => JSON.stringify(data) });
const storeFixture = () => {
  const articles = new Map(), links = new Map(), statuses = [], writes = [];
  return { articles, links, statuses, writes, getSecurities: async () => [{ ticker: '002920.SZ', name: '德赛西威' }],
    saveArticles: async input => { writes.push(input); for (const article of input.articles) articles.set(article.id, article); for (const link of input.links) links.set(`${link.articleId}/${link.ticker}`, link); return { rowsCount: input.articles.length, matchedCount: input.links.length }; },
    setSourceStatus: async value => statuses.push(value), saveWindow: async () => assert.fail('Public column must never mark complete windows') };
};
async function fixture(operation) { const cacheDir = await mkdtemp(join(tmpdir(), 'cls-list-')); try { await operation(cacheDir); } finally { await rm(cacheDir, { recursive: true, force: true }); } }
const options = cacheDir => ({ cacheDir, store: storeFixture(), startDate: start, endDate: end, now: new Date(end), sleep: async () => {}, clock: () => 0 });

test('CLS public checksum uses the same sorted raw parameters independently of object order', () => {
  const raw = 'app=CailianpressWeb&id=1003&last_time=1792140157&os=web&rn=20&sv=8.7.9';
  const expected = createHash('md5').update(createHash('sha1').update(raw).digest('hex')).digest('hex');
  assert.equal(clsPublicChecksum({ rn: '20', app: 'CailianpressWeb', sv: '8.7.9', last_time: '1792140157', id: '1003', os: 'web' }), expected);
  const url = new URL(clsPublicListUrl(1792140157)); assert.equal(url.origin, 'https://www.cls.cn'); assert.equal(url.pathname, '/v3/depth/list/1003'); assert.equal(url.searchParams.get('sign'), expected);
  assert.throws(() => clsPublicListUrl(-1)); assert.throws(() => clsPublicListUrl('secret'));
});

test('CLS list normalization preserves summary provenance, stable IDs and exact date boundaries', () => {
  const result = normalizeClsList([row(1, startSeconds), row(2, startSeconds - 1), row(3, endSeconds), row(4, endSeconds - 1, { brief: '' }),
    row(5, endSeconds - 2, { is_ad: 1 }), row(6, endSeconds - 3, { external_link: 'https://other.test/story' })], { start, end, fetchedAt: end });
  assert.equal(result.records.length, 2); assert.equal(result.skipped, 2); assert.equal(result.outOfRange, 2);
  const first = result.records[0].article; assert.equal(first.id, createHash('sha256').update(JSON.stringify(['cls_web', '1'])).digest('hex'));
  assert.equal(first.contentKind, 'summary'); assert.equal(first.content, '智能驾驶业务增长 & 订单增加'); assert.equal(first.url, 'https://www.cls.cn/detail/1');
  assert.equal(result.records[1].article.contentKind, 'none');
  assert.throws(() => normalizeClsList([row(0, startSeconds)], { start, end, fetchedAt: end }), /ID/);
});

test('CLS pagination does not truncate 30 returned items to requested rn20 and persists a frozen resumable range', async () => fixture(async cacheDir => {
  const store = storeFixture(); let calls = 0;
  const firstRows = Array.from({ length: 30 }, (_, index) => row(100 + index, endSeconds - index - 1));
  const first = await syncClsNewsList({ ...options(cacheDir), store, maxPages: 1, fetchImpl: async () => { calls++; return response(envelope(firstRows, true)); } });
  assert.equal(first.runSaved, 30); assert.equal(first.cursor, endSeconds - 30); assert.equal(first.stopReason, 'page_limit');
  const second = await syncClsNewsList({ cacheDir, store, resume: true, maxPages: 1, now: new Date('2026-11-01T00:00:00Z'), sleep: async () => {},
    fetchImpl: async url => { calls++; assert.equal(new URL(url).searchParams.get('last_time'), String(first.cursor)); return response(envelope([row(200, endSeconds - 31)])); } });
  assert.equal(second.start, start); assert.equal(second.end, end); assert.equal(second.completedPages, 2); assert.equal(calls, 2); assert.equal(second.coverageVerified, false);
}));

test('CLS range start requires a second fully below-start ordered page', async () => fixture(async cacheDir => {
  const pages = [envelope([row(1, startSeconds + 100), row(3, startSeconds + 1), row(2, startSeconds - 1), row(4, startSeconds - 2)], true),
    envelope([row(5, startSeconds - 3), row(6, startSeconds - 4)])]; let requests = 0;
  const result = await syncClsNewsList({ ...options(cacheDir), maxPages: 5, fetchImpl: async () => response(pages[requests++]) });
  assert.equal(requests, 2); assert.equal(result.rangeReachedStart, true); assert.equal(result.status, 'range_reached'); assert.equal(result.runSaved, 2); assert.equal(result.coverageVerified, false);
}));

test('CLS pinned or non-monotonic pages stop without moving the checkpoint cursor', async () => fixture(async cacheDir => {
  let requests = 0;
  const result = await syncClsNewsList({ ...options(cacheDir), maxPages: 5, fetchImpl: async () => { requests++; return response(envelope([
    row(1, startSeconds + 100), row(2, startSeconds - 1), row(3, startSeconds + 1), row(4, startSeconds - 2),
  ], true)); } });
  assert.equal(requests, 1); assert.equal(result.stopReason, 'non_monotonic_page'); assert.equal(result.cursor, null); assert.equal(result.completedPages, 0); assert.equal(result.coverageVerified, false);
}));

test('CLS cursor-second ties remain explicitly unverified in warnings rather than claiming complete pagination', async () => fixture(async cacheDir => {
  const result = await syncClsNewsList({ ...options(cacheDir), maxPages: 1, fetchImpl: async () => response(envelope([
    row(1, endSeconds - 1), row(2, endSeconds - 2), row(3, endSeconds - 2),
  ], true)) });
  assert.equal(result.coverageVerified, false); assert.equal(result.warnings[0].kind, 'cursor_second_tie'); assert.equal(result.warnings[0].completenessUnverified, true);
}));

test('CLS 403, 429 and business permission or captcha stop without retries or cursor advancement', async () => {
  for (const [status, body, reason] of [[403, {}, 'permission'], [429, {}, 'rate_limit'], [200, { errno: 1001, msg: '没有权限' }, 'permission'], [200, { errno: 1002, msg: '请输入验证码' }, 'captcha']]) {
    await fixture(async cacheDir => { let calls = 0; const store = storeFixture(); const result = await syncClsNewsList({ ...options(cacheDir), store,
      fetchImpl: async () => { calls++; return response(body, status); } });
      assert.equal(calls, 1); assert.equal(result.stopReason, reason); assert.equal(result.completedPages, 0); assert.equal(result.cursor, null); assert.notEqual(store.statuses.at(-1).status, 'available');
    });
  }
});

test('CLS duplicate pages and non-descending cursors stop explicitly without claiming coverage', async () => {
  for (const repeat of [true, false]) await fixture(async cacheDir => {
    let count = 0; const firstRows = [row(1, endSeconds - 1), row(2, endSeconds - 2)];
    const result = await syncClsNewsList({ ...options(cacheDir), maxPages: 5, fetchImpl: async () => response(count++ === 0 ? envelope(firstRows, true)
      : envelope(repeat ? firstRows : [row(3, endSeconds - 1)])) });
    assert.equal(count, 2); assert.equal(result.completedPages, 1); assert.equal(result.stopReason, repeat ? 'repeated_page' : 'cursor_not_descending'); assert.equal(result.coverageVerified, false);
  });
});

test('CLS cached page survives a database failure and is committed before resume advances the cursor', async () => fixture(async cacheDir => {
  const store = storeFixture(); let network = 0, failOnce = true; const normalSave = store.saveArticles;
  store.saveArticles = async input => { if (failOnce) { failOnce = false; throw Object.assign(new Error('secret-db'), { kind: 'database' }); } return normalSave(input); };
  const first = await syncClsNewsList({ ...options(cacheDir), store, maxPages: 1, fetchImpl: async () => { network++; return response(envelope([row(1, endSeconds - 1)], true)); } });
  assert.equal(first.completedPages, 0); assert.equal(first.cursor, null); assert.equal(first.stopReason, 'database');
  const second = await syncClsNewsList({ cacheDir, store, resume: true, maxPages: 1, fetchImpl: async () => assert.fail('Use cached page'), sleep: async () => {} });
  assert.equal(network, 1); assert.equal(second.cachedPages, 1); assert.equal(second.completedPages, 1); assert.equal(second.cursor, endSeconds - 1); assert.equal(store.articles.size, 1);
  assert.doesNotMatch(JSON.stringify(first), /secret-db/);
}));

test('CLS skips ads and external stories even when those rows have no publication timestamps', async () => fixture(async cacheDir => {
  const result = await syncClsNewsList({ ...options(cacheDir), maxPages: 1, fetchImpl: async () => response(envelope([
    { is_ad: 1, title: '广告' }, row(1, endSeconds - 1), { external_link: 'https://other.test/x', title: '外站' },
  ], true)) });
  assert.equal(result.runSaved, 1); assert.equal(result.skipped, 2); assert.equal(result.cursor, endSeconds - 1);
}));

test('CLS completed column range resumes without new network calls and never promotes to full-site coverage', async () => fixture(async cacheDir => {
  let count = 0;
  await syncClsNewsList({ ...options(cacheDir), fetchImpl: async () => response(count++ === 0 ? envelope([row(1, startSeconds - 1)], true) : envelope([row(2, startSeconds - 2)])) });
  const result = await syncClsNewsList({ cacheDir, store: storeFixture(), resume: true, fetchImpl: async () => assert.fail('Already range reached') });
  assert.equal(result.stopReason, 'range_already_reached'); assert.equal(result.requests, 0); assert.equal(result.coverageVerified, false); assert.equal(result.status, 'range_reached');
}));
