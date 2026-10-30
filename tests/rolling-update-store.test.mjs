import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRollingUpdateStore, ROLLING_UPDATE_APIS, ROLLING_UPDATE_LOCK_KEYS, HK_ROLLING_UPDATE_LOCK_KEYS } from '../backend/market-data/rolling-update-store.mjs';

const options = { runDate: '20261015', windowStart: '20251015', windowEnd: '20261014',
  priceHistoryExpectedDates: ['20251014', '20261013', '20261014'] };
const running = { runDate: '2026-10-15', windowStart: '2025-10-15', windowEnd: '2026-10-14', status: 'running', summary: {} };
const expectedDates = ['20261013', '20261014'];

function mockPool({ locked = true, run = running, completed = Object.fromEntries(ROLLING_UPDATE_APIS.map(api => [api,
  ['daily', 'adj_factor'].includes(api) ? options.priceHistoryExpectedDates : expectedDates])), failOn, unlock = true } = {}) {
  const calls = [], releases = [];
  return { calls, releases, ended: 0,
    async connect() {
      return { async query(sql, values) {
        calls.push({ sql, values });
        if (failOn?.(sql)) throw Object.assign(new Error('postgres://password-secret@private-host'), { code: '08006' });
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked }] };
        if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: unlock }] };
        if (sql.startsWith('SELECT') && sql.includes('daily_update_runs')) return { rows: run ? [run] : [] };
        if (sql.includes('FROM market_data.sync_days') && sql.startsWith('SELECT')) return { rows: (completed[values[0]] ?? []).map(trade_date => ({ trade_date })) };
        if (sql.startsWith('INSERT INTO market_data.daily_update_runs') || sql.startsWith('UPDATE market_data.daily_update_runs')) return { rows: [] };
        return { rows: [], rowCount: 7 };
      }, release(error) { releases.push(error); } };
    },
    async end() { this.ended++; },
  };
}

test('rolling schema creates only an additive daily run ledger with one outcome per local date', async () => {
  const pool = mockPool(); await createRollingUpdateStore({ pool }).migrate();
  assert.equal(pool.calls[0].sql, 'BEGIN');
  const sql = pool.calls[1].sql;
  assert.match(sql, /CREATE TABLE IF NOT EXISTS market_data\.daily_update_runs/);
  assert.match(sql, /run_date date PRIMARY KEY/); assert.match(sql, /window_end < run_date/);
  assert.match(sql, /'running', 'succeeded', 'failed'/); assert.match(sql, /jsonb_typeof\(summary\) = 'object'/);
  assert.doesNotMatch(sql, /\b(?:DELETE|DROP|TRUNCATE)\b/);
  assert.equal(pool.calls.at(-1).sql, 'COMMIT'); assert.equal(pool.releases.length, 1);
});

test('two fixed PostgreSQL session lock keys protect the full operation, release on success, and reject stale scope use', async () => {
  const pool = mockPool(), store = createRollingUpdateStore({ pool }); let capturedScope;
  const result = await store.withLock(async scope => { capturedScope = scope; return { status: 'example' }; });
  assert.deepEqual(result, { status: 'example' }); assert.deepEqual(pool.calls[0].values, ROLLING_UPDATE_LOCK_KEYS);
  assert.match(pool.calls[0].sql, /pg_try_advisory_lock/); assert.match(pool.calls.at(-1).sql, /pg_advisory_unlock/);
  assert.deepEqual(pool.calls.at(-1).values, pool.calls[0].values); assert.equal(pool.releases.length, 1);
  const count = pool.calls.length;
  await assert.rejects(capturedScope.getRun(options.runDate), { code: 'VALIDATION_ERROR' });
  assert.equal(pool.calls.length, count);
});

test('another updater holding the session lock returns busy without invoking or unlocking its work', async () => {
  const pool = mockPool({ locked: false }); let called = false;
  assert.deepEqual(await createRollingUpdateStore({ pool }).withLock(async () => { called = true; }), { status: 'busy' });
  assert.equal(called, false); assert.equal(pool.calls.length, 1); assert.equal(pool.releases.length, 1);
});

test('operation failure releases the lock while preserving the original safe error', async () => {
  const pool = mockPool(), original = Object.assign(new Error('expected'), { code: 'EXPECTED' });
  await assert.rejects(createRollingUpdateStore({ pool }).withLock(async () => { throw original; }), error => error === original);
  assert.match(pool.calls.at(-1).sql, /pg_advisory_unlock/); assert.equal(pool.releases.length, 1);
});

