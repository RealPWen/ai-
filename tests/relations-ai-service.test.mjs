import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelationsAiService } from '../backend/src/relations-ai-service.mjs';
import { ResearchError } from '../backend/src/errors.mjs';

const now = () => new Date('2026-10-20T02:00:00.000Z');
const input = { ticker: '00700.HK', asOf: '2026-10-20' };
const securities = [
  { ticker: '00700.HK', name: '腾讯控股', market: 'HK' },
  { ticker: '09988.HK', name: '阿里巴巴-W', market: 'HK' },
  { ticker: '002415.SZ', name: '海康威视', market: 'A' },
  { ticker: '600519.SH', name: '贵州茅台', market: 'A' },
];
const evidence = { origin: 'deepseek-search', sources: [{ id: 's1', url: 'https://www.cninfo.com.cn/new/disclosure/detail', contentSha256: 'a'.repeat(64), contentLength: 50 }] };
const row = { relatedTicker: '002415.SZ', relatedName: '海康威视', relationType: 'upstream', evidenceType: 'technical_cooperation',
  rationale: '公告披露技术合作，不等于采购合同。', actualEntity: '海康威视', listedMappingBasis: '上市主体自身', notes: '',
  sources: [{ sourceId: 's1', url: evidence.sources[0].url, title: '合作公告', publishedAt: '2026-10-19',
    excerpt: '腾讯控股与海康威视开展技术合作。', accessedAt: now().toISOString(), readingScope: 'partial_text' }] };
const report = (relations = [row]) => ({ provider: 'deepseek', model: 'deepseek-v4-pro', relations, gaps: ['部分供应关系尚未披露。'], retrievalEvidence: evidence });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(predicate) {
  for (let i = 0; i < 50; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('后台任务未按预期完成');
}

function fixture(t, { research = async () => report(), configured = true, maxConcurrent = 2, provider = 'deepseek', gate, completeError } = {}) {
  const jobs = new Map(), calls = [], saved = [], failures = [], logs = [], freezes = [], sweeps = [];
  let nextId = 0;
  const store = {
    async expireStaleJobs(options) { sweeps.push(options); },
    async getLatestJob(params) { return [...jobs.values()].reverse().find(job => job.ticker === params.ticker && job.asOf === params.asOf) ?? null; },
    async getJob(id) { return jobs.get(id) ?? null; },
    async listCandidates(params) {
      freezes.push(params); const subject = securities.find(row => row.ticker === params.ticker);
      if (!subject) throw new ResearchError('UNKNOWN_SECURITY', '该证券不在当前上市的 A 股或港股公司清单中。', 404);
      return { subject, candidates: securities.filter(row => row !== subject), candidateHash: 'a'.repeat(64) };
    },
    async createJob(params) {
      const jobId = `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`;
      const job = { ...params, jobId, status: 'running', stage: 'queued', relations: [], gaps: [],
        createdAt: now().toISOString(), updatedAt: now().toISOString(), finishedAt: null };
      jobs.set(jobId, job); return { created: true, job };
    },
    async updateProgress({ jobId, stage }) { jobs.get(jobId).stage = stage; },
    async completeJob(params) {
      if (completeError) throw completeError;
      saved.push(params); const job = jobs.get(params.jobId);
      Object.assign(job, { status: 'succeeded', stage: 'completed', relations: params.relations, gaps: params.gaps, finishedAt: now().toISOString() });
      return job;
    },
    async failJob(params) {
      failures.push(params); Object.assign(jobs.get(params.jobId), { status: 'failed', stage: 'failed', errorCode: params.errorCode,
        errorMessage: 'AI 识别未能完成，请重试。', finishedAt: now().toISOString() });
    },
  };
  const client = { async researchRelations(params, prompt, options) {
    calls.push({ params, prompt }); await options.onProgress('searching');
    if (gate) await gate.promise;
    await options.onProgress('analyzing'); return research(params);
  } };
  const service = createRelationsAiService({ store, client, prompt: '真实公告正文关系识别', configured, provider,
    model: 'deepseek-v4-pro', now, maxConcurrent, heartbeatMs: 50, log: message => logs.push(message) });
  t.after(async () => { gate?.resolve(); await service.close(); });
  return { service, store, jobs, calls, saved, failures, logs, freezes, sweeps };
}

test('GET仅查询已有任务，缺少key仍可读取且从不冻结候选或启动AI', async t => {
  const f = fixture(t, { configured: false });
  assert.equal(await f.service.get(input), null);
  assert.equal(await f.service.get({ jobId: '00000000-0000-4000-8000-000000000099' }), null);
  assert.equal(f.calls.length, 0); assert.equal(f.freezes.length, 0); assert.equal(f.jobs.size, 0);
  assert.equal(f.sweeps.length, 1); assert.deepEqual(f.sweeps[0], { olderThanMs: 600000 });
  await assert.rejects(f.service.start(input), { code: 'RELATIONS_AI_NOT_CONFIGURED', status: 503 });
});

test('任务表仅存数量仍可轮询；旧非当前成功任务不会冒充当前结果，失败和空结果仍可查看',async t=>{
  const f=fixture(t,{configured:false});
  const job={...input,jobId:'00000000-0000-4000-8000-000000000001',status:'succeeded',stage:'completed',relations:[],relationCount:10,gaps:[],isCurrent:true};
  f.jobs.set(job.jobId,job);
  assert.equal((await f.service.get(input)).result.relationCount,10);
  job.isCurrent=false;assert.equal(await f.service.get(input),null);
  job.relationCount=0;assert.equal((await f.service.get(input)).result.retainedPrevious,true);
  job.status='failed';assert.equal((await f.service.get(input)).status,'failed');
  assert.equal(f.calls.length,0);
});

test('主体名称和A/HK候选由数据库冻结，POST快速返回任务并允许只保存一项有证据结果', async t => {
  const gate = deferred(), f = fixture(t, { gate });
  const started = await f.service.start({ ticker: ' 00700.hk ' });
  assert.equal(started.status, 'running'); assert.equal(started.ticker, input.ticker); assert.equal(started.asOf, input.asOf);
  assert.equal(f.saved.length, 0); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].params.companyName, '腾讯控股'); assert.equal(f.calls[0].params.name, '腾讯控股');
  assert.deepEqual(f.calls[0].params.candidates, securities); assert.match(f.calls[0].prompt, /公告/);
  const searching = await f.service.get({ jobId: started.jobId }); assert.equal(searching.status, 'running'); assert.equal(f.calls.length, 1);
  gate.resolve(); await until(() => f.saved.length === 1);
  const finished = await f.service.get({ jobId: started.jobId });
  assert.equal(finished.status, 'succeeded'); assert.equal(finished.result.relationCount, 1); assert.equal(finished.result.retainedPrevious, false);
  assert.equal(f.saved[0].relations.length, 1); assert.deepEqual(f.saved[0].audit.retrievalEvidence, evidence);
  assert.equal(f.saved[0].audit.candidateHash, 'a'.repeat(64)); assert.equal(f.calls.length, 1);
  assert.equal(Object.hasOwn(finished, 'relations'), false); assert.equal(Object.hasOwn(finished, 'audit'), false);
});

