import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatGPTClient } from '../backend/src/chatgpt-client.mjs';
import { reportSchema } from '../backend/src/schema.mjs';

const input = { ticker: '002920.SZ', asOf: '2026-10-13', windowStart: '2026-07-16' };
const auth = { getAccessToken: async () => 'mock-oauth-token', status: () => ({ signedIn: true }) };
const catalog = () => Response.json({ models: [
  { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hide' },
  { slug: 'first-visible', display_name: 'First', visibility: 'list' },
  { slug: 'gpt-6.1-sol', display_name: 'GPT 6.1', visibility: 'list' },
] });
const result = (text = JSON.stringify({ summary: '测试中文' }), { search = true, ...overrides } = {}) => ({
  status: 'completed', model: 'gpt-6.1-sol',
  output: [...(search ? [{ type: 'web_search_call', status: 'completed', action: { sources: [] } }] : []), { type: 'message', content: [{ type: 'output_text', text }] }],
  ...overrides,
});
const event = (type, value = {}) => `event: ${type}\r\ndata: ${JSON.stringify({ type, ...value })}\r\n\r\n`;
function sse(text, sizes = [3, 7, 1, 15]) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0, index = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset >= bytes.length) return controller.close();
    const end = Math.min(bytes.length, offset + sizes[index++ % sizes.length]);
    controller.enqueue(bytes.slice(offset, end)); offset = end;
  } }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}
function clientReturning(stream, options = {}) {
  return createChatGPTClient({ auth, fetchImpl: async url => url.endsWith('/models') ? catalog() : stream(), ...options });
}

test('订阅请求只发送 OAuth、数组 input、stream/store；研究保留搜索与 strict schema', async () => {
  const calls = [];
  const client = createChatGPTClient({ auth, apiKey: 'must-never-be-used', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return url.endsWith('/models') ? catalog() : sse(event('response.completed', { response: result() }) + 'data: [DONE]\r\n\r\n');
  } });
  assert.equal(await client.resolveModel(), 'gpt-6.1-sol');
  const output = await client.research(input, '测试提示词');
  assert.equal(output.report.summary, '测试中文');
  assert.equal(output.response.model, 'gpt-6.1-sol');
  assert.equal(calls.length, 2); // The validated account catalog is reused.
  for (const call of calls) {
    assert.equal(call.options.headers.Authorization, 'Bearer mock-oauth-token');
    assert.equal(call.options.headers.Accept, call.url.endsWith('/models') ? 'application/json' : 'text/event-stream');
    assert.equal(call.options.redirect, 'error');
    assert.ok(call.url.startsWith('https://api.openai.com/v1/'));
  }
  const payload = JSON.parse(calls[1].options.body);
  assert.equal(payload.model, 'gpt-6.1-sol');
  assert.equal(payload.store, false); assert.equal(payload.stream, true);
  assert.ok(Array.isArray(payload.input)); assert.equal(payload.input[0].role, 'user');
  assert.equal(payload.instructions, '测试提示词');
  assert.deepEqual(payload.tools, [{ type: 'web_search', search_context_size: 'high' }]);
  assert.equal(payload.tool_choice, 'required');
  assert.deepEqual(payload.include, ['web_search_call.action.sources']);
  assert.equal(payload.text.format.strict, true); assert.deepEqual(payload.text.format.schema, reportSchema);
  for (const forbidden of ['max_output_tokens', 'max_tool_calls', 'temperature', 'background', 'metadata', 'previous_response_id', 'reasoning']) assert.equal(Object.hasOwn(payload, forbidden), false);
});

test('probe 是最短文本请求，不验证或宣称联网能力、不回传模型原文', async () => {
  let payload;
  const client = createChatGPTClient({ auth, fetchImpl: async (url, options) => {
    if (url.endsWith('/models')) return catalog();
    payload = JSON.parse(options.body);
    return sse(event('response.completed', { response: result('secret diagnostic text', { search: false }) }));
  } });
  const response = await client.probe();
  assert.equal(response.ok, true); assert.equal(response.model, 'gpt-6.1-sol');
  assert.ok(response.message.includes('另行验证')); assert.ok(!response.message.includes('secret'));
  assert.equal(payload.input[0].content, 'Say exactly: OK');
  assert.equal(Object.hasOwn(payload, 'tools'), false); assert.equal(Object.hasOwn(payload, 'text'), false);
});

