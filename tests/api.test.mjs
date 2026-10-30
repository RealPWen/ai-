import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../frontend/src/api/client.js';
import { createResearchService } from '../frontend/src/services/research-service.js';
import { adapters } from '../frontend/src/services/adapters.js';
import { safeSourceUrl } from '../frontend/src/views/research-view.js';

const config = { enabled: true, baseUrl: 'http://127.0.0.1:8000/api/', timeoutMs: 1000 };
test('未启用接口时不会发出网络请求', async () => {
  let requests = 0;
  const client = createApiClient({ ...config, enabled: false }, async () => { requests++; });
  await assert.rejects(client.get('/quote'), error => error.code === 'API_DISABLED');
  assert.equal(requests, 0);
});
test('未配置的模块不请求，已配置模块可独立接入并映射参数', async () => {
  const requests = [];
  const service = createResearchService({ config, routes: { quote: params => ({ path: '/snapshot', query: { stock_code: params.ticker } }), events: null }, client: { get: async (path, options) => { requests.push({ path, query: options.query }); return { data: { price: 0, peTtm: null, pb: 0 } }; } }, mappers: { quote: adapters.quote, events: adapters.events } });
  assert.equal((await service.load('events')).status, 'not_configured');
  const result = await service.load('quote', { ticker: '002920.SZ' });
  assert.equal(result.data.price, 0); assert.equal(result.data.pb, 0);
  assert.deepEqual(requests, [{ path: '/snapshot', query: { stock_code: '002920.SZ' } }]);
});
test('URL 保留 baseUrl 的路径前缀，参数安全编码，缺失参数不发送', async () => {
  let observed;
  const client = createApiClient(config, async url => { observed = new URL(url); return Response.json({ value: 1 }); });
  assert.deepEqual(await client.get('/quote', { query: { q: '座舱 & 智驾', empty: null } }), { value: 1 });
  assert.equal(observed.pathname, '/api/quote'); assert.equal(observed.searchParams.get('q'), '座舱 & 智驾'); assert.equal(observed.searchParams.has('empty'), false);
});
test('局域网页面的默认接口使用访问页面的同源地址，而非访问者自己的本机', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin: 'http://192.168.3.148:8765' } });
  try {
    let observed;
    const client = createApiClient({ ...config, baseUrl: '' }, async url => { observed = new URL(url); return Response.json({ data: [] }); });
    await client.get('/api/events', { query: { ticker: '601127.SH' } });
    assert.equal(observed.origin, 'http://192.168.3.148:8765');
    assert.equal(observed.pathname, '/api/events');
    assert.equal(observed.searchParams.get('ticker'), '601127.SH');
  } finally {
    if (original) Object.defineProperty(globalThis, 'location', original);
    else delete globalThis.location;
  }
});
test('HTTP 错误与非 JSON 响应可区分', async () => {
  const http = createApiClient(config, async () => new Response('missing', { status: 404 }));
  await assert.rejects(http.get('/quote'), error => error.code === 'HTTP_ERROR' && error.status === 404);
  const invalid = createApiClient(config, async () => new Response('<html>login</html>'));
  await assert.rejects(invalid.get('/quote'), error => error.code === 'INVALID_JSON');
});
test('生成错误显示安全的失败阶段与耗时，不转发额外诊断内容', async () => {
  const client = createApiClient(config, async () => Response.json({ error: {
    code: 'CHATGPT_CONNECTION_RESET', message: '连接中断',
    diagnostic: { stage: 'stream', elapsedMs: 42500, curlExitCode: 56, privateToken: 'do-not-forward' },
  } }, { status: 502 }));
  await assert.rejects(client.post('/generate', { body: {} }), error => {
    assert.match(error.message, /接收生成结果阶段.*43 秒/);
    assert.deepEqual(error.diagnostic, { stage: 'stream', elapsedMs: 42500, curlExitCode: 56 });
    assert.ok(!JSON.stringify(error).includes('do-not-forward')); return true;
  });
});
const abortableFetch = (_url, { signal }) => new Promise((_resolve, reject) => {
  if (signal.aborted) reject(new DOMException('aborted', 'AbortError'));
  else signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
});
test('请求超时能取消等待并返回 TIMEOUT', async () => {
  const client = createApiClient({ ...config, timeoutMs: 15 }, abortableFetch);
  await assert.rejects(client.get('/quote'), error => error.code === 'TIMEOUT');
});
test('区间切换可取消旧请求，取消不冒充网络失败', async () => {
  const controller = new AbortController();
  const client = createApiClient(config, abortableFetch);
  const request = client.get('/prices', { signal: controller.signal }); controller.abort();
  await assert.rejects(request, error => error.code === 'ABORTED');
});
test('空数据保留空状态，格式错误不会伪装为零或空列表', () => {
  assert.equal(adapters.events({ data: null }), null);
  assert.throws(() => adapters.events({ data: [] }));
  assert.equal(adapters.quote({ data: null }), null);
  assert.throws(() => adapters.prices({ data: [{ date: '2026-10-13', close: '100' }] }));
  assert.throws(() => adapters.events({ data: { wrong: 'shape' } }));
  assert.throws(() => adapters.forecasts([{ fiscalYear: '2026E', low: { value: '3.2' } }]));
});
test('从后端返回的来源链接不允许执行脚本或打开本地协议', () => {
  assert.equal(safeSourceUrl('javascript:alert(1)'), null);
  assert.equal(safeSourceUrl('file:///etc/passwd'), null);
  assert.equal(safeSourceUrl('https://www.desaysv.com/'), 'https://www.desaysv.com/');
});
