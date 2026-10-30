import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createRelationsAiStore } from '../backend/market-data/relations-ai-store.mjs';

// Explicit opt-in. All writes are confined to a generated temporary schema.
const enabled = process.env.RELATIONS_DATABASE_TESTS === '1' && Boolean(process.env.DATABASE_URL);
test('PostgreSQL integration: AI frozen candidates, concurrent deduplication, durable results, stale leases and rollback', { skip: !enabled }, async () => {
  const schema = `relations_ai_test_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^relations_ai_test_[a-f0-9]{32}$/);
  const raw = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
  const rewrite = sql => sql.replaceAll('market_data.', `${schema}.`)
    .replaceAll('CREATE SCHEMA IF NOT EXISTS market_data', `CREATE SCHEMA IF NOT EXISTS ${schema}`);
  let failResult = false;
  const wrapped = {
    async query(sql, values) { return raw.query(rewrite(sql), values); },
    async connect() {
      const client = await raw.connect();
      return { async query(sql, values) {
        if (failResult && /^UPDATE market_data\.company_relation_ai_jobs SET status = 'succeeded'/.test(sql)) throw new Error('postgres://user:secret@private-host/db');
        return client.query(rewrite(sql), values);
      }, release() { client.release(); } };
    }, async end() {},
  };
  const now = () => new Date('2026-10-20T03:05:00Z'), asOf = '2026-10-20';
  const store = createRelationsAiStore({ pool: wrapped, now });
  const input = { ticker: '002920.SZ', asOf };
  const relation = { relatedTicker: '00700.HK', relatedName: '腾讯控股', relationType: 'peer', evidenceType: 'business_comparable',
    rationale: '公开资料显示同类业务。', actualEntity: '腾讯控股有限公司', listedMappingBasis: '上市公司本体。', notes: '',
    sources: [{ url: 'https://www.hkexnews.hk/report.pdf', title: '公司公告', publishedAt: '2026-10-19',
      excerpt: '公司从事相关业务。', accessedAt: '2026-10-20T03:00:00Z', readingScope: 'partial_text' }] };
  const completion = jobId => ({ jobId, relations: [relation], gaps: ['上游与下游证据不足。'], researchedAt: '2026-10-20T03:04:00Z', audit: { sourceIds: ['source_1'], modelReturned: 'peer' } });
  const start = (options = {}) => store.createJob({ ...input, provider: 'test', model: 'test-model', ...options });
  try {
    await store.migrate(); await store.migrate();
    // Exercise conversion from the prior multi-result thirty-row constraint.
    await raw.query(`ALTER TABLE ${schema}.company_relation_ai_jobs DROP CONSTRAINT company_relation_ai_jobs_relations_check`);
    await raw.query(`ALTER TABLE ${schema}.company_relation_ai_jobs ADD CONSTRAINT company_relation_ai_jobs_relations_check CHECK(jsonb_typeof(relations)='array' AND jsonb_array_length(relations)<=30)`);
    await store.migrate();
    await raw.query(`CREATE TABLE ${schema}.securities (ts_code text PRIMARY KEY, name text NOT NULL, market text NOT NULL,
      industry text, list_status text, list_date date, delist_date date, source text NOT NULL)`);
    await raw.query(`CREATE TABLE ${schema}.hk_listed_universe (ts_code text PRIMARY KEY, name text NOT NULL, active boolean,
      list_date date, source text, source_api text)`);
    await raw.query(`INSERT INTO ${schema}.securities VALUES
      ('002920.SZ','德赛西威','A','汽车','L','2017-01-01',NULL,'test'),
      ('300750.SZ','宁德时代','A','电池','L','2018-01-01',NULL,'test'),
      ('000001.SZ','平安银行','A','银行','L','1991-01-01',NULL,'test'),
      ('009999.SZ','退市公司','A','其他','D','2000-01-01','2026-10-01','test'),
      ('00700.HK','腾讯控股','HK',NULL,'L','2004-01-01',NULL,'test')`);
    await raw.query(`INSERT INTO ${schema}.hk_listed_universe VALUES
      ('00700.HK','腾讯控股',true,'2004-01-01','hkex+tushare','hk_listed'),
      ('09999.HK','已除牌公司',false,'2010-01-01','hkex+tushare','hk_listed'),
      ('09998.HK','未来上市公司',true,'2026-10-21','hkex+tushare','hk_listed')`);
    const frozen = await store.listCandidates(input);
    assert.equal(frozen.subject.name, '德赛西威'); assert.equal(frozen.candidates.length, 3);
    assert.deepEqual(frozen.candidates.map(row => row.ticker), ['000001.SZ', '00700.HK', '300750.SZ']);
    assert.equal(frozen.candidates[1].source, 'hkex+tushare');
    for (const ticker of ['009999.SZ', '09999.HK', '09998.HK']) await assert.rejects(store.listCandidates({ ticker, asOf }), error => error.code === 'UNKNOWN_SECURITY');
    const parallel = await Promise.all([start({ candidateHash: frozen.candidateHash }), start({ candidateHash: frozen.candidateHash })]);
    assert.equal(parallel.filter(row => row.created).length, 1);
    assert.equal(parallel[0].job.jobId, parallel[1].job.jobId);
    const id = parallel[0].job.jobId;
    assert.equal((await createRelationsAiStore({ pool: wrapped, now }).getJob(id)).candidateHash, frozen.candidateHash);
    await store.updateProgress({ jobId: id, stage: 'searching' });
    assert.equal((await store.getLatestJob(input)).stage, 'searching');
    await assert.rejects(store.completeJob({ ...completion(id), relations: [{ ...relation, relatedTicker: '09999.HK' }] }), error => error.code === 'INVALID_AI_RELATIONS');
    assert.equal((await store.getJob(id)).status, 'running');
    failResult = true;
    await assert.rejects(store.completeJob(completion(id)), error => error.code === 'RELATIONS_DATABASE_UNAVAILABLE' && !/secret|private-host|postgres/i.test(error.message));
    failResult = false;
    assert.equal((await store.getJob(id)).status, 'running');
    const saved = await store.completeJob(completion(id));
    assert.equal(saved.status, 'succeeded'); assert.equal(saved.relations[0].rank, 1); assert.equal(saved.relations[0].verifiedAt, '2026-10-20T03:04:00.000Z');
    // Simulate an existing pre-upgrade report stored in the old job table.
    await raw.query(`ALTER TABLE ${schema}.company_relation_ai_jobs DROP CONSTRAINT company_relation_ai_jobs_relations_check`);
    await raw.query(`UPDATE ${schema}.company_relation_ai_jobs SET relations=$2::jsonb,result_count=0 WHERE job_id=$1`,[id,JSON.stringify(saved.relations)]);
    await raw.query(`DELETE FROM ${schema}.company_relation_current WHERE subject_ticker=$1`,[input.ticker]);
    await store.migrate();
    const migrated=await raw.query(`SELECT relations FROM ${schema}.company_relation_current WHERE subject_ticker=$1`,[input.ticker]);
    assert.equal(migrated.rowCount,1);assert.equal(migrated.rows[0].relations[0].relatedTicker,'00700.HK');
    assert.equal((await store.getJob(id)).relations.length,0);assert.equal((await store.getJob(id)).relationCount,1);
    assert.equal((await store.failJob({ jobId: id, errorCode: 'RELATIONS_AI_FAILED' })).status, 'succeeded');
    const persisted = await raw.query(`SELECT candidate_securities, audit FROM ${schema}.company_relation_ai_jobs WHERE job_id=$1`, [id]);
    assert.equal(persisted.rows[0].candidate_securities.length, 3); assert.deepEqual(persisted.rows[0].audit.sourceIds, ['source_1']);
    const empty = await start();
    await store.completeJob({ ...completion(empty.job.jobId), relations: [], gaps: ['未核实任何关系。'] });
    assert.equal((await store.getJob(id)).relations.length, 0);
    assert.equal((await store.getJob(id)).relationCount, 1);
    assert.equal((await store.getLatestJob(input)).relations.length, 0);
    assert.equal((await raw.query(`SELECT relations FROM ${schema}.company_relation_current WHERE subject_ticker=$1`,[input.ticker])).rows[0].relations[0].relatedTicker,'00700.HK');
    const summarized=await start();
    const summarySource={url:'https://www.hkexnews.hk/report.pdf',title:'公司公告',publishedAt:'2026-10-19',accessedAt:'2026-10-20T03:00:00Z',readingScope:'search_snippet',sourceKind:'search_summary',sourceId:'s1',evidenceSummary:'两家公司的公开业务可以比较。'};
    const summaryAudit={evidenceMode:'relation_summary',retrievalEvidence:{origin:'deepseek-search',evidenceMode:'relation_summary',sources:[{id:'s1',url:summarySource.url,title:summarySource.title,publishedAt:summarySource.publishedAt,readingScope:summarySource.readingScope}]}};
    const summarySaved=await store.completeJob({...completion(summarized.job.jobId),relations:[{...relation,relatedTicker:'300750.SZ',relatedName:'宁德时代',sources:[summarySource]}],researchedAt:'2026-10-20T03:04:30Z',audit:summaryAudit});
    assert.deepEqual(summarySaved.relations.map(row=>row.relatedTicker),['00700.HK','300750.SZ']);
    const preservedTencent=summarySaved.relations.find(row=>row.relatedTicker==='00700.HK');
    const addedCatl=summarySaved.relations.find(row=>row.relatedTicker==='300750.SZ');
    assert.deepEqual(preservedTencent,saved.relations[0]);
    assert.equal(preservedTencent.verifiedAt,'2026-10-20T03:04:00.000Z');
    assert.equal(addedCatl.verifiedAt,'2026-10-20T03:04:30.000Z');
    assert.equal(addedCatl.sources[0].evidenceSummary,summarySource.evidenceSummary);
    assert.equal(addedCatl.sources[0].excerpt,undefined);
    assert.equal((await store.getJob(id)).relations.length,0);
    const currentReport=await raw.query(`SELECT relations,run_id,refresh_summary FROM ${schema}.company_relation_current WHERE subject_ticker=$1`,[input.ticker]);
    assert.equal(currentReport.rowCount,1);assert.equal(currentReport.rows[0].relations.length,2);
    assert.deepEqual(currentReport.rows[0].relations.map(row=>row.relatedTicker),['00700.HK','300750.SZ']);
    assert.equal(typeof currentReport.rows[0].refresh_summary,'object');
    assert.ok(currentReport.rows[0].refresh_summary);
    assert.deepEqual(currentReport.rows[0].refresh_summary,{retainedCount:1,addedCount:1,removedCount:0,blockedCount:0,changes:[]});
    assert.deepEqual((await store.getExistingRelations(input)).map(row=>row.relatedTicker),['00700.HK','300750.SZ']);
    const summaryMetadata=await raw.query(`SELECT audit FROM ${schema}.company_relation_ai_jobs WHERE job_id=$1`,[summarized.job.jobId]);
    assert.deepEqual(summaryMetadata.rows[0].audit.refreshSummary,currentReport.rows[0].refresh_summary);
    assert.equal(currentReport.rows[0].run_id,summarized.job.jobId);
    const copies=await raw.query(`SELECT sum(jsonb_array_length(relations))::int n FROM ${schema}.company_relation_ai_jobs`);
    assert.equal(copies.rows[0].n,0);
    const renamed = await start();
    await raw.query(`UPDATE ${schema}.hk_listed_universe SET name='新名称' WHERE ts_code='00700.HK'`);
    await assert.rejects(store.completeJob(completion(renamed.job.jobId)), error => error.code === 'RELATIONS_AI_JOB_CONFLICT');
    await store.failJob({ jobId: renamed.job.jobId, errorCode: 'untrusted-private-provider-error' });
    const failure = await store.getJob(renamed.job.jobId);
    assert.equal(failure.errorCode, 'RELATIONS_AI_FAILED'); assert.equal(failure.errorMessage, 'AI 识别失败，请稍后重试。');
    await raw.query(`UPDATE ${schema}.hk_listed_universe SET name='腾讯控股' WHERE ts_code='00700.HK'`);
    const stale = await start();
    const healthy = await start({ ticker: '300750.SZ' });
    await raw.query(`UPDATE ${schema}.company_relation_ai_jobs SET updated_at=clock_timestamp()-interval '31 minutes' WHERE job_id=$1`, [stale.job.jobId]);
    assert.deepEqual(await store.expireStaleJobs(), { expired: 1 });
    assert.equal((await store.getJob(stale.job.jobId)).errorCode, 'RELATIONS_AI_INTERRUPTED');
    assert.equal((await store.getJob(healthy.job.jobId)).status, 'running');
    await assert.rejects(store.completeJob(completion(stale.job.jobId)), error => error.code === 'RELATIONS_AI_JOB_CONFLICT');
    await store.migrate();
    assert.equal((await store.getJob(id)).relationCount,1);
    assert.deepEqual((await raw.query(`SELECT relations FROM ${schema}.company_relation_current WHERE subject_ticker=$1`,[input.ticker])).rows[0].relations.map(row=>row.relatedTicker),['00700.HK','300750.SZ']);

    // A fresh search can return ten entirely different candidates. With no
    // evidence-backed change decisions, ten already saved companies win.
    const retainedSubject='000001.SZ';
    const syntheticTicker=n=>`${String(n).padStart(6,'0')}.SZ`;
    const syntheticName=n=>`关系保留测试${n}`;
    await raw.query(`INSERT INTO ${schema}.securities (ts_code,name,market,industry,list_status,source)
      SELECT lpad(n::text,6,'0')||'.SZ','关系保留测试'||n,'A','测试行业','L','test'
      FROM generate_series(101,120) n`);
    const proposedRows=startAt=>Array.from({length:10},(_,index)=>({...relation,
      relatedTicker:syntheticTicker(startAt+index),relatedName:syntheticName(startAt+index),
      actualEntity:syntheticName(startAt+index),sources:relation.sources.map(source=>({...source}))}));
    const firstTen=await start({ticker:retainedSubject});
    const established=await store.completeJob({...completion(firstTen.job.jobId),relations:proposedRows(101)});
    const secondTen=await start({ticker:retainedSubject});
    const kept=await store.completeJob({...completion(secondTen.job.jobId),relations:proposedRows(111),researchedAt:'2026-10-20T03:04:30Z'});
    assert.deepEqual(kept.relations,established.relations);
    assert.equal(kept.relations.length,10);
    assert.ok(kept.relations.every(row=>row.verifiedAt==='2026-10-20T03:04:00.000Z'));
    const retainedReport=await raw.query(`SELECT relations,refresh_summary FROM ${schema}.company_relation_current WHERE subject_ticker=$1`,[retainedSubject]);
    assert.equal(retainedReport.rowCount,1);
    assert.deepEqual(retainedReport.rows[0].relations,established.relations);
    assert.equal(typeof retainedReport.rows[0].refresh_summary,'object');
    assert.ok(retainedReport.rows[0].refresh_summary);
    assert.deepEqual(retainedReport.rows[0].refresh_summary,{retainedCount:10,addedCount:0,removedCount:0,blockedCount:10,changes:[]});
    const retainedMetadata=await raw.query(`SELECT audit FROM ${schema}.company_relation_ai_jobs WHERE job_id=$1`,[secondTen.job.jobId]);
    assert.deepEqual(retainedMetadata.rows[0].audit.refreshSummary,retainedReport.rows[0].refresh_summary);
    const retainedJobs=await raw.query(`SELECT relations FROM ${schema}.company_relation_ai_jobs WHERE subject_ticker=$1`,[retainedSubject]);
    assert.equal(retainedJobs.rowCount,2);
    assert.ok(retainedJobs.rows.every(job=>Array.isArray(job.relations)&&job.relations.length===0));
  } finally {
    try { await raw.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await raw.end(); }
  }
});