test('models 使用可见 slug 和名称，兼容标准 data，指定模型需在真实目录中', async () => {
  const client = createChatGPTClient({ auth, fetchImpl: async () => catalog() });
  assert.deepEqual(await client.models(), [{ id: 'first-visible', displayName: 'First' }, { id: 'gpt-6.1-sol', displayName: 'GPT 6.1' }]);
  const standard = createChatGPTClient({ auth, fetchImpl: async () => Response.json({ data: [{ id: 'account-model' }, { id: 'account-model' }] }) });
  assert.deepEqual(await standard.models(), [{ id: 'account-model', displayName: 'account-model' }]);
  assert.equal(await standard.resolveModel(), 'account-model');
  const chosen = createChatGPTClient({ auth, model: 'first-visible', fetchImpl: async () => catalog() });
  assert.equal(await chosen.resolveModel(), 'first-visible');
  const unavailable = createChatGPTClient({ auth, model: 'other-model', fetchImpl: async () => catalog() });
  await assert.rejects(unavailable.probe(), error => error.code === 'CHATGPT_MODEL_UNAVAILABLE');
  const empty = createChatGPTClient({ auth, fetchImpl: async () => Response.json({ models: [] }) });
  await assert.rejects(empty.probe(), error => error.code === 'CHATGPT_NO_MODELS');
});

test('每次检查授权、模型缓存随 OAuth token 变化隔离，未登录不请求且不换 API Key', async () => {
  let token = 'first-account', authChecks = 0, requests = 0;
  const client = createChatGPTClient({ apiKey: 'must-never-be-used', auth: { getAccessToken: async () => { authChecks++; return token; } }, fetchImpl: async () => {
    requests++; return Response.json({ models: [{ slug: `model-${token}`, display_name: 'Mock', visibility: 'list' }] });
  } });
  assert.equal(await client.resolveModel(), 'model-first-account');
  assert.equal(await client.resolveModel(), 'model-first-account');
  assert.equal(requests, 1); assert.equal(authChecks, 2);
  token = 'second-account';
  assert.equal(await client.resolveModel(), 'model-second-account'); assert.equal(requests, 2);
  token = '';
  await assert.rejects(client.probe(), error => error.code === 'CHATGPT_LOGIN_REQUIRED');
  assert.equal(requests, 2);
});

test('SSE 跨 UTF-8 字节、CRLF、事件和多行 data 边界后 completed 结果保持权威', async () => {
  const response = result();
  response.output[1].id = 'msg-final';
  const completed = JSON.stringify({ type: 'response.completed', response });
  // Legal SSE JSON can span multiple data lines; joined newlines are whitespace.
  const cut = completed.indexOf(',');
  const stream = ': heartbeat\r\n\r\n' + event('response.output_text.delta', { output_index: 1, item_id: 'msg-final', content_index: 0, delta: '不完整内容' }) + `event: response.completed\r\ndata: ${completed.slice(0, cut + 1)}\r\ndata: ${completed.slice(cut + 1)}\r\n\r\n`;
  const output = await clientReturning(() => sse(stream, [1])).research(input, 'prompt');
  assert.deepEqual(output.report, { summary: '测试中文' });
});

test('200 但仅有 delta、DONE 或 JSON 响应均不能冒充成功', async () => {
  for (const stream of [event('response.output_text.delta', { output_index: 0, item_id: 'msg-unfinished', content_index: 0, delta: 'OK' }), 'data: [DONE]\n\n']) {
    await assert.rejects(clientReturning(() => sse(stream)).probe(), error => error.code === 'CHATGPT_STREAM_INTERRUPTED');
  }
  await assert.rejects(clientReturning(() => Response.json(result('OK'))).probe(), error => error.code === 'CHATGPT_INVALID_RESPONSE');
  await assert.rejects(clientReturning(() => sse('data: {bad}\n\n')).probe(), error => error.code === 'CHATGPT_INVALID_RESPONSE');
});