test('同主体并发点击与任务运行中再次点击复用同一job，即使并发额度已满', async t => {
  const gate = deferred(), f = fixture(t, { gate, maxConcurrent: 1 });
  const first = await Promise.all([f.service.start(input), f.service.start(input), f.service.start(input)]);
  assert.equal(new Set(first.map(job => job.jobId)).size, 1); assert.equal(f.calls.length, 1); assert.equal(f.jobs.size, 1);
  const repeated = await f.service.start(input);
  assert.equal(repeated.jobId, first[0].jobId); assert.equal(f.calls.length, 1); assert.equal(f.jobs.size, 1);
});

test('重新识别使用数据库中的已有及人工关系，来源充分的调整随保存并可读取摘要',async t=>{
  const result={...report(),changes:[{oldTicker:'09988.HK',newTicker:'002415.SZ',reason:'实际业务调整。',sources:[]}],changeGaps:['未批准另一项无来源换股。']};
  const f=fixture(t,{research:async()=>result});
  const old={...row,relatedTicker:'09988.HK',relatedName:'阿里巴巴-W',origin:'manual',evidenceType:'manual'};
  f.store.getExistingRelations=async()=>[old];
  const job=await f.service.start(input);await until(()=>f.saved.length===1);
  assert.deepEqual(f.calls[0].params.existingRelations,[old]);
  assert.deepEqual(f.saved[0].audit.approvedChanges,result.changes);
  assert.equal(f.saved[0].audit.rejectedChangeCount,1);assert.match(f.saved[0].gaps.join(' '),/未批准/);
  const summary={retainedCount:1,addedCount:0,removedCount:0,blockedCount:1,changes:[]};
  f.jobs.get(job.jobId).refreshSummary=summary;
  assert.deepEqual((await f.service.get({jobId:job.jobId})).result.refreshSummary,summary);
});

test('不同公司超过并发限额时明确429，完成后允许创建新任务', async t => {
  const gate = deferred(), f = fixture(t, { gate, maxConcurrent: 2 });
  await Promise.all([f.service.start(input), f.service.start({ ...input, ticker: '09988.HK' })]);
  assert.equal(f.calls.length, 2);
  await assert.rejects(f.service.start({ ...input, ticker: '600519.SH' }), { code: 'RELATIONS_AI_BUSY', status: 429 });
  assert.equal(f.jobs.size, 2); gate.resolve(); await until(() => f.saved.length === 2);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.service.start({ ...input, ticker: '600519.SH' })).ticker, '600519.SH');
  assert.equal(f.calls.length, 3); await f.service.close();
  await assert.rejects(f.service.start({ ...input, ticker: '600519.SH' }), { code: 'RELATIONS_AI_CLOSING', status: 503 });
});