test('connection/lock failures conceal DSN and discard uncertain locked sessions', async () => {
  for (const condition of [sql => sql.includes('pg_try_advisory_lock'), sql => sql.includes('pg_advisory_unlock')]) {
    const pool = mockPool({ failOn: condition });
    await assert.rejects(createRollingUpdateStore({ pool }).withLock(async () => ({})), error => error.code === 'DATABASE_ERROR' && error.sqlState === '08006' && !/secret|private-host/.test(error.message));
    assert.equal(pool.releases.length, 1); assert.equal(pool.releases[0].code, 'DATABASE_ERROR');
  }
  const pool = mockPool({ unlock: false });
  await assert.rejects(createRollingUpdateStore({ pool }).withLock(async () => ({})), { code: 'DATABASE_ERROR' });
  assert.equal(pool.releases[0].code, 'DATABASE_ERROR');
});

function eventPool() {
  const pool = mockPool(), connect = pool.connect.bind(pool); pool.clients = [];
  pool.connect = async () => {
    const source = await connect(), client = Object.assign(new EventEmitter(), source);
    pool.clients.push(client); return client;
  };
  return pool;
}

test('checked-out lock connection errors during network waits are handled, invalidate scope and discard the lost session', async () => {
  const pool = eventPool(), store = createRollingUpdateStore({ pool });
  await assert.rejects(store.withLock(async scope => {
    const client = pool.clients[0]; assert.equal(client.listenerCount('error'), 1);
    assert.doesNotThrow(() => client.emit('error', new Error('postgres://private-password@host')));
    await assert.rejects(scope.getRun(options.runDate), error => error.code === 'DATABASE_ERROR' && !/private-password|host/.test(error.message));
    // Catching the query error inside a collector must not turn a lost lock into
    // successful completion of the enclosing operation.
    return { status: 'succeeded' };
  }), { code: 'DATABASE_ERROR' });
  assert.equal(pool.calls.length, 1); assert.equal(pool.releases[0].code, 'DATABASE_ERROR');
  assert.equal(pool.clients[0].listenerCount('error'), 0);
});

test('lock client error listener is removed after normal release and is bounded per invocation', async () => {
  const pool = eventPool(), store = createRollingUpdateStore({ pool });
  for (let index = 0; index < 3; index++) {
    await store.withLock(async () => { assert.equal(pool.clients[index].listenerCount('error'), 1); });
    assert.equal(pool.clients[index].listenerCount('error'), 0);
  }
  assert.equal(pool.releases.length, 3);
});