test('completed 仍要求 completed 状态、可用 JSON 和真实搜索记录', async () => {
  await assert.rejects(clientReturning(() => sse(event('response.completed', { response: result('{}', { status: 'in_progress' }) }))).research(input, 'prompt'), error => error.code === 'CHATGPT_INVALID_RESPONSE');
  await assert.rejects(clientReturning(() => sse(event('response.completed', { response: result('not json') }))).research(input, 'prompt'), error => error.code === 'CHATGPT_INVALID_JSON');
  await assert.rejects(clientReturning(() => sse(event('response.completed', { response: result('{}', { search: false }) }))).research(input, 'prompt'), error => error.code === 'SEARCH_NOT_USED');
  await assert.rejects(clientReturning(() => sse(event('response.completed', { response: result('', { search: false }) }))).probe(), error => error.code === 'CHATGPT_EMPTY_RESULT');
});

test('流中的拒绝、失败、未完成和 usage limit 停止推理，不返回上游私密文本', async () => {
  const cases = [
    [event('response.refusal.delta', { delta: 'private text' }), 'CHATGPT_REFUSAL'],
    [event('response.incomplete', { response: { status: 'incomplete' } }), 'CHATGPT_INCOMPLETE'],
    [event('response.failed', { response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'private text' } } }), 'CHATGPT_USAGE_LIMIT'],
    [event('error', { code: 'subscription_sharing_unsupported_capability', message: 'private text' }), 'CHATGPT_UNSUPPORTED_CAPABILITY'],
    [event('response.completed', { response: result('', { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'private text' }] }] }) }), 'CHATGPT_REFUSAL'],
  ];
  for (const [stream, expected] of cases) await assert.rejects(clientReturning(() => sse(stream)).probe(), error => error.code === expected && !error.message.includes('private'));
});

test('HTTP 权限、额度及能力错误使用安全分类，未回传 detail 或 error.message', async () => {
  const cases = [
    [401, { detail: 'private auth diagnostic' }, 'CHATGPT_AUTH_ERROR'],
    [403, { detail: 'private region diagnostic' }, 'CHATGPT_PERMISSION_ERROR'],
    [429, { error: { message: 'private rate diagnostic' } }, 'CHATGPT_RATE_OR_USAGE_LIMIT'],
    [400, { error: { code: 'subscription_sharing_unsupported_capability', message: 'private capability' } }, 'CHATGPT_UNSUPPORTED_CAPABILITY'],
    [403, { error: { code: 'subscription_sharing_user_not_eligible' } }, 'CHATGPT_NOT_ELIGIBLE'],
    [503, { error: { code: 'subscription_sharing_usage_unavailable' } }, 'CHATGPT_USAGE_UNAVAILABLE'],
  ];
  for (const [status, body, expected] of cases) {
    let requests = 0;
    const client = createChatGPTClient({ auth, fetchImpl: async () => { requests++; return Response.json(body, { status }); } });
    await assert.rejects(client.probe(), error => error.code === expected && !error.message.includes('private'));
    assert.equal(requests, 1); // No retry or fallback to a different billing route.
  }
});

test('网络中断及超时不会暴露凭据或异常原文', async () => {
  const disconnected = createChatGPTClient({ auth, fetchImpl: async () => { throw new Error('private token'); } });
  await assert.rejects(disconnected.models(), error => error.code === 'CHATGPT_CONNECTION_ERROR' && !error.message.includes('private'));
  const timeout = createChatGPTClient({ auth, timeoutMs: 5, fetchImpl: async (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('private timeout')), { once: true });
  }) });
  await assert.rejects(timeout.models(), error => error.code === 'CHATGPT_TIMEOUT' && !error.message.includes('private'));
});

