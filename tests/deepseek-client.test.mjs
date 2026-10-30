import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeepSeekClient, DEFAULT_DEEPSEEK_MODEL } from '../backend/src/deepseek-client.mjs';
import { reportSchema } from '../backend/src/schema.mjs';

const input = { ticker: '002920.SZ', asOf: '2026-10-13', windowStart: '2026-07-16' };
const report = () => ({ company: { name: '测试公司', ticker: input.ticker, identityStatus: 'verified', description: '测试业务' }, summary: '测试研究', debates: [], sources: [{ id: 's1', title: '可追溯来源', url: 'https://example.com/research', author: '测试作者', publishedAt: input.asOf, platform: 'other', readingScope: 'search_snippet', qualityLabel: '' }], coverage: [], limitations: [] });
const completed = (text = JSON.stringify(report()), extras = {}) => ({ status: 'completed', model: DEFAULT_DEEPSEEK_MODEL, output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text }] }], ...extras });
const searchResults = () => ({ results: [{ url: 'https://example.com/research', title: '可追溯来源', summary: '真实 API 摘要', content: '取得的部分网页正文', date: '2026-10-13T02:00:00Z', site_name: '公开资料' }] });
const clientReturning = (data, options = {}) => createDeepSeekClient({ apiKey: 'mock-deepseek-key', fetchImpl: async url => Response.json(url.endsWith('/v1/tools/search') ? searchResults() : data), ...options });

test('三个官方 Search 请求并行完成后只调用一次无工具 Responses，独立返回真实检索证据', async () => {
  const calls = []; let pending = 0, maxPending = 0;
  const client = createDeepSeekClient({ apiKey: 'mock-deepseek-key', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/v1/tools/search')) { pending++; maxPending = Math.max(maxPending, pending); await new Promise(resolve => setTimeout(resolve, 5)); pending--; return Response.json(searchResults()); }
    assert.equal(pending, 0); return Response.json(completed());
  } });
  assert.equal(await client.resolveModel(), DEFAULT_DEEPSEEK_MODEL);
  const result = await client.research(input, '研究提示词');
  assert.equal(maxPending, 3); assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(call.options.headers.Authorization, 'Bearer mock-deepseek-key');
    assert.equal(call.options.headers.Accept, 'application/json'); assert.equal(call.options.redirect, 'error');
  }
  for (const call of calls.slice(0, 3)) {
    assert.equal(call.url, 'https://api.deepseek.com/v1/tools/search');
    const query = JSON.parse(call.options.body); assert.equal(query.count, 6); assert.equal(query.need_content, true);
    assert.ok(Array.from(query.query).length <= 128); assert.match(query.query, /002920.SZ/);
  }
  assert.equal(calls[3].url, 'https://api.deepseek.com/responses');
  const body = JSON.parse(calls[3].options.body);
  assert.equal(body.model, DEFAULT_DEEPSEEK_MODEL); assert.equal(body.stream, false);
  assert.match(body.instructions, /研究提示词/); assert.match(body.instructions, /已由可信后端/);
  assert.equal(Object.hasOwn(body, 'tools'), false); assert.equal(body.tool_choice, 'none');
  assert.equal(body.reasoning.effort, 'none'); assert.equal(body.max_output_tokens, 8000);
  assert.deepEqual(body.text.format, { type: 'json_schema', name: 'core_market_debates', schema: reportSchema });
  for (const unsupported of ['include', 'store', 'max_tool_calls', 'background', 'previous_response_id']) assert.equal(Object.hasOwn(body, unsupported), false);
  assert.match(body.input[0].content, /002920.SZ/);
  assert.deepEqual(result.retrievalEvidence, { origin: 'deepseek-search', sources: [{ url: 'https://example.com/research', readingScope: 'partial_text', publishedAt: input.asOf }] });
  assert.equal(result.response.output.some(item => item.type === 'web_search_call'), false);
});

test('连接测试只做最短文本调用，不声称搜索可用且不回显模型原文', async () => {
  let body;
  const client = createDeepSeekClient({ apiKey: 'mock', fetchImpl: async (url, options) => { body = JSON.parse(options.body); return Response.json(completed('private provider text', { output: [{ type: 'message', content: [{ type: 'output_text', text: 'private provider text' }] }] })); } });
  const response = await client.probe();
  assert.equal(response.provider, 'deepseek'); assert.equal(response.ok, true);
  assert.match(response.message, /另行验证/); assert.doesNotMatch(response.message, /private/);
  assert.equal(body.input[0].content, 'Say exactly: OK'); assert.equal(body.max_output_tokens, 32);
  assert.equal(Object.hasOwn(body, 'tools'), false); assert.equal(Object.hasOwn(body, 'text'), false);
});

