import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dailyClsNewsWindow, updateDailyClsNews } from '../backend/market-data/daily-news-update.mjs';

const runDate = '2026-10-19', now = new Date('2026-10-18T22:00:00.000Z');
const window = { runDate, windowStart: '2026-10-17T16:00:00.000Z', windowEnd: '2026-10-18T16:00:00.000Z' };
const successfulReport = (overrides = {}) => ({ status: 'range_reached', rangeReachedStart: true, coverageVerified: false, historicalPointInTime: false,
  sourceApi: 'cls_web', searchType: 'depth', searchKeyword: '财联社', start: window.windowStart, end: window.windowEnd,
  stopReason: 'range_start_confirmed', runPages: 3, completedPages: 3, runSaved: 20, runLinks: 7, nextPage: 3, cachedPages: 0, requests: 3, warnings: [], ...overrides });
function fixtures(previous = null) {
  const state = { previous, begun: 0, failed: [], finalized: [], migrated: 0, newsMigrated: 0 };
  const scope = { getRun: async () => state.previous, beginRun: async () => { state.begun++; }, failRun: async input => { state.failed.push(input); state.previous = { status: 'failed', ...input }; },
    finalize: async input => { state.finalized.push(input); state.previous = { status: 'succeeded', ...input }; return input; } };
  return { state, scope, store: { migrate: async () => { state.migrated++; }, withLock: async operation => operation(scope) }, newsStore: { migrate: async () => { state.newsMigrated++; } } };
}

test('daily CLS window is exactly the prior Shanghai calendar day across month/year/leap boundaries', () => {
  assert.deepEqual(dailyClsNewsWindow(runDate), window);
  assert.deepEqual(dailyClsNewsWindow('20260101'), { runDate: '2026-01-01', windowStart: '2025-12-30T16:00:00.000Z', windowEnd: '2025-12-31T16:00:00.000Z' });
  assert.equal(dailyClsNewsWindow('2024-03-01').windowStart, '2024-02-28T16:00:00.000Z');
  assert.throws(() => dailyClsNewsWindow('2026-02-30'));
});

test('daily CLS successful collector finalizes only the exact previous-day range in an isolated cache root', async () => {
  const fixture = fixtures(); let collected;
  const result = await updateDailyClsNews({ ...fixture, runDate, now, cacheDir: '/tmp/news-daily-fixture', collector: async input => { collected = input; return successfulReport(); } });
  assert.equal(result.status, 'succeeded'); assert.equal(fixture.state.finalized.length, 1); assert.equal(fixture.state.newsMigrated, 1);
  assert.equal(collected.startDate, window.windowStart); assert.equal(collected.endDate, window.windowEnd); assert.equal(collected.resume, false);
  assert.equal(collected.keyword, '财联社'); assert.equal(collected.cacheDir, '/tmp/news-daily-fixture/daily/2026-10-19');
  assert.equal(result.summary.coverageVerified, false); assert.equal(result.summary.historicalPointInTime, false); assert.equal(result.summary.runSaved, 20);
});

test('daily CLS prior succeeded date returns already_completed without news migration or collection', async () => {
  const fixture = fixtures({ status: 'succeeded', summary: { runSaved: 99, coverageVerified: false } });
  const result = await updateDailyClsNews({ ...fixture, runDate, now, cacheDir: '/tmp/news-daily-fixture', collector: async () => assert.fail('Already succeeded') });
  assert.equal(result.status, 'already_completed'); assert.equal(result.summary.runSaved, 99); assert.equal(fixture.state.begun, 0); assert.equal(fixture.state.newsMigrated, 0);
});

test('daily CLS busy shared lock skips collection and ledger changes', async () => {
  const fixture = fixtures(); fixture.store.withLock = async () => ({ status: 'busy' });
  const result = await updateDailyClsNews({ ...fixture, runDate, now, cacheDir: '/tmp/news-daily-fixture', collector: async () => assert.fail('Busy') });
  assert.equal(result.status, 'busy'); assert.equal(fixture.state.begun, 0); assert.equal(fixture.state.newsMigrated, 0);
});

test('daily CLS incomplete, permission, rate-limit and network outcomes are safely retryable rather than succeeded', async () => {
  for (const [stopReason, errorCode] of [['page_limit', 'incomplete_window'], ['permission', 'permission_denied'], ['rate_limit', 'rate_limited'], ['network', 'network_error'], ['search_index_exhausted', 'incomplete_window']]) {
    const fixture = fixtures(); const result = await updateDailyClsNews({ ...fixture, runDate, now, cacheDir: '/tmp/news-daily-fixture',
      collector: async () => successfulReport({ status: 'partial', rangeReachedStart: false, stopReason }) });
    assert.notEqual(result.status, 'succeeded', stopReason); assert.equal(result.errorCode, errorCode); assert.equal(fixture.state.finalized.length, 0); assert.equal(fixture.state.failed[0].errorCode, errorCode);
  }
});