test('模型目录的瞬时断线可重试；推理请求即使断线也只发送一次', async () => {
  let modelCalls = 0, responseCalls = 0;
  const reset = () => Object.assign(new Error('private upstream detail'), { code: 'ECONNRESET' });
  const client = createChatGPTClient({ auth, fetchImpl: async url => {
    if (url.endsWith('/models')) {
      modelCalls++;
      if (modelCalls < 3) throw reset();
      return catalog();
    }
    responseCalls++;
    throw reset();
  } });
  await assert.rejects(client.probe(), error => error.code === 'CHATGPT_CONNECTION_RESET' && error.diagnostic.stage === 'responses');
  assert.equal(modelCalls, 3);
  assert.equal(responseCalls, 1);
  const persistent = createChatGPTClient({ auth, fetchImpl: async () => { throw reset(); } });
  await assert.rejects(persistent.models(), error => error.code === 'CHATGPT_CONNECTION_RESET' && error.diagnostic.stage === 'models');
});

test('curl 握手失败才可在发送推理前重连，其他推理断线不重发', async () => {
  let calls = 0;
  const client = createChatGPTClient({ auth, fetchImpl: async url => {
    if (url.endsWith('/models')) return catalog();
    calls++;
    if (calls < 3) throw Object.assign(new Error('private handshake error'), { code: 'ECONNRESET', curlExitCode: 35 });
    return sse(event('response.completed', { response: result('OK', { search: false }) }));
  } });
  assert.equal((await client.probe()).ok, true);
  assert.equal(calls, 3);
  const noRetry = createChatGPTClient({ auth, fetchImpl: async url => {
    if (url.endsWith('/models')) return catalog();
    calls++;
    throw Object.assign(new Error('private partial response'), { code: 'ECONNRESET', curlExitCode: 56 });
  } });
  await assert.rejects(noRetry.probe(), error => error.code === 'CHATGPT_CONNECTION_RESET');
  assert.equal(calls, 4);
});

test('网络错误只从白名单 cause code 分类，不公开异常原文或凭据', async () => {
  const cases = [
    ['ENOTFOUND', 'CHATGPT_DNS_ERROR'], ['EAI_AGAIN', 'CHATGPT_DNS_ERROR'],
    ['ECONNREFUSED', 'CHATGPT_CONNECTION_REFUSED'],
    ['ECONNRESET', 'CHATGPT_CONNECTION_RESET'], ['UND_ERR_SOCKET', 'CHATGPT_CONNECTION_RESET'],
    ['UND_ERR_CONNECT_TIMEOUT', 'CHATGPT_CONNECT_TIMEOUT'], ['ETIMEDOUT', 'CHATGPT_CONNECT_TIMEOUT'],
    ['UND_ERR_HEADERS_TIMEOUT', 'CHATGPT_NETWORK_TIMEOUT'], ['UND_ERR_BODY_TIMEOUT', 'CHATGPT_NETWORK_TIMEOUT'],
    ['CERT_HAS_EXPIRED', 'CHATGPT_TLS_ERROR'], ['CERT_NOT_YET_VALID', 'CHATGPT_TLS_ERROR'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'CHATGPT_TLS_ERROR'], ['SELF_SIGNED_CERT_IN_CHAIN', 'CHATGPT_TLS_ERROR'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CHATGPT_TLS_ERROR'], ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CHATGPT_TLS_ERROR'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'CHATGPT_TLS_ERROR'],
  ];
  for (const [transportCode, expected] of cases) {
    const cause = Object.assign(new Error('private credentials or response'), { code: transportCode, stack: 'private stack' });
    const client = createChatGPTClient({ auth, fetchImpl: async () => { throw new TypeError('private fetch URL', { cause: new Error('private nested', { cause }) }); } });
    await assert.rejects(client.models(), error => {
      assert.equal(error.code, expected);
      assert.equal(error.status, 502);
      assert.deepEqual({ ...error.diagnostic, elapsedMs: 0 }, { stage: 'models', transportCode, elapsedMs: 0 });
      assert.ok(Number.isInteger(error.diagnostic.elapsedMs) && error.diagnostic.elapsedMs >= 0 && error.diagnostic.elapsedMs <= 600000);
      assert.ok(!JSON.stringify(error).includes('private'));
      assert.ok(!error.message.includes('private'));
      return true;
    });
  }
  const unknown = createChatGPTClient({ auth, fetchImpl: async () => { throw Object.assign(new Error('private unknown'), { code: 'private-code' }); } });
  await assert.rejects(unknown.models(), error => error.code === 'CHATGPT_CONNECTION_ERROR' && error.diagnostic.stage === 'models' && !Object.hasOwn(error.diagnostic, 'transportCode') && Number.isInteger(error.diagnostic.elapsedMs) && !JSON.stringify(error).includes('private'));
});

