import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelationsManualStore, validateManualRelationChanges } from '../backend/market-data/relations-manual-store.mjs';

const asOf = '2026-10-19';
const actualNow = '2026-10-19T03:04:05.000Z';
const now = () => new Date(actualNow);
const securities = [
  { ts_code: '002920.SZ', name: '德赛西威', market: 'A', list_status: 'L' },
  { ts_code: '300750.SZ', name: '宁德时代', market: 'A', list_status: 'L' },
  { ts_code: '601127.SH', name: '赛力斯', market: 'A', list_status: 'L' },
  { ts_code: '00700.HK', name: '腾讯控股', market: 'HK', list_status: 'L' },
];
const change = (overrides = {}) => ({ action: 'upsert', relatedTicker: '300750.SZ', relationType: 'upstream', ...overrides });
const payload = (changes = [change()], overrides = {}) => ({ ticker: '002920.SZ', asOf, expectedRevision: '0', changes, ...overrides });
const domainError = (code, status) => error => error?.name === 'ResearchError' && error.code === code && error.status === status;
const invalid = domainError('INVALID_MANUAL_RELATIONS', 400);
const unavailable = error => domainError('RELATIONS_DATABASE_UNAVAILABLE', 503)(error)
  && !/secret|private-host|postgres:|driver failure/i.test(error.message);
const normalizeSql = sql => sql.replace(/\s+/g, ' ').trim();

/** A row lock serializes revision reads; events become visible only after commit. */
function manualPool({ securityRows = securities, revision = '0', currentRelations = [], manualEvents = [], failAt, failConnect = false, failEnd = false } = {}) {
  const calls = [];
  let state = { revision, events: structuredClone(manualEvents) }, released = 0, connected = 0, ended = 0;
  let lockTail = Promise.resolve();
  async function query(sql, values, context) {
    const normalized = normalizeSql(sql);
    calls.push({ sql, normalized, values, client: context?.id ?? null });
    if (failAt && (typeof failAt === 'function' ? failAt(normalized, values) : normalized.includes(failAt))) {
      throw new Error('driver failure postgres://user:secret@private-host/database');
    }
    if (normalized === 'BEGIN') { context.active = true; context.events = []; return { rows: [] }; }
    if (normalized === 'COMMIT') {
      if (context.nextRevision !== undefined) state = { revision: context.nextRevision, events: [...state.events, ...context.events] };
      context.active = false; context.unlock?.(); context.unlock = null;
      return { rows: [] };
    }
    if (normalized === 'ROLLBACK') {
      context.active = false; context.events = []; context.unlock?.(); context.unlock = null;
      return { rows: [] };
    }
    if (/\bFROM market_data\.securities\b/i.test(normalized)) {
      return { rows: securityRows.filter(row => values[0].includes(row.ts_code)) };
    }
    if (/\bFROM market_data\.company_relation_current\b/i.test(normalized)) {
      return { rows: currentRelations.length ? [{ relations: currentRelations, as_of: asOf }] : [] };
    }
    if (/^SELECT\b/i.test(normalized) && /\bFROM market_data\.company_relation_manual_events\b/i.test(normalized)) {
      return { rows: state.events.map(values => ({ relatedTicker: values[1], relatedName: values[2], revision: values[3],
        effectiveDate: values[4], action: values[5], relationType: values[6], rationale: values[7], manualUpdatedAt: values[8] })) };
    }
    if (/^SELECT\b/i.test(normalized) && /\bFROM market_data\.company_relation_manual_subjects\b/i.test(normalized)) {
      assert.match(normalized, /\bFOR UPDATE\b/i);
      const previous = lockTail;
      lockTail = new Promise(resolve => { context.unlock = resolve; });
      await previous;
      return { rows: [{ revision: state.revision }] };
    }
    if (/^INSERT INTO market_data\.company_relation_manual_events\b/i.test(normalized)) {
      context.events.push(structuredClone(values)); return { rows: [] };
    }
    if (/^UPDATE market_data\.company_relation_manual_subjects\b/i.test(normalized)) {
      const revisionIndex = /SET revision\s*=\s*\$1\b/i.test(normalized) ? 0 : 1;
      context.nextRevision = String(values[revisionIndex]); return { rows: [{ revision: context.nextRevision }] };
    }
    return { rows: [] };
  }
  const pool = {
    calls,
    get released() { return released; },
    get connected() { return connected; },
    get ended() { return ended; },
    state() { return structuredClone(state); },
    async query(sql, values) { return query(sql, values); },
    async connect() {
      if (failConnect) throw new Error('postgres://user:secret@private-host/database');
      const context = { id: ++connected };
      return { query: (sql, values) => query(sql, values, context), release() { released++; context.unlock?.(); context.unlock = null; } };
    },
    async end() { ended++; if (failEnd) throw new Error('postgres://user:secret@private-host/database'); },
  };
  return pool;
}

