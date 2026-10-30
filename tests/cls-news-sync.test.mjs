import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clsArticleUrl, discoverClsArticleUrls, clsPlainText, parseClsArticle, matchClsArticle, syncClsNews } from '../backend/market-data/cls-news-sync.mjs';

const start = '2026-07-15T16:00:00.000Z', end = '2026-10-16T12:00:00.000Z';
const securities = [{ ticker: '688295.SH', name: '中复神鹰' }, { ticker: '002920.SZ', name: '德赛西威' }, { ticker: '920077.BJ', name: '吉林碳谷' }];
const detail = (overrides = {}) => ({ id: 2506684, title: '中复神鹰与德赛西威', content: '<p>公开报道 &amp; 内容。</p>', ctime: 1792130193, isFree: true,
  stocks: [{ stockId: 'sh688295' }, { stockId: 'SZ002920' }, { stockId: '920077.BJ' }, { stockId: 'sh999999' }], ...overrides });
const html = value => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { articleDetail: value } } })}</script></html>`;
const response = (text, status = 200, url = '') => ({ ok: status >= 200 && status < 300, status, url, headers: new Map([['content-type', 'text/html']]), text: async () => text });
const parsed = value => parseClsArticle(html(value), { url: 'https://www.cls.cn/detail/2506684', start, end, fetchedAt: end });
const fakeStore = () => {
  const articles = new Map(), links = new Map(), statuses = [];
  return { articles, links, statuses, getSecurities: async () => securities,
    saveArticles: async input => { for (const article of input.articles) articles.set(article.id, article); for (const link of input.links) links.set(`${link.articleId}/${link.ticker}`, link); return { rowsCount: input.articles.length, matchedCount: input.links.length }; },
    setSourceStatus: async status => statuses.push(status), saveWindow: () => assert.fail('Public discovery must not create completed windows') };
};

test('CLS URLs and public homepage links are restricted to canonical HTTPS article pages', () => {
  assert.equal(clsArticleUrl('/detail/2506684'), 'https://www.cls.cn/detail/2506684');
  for (const url of ['http://www.cls.cn/detail/1', 'https://evil.test/detail/1', 'https://secret@www.cls.cn/detail/1', 'https://www.cls.cn:8000/detail/1', '/detail/1?token=secret', '/detail/1#x', '/detail/0', '/api/list', '/detail/no', '/foo/../detail/1', '/detail/%31', '/detail/1 ']) assert.throws(() => clsArticleUrl(url));
  assert.deepEqual(discoverClsArticleUrls('<a href="/detail/2506684">A</a><a href="https://www.cls.cn/detail/2506684">B</a><a href="https://evil.test/detail/1">C</a>'), ['https://www.cls.cn/detail/2506684']);
});

test('CLS plain text removes active tags, encoded tags and controls without executing markup', () => {
  assert.equal(clsPlainText('<p>文字<br>第二行</p><script>secret()</script>&lt;img src=x onerror=bad&gt;&#x4e2d;\u0000'), '文字\n第二行\n中');
  assert.doesNotMatch(clsPlainText('&amp;lt;script&amp;gt;bad&amp;lt;/script&amp;gt; 正文'), /bad|<|>/);
});

test('CLS article dates are validated and filtered with inclusive start and exclusive end', () => {
  const first = Date.parse(start) / 1000, last = Date.parse(end) / 1000;
  assert.equal(parsed(detail({ ctime: first })).article.publishedAt, start);
  assert.equal(parsed(detail({ ctime: first - 1 })), null);
  assert.equal(parsed(detail({ ctime: last })), null);
  assert.ok(parsed(detail({ ctime: last - 1 })));
  for (const ctime of [null, 'not-a-date', Infinity, 1792130193.5]) assert.throws(() => parsed(detail({ ctime })), /日期/);
});

test('CLS rejects response IDs different from requested IDs and malformed NEXT_DATA', () => {
  assert.throws(() => parsed(detail({ id: 2506685 })), /ID/);
  assert.throws(() => parseClsArticle('<script id="__NEXT_DATA__">not-json</script>', { url: '/detail/2506684', start, end }), /校验/);
});

test('CLS website stock tags take precedence and are checked against the securities dictionary', () => {
  const links = matchClsArticle(parsed(detail()), securities);
  assert.deepEqual(links.map(link => link.ticker), ['002920.SZ', '688295.SH', '920077.BJ']);
  assert.ok(links.every(link => link.matchType === 'source_tag'));
  assert.ok(links.find(link => link.ticker === '688295.SH').matchedTerms.includes('中复神鹰'));
  assert.equal(matchClsArticle(parsed(detail({ stocks: [] })), securities).find(link => link.ticker === '688295.SH').matchType, 'name');
});

test('CLS explicit paywall or login flags save only public title and link, with no article body', () => {
  for (const overrides of [{ isFree: false }, { isFree: 0 }, { needLogin: true }, { content: '登录后查看全文' }]) {
    const record = parsed(detail(overrides)); assert.equal(record.restricted, true); assert.equal(record.article.content, ''); assert.ok(record.article.title); assert.ok(record.article.url);
  }
  assert.equal(parsed(detail()).restricted, false);
});

test('CLS one pass saves articles and links idempotently, then resumes from validated cache without requests', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'cls-test-')), store = fakeStore(); let requests = 0;
  try {
    const options = { store, cacheDir, urls: ['/detail/2506684', 'https://www.cls.cn/detail/2506684'], includeHomepage: false,
      startDate: start, endDate: end, now: new Date(end), sleep: async () => {}, clock: () => 0,
      fetchImpl: async () => { requests++; return response(html(detail())); } };
    const first = await syncClsNews(options), second = await syncClsNews(options);
    assert.equal(requests, 1); assert.equal(first.fetched, 1); assert.equal(first.saved, 1); assert.equal(second.cached, 1); assert.equal(second.saved, 1);
    assert.equal(store.articles.size, 1); assert.equal(store.links.size, 3);
    for (const report of [first, second]) { assert.equal(report.status, 'partial'); assert.equal(report.coverageVerified, false); assert.equal(report.stopReason, 'public_discovery_exhausted'); }
    const status = (await readdir(join(cacheDir, 'news', 'cls_web'))).find(file => file.startsWith('status-'));
    assert.equal(JSON.parse(await readFile(join(cacheDir, 'news', 'cls_web', status), 'utf8')).coverageVerified, false);
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});

test('CLS 403 and 429 stop immediately, preserve partial progress and do not retry', async () => {
  for (const status of [403, 429]) {
    const cacheDir = await mkdtemp(join(tmpdir(), 'cls-stop-')), store = fakeStore(); let requests = 0;
    try {
      const report = await syncClsNews({ store, cacheDir, urls: ['/detail/2506684', '/detail/2506685', '/detail/2506686'], includeHomepage: false,
        startDate: start, endDate: end, now: new Date(end), sleep: async () => {}, clock: () => 0,
        fetchImpl: async () => ++requests === 1 ? response(html(detail())) : response('blocked', status) });
      assert.equal(requests, 2); assert.equal(report.saved, 1); assert.equal(report.stopReason, status === 429 ? 'rate_limit' : 'permission');
      assert.equal(report.status, 'partial'); assert.equal(report.coverageVerified, false);
      assert.equal(store.statuses.at(-1).status, 'failed'); assert.equal(store.statuses.at(-1).errorCode, status === 429 ? 'rate_limited' : 'permission_denied');
    } finally { await rm(cacheDir, { recursive: true, force: true }); }
  }
});

test('CLS blocks redirects and retries network failures a finite number of times', async () => {
  for (const redirect of [true, false]) {
    const cacheDir = await mkdtemp(join(tmpdir(), 'cls-fail-')); let requests = 0;
    try {
      const report = await syncClsNews({ store: fakeStore(), cacheDir, urls: ['/detail/2506684'], includeHomepage: false,
        startDate: start, endDate: end, now: new Date(end), sleep: async () => {},
        fetchImpl: async () => { requests++; if (redirect) return response('', 302, 'https://evil.test/'); throw new Error('secret-upstream-error'); } });
      assert.equal(requests, redirect ? 1 : 2); assert.equal(report.failed, 1); assert.equal(report.saved, 0); assert.doesNotMatch(JSON.stringify(report), /secret-upstream/);
    } finally { await rm(cacheDir, { recursive: true, force: true }); }
  }
});

test('CLS homepage discovery remains partial and maximum article budget bounds requests', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'cls-limit-')); let requests = 0; const waits = [];
  try {
    const report = await syncClsNews({ store: fakeStore(), cacheDir, maxArticles: 1, startDate: start, endDate: end, now: new Date(end),
      sleep: async ms => waits.push(ms), clock: () => 0, fetchImpl: async url => { requests++; return url.endsWith('/')
        ? response('<a href="/detail/2506684">A</a><a href="/detail/2506685">B</a>') : response(html(detail())); } });
    assert.equal(requests, 2); assert.equal(report.discovered, 2); assert.equal(report.attempted, 1); assert.equal(report.stopReason, 'article_limit'); assert.equal(report.coverageVerified, false);
    assert.ok(waits.every(ms => ms >= 2000));
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});

test('CLS import rebuilds associations from cache with no homepage or article requests', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'cls-import-'));
  try {
    await syncClsNews({ store: fakeStore(), cacheDir, urls: ['/detail/2506684'], includeHomepage: false,
      startDate: start, endDate: end, now: new Date(end), fetchImpl: async () => response(html(detail())) });
    const store = fakeStore(), report = await syncClsNews({ store, cacheDir, mode: 'import', startDate: start, endDate: end, now: new Date(end),
      fetchImpl: async () => assert.fail('import must not make network requests') });
    assert.equal(report.requests, 0); assert.equal(report.cached, 1); assert.equal(report.saved, 1); assert.equal(report.links, 3);
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});

test('CLS repeated limited runs progress beyond cached seed prefixes rather than downloading the same first N articles', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'cls-resume-budget-')), calls = [];
  try {
    const options = { store: fakeStore(), cacheDir, urls: ['/detail/2506684', '/detail/2506685', '/detail/2506686'], maxArticles: 1,
      includeHomepage: false, startDate: start, endDate: end, now: new Date(end), sleep: async () => {},
      fetchImpl: async url => { calls.push(url); return response(html(detail({ id: Number(url.split('/').at(-1)) }))); } };
    const reports = [];
    for (let index = 0; index < 4; index++) reports.push(await syncClsNews(options));
    assert.deepEqual(calls, ['https://www.cls.cn/detail/2506684', 'https://www.cls.cn/detail/2506685', 'https://www.cls.cn/detail/2506686']);
    assert.deepEqual(reports.map(report => report.cached), [0, 1, 2, 3]);
    assert.deepEqual(reports.map(report => report.newArticlesRequested), [1, 1, 1, 0]);
    assert.equal(reports.at(-1).stopReason, 'public_discovery_exhausted');
    assert.ok(reports.every(report => report.coverageVerified === false));
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});
