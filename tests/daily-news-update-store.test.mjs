import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createDailyNewsUpdateStore, DAILY_NEWS_UPDATE_LOCK_KEYS } from '../backend/market-data/daily-news-update-store.mjs';

const window = { runDate: '2026-10-19', windowStart: '2026-10-17T16:00:00.000Z', windowEnd: '2026-10-18T16:00:00.000Z' };
const summary = { searchType: 'depth', searchKeyword: '财联社', start: window.windowStart, end: window.windowEnd,
  rangeReachedStart: true, coverageVerified: false, historicalPointInTime: false, stopReason: 'range_start_confirmed' };
function poolFixture({ locked = true, unlock = true, failOn, run = { ...window, status: 'running' } } = {}) {
  const calls = [], releases = [], clients = [];
  return { calls, releases, clients, ended: 0, async connect() {
    const client = new EventEmitter();
    client.query = async (sql, values) => { calls.push({ sql, values }); if (failOn?.(sql)) throw Object.assign(new Error('postgres://password-secret@private-host'), { code: '08006' });
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: unlock }] };
      if (sql.startsWith('SELECT') && sql.includes('daily_news_update_runs')) return { rows: run ? [run] : [] };
      return { rows: [], rowCount: 1 }; };
    client.release = error => releases.push(error); clients.push(client); return client;
  }, async end() { this.ended++; } };
}

test('daily news schema is additive, fixed-scope, prior-day only and never deletes any news', async () => {
  const pool = poolFixture(); await createDailyNewsUpdateStore({ pool }).migrate();
  const sql = pool.calls[1].sql; assert.match(sql, /CREATE TABLE IF NOT EXISTS market_data\.daily_news_update_runs/); assert.match(sql, /run_date date PRIMARY KEY/);
  assert.match(sql, /Asia\/Shanghai/); assert.match(sql, /24 hours/); assert.match(sql, /search_keyword = '财联社'/); assert.doesNotMatch(sql, /\b(?:DELETE|DROP|TRUNCATE)\b/);
  assert.equal(pool.calls[0].sql, 'BEGIN'); assert.equal(pool.calls.at(-1).sql, 'COMMIT');
});

test('daily news updater uses an independent session lock, releases it and rejects stale scopes', async () => {
  const pool = poolFixture(), store = createDailyNewsUpdateStore({ pool }); let scope;
  const result = await store.withLock(async input => { scope = input; return { status: 'example' }; });
  assert.deepEqual(result, { status: 'example' }); assert.deepEqual(pool.calls[0].values, DAILY_NEWS_UPDATE_LOCK_KEYS); assert.deepEqual(DAILY_NEWS_UPDATE_LOCK_KEYS, [20261019, 602]);
  assert.match(pool.calls.at(-1).sql, /pg_advisory_unlock/); assert.equal(pool.releases.length, 1);
  await assert.rejects(scope.getRun(window.runDate), { code: 'VALIDATION_ERROR' });
});

test('daily news contention returns busy without running collection or releasing another process lock', async () => {
  const pool = poolFixture({ locked: false }); let called = false;
  assert.deepEqual(await createDailyNewsUpdateStore({ pool }).withLock(async () => { called = true; }), { status: 'busy' }); assert.equal(called, false); assert.equal(pool.calls.length, 1);
});

test('daily news finalization validates exact range and safe traversal outcome in a locked transaction', async () => {
  const pool = poolFixture(), store = createDailyNewsUpdateStore({ pool });
  const result = await store.withLock(scope => scope.finalize({ ...window, summary })); assert.equal(result.status, 'succeeded');
  assert.ok(pool.calls.some(call => call.sql.includes('FOR UPDATE'))); assert.ok(pool.calls.some(call => call.sql.includes("status = 'succeeded'"))); assert.doesNotMatch(pool.calls.map(call => call.sql).join('\n'), /\bDELETE\b/);
  for (const changes of [{ rangeReachedStart: false }, { coverageVerified: true }, { stopReason: 'permission' }, { end: '2026-10-18T15:59:59.000Z' }]) {
    await assert.rejects(createDailyNewsUpdateStore({ pool: poolFixture() }).withLock(scope => scope.finalize({ ...window, summary: { ...summary, ...changes } })), { code: 'VALIDATION_ERROR' });
  }
});

test('daily news retry begin and fail preserve success, parameterize dates and sanitize error codes', async () => {
  const pool = poolFixture(); await createDailyNewsUpdateStore({ pool }).withLock(async scope => {
    await scope.beginRun(window); await scope.failRun({ runDate: window.runDate, errorCode: 'password-secret', summary: {} });
  });
  const begin = pool.calls.find(call => call.sql.startsWith('INSERT')); assert.match(begin.sql, /attempt_count .* \+ 1/); assert.match(begin.sql, /status <> 'succeeded'/); assert.equal(begin.values[0], window.runDate);
  const fail = pool.calls.find(call => call.sql.startsWith('UPDATE')); assert.equal(fail.values[1], 'provider_error'); assert.match(fail.sql, /status <> 'succeeded'/);
});

test('daily news database lock/unlock failures hide credentials and destroy uncertain sessions', async () => {
  for (const condition of [sql => sql.includes('pg_try_advisory_lock'), sql => sql.includes('pg_advisory_unlock')]) {
    const pool = poolFixture({ failOn: condition });
    await assert.rejects(createDailyNewsUpdateStore({ pool }).withLock(async () => ({})), error => error.code === 'DATABASE_ERROR' && error.sqlState === '08006' && !/secret|private-host/.test(error.message));
    assert.equal(pool.releases[0].code, 'DATABASE_ERROR');
  }
  const pool = poolFixture({ unlock: false }); await assert.rejects(createDailyNewsUpdateStore({ pool }).withLock(async () => ({})), { code: 'DATABASE_ERROR' }); assert.equal(pool.releases[0].code, 'DATABASE_ERROR');
});

test('daily news session errors during collection block later database writes and discard the failed connection', async () => {
  const pool = poolFixture(); let caught;
  await assert.rejects(createDailyNewsUpdateStore({ pool }).withLock(async scope => {
    pool.clients[0].emit('error', new Error('password-secret'));
    try { await scope.failRun({ runDate: window.runDate }); } catch (error) { caught = error; }
    return {};
  }), { code: 'DATABASE_ERROR' });
  assert.equal(caught.code, 'DATABASE_ERROR'); assert.doesNotMatch(caught.message, /secret/); assert.equal(pool.releases[0].code, 'DATABASE_ERROR');
  assert.equal(pool.clients[0].listenerCount('error'), 0);
});