test('manual validation normalizes A/HK codes and keeps an omitted rationale empty', () => {
  const result = validateManualRelationChanges(payload([
    change({ relatedTicker: ' 00700.hk ', relationType: 'peer' }),
  ], { ticker: ' 002920.sz ' }), now);
  assert.equal(result.ticker, '002920.SZ');
  assert.equal(result.asOf, asOf);
  assert.equal(result.expectedRevision, '0');
  assert.equal(result.changes[0].relatedTicker, '00700.HK');
  assert.equal(result.changes[0].relationType, 'peer');
  assert.equal(result.changes[0].rationale, '');
  assert.equal(validateManualRelationChanges(payload([change()], { ticker: '00700.hk' }), now).ticker, '00700.HK');
});

test('manual validation rejects unsupported input, future or impossible Shanghai dates, and invalid revisions', async () => {
  const bad = [
    null, [], { ...payload(), extra: true },
    payload(undefined, { ticker: '700.HK' }), payload(undefined, { ticker: '002920.US' }),
    payload(undefined, { ticker: null }), payload(undefined, { asOf: '2026-10-20' }),
    payload(undefined, { asOf: '2026-02-30' }), payload(undefined, { asOf: '20261019' }),
    payload(undefined, { asOf: null }), payload(undefined, { expectedRevision: 0 }),
    payload(undefined, { expectedRevision: '-1' }), payload(undefined, { expectedRevision: '1.5' }),
    payload(undefined, { expectedRevision: undefined }), payload(undefined, { changes: null }),
  ];
  const pool = manualPool(), store = createRelationsManualStore({ pool, now });
  for (const input of bad) {
    assert.throws(() => validateManualRelationChanges(input, now), invalid);
    await assert.rejects(store.save(input), invalid);
  }
  assert.equal(pool.connected, 0); assert.equal(pool.calls.length, 0);
});

test('manual date validation follows Shanghai today across the UTC day boundary', () => {
  const shanghaiNextDay = () => new Date('2026-10-18T16:01:00.000Z');
  assert.equal(validateManualRelationChanges(payload(), shanghaiNextDay).asOf, '2026-10-19');
  assert.throws(() => validateManualRelationChanges(payload(undefined, { asOf: '2026-10-20' }), shanghaiNextDay), invalid);
});

test('remove and restore accept an absent or null role and normalize it to null', () => {
  for (const action of ['remove', 'restore']) {
    for (const relationType of [undefined, null]) {
      const result = validateManualRelationChanges(payload([{ action, relatedTicker: '300750.SZ', relationType }]), now);
      assert.equal(result.changes[0].relationType, null);
      assert.equal(result.changes[0].rationale, '');
    }
  }
});

test('manual validation rejects extra change fields, self links, duplicate normalized codes, and malformed roles or rationale', () => {
  const bad = [
    [null], [change({ action: 'delete' })], [change({ relatedTicker: '002920.SZ' })],
    [change(), change({ relatedTicker: ' 300750.sz ', relationType: 'peer' })],
    [change({ relatedTicker: '300750.SZ; DROP TABLE securities' })],
    [change({ relatedTicker: '700.HK' })], [change({ relationType: undefined })],
    [change({ relationType: 'supplier' })], [change({ relationType: null })],
    [change({ rationale: null })], [change({ rationale: {} })], [change({ rationale: 3 })],
    [change({ rationale: 'bad\u0000text' })], [change({ relatedName: '客户端伪造名称' })],
    [change({ evidenceType: 'manual' })],
  ];
  for (const changes of bad) assert.throws(() => validateManualRelationChanges(payload(changes), now), invalid);
});