test('daily CLS refuses future dates and mismatched/truncated collector dates even if provider claims success', async () => {
  const future = fixtures();
  const invalid = await updateDailyClsNews({ ...future, runDate: '2026-10-20', now, cacheDir: '/tmp/news-daily-fixture', collector: async () => assert.fail('Future date') });
  assert.equal(invalid.status, 'failed'); assert.equal(invalid.errorCode, 'validation_error'); assert.equal(future.state.migrated, 0);
  for (const changes of [{ end: '2026-10-18T15:59:59.000Z' }, { start: '2026-10-17T15:00:00.000Z' }, { coverageVerified: true }, { historicalPointInTime: true }, { searchKeyword: 'other' }, { stopReason: 'permission' }]) {
    const fixture = fixtures(); const result = await updateDailyClsNews({ ...fixture, runDate, now, cacheDir: '/tmp/news-daily-fixture', collector: async () => successfulReport(changes) });
    assert.notEqual(result.status, 'succeeded'); assert.equal(fixture.state.finalized.length, 0);
  }
});

test('daily CLS default runDate uses Shanghai today and log exceptions never block successful work', async () => {
  const fixture = fixtures(); const result = await updateDailyClsNews({ ...fixture, now: () => now, cacheDir: '/tmp/news-daily-fixture',
    log: () => { throw new Error('secret-log'); }, collector: async () => successfulReport() });
  assert.equal(result.runDate, runDate); assert.equal(result.status, 'succeeded');
});

test('daily CLS unexpected provider/database errors return safe independent failure results', async () => {
  for (const database of [true, false]) {
    const fixture = fixtures(); const result = await updateDailyClsNews({ ...fixture, runDate, now, cacheDir: '/tmp/news-daily-fixture',
      collector: async () => { throw Object.assign(new Error('postgres://password-secret@private-host'), database ? { code: 'DATABASE_ERROR' } : {}); } });
    assert.equal(result.status, 'failed'); assert.equal(result.errorCode, database ? 'database_error' : 'provider_error'); assert.doesNotMatch(JSON.stringify(result), /secret|private-host/);
  }
});

test('daily CLS retries clear only an uncommitted terminal page and preserve successful page caches', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'daily-cls-retry-'));
  try {
    const keywordKey = createHash('sha256').update('财联社').digest('hex').slice(0, 24), range = `${window.windowStart.replace(/[-:.]/g, '')}-${window.windowEnd.replace(/[-:.]/g, '')}`;
    const directory = join(cacheDir, 'daily', runDate, 'news', 'cls_web', `search-${keywordKey}`, range, 'pages');
    await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'page-0.json'), 'saved-page'); await writeFile(join(directory, 'page-1.json'), 'stale-terminal-page');
    const fixture = fixtures({ status: 'failed', errorCode: 'incomplete_window', summary: { nextPage: 1, stopReason: 'search_index_exhausted' } });
    const result = await updateDailyClsNews({ ...fixture, runDate, now, cacheDir, collector: async input => {
      assert.equal(input.resume, false); assert.equal(await readFile(join(directory, 'page-0.json'), 'utf8'), 'saved-page');
      await assert.rejects(readFile(join(directory, 'page-1.json')), { code: 'ENOENT' }); return successfulReport();
    } });
    assert.equal(result.status, 'succeeded');
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});

test('daily CLS database retries reuse an uncommitted cached page for idempotent insertion', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'daily-cls-db-retry-'));
  try {
    const keywordKey = createHash('sha256').update('财联社').digest('hex').slice(0, 24), range = `${window.windowStart.replace(/[-:.]/g, '')}-${window.windowEnd.replace(/[-:.]/g, '')}`;
    const path = join(cacheDir, 'daily', runDate, 'news', 'cls_web', `search-${keywordKey}`, range, 'pages', 'page-0.json');
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, 'retry-db-page');
    const fixture = fixtures({ status: 'failed', errorCode: 'database_error', summary: { nextPage: 0 } });
    const result = await updateDailyClsNews({ ...fixture, runDate, now, cacheDir, collector: async () => { assert.equal(await readFile(path, 'utf8'), 'retry-db-page'); return successfulReport(); } });
    assert.equal(result.status, 'succeeded');
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});

