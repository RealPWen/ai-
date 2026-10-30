import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createHkIndexStore } from '../backend/market-data/hk-index-store.mjs';
import { updateRollingHkIndex } from '../backend/market-data/hk-index-sync.mjs';

// Explicitly opted in; all tables and migrations are redirected to a fresh schema.
const enabled = process.env.HK_INDEX_DATABASE_TESTS === '1' && Boolean(process.env.DATABASE_URL);
test('PostgreSQL HSI: migration, annual backfill, idempotency, atomic overwrite/prune and independent advisory lock', { skip: !enabled }, async () => {
  const schema = `hsi_test_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^hsi_test_[a-f0-9]{32}$/);
  const raw = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  const rewrite = sql => sql.replaceAll('market_data.', `${schema}.`).replaceAll('CREATE SCHEMA IF NOT EXISTS market_data', `CREATE SCHEMA IF NOT EXISTS ${schema}`);
  let failFinalize = false;
  const q = async (client, sql, values) => {
    if (failFinalize && sql.includes("SET status='succeeded'")) throw new Error('private database credentials');
    return client.query(rewrite(sql), values);
  };
  const pool = { query: (sql, values) => q(raw, sql, values), end: async () => {},
    connect: async () => { const client = await raw.connect(); return { query: (sql, values) => q(client, sql, values), release: () => client.release() }; } };
  const store = createHkIndexStore({ pool });
  const bar = (date, close = 24000) => ({ index_code: 'HSI', trade_date: date, open: close, high: close + 10, low: close - 10, close, vol: 12345.125 });
  const rows = [];
  for (let time = Date.parse('2025-10-20'); time <= Date.parse('2026-10-19'); time += 86400000) {
    const day = new Date(time); if (![0, 6].includes(day.getUTCDay())) rows.push(bar(day.toISOString().slice(0, 10).replaceAll('-', '')));
  }
  try {
    await store.migrate(); await store.migrate();
    await store.upsert({ rows: [bar('20251017')], startDate: '20251017', endDate: '20251017' });
    let calls = 0;
    const client = { getDaily: async () => { calls++; return { rows }; } };
    const result = await updateRollingHkIndex({ store, client, runDate: '2026-10-20' });
    assert.equal(result.status, 'succeeded'); assert.equal(result.summary.deleted, 1);
    assert.equal((await store.get({ startDate: '20251020', endDate: '20261019' })).length, rows.length);
    assert.equal((await updateRollingHkIndex({ store, client, runDate: '2026-10-20' })).status, 'already_completed'); assert.equal(calls, 1);
    // A failure after upsert and retention deletion must roll both changes back.
    failFinalize = true;
    const failed = await updateRollingHkIndex({ store, runDate: '2026-10-21', client: { getDaily: async () => ({ rows: [bar('20261019', 25000), bar('20261020', 25010)] }) } });
    assert.equal(failed.status, 'failed'); assert.equal(failed.errorCode, 'database_error');
    failFinalize = false;
    const retained = await store.get({ startDate: '20251020', endDate: '20261020' });
    assert.equal(retained[0].trade_date, '20251020'); assert.equal(retained.at(-1).trade_date, '20261019'); assert.equal(Number(retained.at(-1).close), 24000);
    let releaseLock, acquired;
    const ready = new Promise(resolve => { acquired = resolve; });
    const locking = store.withLock(async () => { acquired(); await new Promise(resolve => { releaseLock = resolve; }); return { status: 'succeeded' }; });
    await ready; assert.deepEqual(await store.withLock(async () => assert.fail('busy lock entered')), { status: 'busy' });
    releaseLock(); await locking;
    const records = await raw.query(`SELECT count(*) AS count,count(DISTINCT (index_code,trade_date)) AS unique_count FROM ${schema}.hk_index_daily`);
    assert.equal(Number(records.rows[0].count), rows.length); assert.equal(records.rows[0].count, records.rows[0].unique_count);
  } finally { try { await raw.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await raw.end(); } }
});