test('manual save uses one transaction, canonical security names, row locks, and one new revision for a batch', async () => {
  const pool = manualPool(), store = createRelationsManualStore({ pool, now });
  const result = await store.save(payload([
    change({ rationale: '人工确认供应链关系' }),
    change({ relatedTicker: '00700.HK', relationType: 'peer' }),
  ]));
  assert.deepEqual(result, { ticker: '002920.SZ', asOf, revision: '1', changedCount: 2 });
  assert.equal(pool.calls[0].normalized, 'BEGIN');
  assert.match(pool.calls[1].normalized, /pg_advisory_xact_lock\(hashtext\('company-relations-current'\), hashtext\(\$1\)\)/);
  assert.deepEqual(pool.calls[1].values, ['002920.SZ']);
  assert.equal(pool.calls.at(-1).normalized, 'COMMIT');
  assert.equal(pool.connected, 1); assert.equal(pool.released, 1);
  const names = pool.calls.find(call => /\bFROM market_data\.securities\b/.test(call.normalized));
  assert.match(names.normalized, /ts_code\s*=\s*ANY\(\$1::text\[\]\)/i);
  assert.match(names.normalized, /\bFOR SHARE\b/i);
  assert.deepEqual(new Set(names.values[0]), new Set(['002920.SZ', '300750.SZ', '00700.HK']));
  const init = pool.calls.find(call => /^INSERT INTO market_data\.company_relation_manual_subjects\b/.test(call.normalized));
  assert.match(init.normalized, /ON CONFLICT.*DO NOTHING/i);
  const lock = pool.calls.find(call => /^SELECT\b/.test(call.normalized) && /company_relation_manual_subjects/.test(call.normalized));
  assert.match(lock.normalized, /FOR UPDATE/);
  assert.equal(pool.state().revision, '1');
  assert.deepEqual(pool.state().events, [
    ['002920.SZ', '300750.SZ', '宁德时代', '1', asOf, 'upsert', 'upstream', '人工确认供应链关系', actualNow],
    ['002920.SZ', '00700.HK', '腾讯控股', '1', asOf, 'upsert', 'peer', '', actualNow],
  ]);
  assert.ok(pool.calls.every(call => call.client === 1));
});

test('manual rationale is a bound parameter even when it contains SQL punctuation or markup', async () => {
  const rationale = `人工备注 '; DROP TABLE market_data.company_relations; -- <script>alert(1)</script>`;
  const pool = manualPool();
  await createRelationsManualStore({ pool, now }).save(payload([change({ rationale })]));
  const insert = pool.calls.find(call => /^INSERT INTO market_data\.company_relation_manual_events\b/.test(call.normalized));
  assert.equal(insert.values[7], rationale);
  assert.ok(pool.calls.every(call => !call.sql.includes(rationale)));
  assert.equal(pool.state().events[0][2], '宁德时代');
});

test('remove and restore append audit events instead of deleting researched or manual records', async () => {
  const pool = manualPool(), store = createRelationsManualStore({ pool, now });
  assert.equal((await store.save(payload([{ action: 'remove', relatedTicker: '300750.SZ' }]))).revision, '1');
  assert.equal((await store.save(payload([{ action: 'restore', relatedTicker: '300750.SZ' }], { expectedRevision: '1' }))).revision, '2');
  assert.deepEqual(pool.state().events, [
    ['002920.SZ', '300750.SZ', '宁德时代', '1', asOf, 'remove', null, '', actualNow],
    ['002920.SZ', '300750.SZ', '宁德时代', '2', asOf, 'restore', null, '', actualNow],
  ]);
  assert.ok(pool.calls.every(call => !/\b(?:DELETE|TRUNCATE)\b/i.test(call.sql)));
  assert.ok(pool.calls.every(call => !/\b(?:INSERT INTO|UPDATE) market_data\.(?:company_relations|company_relation_jobs|company_relation_runs)\b/i.test(call.sql)));
});