test('没有充分关系证据可以成功返回零项并明确保留原关系，不凑满10家', async t => {
  const f = fixture(t, { research: async () => report([]) }), job = await f.service.start(input);
  await until(() => f.saved.length === 1);
  const finished = await f.service.get({ jobId: job.jobId });
  assert.equal(finished.status, 'succeeded'); assert.deepEqual(finished.result, { relationCount: 0, gaps: report([]).gaps, retainedPrevious: true });
  assert.match(finished.message, /未改动已有关系/); assert.deepEqual(f.saved[0].relations, []);
});

test('provider或保存错误只保存安全失败码，轮询和日志不泄露上游原文/凭据', async t => {
  for (const [error, code] of [
    [new ResearchError('DEEPSEEK_INSUFFICIENT_BALANCE', 'private-key private-provider-text', 502), 'RELATIONS_AI_INSUFFICIENT_BALANCE'],
    [new ResearchError('DEEPSEEK_SEARCH_TIMEOUT', 'private-key private-provider-text', 502), 'RELATIONS_AI_TIMEOUT'],
    [new ResearchError('DEEPSEEK_RATE_LIMIT', 'private-key private-provider-text', 429), 'RELATIONS_AI_RATE_LIMITED'],
    [new ResearchError('RELATIONS_SOURCES_UNVERIFIED', 'private-key private-provider-text', 502), 'RELATIONS_AI_SEARCH_ERROR'],
    [new Error('private-key private-provider-text postgresql://secret'), 'RELATIONS_AI_PROVIDER_ERROR'],
  ]) {
    const f = fixture(t, { research: async () => { throw error; } }), job = await f.service.start(input);
    await until(() => f.failures.length === 1);
    assert.deepEqual(f.failures[0], { jobId: job.jobId, errorCode: code });
    const status = await f.service.get({ jobId: job.jobId }); assert.equal(status.status, 'failed'); assert.equal(status.error.code, code);
    assert.doesNotMatch(JSON.stringify({ status, logs: f.logs, saved: f.saved, failures: f.failures }), /private-key|private-provider-text|postgresql|secret/);
    assert.equal(f.saved.length, 0);
  }
  const f = fixture(t, { completeError: new ResearchError('RELATIONS_DATABASE_UNAVAILABLE', 'private-key SQL', 503) }), job = await f.service.start(input);
  await until(() => f.failures.length === 1); assert.equal((await f.service.get({ jobId: job.jobId })).error.code, 'RELATIONS_AI_DATABASE_ERROR');
});

test('结果必须来自DeepSeek本次联网来源，缺审计或provider错误均不保存', async t => {
  for (const result of [null, { ...report(), provider: 'other' }, { ...report(), retrievalEvidence: { origin: 'model-invented', sources: evidence.sources } }, { ...report(), retrievalEvidence: { origin: 'deepseek-search', sources: [] } }]) {
    const f = fixture(t, { research: async () => result }), job = await f.service.start(input);
    await until(() => f.failures.length === 1);
    assert.equal(f.saved.length, 0); assert.equal((await f.service.get({ jobId: job.jobId })).error.code, 'RELATIONS_AI_INVALID_RESULT');
  }
});

test('不接受美股/无效日期/用户名称注入，历史日期拒绝发起，未知在市公司不调用API', async t => {
  const f = fixture(t);
  for (const raw of [{ ...input, ticker: 'AAPL' }, { ...input, ticker: '700.HK' }, { ...input, asOf: '2026-02-30' }, { ...input, asOf: '2026-10-21' }, { ...input, companyName: '注入名称' }, { ...input, candidates: securities }]) {
    await assert.rejects(f.service.start(raw), { code: 'INVALID_RELATIONS_RESEARCH', status: 400 });
  }
  await assert.rejects(f.service.start({ ...input, asOf: '2026-10-19' }), { code: 'RELATIONS_AI_HISTORICAL_READ_ONLY', status: 400 });
  await assert.rejects(f.service.start({ ...input, ticker: '12345.HK' }), { code: 'UNKNOWN_SECURITY', status: 404 });
  assert.equal(f.calls.length, 0); assert.equal(f.jobs.size, 0);
  assert.equal(await f.service.get({ ...input, asOf: '2026-10-19' }), null);
  for (const params of [{ jobId: 'bad' }, { jobId: '00000000-0000-4000-8000-000000000099', ticker: input.ticker }, null, [], { ...input, unknown: true }]) {
    await assert.rejects(f.service.get(params), { code: 'INVALID_RELATIONS_RESEARCH', status: 400 });
  }
});
