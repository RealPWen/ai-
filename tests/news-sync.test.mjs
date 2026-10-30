import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createNewsMatcher } from '../backend/market-data/news-matching.mjs';
import { newsRange, partitionNewsRange, normalizeNewsRows, syncNews, probeNewsSources, shanghaiNewsTime, createNewsClient } from '../backend/market-data/news-sync.mjs';

const now = '2026-10-15T05:00:00Z', start = '2026-10-13T16:00:00.000Z', end = '2026-10-14T16:00:00.000Z';
const row = (changes = {}) => ({ title: '赛力斯发布经营信息', content: '赛力斯（601127.SH）公告。', pub_time: '2026-10-14 10:00:00', src: '新浪财经', ...changes });
async function fixture(t, changes = {}) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'news-sync-')); t.after(() => rm(cacheDir, { force: true, recursive: true }));
  const saved = [], failed = [], queries = [], completed = new Set();
  const store = { async migrate() {}, async getSecurities() { return [{ ticker: '601127.SH', name: '赛力斯' }]; }, async getCompletedWindows() { return completed; },
    async saveWindow(value) { saved.push(value); completed.add(`${value.start}|${value.end}`); }, async markFailedWindow(value) { failed.push(value); }, async summary() { return { articleCount: saved.reduce((n, value) => n + value.articles.length, 0) }; } };
  const client = { async query(api, params, fields) { queries.push({ api, params, fields }); return params.offset ? [] : [row()]; } };
  return { cacheDir, saved, failed, queries, completed, store, client, now, startDate: '20261014', endDate: '20261014', ...changes };
}

test('three-month window follows Shanghai calendar months, clips month end and excludes future end dates', () => {
  assert.deepEqual(newsRange({ now: '2026-05-31T02:00:00Z' }), { start: '2026-02-27T16:00:00.000Z', end: '2026-05-31T02:00:00.000Z' });
  assert.deepEqual(newsRange({ startDate: '20261014', endDate: '20261014', now }), { start, end });
  assert.equal(newsRange({ startDate: '20261014', endDate: '20261020', now }).end, '2026-10-15T05:00:00.000Z');
  assert.throws(() => newsRange({ startDate: '20260230', now }), { kind: 'validation' });
  assert.throws(() => newsRange({ startDate: '20261017', now }), { kind: 'validation' });
  assert.throws(() => newsRange({ startDate: '2024-01-01', now }), { kind: 'validation' });
});

test('day partitions use Shanghai midnight, newest first, and cover a partial last day', () => {
  const range = newsRange({ startDate: '20261013', now });
  const windows = partitionNewsRange(range.start, range.end);
  assert.equal(windows.length, 3); assert.equal(windows[0].end, range.end); assert.equal(windows.at(-1).start, range.start);
  assert.equal(windows[0].start, '2026-10-14T16:00:00.000Z');
  for (let index = 0; index < windows.length - 1; index++) assert.equal(windows[index].start, windows[index + 1].end);
});

test('raw news deduplicates stable source/time/title identity and keeps corrected content without invented URLs', () => {
  const options = { start, end, sourceApi: 'major_news', fetchedAt: now };
  const normalized = normalizeNewsRows([row(), row({ content: '更正正文' })], options);
  assert.equal(normalized.length, 1); assert.match(normalized[0].id, /^[a-f0-9]{64}$/); assert.equal(normalized[0].content, '更正正文');
  assert.equal(normalized[0].url, null); assert.equal(normalized[0].sourceName, '新浪财经');
  assert.equal(normalizeNewsRows([row(), row({ src: '财联社' })], options).length, 2);
  assert.throws(() => normalizeNewsRows([row({ pub_time: '2026-10-15 00:00:00' })], options), { kind: 'validation' });
  assert.throws(() => normalizeNewsRows([row({ pub_time: '2026-02-30 00:00:00' })], options), { kind: 'validation' });
  assert.throws(() => normalizeNewsRows([row({ title: '' })], options), { kind: 'validation' });
});