test('unknown subjects or counterparties and blank reference names cannot create manual history', async () => {
  for (const options of [
    { securityRows: securities.filter(row => row.ts_code !== '002920.SZ') },
    { securityRows: securities.filter(row => row.ts_code !== '300750.SZ') },
    { securityRows: securities.map(row => row.ts_code === '300750.SZ' ? { ...row, name: ' ' } : row) },
    { securityRows: securities.map(row => row.ts_code === '002920.SZ' ? { ...row, name: '' } : row) },
  ]) {
    const pool = manualPool(options);
    await assert.rejects(createRelationsManualStore({ pool, now }).save(payload()), domainError('UNKNOWN_SECURITY', 404));
    assert.equal(pool.state().revision, '0'); assert.deepEqual(pool.state().events, []);
    assert.equal(pool.calls.at(-1).normalized, 'ROLLBACK'); assert.equal(pool.released, 1);
    assert.ok(!pool.calls.some(call => /^INSERT INTO market_data\.company_relation_manual_events\b/.test(call.normalized)));
  }
});

test('a stale revision rolls back without appending an event or advancing the subject revision', async () => {
  const pool = manualPool({ revision: '7' });
  await assert.rejects(createRelationsManualStore({ pool, now }).save(payload(undefined, { expectedRevision: '6' })), domainError('RELATIONS_REVISION_CONFLICT', 409));
  assert.deepEqual(pool.state(), { revision: '7', events: [] });
  assert.equal(pool.calls.at(-1).normalized, 'ROLLBACK'); assert.equal(pool.released, 1);
});

