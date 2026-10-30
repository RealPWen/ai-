import test from 'node:test';
import assert from 'node:assert/strict';
import { createResearchServer } from '../backend/app.mjs';
import { createRelationsAiService } from '../backend/src/relations-ai-service.mjs';
import { ResearchError } from '../backend/src/errors.mjs';

const payload = { ticker: '00700.HK', asOf: '2026-10-20' };
const jobId = '00000000-0000-4000-8000-000000000001';
const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function fixture(t, { service, remoteAddress } = {}) {
  const calls = [];
  const forbidden = () => assert.fail('关系识别不能调用其他研究、登录或账户接口');
  const server = createResearchServer({ relationsAiService: service ? {
    get: async params => { calls.push({ method: 'GET', params }); return service.get(params); },
    start: async params => { calls.push({ method: 'POST', params }); return service.start(params); },
  } : undefined, service: { get: forbidden, generate: forbidden }, auth: { status: forbidden }, chatClient: { probe: forbidden } });
  if (remoteAddress) server.prependListener('request', request => Object.defineProperty(request.socket, 'remoteAddress', { value: remoteAddress }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { base: `http://127.0.0.1:${server.address().port}`, calls };
}

test('GET只读取null或已保存状态，POST返回202及可轮询任务，读取不调用start', async t => {
  let started = false, startCalls = 0;
  const running = { jobId, ...payload, status: 'running', stage: 'searching' };
  const succeeded = { ...running, status: 'succeeded', stage: 'completed', result: { relationCount: 2, gaps: [], retainedPrevious: false } };
  const f = await fixture(t, { service: { get: async params => { assert.ok(params.ticker === payload.ticker || params.jobId === jobId); return started ? succeeded : null; },
    start: async params => { assert.deepEqual(params, payload); startCalls++; started = true; return running; } } });
  const initial = await fetch(`${f.base}/api/relations/research?ticker=${payload.ticker}&asOf=${payload.asOf}`);
  assert.equal(initial.status, 200); assert.deepEqual(await initial.json(), { data: null }); assert.equal(startCalls, 0);
  const response = await fetch(`${f.base}/api/relations/research`, post(payload));
  assert.equal(response.status, 202); assert.equal(response.headers.get('Cache-Control'), 'no-store'); assert.deepEqual(await response.json(), { data: running });
  const polled = await fetch(`${f.base}/api/relations/research?jobId=${jobId}`);
  assert.equal(polled.status, 200); assert.deepEqual(await polled.json(), { data: succeeded }); assert.equal(startCalls, 1);
  assert.deepEqual(f.calls.map(call => call.method), ['GET', 'POST', 'GET']);
});

test('HTTP真实service在推理未完成时仍快速202，之后GET成功且仅推理一次', async t => {
  let resolveInference, inferenceCalls = 0, job;
  const inference = new Promise(resolve => { resolveInference = resolve; });
  const store = { async expireStaleJobs() {}, async getLatestJob() { return job ?? null; }, async getJob() { return job ?? null; },
    async listCandidates() { return { subject: { ticker: payload.ticker, name: '腾讯控股' }, candidates: [{ ticker: '09988.HK', name: '阿里巴巴-W' }], candidateHash: 'a'.repeat(64) }; },
    async createJob(params) { job = { ...params, jobId, status: 'running', stage: 'queued', relations: [], gaps: [] }; return { created: true, job }; },
    async updateProgress({ stage }) { job.stage = stage; },
    async completeJob(params) { Object.assign(job, { status: 'succeeded', stage: 'completed', relations: params.relations, gaps: params.gaps }); return job; },
    async failJob() { assert.fail('合法空结果不能失败'); } };
  const service = createRelationsAiService({ store, configured: true, model: 'deepseek-v4-pro', prompt: 'prompt', now: () => new Date('2026-10-20T02:00:00Z'),
    client: { async researchRelations() { inferenceCalls++; return inference; } } });
  t.after(async () => { resolveInference({ provider: 'deepseek', model: 'deepseek-v4-pro', relations: [], gaps: ['未找到充分依据'], retrievalEvidence: { origin: 'deepseek-search', sources: [{ id: 's1' }] } }); await service.close(); });
  const f = await fixture(t, { service });
  const response = await fetch(`${f.base}/api/relations/research`, post(payload));
  assert.equal(response.status, 202); assert.equal((await response.json()).data.status, 'running'); assert.equal(inferenceCalls, 1);
  assert.equal((await (await fetch(`${f.base}/api/relations/research?jobId=${jobId}`)).json()).data.status, 'running');
  resolveInference({ provider: 'deepseek', model: 'deepseek-v4-pro', relations: [], gaps: ['未找到充分依据'], retrievalEvidence: { origin: 'deepseek-search', sources: [{ id: 's1' }] } });
  await service.close();
  const finished = await (await fetch(`${f.base}/api/relations/research?jobId=${jobId}`)).json();
  assert.equal(finished.data.status, 'succeeded'); assert.equal(finished.data.result.retainedPrevious, true); assert.equal(inferenceCalls, 1);
});

test('POST拒绝无JSON类型、坏JSON、超长body、query参数，失败均不启动API', async t => {
  const f = await fixture(t, { service: { get: async () => null, start: async () => assert.fail('无效请求不得启动') } });
  for (const [suffix, options, status, code] of [
    ['', { method: 'POST', body: JSON.stringify(payload) }, 415, 'CONTENT_TYPE_REQUIRED'],
    ['', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' }, 400, 'INVALID_JSON'],
    ['?ticker=another', post(payload), 400, 'INVALID_PARAMETERS'],
    ['', post({ padding: 'x'.repeat(17000) }), 413, 'BODY_TOO_LARGE'],
  ]) {
    const response = await fetch(`${f.base}/api/relations/research${suffix}`, options);
    assert.equal(response.status, status); assert.equal((await response.json()).error.code, code);
  }
  assert.equal(f.calls.length, 0);
});

test('外站Origin、cross-site和非本机无法创建任务，转发头不构成本机授权', async t => {
  const service = { get: async () => null, start: async () => assert.fail('外站不得触发推理') };
  const f = await fixture(t, { service });
  for (const headers of [{ Origin: 'https://untrusted.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const response = await fetch(`${f.base}/api/relations/research`, { ...post(payload), headers: { 'Content-Type': 'application/json', ...headers } });
    assert.equal(response.status, 403); assert.equal((await response.json()).error.code, 'ORIGIN_NOT_ALLOWED');
  }
  const remote = await fixture(t, { service, remoteAddress: '192.0.2.50' });
  const response = await fetch(`${remote.base}/api/relations/research`, { ...post(payload), headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '127.0.0.1' } });
  assert.equal(response.status, 403); assert.equal((await response.json()).error.code, 'LOCAL_ONLY_OPERATION');
  assert.equal(f.calls.length + remote.calls.length, 0);
});

test('允许本地前端CORS预检但不创建任务，未配置时明确503', async t => {
  const f = await fixture(t);
  const preflight = await fetch(`${f.base}/api/relations/research`, { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:8765', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(preflight.status, 204); assert.match(preflight.headers.get('Access-Control-Allow-Methods'), /POST/);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:8765');
  for (const options of [undefined, post(payload)]) {
    const response = await fetch(`${f.base}/api/relations/research`, options);
    assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'RELATIONS_AI_NOT_CONFIGURED');
  }
  assert.equal(f.calls.length, 0);
});

test('领域错误保留status，未知任务为null，未知异常不泄露provider/SQL信息', async t => {
  const unknown = await fixture(t, { service: { get: async () => null, start: async () => null } });
  assert.deepEqual(await (await fetch(`${unknown.base}/api/relations/research?jobId=${jobId}`)).json(), { data: null });
  for (const [error, status, code] of [
    [new ResearchError('INVALID_RELATIONS_RESEARCH', '识别任务标识无效。', 400), 400, 'INVALID_RELATIONS_RESEARCH'],
    [new ResearchError('RELATIONS_AI_HISTORICAL_READ_ONLY', '历史日期只可查看。', 400), 400, 'RELATIONS_AI_HISTORICAL_READ_ONLY'],
    [new ResearchError('UNKNOWN_SECURITY', '不在当前上市公司清单中。', 404), 404, 'UNKNOWN_SECURITY'],
    [new ResearchError('RELATIONS_AI_BUSY', '已有任务尚未完成。', 429), 429, 'RELATIONS_AI_BUSY'],
    [new Error('private-provider-message secret-key SELECT private_rows postgresql://owner:secret'), 500, 'INTERNAL_ERROR'],
  ]) {
    const f = await fixture(t, { service: { get: async () => { throw error; }, start: async () => { throw error; } } });
    for (const options of [undefined, post(payload)]) {
      const response = await fetch(`${f.base}/api/relations/research`, options), body = await response.text();
      assert.equal(response.status, status); assert.equal(JSON.parse(body).error.code, code); assert.doesNotMatch(body, /private-provider|secret|SELECT|postgresql/);
    }
  }
});