test('模型目录 GET /models，去重过滤标识；独立搜索可支持 flash 整理材料', async () => {
  let route, method;
  const client = createDeepSeekClient({ apiKey: 'mock', fetchImpl: async (url, options) => { route = url; method = options.method; return Response.json({ data: [{ id: DEFAULT_DEEPSEEK_MODEL }, { id: DEFAULT_DEEPSEEK_MODEL }, { id: '<private>' }, { id: 'deepseek-flash' }] }); } });
  assert.deepEqual(await client.models(), [{ id: DEFAULT_DEEPSEEK_MODEL, displayName: DEFAULT_DEEPSEEK_MODEL }, { id: 'deepseek-flash', displayName: 'deepseek-flash' }]);
  assert.equal(route, 'https://api.deepseek.com/models'); assert.equal(method, 'GET');
  assert.equal((await clientReturning(completed(), { model: 'deepseek-flash' }).research(input, 'prompt')).report.summary, '测试研究');
  await assert.rejects(clientReturning({ data: {} }).models(), { code: 'DEEPSEEK_INVALID_MODELS' });
});

test('缺失密钥不发请求；认证、余额、限流与配置错误不回显上游内容', async () => {
  let calls = 0;
  await assert.rejects(createDeepSeekClient({ fetchImpl: async () => { calls++; } }).probe(), { code: 'DEEPSEEK_API_KEY_MISSING' });
  assert.equal(calls, 0);
  for (const [status, code] of [[401, 'DEEPSEEK_AUTH_ERROR'], [402, 'DEEPSEEK_INSUFFICIENT_BALANCE'], [403, 'DEEPSEEK_PERMISSION_ERROR'], [429, 'DEEPSEEK_RATE_LIMIT'], [400, 'DEEPSEEK_CONFIG_ERROR'], [404, 'DEEPSEEK_CONFIG_ERROR'], [422, 'DEEPSEEK_CONFIG_ERROR'], [500, 'DEEPSEEK_UPSTREAM_ERROR']]) {
    const client = createDeepSeekClient({ apiKey: 'secret-test-key', fetchImpl: async () => new Response('private secret-test-key raw error', { status }) });
    await assert.rejects(client.probe(), error => error.code === code && !/private|secret-test-key|raw error/.test(JSON.stringify(error)) && !/private|secret-test-key/.test(error.message));
  }
});

test('请求及响应读取中断只发送一次，超时与断线安全分类', async () => {
  let calls = 0;
  const failed = createDeepSeekClient({ apiKey: 'secret-test-key', fetchImpl: async () => { calls++; throw new Error('private secret-test-key'); } });
  await assert.rejects(failed.probe(), error => error.code === 'DEEPSEEK_CONNECTION_ERROR' && !error.message.includes('secret'));
  assert.equal(calls, 1);
  const bodyFailed = createDeepSeekClient({ apiKey: 'mock', fetchImpl: async () => new Response(new ReadableStream({ pull(controller) { controller.error(new Error('private body')); } })) });
  await assert.rejects(bodyFailed.probe(), { code: 'DEEPSEEK_CONNECTION_ERROR' });
  const timeout = createDeepSeekClient({ apiKey: 'mock', timeoutMs: 5, fetchImpl: (url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('private timeout')), { once: true })) });
  await assert.rejects(timeout.probe(), { code: 'DEEPSEEK_TIMEOUT' });
});

test('成功 HTTP 仍拒绝错误 JSON、未完成、拒绝回答或空文本', async () => {
  const invalid = createDeepSeekClient({ apiKey: 'mock', fetchImpl: async () => new Response('private invalid json') });
  await assert.rejects(invalid.probe(), { code: 'DEEPSEEK_INVALID_RESPONSE' });
  await assert.rejects(clientReturning(completed('OK', { status: 'incomplete' })).probe(), { code: 'DEEPSEEK_INCOMPLETE' });
  await assert.rejects(clientReturning(completed('', { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'private' }] }] })).probe(), { code: 'DEEPSEEK_REFUSAL' });
  await assert.rejects(clientReturning(completed('   ')).probe(), { code: 'DEEPSEEK_EMPTY_RESULT' });
});

test('空检索、虚构引用和损坏结构均不能生成成功结果', async () => {
  let generations = 0;
  const empty = createDeepSeekClient({ apiKey: 'mock', fetchImpl: async url => { if (url.endsWith('/responses')) generations++; return Response.json({ results: [] }); } });
  await assert.rejects(empty.research(input, 'prompt'), { code: 'RESEARCH_SOURCES_UNVERIFIED' }); assert.equal(generations, 0);
  const fictional = report(); fictional.sources[0].url = 'https://example.com/fabricated';
  await assert.rejects(clientReturning(completed(JSON.stringify(fictional))).research(input, 'prompt'), { code: 'RESEARCH_SOURCES_UNVERIFIED' });
  await assert.rejects(clientReturning(completed('{private')).research(input, 'prompt'), { code: 'DEEPSEEK_INVALID_JSON' });
  await assert.rejects(clientReturning(completed('{}')).research(input, 'prompt'), { code: 'INVALID_RESEARCH_SHAPE' });
});