test('daily CLS integrates the real search collector offline and marks only a confirmed exact-day traversal succeeded', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'daily-cls-integration-')), fixture = fixtures(); let requests = 0;
  const articles = new Map(), statuses = [];
  const newsStore = { migrate: async () => {}, getSecurities: async () => [{ ticker: '002920.SZ', name: '德赛西威' }],
    saveArticles: async input => { for (const article of input.articles) articles.set(article.id, article); return { rowsCount: input.articles.length, matchedCount: input.links.length }; },
    setSourceStatus: async value => statuses.push(value) };
  const first = Date.parse(window.windowStart) / 1000;
  const make = (id, time) => ({ id, time, title: '德赛西威财联社报道', descr: '公开摘要', external_link: '', stocks: null });
  try {
    const result = await updateDailyClsNews({ ...fixture, newsStore, cacheDir, runDate, now, sleep: async () => {},
      fetchImpl: async () => { const data = requests++ === 0 ? [make(1, first + 100), make(2, first - 1)] : [make(3, first - 2)];
        return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ errno: 0, data: { depth: { total_num: 100000, data } } }) }; } });
    assert.equal(result.status, 'succeeded'); assert.equal(requests, 2); assert.equal(articles.size, 1); assert.equal(result.summary.runSaved, 1);
    assert.equal(result.summary.end, window.windowEnd); assert.equal(result.summary.rangeReachedStart, true); assert.equal(result.summary.coverageVerified, false);
    const repeat = await updateDailyClsNews({ ...fixture, newsStore, cacheDir, runDate, now, fetchImpl: async () => assert.fail('No repeat network after succeeded date') });
    assert.equal(repeat.status, 'already_completed'); assert.equal(statuses.at(-1).status, 'available');
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});

test('daily CLS page_limit retry resumes the exact frozen checkpoint and a second maxPages1 run reaches page1', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'daily-cls-page-budget-')), fixture = fixtures(), pages = [];
  const newsStore = { migrate: async () => {}, getSecurities: async () => [{ ticker: '002920.SZ', name: '德赛西威' }],
    saveArticles: async input => ({ rowsCount: input.articles.length, matchedCount: input.links.length }), setSourceStatus: async () => {} };
  const first = Date.parse(window.windowStart) / 1000;
  const make = (id, time) => ({ id, time, title: '德赛西威财联社报道', descr: '公开摘要', external_link: '', stocks: null });
  const fetchImpl = async (url, input) => {
    const page = JSON.parse(input.body).page; pages.push(page);
    const data = page === 0 ? [make(1, first + 100), make(2, first - 1)] : [make(3, first - 2)];
    return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify({ errno: 0, data: { depth: { total_num: 100000, data } } }) };
  };
  try {
    const firstRun = await updateDailyClsNews({ ...fixture, newsStore, cacheDir, runDate, now, maxPages: 1, sleep: async () => {}, fetchImpl });
    assert.equal(firstRun.status, 'partial'); assert.equal(firstRun.summary.stopReason, 'page_limit'); assert.equal(firstRun.summary.nextPage, 1);
    const secondRun = await updateDailyClsNews({ ...fixture, newsStore, cacheDir, runDate, now, maxPages: 1, sleep: async () => {}, fetchImpl });
    assert.deepEqual(pages, [0, 1]); assert.equal(secondRun.status, 'succeeded'); assert.equal(secondRun.summary.nextPage, 2); assert.equal(secondRun.summary.rangeReachedStart, true);
    assert.equal(secondRun.summary.start, window.windowStart); assert.equal(secondRun.summary.end, window.windowEnd); assert.equal(secondRun.summary.coverageVerified, false);
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});

test('daily CLS page-limit resume refuses a checkpoint with a different date window before provider calls', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'daily-cls-wrong-resume-'));
  try {
    const keywordKey = createHash('sha256').update('财联社').digest('hex').slice(0, 24), range = `${window.windowStart.replace(/[-:.]/g, '')}-${window.windowEnd.replace(/[-:.]/g, '')}`;
    const base = join(cacheDir, 'daily', runDate, 'news', 'cls_web', `search-${keywordKey}`);
    await mkdir(join(base, range), { recursive: true });
    await writeFile(join(base, 'latest.json'), JSON.stringify({ version: 1, rangeKey: range, searchType: 'depth', searchKeyword: '财联社' }));
    await writeFile(join(base, range, 'checkpoint.json'), JSON.stringify({ version: 1, sourceApi: 'cls_web', searchType: 'depth', searchKeyword: '财联社',
      start: window.windowStart, end: '2026-10-18T15:59:59.000Z', nextPage: 1, status: 'partial', stopReason: 'page_limit', rangeReachedStart: false, coverageVerified: false, historicalPointInTime: false }));
    const fixture = fixtures({ status: 'failed', errorCode: 'incomplete_window', summary: { stopReason: 'page_limit', nextPage: 1 } });
    const result = await updateDailyClsNews({ ...fixture, cacheDir, runDate, now, collector: async () => assert.fail('Invalid frozen range must not fetch') });
    assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'validation_error'); assert.equal(fixture.state.finalized.length, 0);
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});