test('AggregateError 和循环 cause 有界检查，诊断区分请求与读取流阶段', async () => {
  const reset = Object.assign(new Error('private reset'), { code: 'ECONNRESET' });
  const aggregate = new AggregateError([new Error('private other'), reset], 'private aggregate');
  aggregate.cause = aggregate;
  const client = createChatGPTClient({ auth, fetchImpl: async url => {
    if (url.endsWith('/models')) return catalog();
    throw new TypeError('private failed fetch', { cause: aggregate });
  } });
  await assert.rejects(client.probe(), error => error.code === 'CHATGPT_CONNECTION_RESET' && error.diagnostic.stage === 'responses' && error.diagnostic.transportCode === 'ECONNRESET' && Number.isInteger(error.diagnostic.elapsedMs));
  const streamClient = clientReturning(() => new Response(new ReadableStream({ start(controller) {
    controller.error(new TypeError('private reader failure', { cause: reset }));
  } }), { headers: { 'Content-Type': 'text/event-stream' } }));
  await assert.rejects(streamClient.probe(), error => error.code === 'CHATGPT_CONNECTION_RESET' && error.diagnostic.stage === 'stream' && error.diagnostic.transportCode === 'ECONNRESET' && Number.isInteger(error.diagnostic.elapsedMs));
  const authClient = createChatGPTClient({ auth: { getAccessToken: async () => { throw reset; } }, fetchImpl: async () => { assert.fail('authorization failure must not fetch'); } });
  await assert.rejects(authClient.models(), error => error.code === 'CHATGPT_CONNECTION_RESET' && error.diagnostic.stage === 'authorization');
});

test('成功 HTTP 非 SSE 仍失败，只显示白名单 MIME 与状态，不读取或返回上游正文', async () => {
  const cases = [
    ['application/json; private-header=value', 'application/json'],
    ['TEXT/HTML; charset=utf-8; private-header=value', 'text/html'],
    ['text/plain', 'text/plain'],
    ['application/private-sensitive-type', 'unknown'],
    ['text/event-stream-private-value', 'unknown'],
  ];
  for (const [header, mime] of cases) {
    const client = clientReturning(() => new Response('private credentials or upstream HTML', { status: 200, headers: { 'Content-Type': header } }));
    await assert.rejects(client.probe(), error => {
      assert.equal(error.code, 'CHATGPT_INVALID_RESPONSE');
      assert.ok(error.message.includes(`HTTP 200，类型 ${mime}`));
      assert.deepEqual({ ...error.diagnostic, elapsedMs: 0 }, { stage: 'stream', httpStatus: 200, mime, bodyPresent: true, elapsedMs: 0 });
      assert.ok(!JSON.stringify(error).includes('private'));
      assert.ok(!error.message.includes('private'));
      return true;
    });
  }
  const noBody = clientReturning(() => new Response(null, { status: 204, headers: { 'Content-Type': 'text/event-stream' } }));
  await assert.rejects(noBody.probe(), error => error.code === 'CHATGPT_INVALID_RESPONSE' && error.diagnostic.httpStatus === 204 && error.diagnostic.bodyPresent === false);
  const valid = clientReturning(() => new Response(event('response.completed', { response: result('OK', { search: false }) }), { headers: { 'Content-Type': 'TEXT/EVENT-STREAM; charset=utf-8' } }));
  assert.equal((await valid.probe()).ok, true);
});