test('matcher finds explicit company/full names and exchange codes, but excludes random numbers and short generic aliases', () => {
  const match = createNewsMatcher([
    { ticker: '601127.SH', name: '赛力斯', fullname: '赛力斯集团股份有限公司' },
    { ticker: '600399.SH', name: '抚顺特钢' }, { ticker: '000656.SZ', name: '*ST金科' },
    { ticker: '002920.SZ', name: '德赛西威' }, { ticker: '001001.SZ', name: 'ABC' },
  ]);
  const matches = match({ id: 'a', title: '赛力斯集团股份有限公司公告', content: '股票代码：600399，SZ002920。金科行业产量601127吨。' });
  assert.deepEqual(matches.map(item => item.ticker), ['002920.SZ', '600399.SH', '601127.SH']);
  assert.equal(matches.find(item => item.ticker === '601127.SH').matchType, 'fullname');
  assert.equal(match({ id: 'b', title: '关注 600399 件产品、金科发展', content: 'XABCX，ABC123。' }).length, 0);
  assert.equal(match({ id: 'c', title: '601127.sh动态，*ST金科公告', content: 'ABC。' }).length, 3);
  assert.equal(match({ id: 'd', title: '普通新闻', content: '<script>赛力斯</script><a href="https://example.com/抚顺特钢">其他资料</a>' }).length, 0);
});

test('complete leaf commits articles and explicit ticker links; raw gzip allows later import and safe resume', async t => {
  const f = await fixture(t), downloaded = await syncNews({ ...f, mode: 'download', store: null });
  assert.equal(downloaded.status, 'completed'); assert.equal(f.saved.length, 0); assert.equal(f.queries[0].params.end_date, '2026-10-14 23:59:59');
  assert.equal(Object.hasOwn(f.queries[0].params, 'offset'), false); assert.equal(Object.hasOwn(f.queries[0].params, 'src'), false);
  const directory = join(f.cacheDir, 'news', 'major_news', 'all'), cache = (await readdir(directory)).find(name => name.endsWith('.json.gz'));
  const raw = JSON.parse(gunzipSync(await readFile(join(directory, cache)))); assert.equal(raw.complete, true); assert.equal(raw.start, start); assert.equal(raw.rows.length, 1);
  const imported = await syncNews({ ...f, mode: 'import', client: null });
  assert.equal(imported.status, 'completed'); assert.equal(f.saved.length, 1); assert.equal(f.saved[0].links[0].ticker, '601127.SH');
  assert.equal(f.saved[0].articles[0].fetchedAt, raw.fetchedAt);
  const resumed = await syncNews({ ...f, client: { async query() { throw new Error('should not call'); } } });
  assert.equal(resumed.status, 'completed'); assert.equal(resumed.skippedWindows, 1);
});

test('a saturated daily response recursively splits seconds without gaps, overlaps or cap-based completion', async t => {
  const f = await fixture(t, { startDate: '2026-10-14T00:00:00+08:00', endDate: '2026-10-14T00:00:04+08:00', saturationLimit: 2 });
  f.client.query = async (api, params) => {
    f.queries.push({ api, params });
    if (params.offset) return [];
    const from = Date.parse(`${params.start_date.replace(' ', 'T')}+08:00`), until = Date.parse(`${params.end_date.replace(' ', 'T')}+08:00`);
    return Array.from({ length: (until - from) / 1000 + 1 }, (_, index) => row({ title: `赛力斯 ${from + index * 1000}`, pub_time: shanghaiNewsTime(from + index * 1000) }));
  };
  const result = await syncNews(f); assert.equal(result.status, 'completed'); assert.equal(result.requests, 11); assert.equal(f.saved.length, 4);
  const windows = [...f.saved].sort((a, b) => a.start.localeCompare(b.start));
  assert.equal(windows[0].start, '2026-10-13T16:00:00.000Z'); assert.equal(windows.at(-1).end, '2026-10-13T16:00:04.000Z');
  for (let index = 1; index < windows.length; index++) assert.equal(windows[index].start, windows[index - 1].end);
  const resumed = await syncNews({ ...f, client: { async query() { throw new Error('should not query cached split parents'); } } });
  assert.equal(resumed.status, 'completed'); assert.equal(resumed.skippedWindows, 4); assert.equal(resumed.requests, 0);
});

test('saturation inside a single second is incomplete, never written as a completed window', async t => {
  const f = await fixture(t, { startDate: '2026-10-14T10:00:00+08:00', endDate: '2026-10-14T10:00:01+08:00', saturationLimit: 2 });
  f.client.query = async () => [row(), row({ title: '第二条' })];
  const result = await syncNews(f); assert.equal(result.status, 'incomplete'); assert.equal(result.failedWindows[0].kind, 'incomplete'); assert.equal(f.saved.length, 0); assert.equal(f.failed.length, 1);
});

