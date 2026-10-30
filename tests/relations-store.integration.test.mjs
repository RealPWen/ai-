import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createRelationsStore, RELATIONS_METHOD_VERSION } from '../backend/market-data/relations-store.mjs';

// Opt-in, isolated schema only. Never uses the production market_data schema.
const enabled = process.env.RELATIONS_DATABASE_TESTS === '1' && Boolean(process.env.DATABASE_URL);
test('PostgreSQL integration: freeze, parallel claims, merge, recovery, rollback and complete-publication preservation', { skip: !enabled }, async () => {
  const schema = `relations_test_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^relations_test_[a-f0-9]{32}$/);
  const raw = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
  const rewrite = sql => sql.replaceAll('market_data.', `${schema}.`).replaceAll('CREATE SCHEMA IF NOT EXISTS market_data', `CREATE SCHEMA IF NOT EXISTS ${schema}`);
  let failLedger = false;
  const wrapped = {
    async query(sql, values) { return raw.query(rewrite(sql), values); },
    async connect() { const client = await raw.connect(); return { async query(sql, values) { if (failLedger && sql.startsWith('UPDATE market_data.company_relation_jobs SET')) throw Object.assign(new Error('private-db-message'), { code: '08006' }); return client.query(rewrite(sql), values); }, release() { client.release(); } }; },
    async end() {},
  };
  const store = createRelationsStore({ pool: wrapped });
  const ticker = n => `${String(n).padStart(6, '0')}.SZ`;
  const name = n => `测试公司${n}`;
  const asOf = '2026-10-15', firstVerified = '2026-10-15T00:00:00.000Z', reviewedAt = '2026-10-15T00:01:00.000Z', replacedAt = '2026-10-15T00:02:00.000Z';
  const relation = n => ({ relatedTicker: ticker(n), relatedName: name(n), relationType: 'peer', evidenceType: 'business_comparable', rationale: '测试公开资料中同类业务。', actualEntity: name(n), listedMappingBasis: '上市公司本体。', notes: '', sources: [{ url: 'https://example.com/report', title: '报告', publishedAt: null, excerpt: '公司经营同类产品业务。', accessedAt: firstVerified, readingScope: 'full_text' }] });
  const payload = (runId, subject, others, overrides = {}) => ({ runId, ticker: ticker(subject), asOf, methodVersion: RELATIONS_METHOD_VERSION, relations: others.map(relation), gaps: [], ...overrides });
  try {
    await store.migrate(); await store.migrate();
    // Simulate the previously deployed schema without touching any business table.
    await raw.query(`ALTER TABLE ${schema}.company_relation_jobs DROP COLUMN archived_relations, DROP COLUMN lease_token`);
    await store.migrate();
    const upgradedColumns = await raw.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'company_relation_jobs' AND column_name = ANY($2::text[]) ORDER BY column_name`, [schema, ['archived_relations', 'lease_token']]);
    assert.deepEqual(upgradedColumns.rows.map(row => row.column_name), ['archived_relations', 'lease_token']);
    await raw.query(`CREATE TABLE ${schema}.securities (ts_code text PRIMARY KEY, name text, industry text, market text, list_status text)`);
    await raw.query(`INSERT INTO ${schema}.securities SELECT lpad(n::text, 6, '0') || '.SZ', '测试公司' || n, '测试行业', 'A', 'L' FROM generate_series(1, 12) n`);
    await raw.query(`INSERT INTO ${schema}.securities VALUES ('009999.SZ','退市公司','测试行业','A','D'),('00700.HK','港股公司','测试行业','HK','L')`);
    const first = await store.initRun({ runId: 'integration-first', asOf });
    assert.equal(first.securitiesCount, 12);
    await raw.query(`UPDATE ${schema}.securities SET name = '新的证券简称' WHERE ts_code = $1`, [ticker(12)]);
    assert.equal((await store.initRun({ runId: 'integration-first', asOf })).created, false);
    assert.equal((await store.listSecurities({ runId: 'integration-first' }))[11].name, name(12));
    await raw.query(`UPDATE ${schema}.securities SET name = $2 WHERE ts_code = $1`, [ticker(12), name(12)]);
    // Preserve a deterministic sub-millisecond precision component. PostgreSQL
    // must compare run timestamps directly rather than round-tripping pg Dates.
    await raw.query(`UPDATE ${schema}.company_relation_runs SET created_at = date_trunc('milliseconds', created_at) + interval '123 microseconds' WHERE run_id = $1`, [first.runId]);
    const [claimedA, claimedB] = await Promise.all([
      store.claimJobs({ runId: first.runId, workerId: 'worker-A', limit: 2 }),
      store.claimJobs({ runId: first.runId, workerId: 'worker-B', limit: 2 }),
    ]);
    assert.equal(new Set([...claimedA, ...claimedB].map(row => row.ticker)).size, 4);
    assert.equal(claimedA[0].leaseToken, claimedA[1].leaseToken); assert.notEqual(claimedA[0].leaseToken, claimedB[0].leaseToken);
    const subject = Number(claimedA[0].ticker.slice(0, 6));
    const others = Array.from({ length: 12 }, (_, i) => i + 1).filter(n => n !== subject).slice(0, 10);
    await assert.rejects(store.importResearch(payload(first.runId, subject, others.slice(0, 3)), { workerId: 'worker-B' }), { code: 'LEASE_CONFLICT' });
    await assert.rejects(store.importResearch(payload(first.runId, subject, others.slice(0, 3)), { workerId: 'worker-A' }), { code: 'LEASE_CONFLICT' });
    assert.equal((await store.importResearch(payload(first.runId, subject, others.slice(0, 3)), { workerId: 'worker-A', leaseToken: claimedA[0].leaseToken })).status, 'partial');
    await store.importResearch(payload(first.runId, subject, others.slice(3)));
    assert.equal((await store.getResearch({ runId: first.runId, ticker: ticker(subject) })).relations.length, 10);
    assert.equal((await store.status({ runId: first.runId })).totals.completed, 1);
    await store.importResearch(payload(first.runId, subject, [others[0]]));
    assert.equal((await store.getResearch({ runId: first.runId, ticker: ticker(subject) })).relations[0].verifiedAt, firstVerified);
    const corrected = payload(first.runId, subject, [others[0]], { researchedAt: reviewedAt });
    corrected.relations[0].rationale = '较新复核结论。';
    await store.importResearch(corrected);
    await assert.rejects(store.importResearch(payload(first.runId, subject, [others[0]])), { code: 'STALE_IMPORT' });
    assert.equal((await store.getResearch({ runId: first.runId, ticker: ticker(subject) })).relations[0].rationale, '较新复核结论。');
    await assert.rejects(store.importResearch(payload(first.runId, subject, [Array.from({ length: 12 }, (_, i) => i + 1).find(n => n !== subject && !others.includes(n))])), { code: 'VALIDATION_ERROR' });
    assert.equal((await store.getResearch({ runId: first.runId, ticker: ticker(subject) })).relations.length, 10);
    const leased = claimedB[0];
    await raw.query(`UPDATE ${schema}.company_relation_jobs SET lease_until = clock_timestamp() - interval '1 second' WHERE run_id = $1 AND ticker = $2`, [first.runId, leased.ticker]);
    await assert.rejects(store.importResearch(payload(first.runId, Number(leased.ticker.slice(0, 6)), [12]), { workerId: 'worker-B' }), { code: 'LEASE_CONFLICT' });
    const renewed = (await store.claimJobs({ runId: first.runId, workerId: 'worker-B', tickers: [leased.ticker] }))[0];
    assert.equal(renewed.attempts, 2); assert.notEqual(renewed.leaseToken, leased.leaseToken);
    await assert.rejects(store.importResearch(payload(first.runId, Number(leased.ticker.slice(0, 6)), [12]), { workerId: 'worker-B', leaseToken: leased.leaseToken }), { code: 'LEASE_CONFLICT' });
    await assert.rejects(store.markFailed({ runId: first.runId, ticker: leased.ticker, workerId: 'worker-B', leaseToken: leased.leaseToken }), { code: 'LEASE_CONFLICT' });
    assert.equal((await store.releaseJobs({ runId: first.runId, workerId: 'worker-B', leaseToken: leased.leaseToken, tickers: [leased.ticker] })).released, 0);
    assert.equal((await store.status({ runId: first.runId, includeStocks: true })).stocks.find(row => row.ticker === leased.ticker).leaseToken, renewed.leaseToken);
    assert.equal((await store.markFailed({ runId: first.runId, ticker: leased.ticker, workerId: 'worker-B', leaseToken: renewed.leaseToken })).status, 'failed');
    await assert.rejects(store.claimJobs({ runId: first.runId, workerId: 'recovery', tickers: ['999999.SZ'] }), { code: 'JOB_NOT_FOUND' });
    await store.releaseJobs({ runId: first.runId, workerId: 'worker-A', leaseToken: claimedA[0].leaseToken }); await store.releaseJobs({ runId: first.runId, workerId: 'worker-B', leaseToken: claimedB[0].leaseToken });
    const concurrentSubject = Array.from({ length: 12 }, (_, i) => i + 1).find(n => n !== subject && n !== 11 && n !== 12);
    await Promise.all([store.importResearch(payload(first.runId, concurrentSubject, [11])), store.importResearch(payload(first.runId, concurrentSubject, [12]))]);
    assert.equal((await store.getResearch({ runId: first.runId, ticker: ticker(concurrentSubject) })).relations.length, 2);
    failLedger = true;
    await assert.rejects(store.importResearch(payload(first.runId, concurrentSubject, [10].filter(n => n !== concurrentSubject))), error => error.code === 'DATABASE_ERROR' && !error.message.includes('private-db-message'));
    failLedger = false;
    assert.equal((await store.getResearch({ runId: first.runId, ticker: ticker(concurrentSubject) })).relations.length, 2);
    const extra = Array.from({ length: 12 }, (_, i) => i + 1).find(n => n !== subject && !others.includes(n));
    const replacement = others.slice(1).concat(extra);
    await assert.rejects(store.importResearch(payload(first.runId, subject, replacement, { researchedAt: reviewedAt }), { replace: true }), { code: 'STALE_IMPORT' });
    await store.importResearch(payload(first.runId, subject, replacement, { researchedAt: replacedAt }), { replace: true });
    const second = await store.initRun({ runId: 'integration-newer', asOf });
    await assert.rejects(store.importResearch(payload(first.runId, subject, [others[0]])), { code: 'STALE_RUN' });
    const draft = await store.importResearch(payload(second.runId, subject, others.slice(0, 3)));
    assert.equal(draft.published, false); assert.equal(draft.draftCount, 3); assert.equal(draft.preservedPreviousCount, 10);
    const oldPublication = await raw.query(`SELECT DISTINCT run_id, count(*)::integer AS count FROM ${schema}.company_relations WHERE subject_ticker = $1 GROUP BY run_id`, [ticker(subject)]);
    assert.deepEqual(oldPublication.rows, [{ run_id: first.runId, count: 10 }]);
    const progress = await store.status({ runId: second.runId, includeStocks: true });
    assert.equal(progress.totals.relations, 0); assert.equal(progress.totals.draftRelations, 3); assert.equal(progress.totals.partial, 1); assert.equal(progress.totals.completed, 0);
    assert.equal((await store.getResearch({ runId: second.runId, ticker: ticker(subject) })).relations.length, 3);
    const published = await store.importResearch(payload(second.runId, subject, others.slice(3)));
    assert.equal(published.status, 'completed'); assert.equal(published.published, true); assert.equal(published.draftCount, 0);
    assert.equal((await store.getResearch({ runId: second.runId, ticker: ticker(subject) })).relations.length, 10);
    assert.equal((await store.status({ runId: second.runId })).totals.completed, 1);
    assert.equal((await store.status({ runId: first.runId })).totals.completed, 0);
    const completeArchive = await store.getResearch({ runId: first.runId, ticker: ticker(subject) });
    assert.equal(completeArchive.relationSource, 'archive'); assert.equal(completeArchive.archivedCount, 10); assert.equal(completeArchive.publishedRelationCount, 0);
    const partialOthers = Array.from({ length: 12 }, (_, i) => i + 1).filter(n => n !== concurrentSubject).slice(0, 10);
    const partialRefresh = await store.importResearch(payload(second.runId, concurrentSubject, partialOthers.slice(0, 1)));
    assert.equal(partialRefresh.published, false); assert.equal(partialRefresh.preservedPreviousCount, 2);
    assert.equal((await store.getResearch({ runId: first.runId, ticker: ticker(concurrentSubject) })).publishedRelationCount, 2);
    await store.importResearch(payload(second.runId, concurrentSubject, partialOthers.slice(1)));
    const partialArchive = await store.getResearch({ runId: first.runId, ticker: ticker(concurrentSubject) });
    assert.equal(partialArchive.relationSource, 'archive'); assert.equal(partialArchive.archivedCount, 2); assert.equal(partialArchive.publishedRelationCount, 0);
    assert.deepEqual(partialArchive.relations.map(row => row.relatedTicker), [ticker(11), ticker(12)]);
    const previousStatus = (await store.status({ runId: first.runId, includeStocks: true })).stocks.find(row => row.ticker === ticker(concurrentSubject));
    assert.equal(previousStatus.relationCount, 0); assert.notEqual(previousStatus.status, 'completed');
    // A scoped run preserves every A candidate but supersedes only its subjects.
    const subjects = [{ ticker: ticker(1), name: name(1) }, { ticker: '00700.HK', name: '腾讯控股', industry: '互联网' }];
    const scoped = await store.initRun({ runId: 'integration-scoped', asOf, subjects });
    assert.equal(scoped.securitiesCount, 13);
    assert.equal((await store.listSecurities({ runId: scoped.runId })).filter(row => row.isSubject).length, 2);
    assert.equal((await store.status({ runId: scoped.runId })).totals.stocks, 2);
    assert.equal((await store.initRun({ runId: scoped.runId, asOf, subjects: [...subjects].reverse() })).created, false);
    await assert.rejects(store.initRun({ runId: scoped.runId, asOf }), { code: 'VALIDATION_ERROR' });
    await assert.rejects(store.claimJobs({ runId: scoped.runId, workerId: 'scope-worker', tickers: [ticker(2)] }), { code: 'JOB_NOT_FOUND' });
    await assert.rejects(store.importResearch(payload(scoped.runId, 2, [12])), { code: 'JOB_NOT_FOUND' });
    await assert.rejects(store.markFailed({ runId: scoped.runId, ticker: ticker(2) }), { code: 'JOB_NOT_FOUND' });
    await assert.rejects(store.importResearch(payload(second.runId, 1, [12])), { code: 'STALE_RUN' });
    const unaffected = await store.getResearch({ runId: second.runId, ticker: ticker(2) });
    await store.importResearch(payload(second.runId, 2, unaffected.relations.length ? [Number(unaffected.relations[0].relatedTicker.slice(0, 6))] : [12]));
    await store.claimJobs({ runId: second.runId, workerId: 'unaffected-worker', tickers: [ticker(2)] });
    const scopeClaims = await store.claimJobs({ runId: scoped.runId, workerId: 'scope-worker' });
    assert.deepEqual(scopeClaims.map(row => row.ticker), [ticker(1), '00700.HK']);
    await store.releaseJobs({ runId: scoped.runId, workerId: 'scope-worker', leaseToken: scopeClaims[0].leaseToken });
    const hk = await store.importResearch(payload(scoped.runId, 1, Array.from({ length: 10 }, (_, i) => i + 1), { ticker: '00700.HK' }));
    assert.equal(hk.status, 'completed');
    assert.equal((await store.getResearch({ runId: scoped.runId, ticker: '00700.HK' })).relations.length, 10);
    assert.equal((await store.status({ runId: scoped.runId })).totals.completed, 1);
    const beforeMigration = await raw.query(`SELECT count(*)::integer AS count FROM ${schema}.company_relations`);
    await store.migrate();
    assert.deepEqual((await raw.query(`SELECT count(*)::integer AS count FROM ${schema}.company_relations`)).rows, beforeMigration.rows);

  } finally {
    // Only this generated test schema is removable; no business tables are touched.
    try { await raw.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await raw.end(); }
  }
});
