import test from 'node:test';
import assert from 'node:assert/strict';
import { createResearchServer } from '../backend/app.mjs';
import { createNewsReadService } from '../backend/market-data/news-read-service.mjs';

async function fixture(t, newsService) {
  let externalCalls = 0;
  const forbidden = () => { externalCalls++; throw new Error('unexpected external request'); };
  const server = createResearchServer({ newsService, health: { status: 'ok' }, service: { get: forbidden, generate: forbidden },
    auth: { status: forbidden }, chatClient: { probe: forbidden } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { base: `http://127.0.0.1:${server.address().port}`, get externalCalls() { return externalCalls; } };
}

test('news API forwards company, date, category and pagination without authentication or inference', async t => {
  const calls = [], data = { ticker: '002920.SZ', asOf: '2026-10-15', category: '公司', items: [], total: 0 };
  const f = await fixture(t, { get: async input => { calls.push(input); return data; } });
  const response = await fetch(`${f.base}/api/events?ticker=002920.SZ&asOf=2026-10-15&category=${encodeURIComponent('公司')}&limit=20&offset=40`, {
    headers: { Origin: 'http://127.0.0.1:8765' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:8765');
  assert.deepEqual(await response.json(), { data });
  assert.deepEqual(calls, [{ ticker: '002920.SZ', asOf: '2026-10-15', category: '公司', limit: '20', offset: '40' }]);
  assert.equal(f.externalCalls, 0);
});

test('news API preflight never queries storage and missing configuration returns safe 503', async t => {
  const f = await fixture(t);
  const preflight = await fetch(`${f.base}/api/events`, { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:8765' } });
  assert.equal(preflight.status, 204);
  const response = await fetch(`${f.base}/api/events?ticker=002920.SZ`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'NEWS_DATABASE_NOT_CONFIGURED');
  assert.equal(f.externalCalls, 0);
});

test('news API rejects invalid inputs before SQL and hides database internals on failure', async t => {
  let sqlCalls = 0;
  const newsService = createNewsReadService({ now: () => new Date('2026-10-15T03:00:00Z'), pool: {
    async query() { sqlCalls++; throw new Error('postgresql://user:secret@localhost/private_table'); },
  } });
  const f = await fixture(t, newsService);
  for (const query of ['ticker=invalid', 'ticker=00700.HK', 'ticker=002920.SZ&asOf=2026-10-16', 'ticker=002920.SZ&limit=51', 'ticker=002920.SZ&offset=-1', 'ticker=002920.SZ&category=invalid']) {
    const response = await fetch(`${f.base}/api/events?${query}`);
    assert.equal(response.status, 400);
  }
  assert.equal(sqlCalls, 0);
  const response = await fetch(`${f.base}/api/events?ticker=002920.SZ`);
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.equal(JSON.parse(body).error.code, 'NEWS_DATABASE_UNAVAILABLE');
  assert.doesNotMatch(body, /secret|postgresql|private_table/);
  assert.equal(f.externalCalls, 0);
});