test('bad cache provenance, missing raw import and out-of-window provider rows cannot masquerade as complete', async t => {
  const f = await fixture(t); assert.equal((await syncNews({ ...f, mode: 'import', client: null })).status, 'incomplete');
  assert.equal((await syncNews({ ...f, mode: 'download', store: null })).status, 'completed');
  const directory = join(f.cacheDir, 'news', 'major_news', 'all'), file = (await readdir(directory)).find(name => name.endsWith('.json.gz'));
  const raw = JSON.parse(gunzipSync(await readFile(join(directory, file)))); raw.sourceApi = 'news'; await writeFile(join(directory, file), gzipSync(JSON.stringify(raw)));
  assert.equal((await syncNews({ ...f, mode: 'import', client: null })).status, 'incomplete'); assert.equal(f.saved.length, 0);
  const refreshed = await syncNews({ ...f, refresh: true, client: { async query() { return [row({ pub_time: '2026-10-15 00:00:00' })]; } } });
  assert.equal(refreshed.status, 'incomplete'); assert.equal(f.saved.length, 0);
});

test('permission and network failures preserve fixed error classifications and do not leak secrets', async t => {
  for (const kind of ['permission', 'authentication', 'rate_limit', 'network']) {
    const f = await fixture(t); f.client.query = async () => { throw Object.assign(new Error('token=secret'), { kind }); };
    const result = await syncNews(f); assert.equal(result.status, 'incomplete'); assert.equal(result.blockedBy, kind); assert.equal(result.failedWindows.length, 1); assert.equal(f.saved.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /secret|token=/);
  }
});

test('availability probe records unavailable news and announcement permissions while leaving major news usable', async () => {
  const results = await probeNewsSources({ async query(api) { if (api !== 'major_news') throw Object.assign(new Error('secret'), { kind: 'permission' }); return [row()]; } }, { now });
  assert.deepEqual(results.map(item => [item.sourceApi, item.status]), [['major_news', 'available'], ['news', 'permission_denied'], ['anns_d', 'permission_denied']]);
  assert.doesNotMatch(JSON.stringify(results), /secret/);
});

test('a lower provider row cap is detected by a one-row overflow probe instead of silently completing the truncated window', async t => {
  const f = await fixture(t, { startDate: '2026-10-14T00:00:00+08:00', endDate: '2026-10-14T00:00:04+08:00', saturationLimit: 2 });
  f.client.query = async (_, params) => {
    const from = Date.parse(`${params.start_date.replace(' ', 'T')}+08:00`), until = Date.parse(`${params.end_date.replace(' ', 'T')}+08:00`);
    const all = Array.from({ length: (until - from) / 1000 + 1 }, (_, index) => row({ title: `赛力斯 ${from + index * 1000}`, pub_time: shanghaiNewsTime(from + index * 1000) }));
    return all.slice(params.offset ?? 0, (params.offset ?? 0) + 1);
  };
  const result = await syncNews(f); assert.equal(result.status, 'completed'); assert.equal(f.saved.length, 4); assert.equal(result.rows, 4);
  assert.equal((await syncNews({ ...f, mode: 'import', client: null })).status, 'completed');
});

test('news client can recover within an explicitly configured finite retry budget', async () => {
  let clock = 0, calls = 0; const slept = [], events = [];
  const client = createNewsClient({ async query() {
    calls++; if (calls <= 2) throw Object.assign(new Error('secret'), { kind: 'rate_limit' });
    if (calls <= 4) throw Object.assign(new Error('secret'), { kind: 'network' }); return [row()];
  } }, { maxRetries: 4, intervalMs: 0, now: () => clock, sleep: async ms => { slept.push(ms); clock += ms; }, log: entry => events.push(entry) });
  assert.equal((await client.query('major_news', { start_date: '2026-10-14 00:00:00', end_date: '2026-10-14 23:59:59' })).length, 1);
  assert.deepEqual(slept, [3600000, 3600000, 5000, 10000]); assert.equal(calls, 5);
  assert.deepEqual(client.stats(), { attempts: 5, rateLimitRetries: 2, networkRetries: 2 });
  assert.ok(events.every(event => Number.isFinite(Date.parse(event.retryAt)) && event.window.start === '2026-10-14 00:00:00'));
  assert.doesNotMatch(JSON.stringify(events), /secret/);
});

