import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelationsStore, validateResearch, validateRelationSubjects, RELATIONS_METHOD_VERSION } from '../backend/market-data/relations-store.mjs';

const asOf = '2026-10-15', runId = 'research-20261015';
const run = { run_id: runId, as_of: asOf, method_version: RELATIONS_METHOD_VERSION, securities_count: 12, created_at: '2026-10-15T00:00:00.000Z' };
const security = index => ({ ticker: `${String(index).padStart(6, '0')}.SZ`, name: `公司${index}` });
const relation = (index = 2, overrides = {}) => ({ relatedTicker: security(index).ticker, relatedName: security(index).name, relationType: 'peer', evidenceType: 'business_comparable', rationale: '双方公开资料显示均经营同类业务。', actualEntity: security(index).name, listedMappingBasis: '上市公司本体，名称与冻结证券清单一致。', notes: '', sources: [{ url: 'https://example.com/annual-report.pdf', title: '公司年度报告', publishedAt: '2026-04-12', excerpt: '公司主要从事相关产品的研发、生产和销售。', accessedAt: '2026-10-15T03:00:00.000Z', readingScope: 'full_text' }], ...overrides });
const payload = (relations = [relation()], overrides = {}) => ({ runId, ticker: security(1).ticker, asOf, methodVersion: RELATIONS_METHOD_VERSION, relations, gaps: [], ...overrides });
const stored = (index, origin = runId) => { const row = relation(index); return { subject_ticker: security(1).ticker, subject_name: security(1).name, related_ticker: row.relatedTicker, related_name: row.relatedName, relation_type: row.relationType, evidence_type: row.evidenceType, rationale: row.rationale, actual_entity: row.actualEntity, listed_mapping_basis: row.listedMappingBasis, notes: row.notes, sources: row.sources, rank: index - 1, verified_at: '2026-10-15T03:00:00.000Z', run_id: origin, as_of: asOf, method_version: RELATIONS_METHOD_VERSION }; };
function recordingPool(handler = () => ({ rows: [] })) {
  const calls = []; let released = 0;
  const pool = { calls, get released() { return released; }, async query(sql, values) { calls.push({ sql, values }); return handler(sql, values); }, async connect() { return { query: pool.query, release() { released++; } }; }, async end() {} };
  return pool;
}
function researchPool({ existing = [], newer = false, job: jobOverrides = {}, failInsert = false } = {}) {
  let committed = { rows: existing, archives: {}, job: { name: security(1).name, gaps: [], draft_relations: [], archived_relations: [], lease_active: false, lease_owner: null, lease_token: null, ...jobOverrides } }, pending;
  const pool = recordingPool((sql, values) => {
    if (sql === 'BEGIN') pending = structuredClone(committed);
    else if (sql === 'COMMIT') committed = pending;
    else if (sql === 'ROLLBACK') pending = undefined;
    else if (sql.startsWith('SELECT run_id, to_char(as_of')) return { rows: [run] };
    else if (sql.startsWith('SELECT newer.run_id')) return { rows: newer ? [{ run_id: 'new-run' }] : [] };
    else if (sql.startsWith('SELECT *, (lease_until')) return { rows: [pending.job] };
    else if (sql.startsWith('SELECT ticker, name FROM')) return { rows: values[1].map(code => security(Number(code.slice(0, 6)))) };
    else if (sql.startsWith('SELECT name, gaps, draft_relations')) { const state = pending ?? committed; return { rows: [values[0] === runId ? state.job : { name: security(1).name, gaps: [], draft_relations: [], archived_relations: state.archives[values[0]] ?? [] }] }; }
    else if (sql.startsWith('SELECT * FROM market_data.company_relations')) { const state = pending ?? committed; return { rows: sql.includes('WHERE run_id =') ? state.rows.filter(row => row.run_id === values[0]) : state.rows }; }
    else if (sql.startsWith('DELETE FROM market_data.company_relations')) pending.rows = [];
    else if (sql.startsWith('INSERT INTO market_data.company_relations')) {
      if (failInsert) throw Object.assign(new Error('postgres://user:secret@private-host/db'), { code: '08006' });
      pending.rows.push(Object.fromEntries(['subject_ticker', 'subject_name', 'related_ticker', 'related_name', 'relation_type', 'rank', 'evidence_type', 'rationale', 'actual_entity', 'listed_mapping_basis', 'notes', 'sources', 'verified_at', 'run_id', 'as_of', 'method_version'].map((key, i) => [key, key === 'sources' ? JSON.parse(values[i]) : values[i]])));
    } else if (sql.startsWith('UPDATE market_data.company_relation_jobs SET archived_relations')) pending.archives[values[0]] = JSON.parse(values[2]);
    else if (sql.startsWith('UPDATE market_data.company_relation_jobs SET')) { pending.job.status = values[2]; pending.job.draft_relations = JSON.parse(values[4]); pending.job.lease_active = false; pending.job.lease_owner = null; pending.job.lease_token = null; }
    return { rows: [] };
  });
  pool.state = () => committed;
  return pool;
}