test('two concurrent writers with the same revision token cannot both commit', async () => {
  const pool = manualPool(), store = createRelationsManualStore({ pool, now });
  const results = await Promise.allSettled([
    store.save(payload([change({ rationale: '第一次修改' })])),
    store.save(payload([change({ rationale: '第二次修改' })])),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.ok(domainError('RELATIONS_REVISION_CONFLICT', 409)(rejected.reason));
  assert.equal(pool.state().revision, '1'); assert.equal(pool.state().events.length, 1);
  assert.equal(pool.calls.filter(call => call.normalized === 'COMMIT').length, 1);
  assert.equal(pool.calls.filter(call => call.normalized === 'ROLLBACK').length, 1);
  assert.equal(pool.released, 2);
});

test('revision arithmetic retains precision above the JavaScript safe integer range', async () => {
  const revision = '9007199254740993', pool = manualPool({ revision });
  const result = await createRelationsManualStore({ pool, now }).save(payload(undefined, { expectedRevision: revision }));
  assert.equal(result.revision, '9007199254740994');
  assert.equal(pool.state().events[0][3], '9007199254740994');
});

test('an event failure rolls back the entire batch and hides PostgreSQL driver details', async () => {
  let inserts = 0;
  const pool = manualPool({ failAt: sql => /^INSERT INTO market_data\.company_relation_manual_events\b/.test(sql) && ++inserts === 2 });
  await assert.rejects(createRelationsManualStore({ pool, now }).save(payload([
    change(), change({ relatedTicker: '00700.HK', relationType: 'downstream' }),
  ])), unavailable);
  assert.deepEqual(pool.state(), { revision: '0', events: [] });
  assert.equal(pool.calls.at(-1).normalized, 'ROLLBACK'); assert.equal(pool.released, 1);
});

test('security lookup, revision update and connection errors are sanitized and release acquired clients', async () => {
  for (const failAt of ['FROM market_data.securities', 'UPDATE market_data.company_relation_manual_subjects']) {
    const pool = manualPool({ failAt });
    await assert.rejects(createRelationsManualStore({ pool, now }).save(payload()), unavailable);
    assert.deepEqual(pool.state(), { revision: '0', events: [] });
    assert.equal(pool.calls.at(-1).normalized, 'ROLLBACK'); assert.equal(pool.released, 1);
  }
  const pool = manualPool({ failConnect: true });
  await assert.rejects(createRelationsManualStore({ pool, now }).save(payload()), unavailable);
  assert.equal(pool.calls.length, 0); assert.equal(pool.released, 0);
});

test('manual migration only creates its own additive schema and never mutates researched business tables', async () => {
  const pool = manualPool();
  await createRelationsManualStore({ pool, now }).migrate();
  const sql = pool.calls.map(call => call.sql).join('\n').replace(/--[^\n]*/g, '');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS market_data\.company_relation_manual_subjects/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS market_data\.company_relation_manual_events/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS market_data\.company_relation_current/i);
  const withoutSummaryAddition=sql.replace(/ALTER TABLE market_data\.company_relation_current ADD COLUMN IF NOT EXISTS refresh_summary jsonb NOT NULL DEFAULT '\{\}'::jsonb;/i,'');
  assert.doesNotMatch(withoutSummaryAddition, /\b(?:DELETE|TRUNCATE|DROP|ALTER)\b|\b(?:INSERT INTO|UPDATE)\b/i);
  assert.doesNotMatch(sql, /(?:CREATE TABLE(?: IF NOT EXISTS)?|COMMENT ON TABLE|COMMENT ON COLUMN) market_data\.(?:company_relations|company_relation_jobs|company_relation_runs)\b/i);
});

const manySecurities = Array.from({ length: 15 }, (_, index) => ({
  ts_code: `${String(index + 1).padStart(6, '0')}.SZ`, name: `公司${index + 1}`, market: 'A',
}));
const savedRelations = count => manySecurities.slice(0, count).map(row => ({
  relatedTicker: row.ts_code, relatedName: row.name, relationType: 'peer', evidenceType: 'business_comparable',
}));

test('manual save rejects an eleventh company against the current report and leaves revisions and events unchanged', async () => {
  const pool = manualPool({ securityRows: [...securities, ...manySecurities], currentRelations: savedRelations(10) });
  await assert.rejects(createRelationsManualStore({ pool, now }).save(payload([change({ relatedTicker: manySecurities[10].ts_code })])), invalid);
  assert.deepEqual(pool.state(), { revision: '0', events: [] });
  assert.equal(pool.calls.at(-1).normalized, 'ROLLBACK');
  assert.ok(!pool.calls.some(call => /^INSERT INTO market_data\.company_relation_manual_events\b/.test(call.normalized)));
});

test('manual limit counts persisted overrides, allows remove-plus-add in the same batch, and permits changing an existing company', async () => {
  const pool = manualPool({ securityRows: [...securities, ...manySecurities], currentRelations: savedRelations(9) });
  const store = createRelationsManualStore({ pool, now });
  await store.save(payload([change({ relatedTicker: manySecurities[9].ts_code })]));
  await assert.rejects(store.save(payload([change({ relatedTicker: manySecurities[10].ts_code })], { expectedRevision: '1' })), invalid);
  assert.equal(pool.state().revision, '1'); assert.equal(pool.state().events.length, 1);
  await store.save(payload([{ action: 'remove', relatedTicker: manySecurities[0].ts_code },
    change({ relatedTicker: manySecurities[10].ts_code })], { expectedRevision: '1' }));
  assert.equal(pool.state().revision, '2');
  await store.save(payload([change({ relatedTicker: manySecurities[1].ts_code, relationType: 'downstream' })], { expectedRevision: '2' }));
  assert.equal(pool.state().revision, '3');
});

test('restoring a removed researched company is rejected if other manual additions already occupy all ten places', async () => {
  const pool = manualPool({ securityRows: [...securities, ...manySecurities], currentRelations: savedRelations(10) });
  const store = createRelationsManualStore({ pool, now });
  await store.save(payload([{ action: 'remove', relatedTicker: manySecurities[0].ts_code },
    change({ relatedTicker: manySecurities[10].ts_code })]));
  await assert.rejects(store.save(payload([{ action: 'restore', relatedTicker: manySecurities[0].ts_code }], { expectedRevision: '1' })), invalid);
  assert.equal(pool.state().revision, '1'); assert.equal(pool.state().events.length, 2);
});

test('manual close ends the pool and sanitizes shutdown failure', async () => {
  const pool = manualPool(); await createRelationsManualStore({ pool, now }).close(); assert.equal(pool.ended, 1);
  await assert.rejects(createRelationsManualStore({ pool: manualPool({ failEnd: true }), now }).close(), unavailable);
});