test('default retry budget stops persistent rate or network failures after three retries with safe upstream codes', async () => {
  for (const kind of ['rate_limit', 'network']) {
    let clock = 0, calls = 0; const slept = [], events = [];
    const client = createNewsClient({ async query() { calls++; throw Object.assign(new Error('token=secret'), { kind, code: -2002 }); } }, {
      intervalMs: 0, now: () => clock, sleep: async ms => { slept.push(ms); clock += ms; }, log: event => events.push(event),
    });
    await assert.rejects(client.query('major_news'), { kind, code: -2002 });
    assert.equal(calls, 4); assert.equal(events.length, 3);
    assert.deepEqual(slept, kind === 'rate_limit' ? [3600000, 3600000, 3600000] : [5000, 10000, 20000]);
    assert.ok(events.every(event => event.upstreamCode === -2002));
    assert.doesNotMatch(JSON.stringify(events), /secret|token=/);
  }
});

test('zero retries is immediate and unsafe diagnostics or infinite retry settings are rejected', async () => {
  const underlying = { async query() { throw Object.assign(new Error('secret'), { kind: 'rate_limit', code: 'token=secret' }); } };
  for (const maxRetries of [Infinity, -1, 11, 0.5, NaN]) assert.throws(() => createNewsClient(underlying, { maxRetries }), { kind: 'validation' });
  await assert.rejects(createNewsClient(underlying, { maxRetries: 0, sleep: async () => assert.fail('zero budget must not wait') }).query('major_news'), { kind: 'rate_limit' });
  const events = [];
  const client = createNewsClient(underlying, { intervalMs: 0, maxRetries: 1, sleep: async () => {}, log: event => events.push(event) });
  await assert.rejects(client.query('major_news'), { kind: 'rate_limit' });
  assert.equal(events.length, 1); assert.equal(Object.hasOwn(events[0], 'upstreamCode'), false);
  assert.doesNotMatch(JSON.stringify(events), /secret|token=/);
});

test('exhausting the retry budget persists incomplete progress and resumes past already completed cached windows', async t => {
  const f = await fixture(t, { startDate: '20261013' });
  let clock = 0, attempts = 0; const logs = [];
  const client = createNewsClient({ async query(_, params) {
    attempts++;
    if (params.start_date.startsWith('2026-10-13')) throw Object.assign(new Error('token=secret'), { kind: 'rate_limit', code: 40203 });
    return params.offset ? [] : [row()];
  } }, { now: () => clock, sleep: async ms => { clock += ms; }, log: event => logs.push(event) });
  const failed = await syncNews({ ...f, client, log: event => logs.push(event) });
  assert.equal(failed.status, 'incomplete'); assert.equal(failed.blockedBy, 'rate_limit'); assert.equal(failed.upstreamCode, 40203);
  assert.equal(failed.completedDays, 1); assert.equal(failed.provider.attempts, 6); assert.equal(attempts, 6);
  assert.equal(f.saved.length, 1); assert.equal(f.failed.length, 1);
  assert.equal(failed.failedWindows[0].upstreamCode, 40203);
  assert.ok(logs.filter(event => event.type === 'news_window_failed' || event.type === 'news_failed').every(event => event.upstreamCode === 40203));
  const directory = join(f.cacheDir, 'news', 'major_news', 'all');
  const statusFile = (await readdir(directory)).find(name => name.startsWith('status-'));
  const persisted = JSON.parse(await readFile(join(directory, statusFile), 'utf8'));
  assert.equal(persisted.status, 'incomplete'); assert.equal(persisted.provider.rateLimitRetries, 3);
  const resumedQueries = [];
  const resumed = await syncNews({ ...f, client: { async query(_, params) {
    resumedQueries.push(params);
    return params.offset ? [] : [row({ pub_time: '2026-10-13 10:00:00' })];
  } } });
  assert.equal(resumed.status, 'completed'); assert.equal(resumed.completedDays, 2); assert.equal(resumed.skippedWindows, 1);
  assert.equal(resumedQueries.length, 2); assert.ok(resumedQueries.every(params => params.start_date.startsWith('2026-10-13')));
  assert.equal(f.saved.length, 2); assert.doesNotMatch(JSON.stringify({ failed, persisted, logs }), /secret|token=/);
});

test('news limiter serializes concurrent requests with the configured 122-second cadence, without changing the underlying client', async () => {
  let clock = 0; const started = [];
  const client = createNewsClient({ async query(_, params) { started.push([clock, params.offset]); return []; } }, { now: () => clock, sleep: async ms => { clock += ms; } });
  await Promise.all([0, 1, 2].map(offset => client.query('major_news', { offset })));
  assert.deepEqual(started, [[0, 0], [122000, 1], [244000, 2]]);
  await assert.rejects(createNewsClient({ async query() { throw Object.assign(new Error('secret'), { kind: 'permission' }); } }, { sleep: async () => assert.fail('permission must not retry') }).query('major_news'), { kind: 'permission' });
});
