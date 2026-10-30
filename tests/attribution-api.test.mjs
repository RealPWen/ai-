import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createResearchServer } from '../backend/app.mjs';
import { ResearchError } from '../backend/src/errors.mjs';

const ticker = '02359.HK', jobId = '00000000-0000-4000-8000-000000000001';
const payload = { ticker, periods: ['1m', '6m', '1y'] };
const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function fixture(t, { service, remoteAddress } = {}) {
  const calls = [], forbidden = () => assert.fail('归因接口不能调用核心分歧、关系识别、登录或其他AI接口');
  const server = createResearchServer({ attributionService: service ? {
    get: async params => { calls.push({ method: 'get', params }); return service.get(params); },
    start: async params => { calls.push({ method: 'start', params }); return service.start(params); },
    getJob: async id => { calls.push({ method: 'getJob', id }); return service.getJob(id); },
  } : undefined,
    service: { get: forbidden, generate: forbidden }, auth: { status: forbidden }, chatClient: { probe: forbidden },
    relationsAiService: { get: forbidden, start: forbidden } });
  if (remoteAddress) server.prependListener('request', request => Object.defineProperty(request.socket, 'remoteAddress', { value: remoteAddress }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { base: `http://127.0.0.1:${server.address().port}`, calls };
}

test('GET归因报告只读并准确转交ticker/asOf查询参数，不启动任何生成', async t => {
  const expected = { ticker, reports: { '1m': { summary: '数据库已有报告' } }, periods: [] };
  const f = await fixture(t, { service: {
    get: async params => { assert.deepEqual(params, { ticker, asOf: '2026-10-19' }); return expected; },
    start: async () => assert.fail('刷新读取不能生成'), getJob: async () => assert.fail('报告读取不能查询其他任务'),
  } });
  const response = await fetch(`${f.base}/api/market/attribution?ticker=${ticker}&asOf=2026-10-19`);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { data: expected });
  assert.equal(response.headers.get('Cache-Control'), 'no-store'); assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.deepEqual(f.calls, [{ method: 'get', params: { ticker, asOf: '2026-10-19' } }]);
});

test('POST生成转交JSON并立即202，GET jobs仅按id轮询，三个周期执行由服务管理', async t => {
  const running = { jobId, ticker, requestedAsOf: '2026-10-20', status: 'running', stage: 'queued', periods: { '1m': { status: 'queued' } } };
  let startCalls = 0;
  const f = await fixture(t, { service: {
    get: async () => null, start: async params => { assert.deepEqual(params, payload); startCalls++; return running; },
    getJob: async id => { assert.equal(id, jobId); return { ...running, stage: 'searching' }; },
  } });
  const response = await fetch(`${f.base}/api/market/attribution/generate`, { ...post(payload), headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  assert.equal(response.status, 202); assert.deepEqual(await response.json(), { data: running }); assert.equal(startCalls, 1);
  for (let index = 0; index < 2; index++) {
    const polled = await fetch(`${f.base}/api/market/attribution/jobs/${jobId}`);
    assert.equal(polled.status, 200); assert.equal((await polled.json()).data.stage, 'searching');
  }
  assert.equal(startCalls, 1); assert.deepEqual(f.calls.map(call => call.method), ['start', 'getJob', 'getJob']);
});

test('未配置归因服务时三条路由明确503，CORS预检不触发服务', async t => {
  const f = await fixture(t);
  for (const [path, options] of [['/api/market/attribution?ticker=02359.HK'], [`/api/market/attribution/jobs/${jobId}`], ['/api/market/attribution/generate', post(payload)]]) {
    const response = await fetch(`${f.base}${path}`, options);
    assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'ATTRIBUTION_DATABASE_NOT_CONFIGURED');
  }
  const preflight = await fetch(`${f.base}/api/market/attribution/generate`, { method: 'OPTIONS', headers: {
    Origin: 'http://127.0.0.1:8765', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Content-Type',
  } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:8765');
  assert.match(preflight.headers.get('Access-Control-Allow-Methods'), /POST/); assert.equal(f.calls.length, 0);
});

test('拒绝POST查询串、任务查询串、非JSON类型、坏JSON与超长body，均不调用服务', async t => {
  const forbidden = () => assert.fail('非法请求不得读取任务或启动AI');
  const f = await fixture(t, { service: { get: forbidden, start: forbidden, getJob: forbidden } });
  for (const [path, options, status, code] of [
    ['/api/market/attribution/generate?ticker=other', post(payload), 400, 'INVALID_PARAMETERS'],
    [`/api/market/attribution/jobs/${jobId}?ticker=other`, undefined, 400, 'INVALID_PARAMETERS'],
    ['/api/market/attribution/generate', { method: 'POST', body: JSON.stringify(payload) }, 415, 'CONTENT_TYPE_REQUIRED'],
    ['/api/market/attribution/generate', { ...post(payload), headers: { 'Content-Type': 'text/plain' } }, 415, 'CONTENT_TYPE_REQUIRED'],
    ['/api/market/attribution/generate', { ...post(payload), headers: { 'Content-Type': 'application/jsonp' } }, 415, 'CONTENT_TYPE_REQUIRED'],
    ['/api/market/attribution/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' }, 400, 'INVALID_JSON'],
    ['/api/market/attribution/generate', post({ padding: 'x'.repeat(17000) }), 413, 'BODY_TOO_LARGE'],
  ]) {
    const response = await fetch(`${f.base}${path}`, options);
    assert.equal(response.status, status, path); assert.equal((await response.json()).error.code, code);
  }
  assert.equal(f.calls.length, 0);
});

test('外站Origin不能读写归因，cross-site不能生成，本机允许的前端Origin正常返回', async t => {
  const f = await fixture(t, { service: { get: async () => null, start: async () => ({ jobId }), getJob: async () => ({ jobId }) } });
  for (const origin of ['https://untrusted.example', 'null']) {
    for (const [path, options] of [['/api/market/attribution?ticker=02359.HK'], [`/api/market/attribution/jobs/${jobId}`], ['/api/market/attribution/generate', post(payload)]]) {
      const response = await fetch(`${f.base}${path}`, { ...options, headers: { ...options?.headers, Origin: origin } });
      assert.equal(response.status, 403); assert.equal((await response.json()).error.code, 'ORIGIN_NOT_ALLOWED');
    }
  }
  const cross = await fetch(`${f.base}/api/market/attribution/generate`, { ...post(payload), headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(cross.status, 403); assert.equal((await cross.json()).error.code, 'ORIGIN_NOT_ALLOWED'); assert.equal(f.calls.length, 0);
  const allowed = await fetch(`${f.base}/api/market/attribution?ticker=${ticker}`, { headers: { Origin: 'http://localhost:8765' } });
  assert.equal(allowed.status, 200); assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8765');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'get');
});

test('生成只允许真实loopback，转发头不能授权；DNS rebinding Host不能访问任何归因接口', async t => {
  const service = { get: async () => null, start: async () => ({ jobId }), getJob: async () => ({ jobId }) };
  for (const address of ['192.0.2.55', '::ffff:192.0.2.55', '2001:db8::1']) {
    const f = await fixture(t, { service, remoteAddress: address });
    const response = await fetch(`${f.base}/api/market/attribution/generate`, { ...post(payload), headers: {
      'Content-Type': 'application/json', 'X-Forwarded-For': '127.0.0.1', Forwarded: 'for=127.0.0.1;host=localhost',
    } });
    assert.equal(response.status, 403); assert.equal((await response.json()).error.code, 'LOCAL_ONLY_OPERATION'); assert.equal(f.calls.length, 0);
  }
  for (const address of ['::1', '::ffff:127.0.0.1', '127.0.1.2']) {
    const f = await fixture(t, { service, remoteAddress: address });
    assert.equal((await fetch(`${f.base}/api/market/attribution/generate`, post(payload))).status, 202);
  }
  const f = await fixture(t, { service });
  for (const path of ['/api/market/attribution', `/api/market/attribution/jobs/${jobId}`, '/api/market/attribution/generate']) {
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest(`${f.base}${path}`, { headers: { Host: 'untrusted.example:8000' } }, result => {
        const chunks = []; result.on('data', chunk => chunks.push(chunk));
        result.on('end', () => resolve({ status: result.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      request.on('error', reject); request.end();
    });
    assert.equal(response.status, 403); assert.equal(response.body.error.code, 'HOST_NOT_ALLOWED');
  }
  assert.equal(f.calls.length, 0);
});

test('领域错误保留安全status/code，未知异常只返回通用错误不泄漏模型或SQL', async t => {
  for (const [error, status, code] of [
    [new ResearchError('INVALID_ATTRIBUTION_INPUT', '归因参数无效。', 400), 400, 'INVALID_ATTRIBUTION_INPUT'],
    [new ResearchError('ATTRIBUTION_JOB_NOT_FOUND', '归因任务不存在。', 404), 404, 'ATTRIBUTION_JOB_NOT_FOUND'],
    [new ResearchError('ATTRIBUTION_BUSY', '已有任务正在运行。', 429), 429, 'ATTRIBUTION_BUSY'],
    [new ResearchError('ATTRIBUTION_DATABASE_UNAVAILABLE', '归因数据库暂不可用。', 503), 503, 'ATTRIBUTION_DATABASE_UNAVAILABLE'],
    [new Error('private-provider secret-key SELECT postgres://owner:password@private/db'), 500, 'INTERNAL_ERROR'],
  ]) {
    const fail = async () => { throw error; }, f = await fixture(t, { service: { get: fail, start: fail, getJob: fail } });
    for (const [path, options] of [['/api/market/attribution?ticker=02359.HK'], [`/api/market/attribution/jobs/${jobId}`], ['/api/market/attribution/generate', post(payload)]]) {
      const response = await fetch(`${f.base}${path}`, options), body = await response.text();
      assert.equal(response.status, status); assert.equal(JSON.parse(body).error.code, code);
      assert.doesNotMatch(body, /private-provider|secret-key|SELECT|postgres|password|stack/);
    }
  }
});
