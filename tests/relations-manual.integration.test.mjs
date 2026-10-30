import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createResearchServer } from '../backend/app.mjs';
import { createMarketStore } from '../backend/market-data/postgres-store.mjs';
import { createRelationsStore, RELATIONS_METHOD_VERSION } from '../backend/market-data/relations-store.mjs';
import { createRelationsReadService } from '../backend/market-data/relations-read-service.mjs';
import { createRelationsAiStore } from '../backend/market-data/relations-ai-store.mjs';
import { createHkMarketStore } from '../backend/market-data/hk-market-store.mjs';
import { createValuationStore } from '../backend/market-data/valuation-store.mjs';
import { createHkValuationStore } from '../backend/market-data/hk-valuation-store.mjs';
import { createIndustryStore } from '../backend/market-data/industry-store.mjs';
import {
  createRelationsManualStore, mergeManualRelations,
  MANUAL_RELATION_FIELDS, MANUAL_RELATION_JOINS,
} from '../backend/market-data/relations-manual-store.mjs';

// Opt-in, generated schema only. Every business-schema reference is rewritten.
const enabled = process.env.RELATIONS_DATABASE_TESTS === '1' && Boolean(process.env.DATABASE_URL);
test('PostgreSQL integration: manual persistence, revisions, rollback, AI refresh, cutoffs, HK and audit', { skip: !enabled }, async t => {
  const schema = `relations_manual_test_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^relations_manual_test_[a-f0-9]{32}$/);
  const connectionString = process.env.DATABASE_URL;
  const admin = new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000 });
  const rewrite = sql => sql.replaceAll('market_data.', `${schema}.`)
    .replaceAll('CREATE SCHEMA IF NOT EXISTS market_data', `CREATE SCHEMA IF NOT EXISTS ${schema}`);
  const ticker = n => `${String(n).padStart(6, '0')}.SZ`;
  const name = n => `集成测试公司${n}`;
  const asOf = '2026-10-19', now = () => new Date('2026-10-19T03:04:05.000Z');
  const sessions = new Set();
  let schemaCreated = false, failEventTicker;
  function session() {
    const raw = new pg.Pool({ connectionString, max: 6, connectionTimeoutMillis: 5000 });
    sessions.add(raw);
    const wrapped = {
      async query(sql, values) { return raw.query(rewrite(sql), values); },
      async connect() {
        const client = await raw.connect();
        return { async query(sql, values) {
          if (failEventTicker && /^INSERT INTO market_data\.company_relation_manual_events\b/.test(sql) && values[1] === failEventTicker) {
            throw new Error('private injected database failure');
          }
          return client.query(rewrite(sql), values);
        }, release() { client.release(); } };
      },
      async end() { sessions.delete(raw); await raw.end(); },
    };
    return { raw, wrapped, manual: createRelationsManualStore({ pool: wrapped, now }),
      research: createRelationsStore({ pool: wrapped }), read: createRelationsReadService({ pool: wrapped, now }) };
  }
  const saveInput = (subject, changes, revision = '0', effectiveDate = asOf) => ({ ticker: subject, asOf: effectiveDate, expectedRevision: revision, changes });
  const upsert = (relatedTicker, relationType = 'upstream', rationale = '') => ({ action: 'upsert', relatedTicker, relationType, rationale });
  async function manualSnapshot(subject, cutoff = asOf) {
    const result = await admin.query(rewrite(`SELECT ${MANUAL_RELATION_FIELDS}
      FROM market_data.securities s ${MANUAL_RELATION_JOINS} WHERE s.ts_code = $1`), [subject, cutoff]);
    return result.rows[0];
  }
  async function effectiveRelations(subject, base = [], cutoff = asOf) {
    const snapshot = await manualSnapshot(subject, cutoff);
    return mergeManualRelations(base, snapshot?.manual_events, { ticker: subject, asOf: cutoff });
  }
  const aiRelation = (n, verifiedAt) => ({
    relatedTicker: ticker(n), relatedName: name(n), relationType: 'peer', evidenceType: 'business_comparable',
    rationale: '公开资料显示同类经营业务。', actualEntity: name(n), listedMappingBasis: '上市公司本体。', notes: '',
    sources: [{ url: 'https://example.com/annual-report', title: '测试年报', publishedAt: '2026-10-01',
      excerpt: '公司从事相关产品研发、生产与销售。', accessedAt: verifiedAt, readingScope: 'full_text' }],
  });
  const aiPayload = (runId, subject, others, cutoff) => ({
    runId, ticker: subject, asOf: cutoff, methodVersion: RELATIONS_METHOD_VERSION, gaps: [],
    relations: others.map(n => aiRelation(n, `${cutoff}T00:00:00.000Z`)),
  });
  try {
    try { await admin.query(`CREATE SCHEMA ${schema}`); schemaCreated = true; }
    catch (error) {
      if (['42501', 'ECONNREFUSED', 'ENOTFOUND', '3D000', '28P01'].includes(error?.code)) {
        t.skip('Isolated PostgreSQL schema unavailable; run with a test database and CREATE SCHEMA permission.');
        return;
      }
      throw error;
    }
    let active = session();
    await createMarketStore({ pool: active.wrapped }).migrate();
    await createValuationStore({ pool: active.wrapped }).migrate();
    await createHkValuationStore({ pool: active.wrapped }).migrate();
    await createIndustryStore({ pool: active.wrapped }).migrate();
    await createHkMarketStore({ pool: active.wrapped }).migrate();
    await createRelationsAiStore({ pool: active.wrapped, now }).migrate();
    await active.research.migrate();
    await active.manual.migrate();
    await active.manual.migrate();
    await admin.query(`INSERT INTO ${schema}.securities (ts_code, name, market, industry, list_status, source)
      SELECT lpad(n::text, 6, '0') || '.SZ', '集成测试公司' || n, 'A', '测试行业', 'L', 'integration_test' FROM generate_series(1, 20) n`);
    await admin.query(`INSERT INTO ${schema}.securities (ts_code, name, market, list_status, source)
      VALUES ('00700.HK','腾讯控股','HK','L','integration_test'),('02313.HK','申洲国际','HK','L','integration_test')`);

    await t.test('closing and reopening the actual connection pool retains canonical names and events', async () => {
      const saved = await active.manual.save(saveInput(ticker(1), [upsert(ticker(2), 'upstream', '人工备注')], '0', '2026-10-17'));
      assert.equal(saved.revision, '1');
      const firstRaw = active.raw;
      await active.manual.close();
      assert.ok(!sessions.has(firstRaw));
      active = session();
      const snapshot = await manualSnapshot(ticker(1));
      assert.equal(snapshot.manual_revision, '1');
      assert.equal(snapshot.manual_events[0].relatedName, name(2));
      assert.equal(new Date(snapshot.manual_events[0].manualUpdatedAt).toISOString(), '2026-10-19T03:04:05.000Z');
      const effective = await effectiveRelations(ticker(1));
      assert.equal(effective.relations[0].origin, 'manual');
      assert.deepEqual(effective.relations[0].sources, []);
      assert.equal(effective.relations[0].rationale, '人工备注');
      const displayed = await active.read.get({ ticker: ticker(1), asOf });
      assert.equal(displayed.status, 'customized'); assert.equal(displayed.meta.manualRevision, '1');
      assert.equal(displayed.subject.name, name(1)); assert.equal(displayed.relations[0].relatedName, name(2));
      assert.equal(displayed.relations[0].market.status, 'no_prices');
    });

    await t.test('real row locks reject one of two writers holding the same revision', async () => {
      const outcomes = await Promise.allSettled([
        active.manual.save(saveInput(ticker(1), [upsert(ticker(3))], '1')),
        active.manual.save(saveInput(ticker(1), [upsert(ticker(4))], '1')),
      ]);
      assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
      const rejected = outcomes.find(value => value.status === 'rejected');
      assert.equal(rejected.reason.code, 'RELATIONS_REVISION_CONFLICT'); assert.equal(rejected.reason.status, 409);
      const count = await admin.query(`SELECT count(*)::integer AS count FROM ${schema}.company_relation_manual_events WHERE subject_ticker = $1`, [ticker(1)]);
      assert.equal(count.rows[0].count, 2); assert.equal((await manualSnapshot(ticker(1))).manual_revision, '2');
    });

    await t.test('failure after an inserted event rolls back both batch rows and the revision head', async () => {
      failEventTicker = ticker(6);
      try {
        await assert.rejects(active.manual.save(saveInput(ticker(1), [upsert(ticker(5)), upsert(ticker(6))], '2')), error => error.code === 'RELATIONS_DATABASE_UNAVAILABLE' && error.status === 503 && !error.message.includes('private'));
      } finally { failEventTicker = undefined; }
      assert.equal((await manualSnapshot(ticker(1))).manual_revision, '2');
      const rows = await admin.query(`SELECT related_ticker FROM ${schema}.company_relation_manual_events WHERE subject_ticker = $1 AND related_ticker = ANY($2::text[])`, [ticker(1), [ticker(5), ticker(6)]]);
      assert.deepEqual(rows.rows, []);
    });

    await t.test('HTTP POST to the real store is visible in GET and survives server and pool restart', async () => {
      const allowedOrigins = [];
      const server = createResearchServer({ relationsManualService: active.manual, relationsService: active.read, allowedOrigins });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const base = `http://127.0.0.1:${server.address().port}`;
      allowedOrigins.push(base);
      try {
        const response = await fetch(`${base}/api/relations/manual`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
          body: JSON.stringify(saveInput(ticker(17), [upsert('00700.HK', 'downstream', 'HTTP真实落库')], '0')),
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('Access-Control-Allow-Origin'), base);
        assert.deepEqual(await response.json(), { data: { ticker: ticker(17), asOf, revision: '1', changedCount: 1 } });
        const getResponse = await fetch(`${base}/api/relations?ticker=${ticker(17)}&asOf=${asOf}`, { headers: { Origin: base } });
        assert.equal(getResponse.status, 200);
        const { data } = await getResponse.json();
        assert.equal(data.meta.manualRevision, '1'); assert.equal(data.status, 'customized');
        assert.equal(data.relations.length, 1); assert.equal(data.relations[0].relatedName, '腾讯控股');
        assert.equal(data.relations[0].relationType, 'downstream'); assert.equal(data.relations[0].rationale, 'HTTP真实落库');
      } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
      const closedPool = active.raw;
      await active.manual.close();
      assert.ok(!sessions.has(closedPool));
      active = session();
      const reopened = await active.read.get({ ticker: ticker(17), asOf });
      assert.equal(reopened.meta.manualRevision, '1');
      assert.equal(reopened.relations[0].relatedTicker, '00700.HK');
      assert.equal(reopened.relations[0].rationale, 'HTTP真实落库');
      assert.equal((await manualSnapshot(ticker(17))).manual_events.length, 1);
    });

    await t.test('human removal survives a new AI publication and restore follows the new researched row', async () => {
      await active.research.initRun({ runId: 'manual-integration-ai-first', asOf: '2026-10-15' });
      await active.research.importResearch(aiPayload('manual-integration-ai-first', ticker(8), [9], '2026-10-15'));
      await active.manual.save(saveInput(ticker(8), [{ action: 'remove', relatedTicker: ticker(9), rationale: '人工排除' }], '0', '2026-10-17'));
      await active.research.initRun({ runId: 'manual-integration-ai-newer', asOf: '2026-10-18' });
      const candidates = [1, 2, 3, 4, 5, 6, 7, 9, 10, 11];
      await active.research.importResearch(aiPayload('manual-integration-ai-newer', ticker(8), candidates, '2026-10-18'));
      const researched = await active.research.getResearch({ runId: 'manual-integration-ai-newer', ticker: ticker(8) });
      assert.equal(researched.relations.length, 10);
      assert.ok(researched.relations.some(row => row.relatedTicker === ticker(9)));
      const removed = await effectiveRelations(ticker(8), researched.relations);
      assert.ok(!removed.relations.some(row => row.relatedTicker === ticker(9)));
      assert.equal(removed.removedRelations[0].relatedTicker, ticker(9));
      const displayed = await active.read.get({ ticker: ticker(8), asOf });
      assert.equal(displayed.counts.total, 9); assert.equal(displayed.status, 'customized');
      assert.ok(!displayed.relations.some(row => row.relatedTicker === ticker(9)));
      assert.equal(displayed.meta.removedRelations[0].relatedTicker, ticker(9));
      const historicalBefore = await effectiveRelations(ticker(8), researched.relations, '2026-10-16');
      assert.ok(historicalBefore.relations.some(row => row.relatedTicker === ticker(9)));
      assert.ok((await active.read.get({ ticker: ticker(8), asOf: '2026-10-16' })).relations.some(row => row.relatedTicker === ticker(9)));
      await active.manual.save(saveInput(ticker(8), [{ action: 'restore', relatedTicker: ticker(9) }], '1', '2026-10-18'));
      const restored = await effectiveRelations(ticker(8), researched.relations);
      assert.deepEqual(restored.relations.find(row => row.relatedTicker === ticker(9)).sources, researched.relations.find(row => row.relatedTicker === ticker(9)).sources);
      assert.equal(restored.hasManualChanges, false);
      const restoredDisplay = await active.read.get({ ticker: ticker(8), asOf });
      assert.equal(restoredDisplay.status, 'complete'); assert.equal(restoredDisplay.counts.total, 10);
      assert.equal(restoredDisplay.meta.hasManualChanges, false);
      assert.ok(!(await effectiveRelations(ticker(8), researched.relations, '2026-10-17')).relations.some(row => row.relatedTicker === ticker(9)));
      const audits = await admin.query(`SELECT action, revision::text, related_name, to_char(effective_date,'YYYY-MM-DD') AS effective_date
        FROM ${schema}.company_relation_manual_events WHERE subject_ticker = $1 ORDER BY revision`, [ticker(8)]);
      assert.deepEqual(audits.rows, [
        { action: 'remove', revision: '1', related_name: name(9), effective_date: '2026-10-17' },
        { action: 'restore', revision: '2', related_name: name(9), effective_date: '2026-10-18' },
      ]);
    });

    await t.test('manual writes reject more than ten atomically and both A/HK subjects and counterparties persist', async () => {
      const oversized = Array.from({ length: 12 }, (_, index) => upsert(ticker(index + 1), index % 2 ? 'peer' : 'downstream'));
      oversized.push(upsert('00700.HK', 'peer'));
      await assert.rejects(active.manual.save(saveInput(ticker(20), oversized)), error => error.code === 'INVALID_MANUAL_RELATIONS' && error.status === 400);
      assert.equal((await manualSnapshot(ticker(20))).manual_revision, '0');
      assert.equal((await effectiveRelations(ticker(20))).relations.length, 0);
      const changes = oversized.slice(0, 9).concat(upsert('00700.HK', 'peer'));
      assert.equal((await active.manual.save(saveInput(ticker(20), changes))).changedCount, 10);
      const effective = await effectiveRelations(ticker(20));
      assert.equal(effective.relations.length, 10); assert.equal(effective.manualCounts.upsert, 10);
      assert.equal(effective.relations.find(row => row.relatedTicker === '00700.HK').relatedName, '腾讯控股');
      await assert.rejects(active.manual.save(saveInput(ticker(20), [upsert(ticker(10))], '1')), error => error.code === 'INVALID_MANUAL_RELATIONS');
      assert.equal((await manualSnapshot(ticker(20))).manual_revision, '1');
      const displayed = await active.read.get({ ticker: ticker(20), asOf });
      assert.equal(displayed.counts.total, 10); assert.equal(displayed.relations.length, 10);
      assert.equal(displayed.missing, 0); assert.equal(displayed.status, 'customized');
      await active.manual.save(saveInput('00700.HK', [upsert('02313.HK', 'downstream'), upsert(ticker(20), 'peer')]));
      const hongKong = await effectiveRelations('00700.HK');
      assert.equal(hongKong.relations.length, 2);
      assert.equal(hongKong.relations.find(row => row.relatedTicker === '02313.HK').relatedName, '申洲国际');
      const displayedHk = await active.read.get({ ticker: '00700.HK', asOf });
      assert.equal(displayedHk.counts.total, 2); assert.equal(displayedHk.subject.name, '腾讯控股');
      assert.equal(displayedHk.relations.find(row => row.relatedTicker === '02313.HK').market.currency, 'HKD');
      assert.equal(displayedHk.relations.find(row => row.relatedTicker === ticker(20)).market.currency, 'CNY');
    });

    await t.test('the shared current-report lock makes the tenth place atomic across concurrent manual writers', async () => {
      await active.manual.save(saveInput(ticker(18), Array.from({ length: 9 }, (_, index) => upsert(ticker(index + 1)))));
      const outcomes = await Promise.allSettled([
        active.manual.save(saveInput(ticker(18), [upsert(ticker(10))], '1')),
        active.manual.save(saveInput(ticker(18), [upsert(ticker(11))], '1')),
      ]);
      assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
      assert.equal(outcomes.find(result => result.status === 'rejected').reason.code, 'RELATIONS_REVISION_CONFLICT');
      assert.equal((await effectiveRelations(ticker(18))).relations.length, 10);
      assert.equal((await manualSnapshot(ticker(18))).manual_revision, '2');
    });

    await t.test('manual changes count the canonical report and refuse overflow or restoring an eleventh company', async () => {
      const rows = Array.from({ length: 10 }, (_, index) => ({ ...aiRelation(index + 1, `${asOf}T00:00:00.000Z`),
        verifiedAt: `${asOf}T00:00:00.000Z` }));
      await admin.query(`INSERT INTO ${schema}.company_relation_current
        (subject_ticker,subject_name,as_of,relations,gaps,researched_at,method_version,source,run_id)
        VALUES ($1,$2,$3::date,$4::jsonb,'[]'::jsonb,$5::timestamptz,'integration','ai','manual-limit-current')`,
      [ticker(16), name(16), asOf, JSON.stringify(rows), `${asOf}T03:00:00.000Z`]);
      await assert.rejects(active.manual.save(saveInput(ticker(16), [upsert(ticker(11))])), error => error.code === 'INVALID_MANUAL_RELATIONS');
      assert.equal((await manualSnapshot(ticker(16))).manual_revision, '0');
      await active.manual.save(saveInput(ticker(16), [{ action: 'remove', relatedTicker: ticker(1) }, upsert(ticker(11))]));
      const replaced = await active.read.get({ ticker: ticker(16), asOf });
      assert.equal(replaced.relations.length, 10);
      assert.ok(replaced.relations.some(row => row.relatedTicker === ticker(11)));
      assert.ok(!replaced.relations.some(row => row.relatedTicker === ticker(1)));
      await assert.rejects(active.manual.save(saveInput(ticker(16), [{ action: 'restore', relatedTicker: ticker(1) }], '1')),
        error => error.code === 'INVALID_MANUAL_RELATIONS');
      assert.equal((await manualSnapshot(ticker(16))).manual_revision, '1');
      assert.equal((await active.read.get({ ticker: ticker(16), asOf })).relations.length, 10);
    });

    await t.test('historical snapshots prefer effective date before revision and exclude later changes', async () => {
      await active.manual.save(saveInput(ticker(19), [upsert(ticker(18), 'upstream')], '0', '2026-10-17'));
      await active.manual.save(saveInput(ticker(19), [upsert(ticker(18), 'peer')], '1', '2026-10-18'));
      await active.manual.save(saveInput(ticker(19), [upsert(ticker(18), 'downstream')], '2', '2026-10-16'));
      assert.equal((await effectiveRelations(ticker(19), [], '2026-10-15')).relations.length, 0);
      assert.equal((await effectiveRelations(ticker(19), [], '2026-10-16')).relations[0].relationType, 'downstream');
      assert.equal((await effectiveRelations(ticker(19), [], '2026-10-17')).relations[0].relationType, 'upstream');
      assert.equal((await effectiveRelations(ticker(19), [], '2026-10-18')).relations[0].relationType, 'peer');
      assert.equal((await manualSnapshot(ticker(19), '2026-10-15')).manual_revision, '3');
      for (const [cutoff, role] of [['2026-10-15', null], ['2026-10-16', 'downstream'], ['2026-10-17', 'upstream'], ['2026-10-18', 'peer']]) {
        const displayed = await active.read.get({ ticker: ticker(19), asOf: cutoff });
        assert.equal(displayed.relations[0]?.relationType ?? null, role);
        assert.equal(displayed.meta.manualRevision, '3');
      }
    });

    await t.test('on-demand A/HK research is visible after persistence, human removals win, and empty retries retain the good snapshot', async () => {
      await admin.query(`INSERT INTO ${schema}.hk_listed_universe (ts_code,name,active,currency,source,source_api)
        VALUES ('00700.HK','腾讯控股',true,'HKD','integration_test','hk_listed'),
          ('02313.HK','申洲国际',true,'HKD','integration_test','hk_listed')`);
      const ai = createRelationsAiStore({ pool: active.wrapped, now });
      const start = () => ai.createJob({ ticker: ticker(12), asOf, provider: 'integration_test', model: 'test-model' });
      const first = await start();
      const hk = { ...aiRelation(9, `${asOf}T00:00:00.000Z`), relatedTicker: '00700.HK', relatedName: '腾讯控股' };
      await ai.completeJob({ jobId: first.job.jobId, relations: [hk, aiRelation(9, `${asOf}T00:00:00.000Z`)],
        gaps: ['缺少直接供应商证据。'], researchedAt: `${asOf}T03:04:00.000Z`, audit: { evidenceIds: ['actual_source_1'] } });
      const saved = await active.read.get({ ticker: ticker(12), asOf });
      assert.equal(saved.meta.relationSource, 'ai'); assert.equal(saved.runId, first.job.jobId);
      assert.deepEqual(saved.relations.map(row => row.relatedTicker), ['00700.HK', ticker(9)]);
      assert.equal(saved.relations[0].market.currency, 'HKD');
      await active.manual.save(saveInput(ticker(12), [{ action: 'remove', relatedTicker: '00700.HK' }]));
      const retry = await start();
      await ai.completeJob({ jobId: retry.job.jobId, relations: [], gaps: ['本次检索未核实额外公司。'],
        researchedAt: `${asOf}T03:04:01.000Z`, audit: {} });
      const retained = await active.read.get({ ticker: ticker(12), asOf });
      assert.equal(retained.runId, first.job.jobId); assert.equal(retained.status, 'customized');
      assert.deepEqual(retained.relations.map(row => row.relatedTicker), [ticker(9)]);
      assert.equal(retained.meta.aiJob.jobId, retry.job.jobId);
      assert.match(retained.meta.aiResultNote, /保留此前关系/);
      const failed = await start();
      await ai.failJob({ jobId: failed.job.jobId, errorCode: 'RELATIONS_AI_TIMEOUT' });
      const afterFailure = await active.read.get({ ticker: ticker(12), asOf });
      assert.equal(afterFailure.runId, first.job.jobId); assert.equal(afterFailure.meta.aiJob.errorCode, 'RELATIONS_AI_TIMEOUT');
      assert.match(afterFailure.meta.aiResultNote, /识别失败/);
      await admin.query(`UPDATE ${schema}.securities SET list_status='D' WHERE ts_code=$1`, [ticker(9)]);
      assert.deepEqual((await active.read.get({ ticker: ticker(12), asOf })).relations, []);
      await admin.query(`UPDATE ${schema}.securities SET list_status='L' WHERE ts_code=$1`, [ticker(9)]);
      assert.equal((await ai.getJob(first.job.jobId)).relations.length, 0);
      assert.equal((await ai.getJob(first.job.jobId)).relationCount, 2);
      assert.equal((await active.read.get({ ticker: ticker(12), asOf: '2026-10-18' })).meta.relationSource, 'none');
    });

    await t.test('human edits made while AI is running protect removals, additions and relation types', async () => {
      const subject=ticker(13), ai=createRelationsAiStore({pool:active.wrapped,now});
      const start=()=>ai.createJob({ticker:subject,asOf,provider:'integration_test',model:'test-model'});
      const initial=await start();
      const rows=Array.from({length:10},(_,index)=>aiRelation(index+1,`${asOf}T00:00:00.000Z`));
      await ai.completeJob({jobId:initial.job.jobId,relations:rows,gaps:[],researchedAt:`${asOf}T03:03:00.000Z`,audit:{}});
      const inFlight=await start();
      const before=await ai.getExistingRelations({ticker:subject,asOf});
      assert.equal(before.length,10);
      assert.equal(before.find(row=>row.relatedTicker===ticker(2)).relationType,'peer');
      await active.manual.save(saveInput(subject,[
        {action:'remove',relatedTicker:ticker(1),rationale:'人工排除，无需AI更换理由'},
        upsert(ticker(11),'upstream','人工新增'),
        upsert(ticker(2),'downstream','人工更正关系分类'),
      ]));
      const saved=await ai.completeJob({jobId:inFlight.job.jobId,relations:rows,gaps:[],researchedAt:`${asOf}T03:04:00.000Z`,audit:{}});
      assert.equal(saved.relationCount,10);
      const displayed=await active.read.get({ticker:subject,asOf});
      assert.equal(displayed.relations.length,10);
      assert.ok(!displayed.relations.some(row=>row.relatedTicker===ticker(1)));
      assert.equal(displayed.relations.find(row=>row.relatedTicker===ticker(11)).origin,'manual');
      assert.equal(displayed.relations.find(row=>row.relatedTicker===ticker(2)).relationType,'downstream');
      assert.equal(displayed.relations.find(row=>row.relatedTicker===ticker(2)).rationale,'人工更正关系分类');
      const nextExisting=await ai.getExistingRelations({ticker:subject,asOf});
      assert.ok(!nextExisting.some(row=>row.relatedTicker===ticker(1)));
      assert.equal(nextExisting.find(row=>row.relatedTicker===ticker(11)).origin,'manual');
      const metadata=await admin.query(`SELECT refresh_summary FROM ${schema}.company_relation_current WHERE subject_ticker=$1`,[subject]);
      assert.equal(metadata.rowCount,1);
      assert.equal(metadata.rows[0].refresh_summary.retainedCount,10);
      assert.equal(metadata.rows[0].refresh_summary.addedCount,0);
      assert.equal(metadata.rows[0].refresh_summary.removedCount,0);
      assert.equal((await ai.getJob(inFlight.job.jobId)).relations.length,0);
    });

    await t.test('AI fills a vacancy from a human removal without evicting any visible saved company', async () => {
      const subject=ticker(14), ai=createRelationsAiStore({pool:active.wrapped,now});
      const start=()=>ai.createJob({ticker:subject,asOf,provider:'integration_test',model:'test-model'});
      const initial=await start();
      await ai.completeJob({jobId:initial.job.jobId,
        relations:Array.from({length:10},(_,index)=>aiRelation(index+1,`${asOf}T00:00:00.000Z`)),
        gaps:[],researchedAt:`${asOf}T03:03:00.000Z`,audit:{}});
      const inFlight=await start();
      await active.manual.save(saveInput(subject,[{action:'remove',relatedTicker:ticker(1),rationale:'人工移除后留下一个可见空位'}]));
      assert.equal((await active.read.get({ticker:subject,asOf})).relations.length,9);
      await ai.completeJob({jobId:inFlight.job.jobId,relations:[aiRelation(11,`${asOf}T00:00:00.000Z`)],
        gaps:[],researchedAt:`${asOf}T03:04:00.000Z`,audit:{}});
      const visible=await active.read.get({ticker:subject,asOf});
      assert.deepEqual(new Set(visible.relations.map(row=>row.relatedTicker)),new Set(Array.from({length:10},(_,index)=>ticker(index+2))));
      assert.ok(!visible.relations.some(row=>row.relatedTicker===ticker(1)));
      const canonical=await admin.query(`SELECT relations,refresh_summary FROM ${schema}.company_relation_current WHERE subject_ticker=$1`,[subject]);
      assert.equal(canonical.rowCount,1);
      assert.equal(canonical.rows[0].relations.length,10);
      assert.equal(canonical.rows[0].refresh_summary.retainedCount,9);
      assert.equal(canonical.rows[0].refresh_summary.addedCount,1);
      assert.equal(canonical.rows[0].refresh_summary.removedCount,0);
      assert.equal((await manualSnapshot(subject)).manual_events.find(row=>row.relatedTicker===ticker(1)).action,'remove');
      assert.equal((await ai.getExistingRelations({ticker:subject,asOf})).length,10);
      // Human selection remains unrestricted by AI change evidence, subject
      // only to the same ten-company capacity rule.
      await assert.rejects(active.manual.save(saveInput(subject,[upsert(ticker(1),'downstream','人工换回旧公司')],'1')),
        error=>error.code==='INVALID_MANUAL_RELATIONS');
      await active.manual.save(saveInput(subject,[{action:'remove',relatedTicker:ticker(11)},upsert(ticker(1),'downstream','人工换回旧公司')],'1'));
      const restored=await active.read.get({ticker:subject,asOf});
      assert.equal(restored.relations.length,10);
      assert.equal(restored.relations.find(row=>row.relatedTicker===ticker(1)).origin,'manual');
      assert.ok(!restored.relations.some(row=>row.relatedTicker===ticker(11)));
    });

    await t.test('ten exclusively manual companies complete AI refresh without creating an empty canonical report', async () => {
      const subject=ticker(15),ai=createRelationsAiStore({pool:active.wrapped,now});
      await active.manual.save(saveInput(subject,Array.from({length:10},(_,index)=>upsert(ticker(index+1),'upstream',`人工指定${index+1}`))));
      const before=await ai.getExistingRelations({ticker:subject,asOf});
      assert.equal(before.length,10);
      assert.ok(before.every(row=>row.origin==='manual'));
      const job=await ai.createJob({ticker:subject,asOf,provider:'integration_test',model:'test-model'});
      const completed=await ai.completeJob({jobId:job.job.jobId,relations:[aiRelation(11,`${asOf}T00:00:00.000Z`)],
        gaps:[],researchedAt:`${asOf}T03:04:00.000Z`,audit:{}});
      assert.equal(completed.status,'succeeded');
      assert.equal(completed.relationCount,10);
      assert.deepEqual(completed.relations,[]);
      assert.equal((await admin.query(`SELECT relations FROM ${schema}.company_relation_current WHERE subject_ticker=$1`,[subject])).rowCount,0);
      const metadata=await admin.query(`SELECT relations,audit FROM ${schema}.company_relation_ai_jobs WHERE job_id=$1`,[job.job.jobId]);
      assert.deepEqual(metadata.rows[0].relations,[]);
      assert.equal(metadata.rows[0].audit.refreshSummary.retainedCount,10);
      assert.equal(metadata.rows[0].audit.refreshSummary.addedCount,0);
      assert.equal(metadata.rows[0].audit.refreshSummary.removedCount,0);
      assert.deepEqual(await ai.getExistingRelations({ticker:subject,asOf}),before);
      const displayed=await active.read.get({ticker:subject,asOf});
      assert.equal(displayed.relations.length,10);
      assert.ok(displayed.relations.every(row=>row.origin==='manual'));
      assert.equal((await manualSnapshot(subject)).manual_events.length,10);
    });

    await t.test('repeated additive migration preserves the complete manual audit and AI business rows', async () => {
      const counts = () => admin.query(`SELECT
        (SELECT count(*)::integer FROM ${schema}.company_relation_manual_events) AS manual,
        (SELECT count(*)::integer FROM ${schema}.company_relations) AS researched,
        (SELECT count(*)::integer FROM ${schema}.company_relation_jobs) AS jobs`);
      const before = (await counts()).rows;
      await active.manual.migrate(); await active.research.migrate(); await active.manual.migrate();
      assert.deepEqual((await counts()).rows, before);
      const eventIds = await admin.query(`SELECT count(*)::integer AS total, count(DISTINCT event_id)::integer AS unique_ids FROM ${schema}.company_relation_manual_events`);
      assert.equal(eventIds.rows[0].total, eventIds.rows[0].unique_ids);
    });
  } finally {
    await Promise.all([...sessions].map(raw => raw.end()));
    try { if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await admin.end(); }
  }
});