test('schema is additive and enforces frozen membership, pair uniqueness and no more than 10 distinct ranks', async () => {
  const pool = recordingPool(); await createRelationsStore({ pool }).migrate();
  const sql = pool.calls[1].sql;
  for (const table of ['company_relation_runs', 'company_relation_jobs', 'company_relations']) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS market_data\\.${table}`));
  assert.match(sql, /PRIMARY KEY \(subject_ticker, related_ticker\)/); assert.match(sql, /UNIQUE \(subject_ticker, rank\)/); assert.match(sql, /rank BETWEEN 1 AND 10/); assert.match(sql, /CHECK \(subject_ticker <> related_ticker\)/);
  assert.match(sql, /FOREIGN KEY \(run_id, related_ticker\)/); assert.match(sql, /semantic evidence must be reviewed/); assert.doesNotMatch(sql, /\b(?:DELETE|TRUNCATE)\b|DROP\s+(?:TABLE|SCHEMA|COLUMN)/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS is_subject boolean NOT NULL DEFAULT true/);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS company_relation_jobs_ticker_check/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS archived_relations/); assert.match(sql, /ADD COLUMN IF NOT EXISTS lease_token uuid/);
  assert.equal(pool.calls.at(-1).sql, 'COMMIT'); assert.equal(pool.released, 1);
});
test('research validates HTTP and HTTPS sources and normalizes source times without pretending to verify their truth', () => {
  const result = validateResearch(payload([relation(2, { sources: [{ ...relation().sources[0], url: 'http://example.com/old-report', publishedAt: null, accessedAt: '2026-10-15T11:00:00+08:00', readingScope: 'partial_text' }] })]));
  assert.equal(result.relations[0].sources[0].accessedAt, '2026-10-15T03:00:00.000Z'); assert.equal(result.relations[0].sources[0].publishedAt, null);
});
test('research rejects self links, duplicates, unsupported codes, blank metadata and overfull submissions before touching the database', async () => {
  const bad = [payload([relation(1)]), payload([relation(), relation()]), payload([relation(2, { relatedTicker: '00700.HK' })]), payload([relation(2, { rationale: ' ' })]), payload([relation(2, { actualEntity: '' })]), payload([relation(2, { listedMappingBasis: '' })]), payload([relation(2, { relationType: 'supplier' })]), payload([relation(2, { evidenceType: 'rumor' })]), payload(Array.from({ length: 11 }, (_, i) => relation(i + 2)))];
  const pool = recordingPool(), store = createRelationsStore({ pool });
  for (const input of bad) await assert.rejects(store.importResearch(input), { code: 'VALIDATION_ERROR' });
  assert.equal(pool.calls.length, 0);
});
test('research rejects missing, unsafe, future, invalid-date or unquoted sources', () => {
  const source = relation().sources[0];
  const badSources = [[], [{ ...source, url: 'javascript:alert(1)' }], [{ ...source, url: 'ftp://example.com/data' }], [{ ...source, url: 'https://secret:password@example.com' }], [{ ...source, excerpt: ' ' }], [{ ...source, publishedAt: '2026-10-16' }], [{ ...source, publishedAt: '2026-02-30' }], [{ ...source, publishedAt: '20260412' }], [{ ...source, accessedAt: '2026-10-15 03:00:00' }], [{ ...source, accessedAt: '2026-02-30T03:00:00Z' }], [{ ...source, accessedAt: '2026-10-15T24:00:00Z' }], [{ ...source, readingScope: 'search_snippet' }], [{ ...source, url: { href: 'https://example.com' } }]];
  for (const sources of badSources) assert.throws(() => validateResearch(payload([relation(2, { sources })])), { code: 'VALIDATION_ERROR' });
});
test('init freezes current listed A shares atomically with optional SW candidates and is idempotent', async () => {
  const securities = [security(1), security(2)].map(row => ({ ts_code: row.ticker, name: row.name, industry: '行业', industry_classifications: [] }));
  const pool = recordingPool((sql) => {
    if (sql.startsWith('SELECT run_id, to_char')) return { rows: [] };
    if (sql.includes("to_regclass('market_data.sw_industry_members')")) return { rows: [{ available: false }] };
    if (sql.startsWith('SELECT s.ts_code')) return { rows: securities };
    if (sql.startsWith('INSERT INTO market_data.company_relation_runs')) return { rows: [{ ...run, securities_count: 2 }] };
    return { rows: [] };
  });
  const result = await createRelationsStore({ pool }).initRun({ runId, asOf });
  assert.equal(result.securitiesCount, 2); assert.equal(result.created, true);
  assert.equal(pool.calls.find(call => call.sql.startsWith('INSERT INTO market_data.company_relation_runs')).values[4], null);
  assert.match(pool.calls.find(call => call.sql.startsWith('SELECT s.ts_code')).sql, /s.market = 'A' AND s.list_status = 'L'/);
  assert.deepEqual(JSON.parse(pool.calls.find(call => call.sql.startsWith('INSERT INTO market_data.company_relation_jobs')).values[1]), securities);
  assert.ok(!pool.calls.some(call => /DELETE FROM/.test(call.sql)));
  const reused = recordingPool(sql => ({ rows: sql.startsWith('SELECT run_id, to_char') ? [run] : [] }));
  assert.equal((await createRelationsStore({ pool: reused }).initRun({ runId, asOf })).created, false);
  assert.ok(!reused.calls.some(call => call.sql.startsWith('INSERT')));
  await assert.rejects(createRelationsStore({ pool: reused }).initRun({ runId, asOf: '2026-10-14' }), { code: 'VALIDATION_ERROR' });
});
test('partial research merges to exactly 10 with continuous ranks and repeated imports stay idempotent', async () => {
  const pool = researchPool(), store = createRelationsStore({ pool });
  let result = await store.importResearch(payload([relation(2), relation(3), relation(4)]));
  assert.equal(result.status, 'partial'); assert.equal(result.relationCount, 3); assert.match(result.gaps[0], /7/);
  result = await store.importResearch(payload(Array.from({ length: 7 }, (_, i) => relation(i + 5))));
  assert.equal(result.status, 'completed'); assert.equal(result.relationCount, 10);
  assert.deepEqual(pool.state().rows.map(row => row.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  await store.importResearch(payload([relation(2, { rationale: '补充研究后的明确理由。' })], { researchedAt: '2026-10-15T03:01:00Z' }));
  assert.equal(pool.state().rows.length, 10); assert.equal(pool.state().rows[0].rationale, '补充研究后的明确理由。');
});
test('overfull merged results roll back and preserve already stored research', async () => {
  const pool = researchPool(), store = createRelationsStore({ pool });
  await store.importResearch(payload(Array.from({ length: 10 }, (_, i) => relation(i + 2))));
  await assert.rejects(store.importResearch(payload([relation(12)])), { code: 'VALIDATION_ERROR' });
  assert.equal(pool.state().rows.length, 10); assert.equal(pool.calls.at(-1).sql, 'ROLLBACK');
});
test('review can explicitly replace a complete selection while accidental or partial replacement cannot erase evidence', async () => {
  const pool = researchPool(), store = createRelationsStore({ pool });
  await store.importResearch(payload(Array.from({ length: 10 }, (_, i) => relation(i + 2))));
  await assert.rejects(store.importResearch(payload([relation(12)]), { replace: true }), { code: 'VALIDATION_ERROR' });
  assert.equal(pool.state().rows.length, 10);
  const replacement = Array.from({ length: 10 }, (_, i) => relation(i + 3));
  assert.equal((await store.importResearch(payload(replacement, { researchedAt: '2026-10-15T03:01:00Z' }), { replace: true })).status, 'completed');
  assert.deepEqual(pool.state().rows.map(row => row.related_ticker), replacement.map(row => row.relatedTicker));
});
test('evidence of business comparability and upstream or downstream roles cannot be interchanged', () => {
  assert.throws(() => validateResearch(payload([relation(2, { relationType: 'upstream' })])), { code: 'VALIDATION_ERROR' });
  assert.throws(() => validateResearch(payload([relation(2, { evidenceType: 'direct_business' })])), { code: 'VALIDATION_ERROR' });
  assert.equal(validateResearch(payload([relation(2, { relationType: 'upstream', evidenceType: 'industry_position' })])).relations[0].relationType, 'upstream');
});
test('import refuses stale runs, mismatched run metadata and frozen security names without deleting evidence', async () => {
  const stale = researchPool({ newer: true });
  await assert.rejects(createRelationsStore({ pool: stale }).importResearch(payload()), { code: 'STALE_RUN' });
  assert.ok(!stale.calls.some(call => call.sql.startsWith('DELETE')));
  const pool = researchPool(), store = createRelationsStore({ pool });
  await assert.rejects(store.importResearch(payload(undefined, { asOf: '2026-10-14' })), { code: 'VALIDATION_ERROR' });
  await assert.rejects(store.importResearch(payload([relation(2, { relatedName: '过期或错误简称' })])), { code: 'VALIDATION_ERROR' });
  assert.ok(!pool.calls.some(call => call.sql.startsWith('DELETE')));
});
test('lease ownership is required while a claim is active and an expired worker cannot publish', async () => {
  const active = researchPool({ job: { lease_active: true, lease_owner: 'worker-1' } }), store = createRelationsStore({ pool: active });
  await assert.rejects(store.importResearch(payload()), { code: 'LEASE_CONFLICT' });
  await assert.rejects(store.importResearch(payload(), { workerId: 'worker-2' }), { code: 'LEASE_CONFLICT' });
  assert.equal((await store.importResearch(payload(), { workerId: 'worker-1' })).relationCount, 1);
  const expired = researchPool({ job: { lease_active: false, lease_owner: 'worker-1' } });
  await assert.rejects(createRelationsStore({ pool: expired }).importResearch(payload(), { workerId: 'worker-1' }), { code: 'LEASE_CONFLICT' });
});
test('new-run initialization does not remove old research; empty imports retain older published rows', async () => {
  const old = stored(2, 'old-run');
  const pool = researchPool({ existing: [old] });
  const result = await createRelationsStore({ pool }).importResearch(payload([]));
  assert.equal(result.relationCount, 0); assert.deepEqual(pool.state().rows, [old]);
  assert.ok(!pool.calls.some(call => call.sql.startsWith('DELETE')));
});
test('publication failure rolls back the entire subject and hides DSN or raw PostgreSQL messages', async () => {
  const old = stored(2, 'old-run'), pool = researchPool({ existing: [old], failInsert: true });
  await assert.rejects(createRelationsStore({ pool }).importResearch(payload(Array.from({ length: 10 }, (_, i) => relation(i + 2)))), error => error.code === 'DATABASE_ERROR' && error.sqlState === '08006' && !/secret|private-host|postgres:/.test(error.message));
  assert.deepEqual(pool.state().rows, [old]); assert.equal(pool.calls.at(-1).sql, 'ROLLBACK'); assert.equal(pool.released, 1);
  assert.deepEqual(pool.state().archives, {});
});
test('claim uses transaction locks and SKIP LOCKED, expires claims, and prefers first-pass stocks in ticker order', async () => {
  const pool = recordingPool((sql, values) => ({ rows: sql.startsWith('SELECT run_id, to_char') ? [run] : sql.startsWith('WITH candidates') ? [{ ...security(2), attempts: 1, lease_owner: 'worker-1', lease_until: '2026-10-15T03:30:00Z', lease_token: values[5] }] : [] }));
  const result = await createRelationsStore({ pool }).claimJobs({ runId, workerId: 'worker-1' });
  const claim = pool.calls.find(call => call.sql.startsWith('WITH candidates'));
  assert.match(claim.sql, /FOR UPDATE OF j SKIP LOCKED/); assert.match(claim.sql, /lease_until <= clock_timestamp\(\)/); assert.match(claim.sql, /j.attempts = 0/); assert.match(claim.sql, /r.run_id = j.run_id/);
  assert.deepEqual(claim.values.slice(0, 5), [runId, 'worker-1', 10, 30, null]); assert.match(claim.values[5], /^[a-f0-9-]{36}$/); assert.equal(result[0].leaseToken, claim.values[5]); assert.equal(result[0].asOf, asOf); assert.equal(pool.calls.at(-1).sql, 'COMMIT');
});
test('status derives completion from actual run-isolated relation counts, not old ledger statuses', async () => {
  const stocks = [{ ...security(1), effective_status: 'completed', relation_count: 10, attempts: 1, gaps: [] }, { ...security(2), effective_status: 'partial', relation_count: 2, attempts: 2, gaps: ['上游证据不足。'] }, { ...security(3), effective_status: 'pending', relation_count: 0, attempts: 0, gaps: [] }];
  const pool = recordingPool(sql => ({ rows: sql.startsWith('SELECT run_id, to_char') ? [run] : stocks }));
  const result = await createRelationsStore({ pool }).status({ runId, includeStocks: true });
  assert.equal(result.totals.completed, 1); assert.equal(result.totals.relations, 12); assert.equal(result.totals.missing, 18); assert.equal(result.totals.remainingStocks, 2); assert.equal(result.gaps.length, 1);
  assert.match(pool.calls.at(-1).sql, /r.run_id = j.run_id AND r.subject_ticker = j.ticker/); assert.match(pool.calls.at(-1).sql, /count\(r.related_ticker\) = 10/);
});
test('release and failure bookkeeping preserve partial or completed data and sanitize supplied error text', async () => {
  const pool = recordingPool(sql => ({ rows: sql.startsWith('SELECT run_id, to_char') ? [run] : sql.startsWith('SELECT *, (lease_until') ? [{ name: '公司1', lease_active: false }] : sql.startsWith('UPDATE market_data.company_relation_jobs j SET status') ? [{ status: 'partial', ticker: security(1).ticker }] : [] }));
  const store = createRelationsStore({ pool });
  const failed = await store.markFailed({ runId, ticker: security(1).ticker, errorCode: 'postgres://secret@host' });
  assert.equal(failed.status, 'partial'); assert.equal(failed.errorCode, 'unknown_error');
  const result = await store.releaseJobs({ runId, workerId: 'worker-1' }); assert.equal(result.released, 1);
  assert.ok(pool.calls.filter(call => call.sql.startsWith('UPDATE')).every(call => !/DELETE FROM/.test(call.sql)));
});

test('new-run partial candidates stay in a job draft until all 10 replace a complete old publication', async () => {
  const oldRows = Array.from({ length: 10 }, (_, i) => stored(i + 2, 'old-run'));
  const pool = researchPool({ existing: oldRows }), store = createRelationsStore({ pool });
  const partial = await store.importResearch(payload([relation(2), relation(3), relation(4)]));
  assert.equal(partial.published, false); assert.equal(partial.draftCount, 3); assert.equal(partial.preservedPreviousCount, 10);
  assert.deepEqual(pool.state().rows, oldRows); assert.equal(pool.state().job.draft_relations.length, 3);
  const emptyAttempt = await store.importResearch(payload([]));
  assert.equal(emptyAttempt.relationCount, 3); assert.deepEqual(pool.state().rows, oldRows);
  const completed = await store.importResearch(payload(Array.from({ length: 7 }, (_, i) => relation(i + 5))));
  assert.equal(completed.status, 'completed'); assert.equal(completed.draftCount, 0); assert.equal(completed.publishedRelationCount, 10);
  assert.equal(pool.state().rows.length, 10); assert.ok(pool.state().rows.every(row => row.run_id === runId));
});
test('future research cutoffs and unknown explicitly requested frozen tickers are rejected', async () => {
  assert.throws(() => validateResearch(payload(undefined, { asOf: '2099-10-15' })), { code: 'VALIDATION_ERROR' });
  const pool = recordingPool(sql => ({ rows: sql.startsWith('SELECT run_id, to_char') ? [run] : [] }));
  await assert.rejects(createRelationsStore({ pool }).claimJobs({ runId, workerId: 'worker-1', tickers: ['999999.SZ'] }), { code: 'JOB_NOT_FOUND' });
  assert.ok(!pool.calls.some(call => call.sql.startsWith('WITH candidates')));
});

test('verification time uses an explicit version or the newest submitted source and rejects future versions', () => {
  const laterSource = { ...relation().sources[0], accessedAt: '2026-10-15T03:01:00Z' };
  assert.equal(validateResearch(payload([relation(2), relation(3, { sources: [laterSource] })])).researchedAt, '2026-10-15T03:01:00.000Z');
  assert.equal(validateResearch(payload(undefined, { researchedAt: '2026-10-15T11:02:00+08:00' })).researchedAt, '2026-10-15T03:02:00.000Z');
  assert.equal(validateResearch(payload([])).researchedAt, null);
  for (const researchedAt of ['2026-02-30T03:00:00Z', 'not-a-time', '2099-01-01T00:00:00Z']) assert.throws(() => validateResearch(payload(undefined, { researchedAt })), { code: 'VALIDATION_ERROR' });
  assert.throws(() => validateResearch(payload([relation(2, { sources: [{ ...laterSource, accessedAt: '2099-01-01T00:00:00Z' }] })])), { code: 'VALIDATION_ERROR' });
});

test('identical evidence replay preserves its version while stale changed evidence rolls back the whole import', async () => {
  const pool = researchPool(), store = createRelationsStore({ pool });
  await store.importResearch(payload());
  await store.importResearch(payload(undefined, { researchedAt: '2026-10-15T03:01:00Z' }));
  assert.equal(pool.state().rows[0].verified_at, '2026-10-15T03:00:00.000Z');
  const changed = relation(2, { rationale: '新核验后的明确结论。' });
  await assert.rejects(store.importResearch(payload([relation(3), changed])), { code: 'STALE_IMPORT' });
  assert.equal(pool.state().rows.length, 1);
  await store.importResearch(payload([changed], { researchedAt: '2026-10-15T03:01:00Z' }));
  await assert.rejects(store.importResearch(payload()), { code: 'STALE_IMPORT' });
  assert.equal(pool.state().rows[0].rationale, changed.rationale);
  assert.equal(pool.state().rows[0].verified_at, '2026-10-15T03:01:00.000Z');
});

test('complete replacement cannot discard evidence with an equal or newer version', async () => {
  const pool = researchPool(), store = createRelationsStore({ pool });
  await store.importResearch(payload(Array.from({ length: 10 }, (_, i) => relation(i + 2))));
  const replacement = Array.from({ length: 10 }, (_, i) => relation(i + 3));
  await assert.rejects(store.importResearch(payload(replacement), { replace: true }), { code: 'STALE_IMPORT' });
  assert.equal(pool.state().rows[0].related_ticker, security(2).ticker);
  await store.importResearch(payload(replacement, { researchedAt: '2026-10-15T03:01:00Z' }), { replace: true });
  assert.equal(pool.state().rows.find(row => row.related_ticker === security(3).ticker).verified_at, '2026-10-15T03:00:00.000Z');
  assert.equal(pool.state().rows.find(row => row.related_ticker === security(12).ticker).verified_at, '2026-10-15T03:01:00.000Z');
});

test('old partial publications survive refresh and remain readable from their original archive after replacement', async () => {
  const oldRows = [stored(2, 'old-run'), stored(3, 'old-run'), stored(4, 'old-run')];
  const pool = researchPool({ existing: oldRows }), store = createRelationsStore({ pool });
  const partial = await store.importResearch(payload([relation(5)]));
  assert.equal(partial.published, false); assert.equal(partial.preservedPreviousCount, 3);
  assert.deepEqual(pool.state().rows, oldRows);
  assert.equal((await store.getResearch({ runId, ticker: security(1).ticker })).relationSource, 'draft');
  const rest = [2, 3, 4, 6, 7, 8, 9, 10, 11].map(index => relation(index));
  await store.importResearch(payload(rest));
  const archived = await store.getResearch({ runId: 'old-run', ticker: security(1).ticker });
  assert.equal(archived.archivedCount, 3); assert.equal(archived.publishedRelationCount, 0); assert.equal(archived.relationSource, 'archive');
  assert.deepEqual(archived.relations.map(row => row.relatedTicker), oldRows.map(row => row.related_ticker));
  assert.equal(archived.relations[0].verifiedAt, oldRows[0].verified_at);
});

test('changed draft evidence also requires a newer verification version', async () => {
  const oldRows = [stored(2, 'old-run')], pool = researchPool({ existing: oldRows }), store = createRelationsStore({ pool });
  await store.importResearch(payload([relation(3)]));
  await assert.rejects(store.importResearch(payload([relation(3, { rationale: '旧缓存里的不同结论。' })])), { code: 'STALE_IMPORT' });
  assert.equal(pool.state().job.draft_relations[0].rationale, relation(3).rationale);
  assert.deepEqual(pool.state().rows, oldRows);
});

test('active token leases require the current generation for publication and failure bookkeeping', async () => {
  const currentToken = '11111111-1111-4111-8111-111111111111', oldToken = '22222222-2222-4222-8222-222222222222';
  const pool = researchPool({ job: { lease_active: true, lease_owner: 'worker', lease_token: currentToken } }), store = createRelationsStore({ pool });
  await assert.rejects(store.importResearch(payload(), { workerId: 'worker' }), { code: 'LEASE_CONFLICT' });
  await assert.rejects(store.importResearch(payload(), { workerId: 'worker', leaseToken: oldToken }), { code: 'LEASE_CONFLICT' });
  await assert.rejects(store.markFailed({ runId, ticker: security(1).ticker, workerId: 'worker', leaseToken: oldToken }), { code: 'LEASE_CONFLICT' });
  assert.equal(pool.state().job.lease_token, currentToken);
  await store.importResearch(payload(), { workerId: 'worker', leaseToken: currentToken });
  assert.equal(pool.state().job.lease_token, null);
  const releases = recordingPool(() => ({ rows: [] }));
  await createRelationsStore({ pool: releases }).releaseJobs({ runId, workerId: 'worker', leaseToken: oldToken });
  assert.match(releases.calls[0].sql, /lease_token IS NULL OR lease_token = \$4::uuid/);
  assert.equal(releases.calls[0].values[3], oldToken);
});


test('HK subjects retain the A-share counterparty rule and strict evidence validation', () => {
  assert.equal(validateResearch(payload(undefined, { ticker: '00700.HK' })).ticker, '00700.HK');
  assert.throws(() => validateResearch(payload([relation(2, { relatedTicker: '02313.HK' })], { ticker: '00700.HK' })), { code: 'VALIDATION_ERROR' });
  for (const ticker of ['700.HK', '000700.HK', '00700.US']) assert.throws(() => validateResearch(payload(undefined, { ticker })), { code: 'VALIDATION_ERROR' });
  assert.throws(() => validateResearch(payload([relation(2, { sources: [] })], { ticker: '00700.HK' })), { code: 'VALIDATION_ERROR' });
});

test('scoped init freezes all A counterparties plus explicit HK subjects while validating A identities', async () => {
  const securities = [security(1), security(2)].map(row => ({ ts_code: row.ticker, name: row.name, industry: '行业', industry_classifications: [] }));
  const subjects = [{ ticker: '00700.HK', name: '腾讯控股', industry: '互联网' }, security(1)];
  const pool = recordingPool(sql => ({ rows: sql.startsWith('SELECT run_id, to_char') ? [] : sql.startsWith('SELECT s.ts_code') ? securities : sql.startsWith('INSERT INTO market_data.company_relation_runs') ? [{ ...run, securities_count: 3 }] : [] }));
  const store = createRelationsStore({ pool });
  assert.equal((await store.initRun({ runId, asOf, subjects })).securitiesCount, 3);
  const frozen = JSON.parse(pool.calls.find(call => call.sql.startsWith('INSERT INTO market_data.company_relation_jobs')).values[1]);
  assert.deepEqual(frozen.filter(row => row.is_subject).map(row => row.ts_code), ['000001.SZ', '00700.HK']);
  assert.equal(frozen.find(row => row.ts_code === '000002.SZ').is_subject, false);
  assert.deepEqual(JSON.parse(pool.calls.find(call => call.sql.startsWith('INSERT INTO market_data.company_relation_runs')).values[4]), validateRelationSubjects(subjects));
  for (const subjects of [[{ ticker: '999999.SZ', name: '不存在' }], [{ ticker: '000001.SZ', name: '错误名称' }]]) await assert.rejects(store.initRun({ runId, asOf, subjects }), { code: 'VALIDATION_ERROR' });
  for (const subjects of [[], [security(1), security(1)], [{ ticker: '700.HK', name: '腾讯' }], [{ ticker: '00700.HK', name: ' ' }]]) assert.throws(() => validateRelationSubjects(subjects), { code: 'VALIDATION_ERROR' });
});

test('scope identity is immutable and ordered input can safely reuse the same frozen run', async () => {
  const subjects = [security(1), { ticker: '00700.HK', name: '腾讯控股' }];
  const pool = recordingPool(sql => ({ rows: sql.startsWith('SELECT run_id, to_char') ? [{ ...run, subject_scope: validateRelationSubjects(subjects) }] : [] }));
  const store = createRelationsStore({ pool });
  assert.equal((await store.initRun({ runId, asOf, subjects: [...subjects].reverse() })).created, false);
  for (const changed of [undefined, [security(1)], [security(1), { ticker: '00700.HK', name: '新名称' }]]) await assert.rejects(store.initRun({ runId, asOf, subjects: changed }), { code: 'VALIDATION_ERROR' });
  assert.ok(!pool.calls.some(call => call.sql.startsWith('INSERT')));
});

test('candidate-only rows cannot become tasks and newer scopes supersede only overlapping subjects', async () => {
  const pool = recordingPool(sql => ({ rows: sql.startsWith('SELECT run_id, to_char') ? [run] : [] }));
  const store = createRelationsStore({ pool });
  await assert.rejects(store.importResearch(payload()), { code: 'JOB_NOT_FOUND' });
  assert.match(pool.calls.find(call => call.sql.startsWith('SELECT newer.run_id')).sql, /j.ticker = \$2 AND j.is_subject/);
  assert.match(pool.calls.find(call => call.sql.startsWith('SELECT *,')).sql, /AND is_subject FOR UPDATE/);
  await assert.rejects(store.markFailed({ runId, ticker: security(2).ticker }), { code: 'JOB_NOT_FOUND' });
  await assert.rejects(store.claimJobs({ runId, workerId: 'w', tickers: [security(2).ticker] }), { code: 'JOB_NOT_FOUND' });
  await store.claimJobs({ runId, workerId: 'w' });
  const claim = pool.calls.find(call => call.sql.startsWith('WITH candidates'));
  assert.match(claim.sql, /j.is_subject/);
  assert.match(claim.sql, /next_job.ticker = j.ticker AND next_job.is_subject/);
  assert.equal(claim.values.length, 6);
  assert.match(claim.sql, /current.run_id = j.run_id/);
  assert.match(claim.sql, /newer.created_at > current.created_at/);
  assert.doesNotMatch(claim.sql, /\$[78]/);
  await store.releaseJobs({ runId, workerId: 'w' });
  assert.match(pool.calls.at(-1).sql, /WHERE run_id = \$1 AND is_subject/);
  await store.status({ runId });
  assert.match(pool.calls.at(-1).sql, /WHERE j.run_id = \$1 AND j.is_subject/);
});


test('HK subject publication uses its frozen name and existing transactional safeguards', async () => {
  const pool = researchPool({ job: { name: '腾讯控股' } });
  const result = await createRelationsStore({ pool }).importResearch(payload(undefined, { ticker: '00700.HK' }));
  assert.equal(result.status, 'partial');
  assert.equal(pool.state().rows[0].subject_ticker, '00700.HK');
  assert.equal(pool.state().rows[0].subject_name, '腾讯控股');
  assert.equal(pool.state().rows[0].related_ticker, '000002.SZ');
});