test('completed days are read independently for each API and exclude failed/empty market days', async () => {
  const pool = mockPool(), store = createRollingUpdateStore({ pool });
  await store.withLock(async scope => {
    assert.deepEqual(await scope.getCompletedDates({ apiName: 'daily_basic', startDate: options.windowStart, endDate: options.windowEnd }), new Set(expectedDates));
  });
  const query = pool.calls.find(call => call.sql.includes('FROM market_data.sync_days'));
  assert.deepEqual(query.values, ['daily_basic', '2025-10-15', '2026-10-14']);
  assert.match(query.sql, /market = 'A'/); assert.match(query.sql, /status = 'completed' AND rows_count > 0/);
  assert.match(query.sql, /EXISTS \(SELECT 1 FROM market_data\.daily_valuations AS observations/);
  assert.match(query.sql, /observations\.trade_date = days\.trade_date AND observations\.market = 'A'/);
});

test('retry begin resets failed or interrupted runs and requires explicit reopening for success', async () => {
  const pool = mockPool(), store = createRollingUpdateStore({ pool });
  await store.withLock(async scope => {
    assert.deepEqual(await scope.beginRun(options), running);
    await scope.failRun({ runDate: options.runDate, errorCode: 'postgres://raw-secret' });
    await scope.failRun({ runDate: options.runDate, errorCode: 'INCOMPLETE_WINDOW' });
  });
  const begin = pool.calls.find(call => call.sql.startsWith('INSERT INTO market_data.daily_update_runs'));
  assert.deepEqual(begin.values, ['2026-10-15', '2025-10-15', '2026-10-14', false]);
  assert.match(begin.sql, /WHERE market_data.daily_update_runs.status <> 'succeeded' OR \$4::boolean/);
  assert.match(begin.sql, /status = 'running', summary = '\{\}'::jsonb/);
  assert.match(begin.sql, /finished_at = NULL/);
  const failures = pool.calls.filter(call => call.sql.startsWith('UPDATE market_data.daily_update_runs'));
  assert.equal(failures[0].values[1], 'unknown_error'); assert.equal(failures[1].values[1], 'incomplete_window');
  assert.ok(failures.every(call => /status <> 'succeeded'/.test(call.sql)));
});

test('legacy success can reopen under the existing market session lock to backfill the price buffer', async () => {
  const pool = mockPool({ run: { ...running, status: 'succeeded' } });
  await createRollingUpdateStore({ pool }).withLock(scope => scope.beginRun({ ...options, reopen: true }));
  const begin = pool.calls.find(call => call.sql.startsWith('INSERT INTO market_data.daily_update_runs'));
  assert.deepEqual(begin.values, ['2026-10-15', '2025-10-15', '2026-10-14', true]);
  assert.match(pool.calls[0].sql, /pg_try_advisory_lock/);
});

test('finalization guards every API/day before retention and commits success together with all deletions', async () => {
  const pool = mockPool(), store = createRollingUpdateStore({ pool });
  const result = await store.withLock(scope => scope.finalize({ ...options, expectedDates: new Set(expectedDates), summary: { downloadedDays: 1 } }));
  assert.equal(result.status, 'succeeded'); assert.equal(result.runDate, '2026-10-15');
  assert.equal(result.downloadedDays, 1); assert.deepEqual(result.deleted, { daily_prices: 7, daily_valuations: 7, stock_adj_factors: 7, sw_index_daily: 7, sync_days: 14 });
  const calls = pool.calls, firstDelete = calls.findIndex(call => call.sql.startsWith('DELETE'));
  assert.equal(calls.filter(call => call.sql.startsWith('SELECT') && call.sql.includes('FROM market_data.sync_days')).length, 4);
  const coverage = calls.filter(call => call.sql.startsWith('SELECT') && call.sql.includes('FROM market_data.sync_days'));
  for (const table of ['daily_prices', 'daily_valuations', 'stock_adj_factors', 'sw_index_daily']) assert.ok(coverage.some(call => call.sql.includes(`EXISTS (SELECT 1 FROM market_data.${table} AS observations`)));
  assert.match(coverage.find(call => call.values[0] === 'daily').sql, /observations\.market = 'A' AND observations\.source_api = 'daily'/);
  for (const call of coverage) assert.equal(call.values[1], ['daily', 'adj_factor'].includes(call.values[0]) ? '2025-10-14' : '2025-10-15');
  assert.equal(calls.slice(firstDelete).filter(call => call.sql.includes('FROM market_data.sync_days') && call.sql.startsWith('SELECT')).length, 0);
  assert.match(calls.find(call => call.sql.startsWith('SELECT') && call.sql.includes('daily_update_runs')).sql, /FOR UPDATE$/);
  for (const table of ['daily_prices', 'daily_valuations', 'stock_adj_factors', 'sw_index_daily']) {
    const deletion = calls.find(call => call.sql.startsWith(`DELETE FROM market_data.${table}`));
    assert.deepEqual(deletion.values, ['2025-10-15']);
    if (['daily_prices', 'stock_adj_factors'].includes(table)) {
      assert.match(deletion.sql, /history.trade_date IS DISTINCT FROM/);
      assert.match(deletion.sql, /SELECT max\(prices.trade_date\) FROM market_data.daily_prices prices/);
      assert.match(deletion.sql, /prices.ts_code = history.ts_code/);
      assert.match(deletion.sql, /prices.trade_date < \$1 AND prices.close > 0/);
    } else {
      assert.match(deletion.sql, /trade_date < \$1$/);
      assert.doesNotMatch(deletion.sql, /close|IS NULL/);
    }
  }
  assert.match(calls.find(call => call.sql.startsWith('DELETE FROM market_data.daily_prices')).sql, /market = 'A' AND source_api = 'daily'/);
  assert.deepEqual(calls.filter(call => call.sql.startsWith('DELETE FROM market_data.sync_days')).map(call => call.values), [
    [['daily', 'adj_factor'], '2025-10-14'], [['daily_basic', 'sw_daily'], '2025-10-15'],
  ]);
  const completion = calls.find(call => call.sql.startsWith('UPDATE market_data.daily_update_runs'));
  assert.match(completion.sql, /status = 'succeeded'/); assert.deepEqual(JSON.parse(completion.values[1]), {
    downloadedDays: 1, priceHistoryWindowStart: '20251014', priceHistoryExtraTradingDays: 1, deleted: result.deleted,
  });
  assert.equal(calls.at(-2).sql, 'COMMIT'); assert.ok(!calls.some(call => /DELETE FROM market_data\.(?:securities|sw_industries|sw_industry_members|seller_forecasts)/.test(call.sql)));
});

test('one missing companion API/day rolls back without deleting any history or recording success', async () => {
  const completed = Object.fromEntries(ROLLING_UPDATE_APIS.map(api => [api, options.priceHistoryExpectedDates])); completed.adj_factor = expectedDates.slice(0, 1);
  const pool = mockPool({ completed });
  await assert.rejects(createRollingUpdateStore({ pool }).withLock(scope => scope.finalize({ ...options, expectedDates })), { code: 'INCOMPLETE_WINDOW' });
  assert.equal(pool.calls.at(-2).sql, 'ROLLBACK'); assert.equal(pool.calls.filter(call => call.sql.startsWith('DELETE')).length, 0);
  assert.ok(!pool.calls.some(call => call.sql === 'COMMIT' || call.sql.startsWith('UPDATE market_data.daily_update_runs')));
});

test('a missing buffered price or factor day blocks all pruning even when the annual window is complete', async () => {
  for (const missingApi of ['daily', 'adj_factor']) {
    const completed = Object.fromEntries(ROLLING_UPDATE_APIS.map(api => [api,
      ['daily', 'adj_factor'].includes(api) ? options.priceHistoryExpectedDates : expectedDates]));
    completed[missingApi] = expectedDates;
    const pool = mockPool({ completed });
    await assert.rejects(createRollingUpdateStore({ pool }).withLock(scope => scope.finalize({ ...options, expectedDates })), { code: 'INCOMPLETE_WINDOW' });
    assert.equal(pool.calls.at(-2).sql, 'ROLLBACK');
    assert.equal(pool.calls.some(call => call.sql.startsWith('DELETE') || call.sql === 'COMMIT'), false);
  }
});

test('valuation-only collection keeps its annual cutoff and never requires or prunes the price buffer', async () => {
  const pool = mockPool();
  await createRollingUpdateStore({ pool }).withLock(scope => scope.finalize({ ...options, priceHistoryExpectedDates: undefined, expectedDates, apis: ['daily_basic', 'sw_daily'] }));
  const deletes = pool.calls.filter(call => call.sql.startsWith('DELETE'));
  assert.equal(deletes.length, 3);
  assert.ok(deletes.every(call => !/daily_prices|stock_adj_factors/.test(call.sql)));
  assert.ok(deletes.every(call => call.values.at(-1) === '2025-10-15'));
});

test('retention or success-ledger write failure rolls the entire prune back', async () => {
  for (const failOn of [sql => sql.startsWith('DELETE FROM market_data.stock_adj_factors'), sql => sql.startsWith('UPDATE market_data.daily_update_runs')]) {
    const pool = mockPool({ failOn });
    await assert.rejects(createRollingUpdateStore({ pool }).withLock(scope => scope.finalize({ ...options, expectedDates })), { code: 'DATABASE_ERROR' });
    assert.equal(pool.calls.at(-2).sql, 'ROLLBACK'); assert.ok(!pool.calls.some(call => call.sql === 'COMMIT'));
    assert.equal(pool.releases[0].code, 'DATABASE_ERROR');
  }
});

test('changed, absent or already-successful run cannot prune a different window', async () => {
  for (const run of [null, { ...running, status: 'succeeded' }, { ...running, windowStart: '2025-10-14' }]) {
    const pool = mockPool({ run });
    await assert.rejects(createRollingUpdateStore({ pool }).withLock(scope => scope.finalize({ ...options, expectedDates })), { code: 'VALIDATION_ERROR' });
    assert.equal(pool.calls.filter(call => call.sql.startsWith('DELETE')).length, 0); assert.equal(pool.calls.at(-2).sql, 'ROLLBACK');
  }
});

test('invalid windows, malicious APIs and invalid expected dates fail before transaction or deletion', async () => {
  const pool = mockPool(), store = createRollingUpdateStore({ pool });
  await store.withLock(async scope => {
    for (const overrides of [
      { windowEnd: options.runDate }, { windowStart: '20261016' }, { expectedDates: undefined },
      { expectedDates: ['20251014'] }, { expectedDates: ['20261014', '2026-10-14'] },
      { apis: ['daily; DELETE FROM market_data.securities'] }, { apis: [] }, { apis: ['daily', 'daily'] },
      { summary: [] }, { summary: { value: 'x'.repeat(100001) } },
      { priceHistoryExpectedDates: undefined }, { priceHistoryExpectedDates: ['20250914', ...expectedDates] },
      { priceHistoryExpectedDates: expectedDates.slice(1) },
      { priceHistoryExpectedDates: ['20250930', ...options.priceHistoryExpectedDates] },
    ]) await assert.rejects(scope.finalize({ ...options, expectedDates, ...overrides }), { code: 'VALIDATION_ERROR' });
  });
  assert.equal(pool.calls.length, 2); assert.ok(!pool.calls.some(call => call.sql === 'BEGIN'));
});

test('closed-day calendars may finalize an empty expected set, and API subsets never delete unrelated tables', async () => {
  const pool = mockPool({ completed: { daily: ['20251014'] } });
  const result = await createRollingUpdateStore({ pool }).withLock(scope => scope.finalize({ ...options, expectedDates: [], priceHistoryExpectedDates: ['20251014'], apis: ['daily'] }));
  assert.equal(result.status, 'succeeded'); assert.deepEqual(Object.keys(result.deleted), ['daily_prices', 'sync_days']);
  assert.equal(pool.calls.filter(call => call.sql.startsWith('DELETE FROM market_data.')).length, 2);
});

test('港股在独立运行表和锁中完成，清理仅限 HK hk_daily 的行情与日账本', async () => {
  const pool = mockPool({ completed: { hk_daily: expectedDates } }), store = createRollingUpdateStore({ pool, market: 'HK' });
  const result = await store.withLock(async scope => {
    await scope.beginRun(options);
    return scope.finalize({ ...options, expectedDates, summary: { hk_daily: { completedDays: 2 } } });
  });
  assert.equal(result.status, 'succeeded'); assert.deepEqual(result.deleted, { daily_prices: 7, sync_days: 7 });
  assert.deepEqual(pool.calls[0].values, HK_ROLLING_UPDATE_LOCK_KEYS);
  assert.notDeepEqual(HK_ROLLING_UPDATE_LOCK_KEYS, ROLLING_UPDATE_LOCK_KEYS);
  const runQueries = pool.calls.filter(call => call.sql.includes('daily_update_runs'));
  assert.ok(runQueries.length >= 3); assert.ok(runQueries.every(call => call.sql.includes('market_data.hk_daily_update_runs')));
  const coverage = pool.calls.find(call => call.sql.includes('FROM market_data.sync_days') && call.sql.startsWith('SELECT'));
  assert.deepEqual(coverage.values, ['hk_daily', '2025-10-15', '2026-10-14']);
  assert.match(coverage.sql, /WHERE market = 'HK' AND source_api = \$1/);
  assert.match(coverage.sql, /observations\.market = 'HK' AND observations\.source_api = 'hk_daily'/);
  const deletions = pool.calls.filter(call => call.sql.startsWith('DELETE'));
  assert.equal(deletions.length, 2);
  assert.match(deletions[0].sql, /daily_prices WHERE market = 'HK' AND source_api = 'hk_daily' AND trade_date < \$1$/);
  assert.match(deletions[1].sql, /sync_days WHERE market = 'HK'/);
  assert.deepEqual(deletions[1].values, [['hk_daily'], '2025-10-15']);
});

test('港股缺少交易日时保留旧数据；HK运行不接受 A 股接口进行清理', async () => {
  const pool = mockPool({ completed: { hk_daily: expectedDates.slice(0, 1) } }), store = createRollingUpdateStore({ pool, market: 'HK' });
  await assert.rejects(store.withLock(scope => scope.finalize({ ...options, expectedDates })), { code: 'INCOMPLETE_WINDOW' });
  assert.equal(pool.calls.some(call => call.sql.startsWith('DELETE')), false);
  await store.withLock(async scope => {
    await assert.rejects(scope.finalize({ ...options, expectedDates, apis: ['daily'] }), { code: 'VALIDATION_ERROR' });
    await assert.rejects(scope.getCompletedDates({ apiName: 'daily', startDate: options.windowStart, endDate: options.windowEnd }), { code: 'VALIDATION_ERROR' });
  });
  assert.throws(() => createRollingUpdateStore({ pool, market: 'US' }), { code: 'VALIDATION_ERROR' });
});