test('订阅接口省略 Content-Type 时仍验证真实 SSE 完成事件', async () => {
  const streamWithoutType = text => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(text));
    controller.close();
  } }));
  const client = clientReturning(() => streamWithoutType(event('response.completed', { response: result('OK', { search: false }) })));
  assert.equal((await client.probe()).ok, true);
  const invalid = clientReturning(() => streamWithoutType('<html>proxy error</html>'));
  await assert.rejects(invalid.probe(), error => error.code === 'CHATGPT_INVALID_RESPONSE' && error.diagnostic.mime === 'missing');
});


function sparseResearchStream({ terminal = { status: 'completed', model: 'gpt-6.1-sol', output: [] }, report = { summary: '中文🧪观点' } } = {}) {
  const text = JSON.stringify(report);
  const source = { type: 'url', url: 'https://example.com/report', title: '卖方研报' };
  return event('response.output_item.added', { output_index: 0, item: { id: 'search-one', type: 'web_search_call', status: 'in_progress' } })
    + event('response.web_search_call.completed', { output_index: 0, item_id: 'search-one' })
    + event('response.output_item.done', { output_index: 0, item: { id: 'search-one', type: 'web_search_call', status: 'completed', action: { type: 'search', query: '公司研报', sources: [source] } } })
    + event('response.output_item.added', { output_index: 1, item: { id: 'msg-one', type: 'message', role: 'assistant', status: 'in_progress', content: [] } })
    + event('response.content_part.added', { output_index: 1, item_id: 'msg-one', content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
    + event('response.output_text.delta', { output_index: 1, item_id: 'msg-one', content_index: 0, delta: text.slice(0, 10) })
    + event('response.output_text.delta', { output_index: 1, item_id: 'msg-one', content_index: 0, delta: text.slice(10) })
    + event('response.output_text.done', { output_index: 1, item_id: 'msg-one', content_index: 0, text })
    + event('response.content_part.done', { output_index: 1, item_id: 'msg-one', content_index: 0, part: { type: 'output_text', text } })
    + event('response.output_item.done', { output_index: 1, item: { id: 'msg-one', type: 'message', role: 'assistant', status: 'completed', content: [] } })
    + event('response.completed', { response: terminal });
}

test('稀疏 completed 用已完成 SSE 项目恢复 Unicode 文本与真实搜索证据', async () => {
  const output = await clientReturning(() => sse(sparseResearchStream(), [1])).research(input, 'prompt');
  assert.deepEqual(output.report, { summary: '中文🧪观点' });
  assert.equal(output.response.output[0].status, 'completed');
  assert.deepEqual(output.response.output[0].action.sources, [{ type: 'url', url: 'https://example.com/report', title: '卖方研报' }]);
  assert.equal(output.response.output[1].content[0].text, JSON.stringify(output.report));
});

test('终端按 item ID 合并稀疏项目，保留权威字段，仅填充缺少的 action.sources', async () => {
  const terminal = { status: 'completed', output: [
    { id: 'msg-one', type: 'message', status: 'completed', content: [{ type: 'output_text', text: '{"summary":"最终结果"}' }] },
    { id: 'search-one', type: 'web_search_call', status: 'completed', action: { type: 'search', query: '最终查询' } },
  ] };
  const output = await clientReturning(() => sse(sparseResearchStream({ terminal }))).research(input, 'prompt');
  assert.equal(output.report.summary, '最终结果');
  const search = output.response.output.find(item => item.type === 'web_search_call');
  assert.equal(search.action.query, '最终查询');
  assert.equal(search.action.sources[0].url, 'https://example.com/report');
  terminal.output[1].action.sources = [];
  const explicit = await clientReturning(() => sse(sparseResearchStream({ terminal }))).research(input, 'prompt');
  assert.deepEqual(explicit.response.output[0].action.sources, []);
});

test('仅 output_item.done 的文本与搜索也可恢复，但始终要求 response.completed', async () => {
  const text = '{"summary":"仅 done 项目"}';
  const stream = event('response.output_item.done', { output_index: 0, item: { id: 'search-done', type: 'web_search_call', status: 'completed', action: { sources: [] } } })
    + event('response.output_item.done', { output_index: 1, item: { id: 'msg-done', type: 'message', status: 'completed', content: [{ type: 'output_text', text }] } });
  await assert.rejects(clientReturning(() => sse(stream)).research(input, 'prompt'), error => error.code === 'CHATGPT_STREAM_INTERRUPTED');
  assert.equal((await clientReturning(() => sse(stream + event('response.completed', { response: { status: 'completed' } }))).research(input, 'prompt')).report.summary, '仅 done 项目');
});

test('content part 和 annotation 事件保留有序文本及引用，不从模型 JSON 发明搜索', async () => {
  const report = '{"summary":"第一段第二段", "sources":[{"url":"https://made-up.example"}]}';
  const stream = event('response.output_item.added', { output_index: 0, item: { id: 'message-parts', type: 'message', content: [] } })
    + event('response.output_text.done', { output_index: 0, item_id: 'message-parts', content_index: 1, text: report.slice(13) })
    + event('response.output_text.done', { output_index: 0, item_id: 'message-parts', content_index: 0, text: report.slice(0, 13) })
    + event('response.output_text.annotation.added', { output_index: 0, item_id: 'message-parts', content_index: 0, annotation_index: 0, annotation: { type: 'url_citation', url: 'https://example.com/citation' } })
    + event('response.completed', { response: { status: 'completed', output: [] } });
  await assert.rejects(clientReturning(() => sse(stream, [1])).research(input, 'prompt'), error => error.code === 'SEARCH_NOT_USED');
  const withSearch = stream.replace(event('response.completed', { response: { status: 'completed', output: [] } }), event('response.output_item.done', { output_index: 1, item: { id: 'real-search', type: 'web_search_call', status: 'completed', action: { sources: [] } } }) + event('response.completed', { response: { status: 'completed', output: [] } }));
  const output = await clientReturning(() => sse(withSearch)).research(input, 'prompt');
  assert.equal(output.report.summary, '第一段第二段');
  assert.equal(output.response.output[0].content[0].annotations[0].url, 'https://example.com/citation');
  assert.deepEqual(output.response.output[1].action.sources, []);
});

test('身份冲突、非法索引、不同 done 文本、稀疏内容和超量状态安全失败', async () => {
  const delta = { output_index: 0, item_id: 'message-conflict', content_index: 0, delta: 'OK' };
  const cases = [
    event('response.output_text.delta', { ...delta, output_index: -1 }),
    event('response.output_text.delta', { ...delta, output_index: 256 }),
    event('response.output_text.delta', { ...delta, content_index: 256 }),
    event('response.output_text.delta', { ...delta, delta: {} }),
    event('response.output_text.delta', delta) + event('response.output_text.delta', { ...delta, output_index: 1 }),
    event('response.output_text.delta', delta) + event('response.output_text.delta', { ...delta, item_id: 'other-message' }),
    event('response.output_text.delta', delta) + event('response.output_text.done', { ...delta, text: 'different private text' }),
    event('response.output_text.done', { output_index: 0, item_id: 'message-hole', content_index: 1, text: 'private text' }),
    event('response.output_item.done', { output_index: 0, item: { id: 'search-conflict', type: 'web_search_call', status: 'completed', action: { sources: Array(1025).fill({}) } } }),
  ];
  for (const stream of cases) {
    await assert.rejects(clientReturning(() => sse(stream + event('response.completed', { response: { status: 'completed', output: [] } }))).probe(), error => error.code === 'CHATGPT_INVALID_RESPONSE' && !JSON.stringify(error).includes('private'));
  }
});

test('恢复的拒绝或未完成项目仍失败', async () => {
  const cases = [
    [event('response.content_part.done', { output_index: 0, item_id: 'refusal-message', content_index: 0, part: { type: 'refusal', refusal: 'private text' } }), 'CHATGPT_REFUSAL'],
    [event('response.output_item.done', { output_index: 0, item: { id: 'failed-item', type: 'message', status: 'incomplete', content: [] } }), 'CHATGPT_INCOMPLETE'],
  ];
  for (const [stream, code] of cases) await assert.rejects(clientReturning(() => sse(stream + event('response.completed', { response: { status: 'completed', output: [] } }))).probe(), error => error.code === code && !JSON.stringify(error).includes('private'));
});


test('有效 completed 立即完成并取消仍打开的流，随后断线不丢失结果', async () => {
  for (const resetAfterCompletion of [false, true]) {
    let cancelled = false, reads = 0;
    const stream = new ReadableStream({
      pull(controller) {
        reads++;
        if (reads === 1) controller.enqueue(new TextEncoder().encode(event('response.completed', { response: result('OK', { search: false }) })));
        else if (resetAfterCompletion) controller.error(Object.assign(new Error('private late reset'), { code: 'ECONNRESET' }));
        // Without an error this stream intentionally remains open.
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const client = clientReturning(() => new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }), { timeoutMs: 50 });
    assert.equal((await client.probe()).ok, true);
    assert.equal(cancelled, true);
    assert.equal(reads, 1);
  }
});

test('curl 退出码与耗时只公开有界的本地诊断，嵌套原文和无效退出码不公开', async () => {
  for (const curlExitCode of [35, 56, -1, 101, 1.5, 'private-code']) {
    const cause = Object.assign(new Error('private token or URL'), { code: 'ECONNRESET', curlExitCode });
    const client = createChatGPTClient({ auth, fetchImpl: async () => { throw new TypeError('private wrapper', { cause }); } });
    await assert.rejects(client.models(), error => {
      assert.equal(error.code, 'CHATGPT_CONNECTION_RESET');
      assert.equal(error.diagnostic.stage, 'models');
      assert.equal(error.diagnostic.transportCode, 'ECONNRESET');
      assert.ok(Number.isInteger(error.diagnostic.elapsedMs) && error.diagnostic.elapsedMs >= 0 && error.diagnostic.elapsedMs <= 600000);
      if (Number.isInteger(curlExitCode) && curlExitCode >= 0 && curlExitCode <= 100) assert.equal(error.diagnostic.curlExitCode, curlExitCode);
      else assert.equal(Object.hasOwn(error.diagnostic, 'curlExitCode'), false);
      assert.ok(!JSON.stringify(error).includes('private'));
      return true;
    });
  }
});

test('研究有独立超时预算，连接测试仍使用较短 timeoutMs', async () => {
  const completeAfter = delay => new Response(new ReadableStream({ async start(controller) {
    await new Promise(resolve => setTimeout(resolve, delay));
    controller.enqueue(new TextEncoder().encode(event('response.completed', { response: result() })));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
  const client = clientReturning(() => completeAfter(15), { timeoutMs: 5, researchTimeoutMs: 100 });
  assert.equal((await client.research(input, 'prompt')).report.summary, '测试中文');
  const abortingFetch = async (url, options) => url.endsWith('/models') ? catalog() : new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('private timeout')), { once: true });
  });
  const limited = createChatGPTClient({ auth, fetchImpl: abortingFetch, timeoutMs: 5, researchTimeoutMs: 15 });
  await assert.rejects(limited.probe(), error => error.code === 'CHATGPT_TIMEOUT' && error.diagnostic.stage === 'responses' && Number.isInteger(error.diagnostic.elapsedMs));
  await assert.rejects(limited.research(input, 'prompt'), error => error.code === 'CHATGPT_TIMEOUT' && error.diagnostic.stage === 'responses');
});


test('连接测试恢复稀疏完成事件中的实际文本，空白或完成事件本身不足以判定成功', async () => {
  const stream = event('response.output_text.delta', { output_index: 0, item_id: 'probe-text', content_index: 0, delta: 'OK' })
    + event('response.output_text.done', { output_index: 0, item_id: 'probe-text', content_index: 0, text: 'OK' })
    + event('response.completed', { response: { status: 'completed', output: [] } });
  const response = await clientReturning(() => sse(stream)).probe();
  assert.equal(response.ok, true);
  assert.ok(response.message.includes('最短文本调用成功'));
  for (const text of ['', ' \n\t']) await assert.rejects(clientReturning(() => sse(event('response.completed', { response: result(text, { search: false }) }))).probe(), error => error.code === 'CHATGPT_EMPTY_RESULT');
});