test('研究使用独立长超时预算', async () => {
  const client = createDeepSeekClient({ apiKey: 'mock', timeoutMs: 1, researchTimeoutMs: 100, fetchImpl: async url => { await new Promise(resolve => setTimeout(resolve, 10)); return Response.json(url.endsWith('/v1/tools/search') ? searchResults() : completed()); } });
  assert.equal((await client.research(input, 'prompt')).report.summary, '测试研究');
});

test('整理阶段和整个研究各有截止时间，超时不重发生成请求', async () => {
  for (const limits of [{ generationTimeoutMs: 5 }, { researchTimeoutMs: 5 }]) {
    let generations = 0;
    const client = createDeepSeekClient({ apiKey: 'mock', ...limits, fetchImpl: async (url, options) => {
      if (url.endsWith('/v1/tools/search')) return Response.json(searchResults());
      generations++;
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('private timeout')), { once: true }));
    } });
    await assert.rejects(client.research(input, 'prompt'), { code: 'DEEPSEEK_TIMEOUT' }); assert.equal(generations, 1);
  }
});

test('任一搜索失败或返回坏结构都会停止，无静默降级、无重试', async () => {
  let searches = 0, generations = 0;
  const failed = createDeepSeekClient({ apiKey: 'mock', fetchImpl: async url => {
    if (url.endsWith('/responses')) { generations++; return Response.json(completed()); }
    searches++; if (searches === 2) throw new Error('private key-bearing failure'); return Response.json(searchResults());
  } });
  await assert.rejects(failed.research(input, 'prompt'), { code: 'DEEPSEEK_SEARCH_CONNECTION_ERROR' });
  assert.equal(searches, 3); assert.equal(generations, 0);
  const invalid = createDeepSeekClient({ apiKey: 'mock', fetchImpl: async () => Response.json({ results: {} }) });
  await assert.rejects(invalid.research(input, 'prompt'), { code: 'DEEPSEEK_SEARCH_INVALID_RESPONSE' });
  const timedOut = createDeepSeekClient({ apiKey: 'mock', searchTimeoutMs: 5, fetchImpl: (url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('private')), { once: true })) });
  await assert.rejects(timedOut.research(input, 'prompt'), { code: 'DEEPSEEK_SEARCH_TIMEOUT' });
});

test('检索上下文去重、拒绝不安全或未来来源，未知日期保留为空并限制阅读范围', async () => {
  let supplied;
  const result = await createDeepSeekClient({ apiKey: 'mock', fetchImpl: async (url, options) => {
    if (url.endsWith('/v1/tools/search')) return Response.json({ results: [
      ...searchResults().results,
      { url: 'https://example.com/research#repeat', title: '重复', summary: '摘要' },
      { url: 'javascript:private()', title: '危险来源' },
      { url: 'https://user:private@example.com/no', title: '含凭据' },
      { url: 'https://example.com/future', title: '未来来源', date: '2026-10-14T02:00:00Z' },
      { url: 'https://example.com/unknown', title: '未知日期', summary: '仅摘要', date: null, content: '' },
    ] });
    supplied = JSON.parse(JSON.parse(options.body).input[0].content.split('\n').at(-1)); return Response.json(completed());
  } }).research(input, 'prompt');
  assert.equal(supplied.retrievedSources.length, 2);
  assert.deepEqual(result.retrievalEvidence.sources[1], { url: 'https://example.com/unknown', readingScope: 'search_snippet', publishedAt: null });
  assert.ok(!JSON.stringify(supplied).includes('private'));
});

test('上下文至多16来源且总长不超过50k，检索query最多128字', async () => {
  let context, queries = [];
  const client = createDeepSeekClient({ apiKey: 'mock', fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/v1/tools/search')) {
      queries.push(body.query);
      return Response.json({ results: Array.from({ length: 6 }, (_, i) => ({ ...searchResults().results[0], url: i === 0 ? 'https://example.com/research' : `https://example.com/${queries.length}/${i}`, content: '长正文'.repeat(10000), summary: '摘要'.repeat(10000) })) });
    }
    context = JSON.parse(body.input[0].content.split('\n').at(-1)).retrievedSources; return Response.json(completed());
  } });
  await client.research({ ...input, companyName: '很长的公司名称'.repeat(100) }, 'prompt');
  assert.ok(context.length <= 16); assert.ok(JSON.stringify(context).length <= 50000);
  assert.ok(queries.every(query => Array.from(query).length <= 128));
});
