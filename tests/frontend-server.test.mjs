import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFrontendServer } from '../scripts/serve-frontend.mjs';
import { normalizeAuthStatus, canUseAIResearch } from '../frontend/src/services/auth.js';

async function fixture(t, { remoteAddress, ...options } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), 'company-frontend-test-')), root = join(temporary, 'dist');
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, '.private'));
  await writeFile(join(root, 'index.html'), '<h1>投研看板</h1>');
  await writeFile(join(root, 'src', 'app.js'), 'export const ready = true;');
  await writeFile(join(root, 'styles.css'), 'body { color: teal; }');
  await writeFile(join(root, '.env'), 'secret-should-not-be-served');
  await writeFile(join(root, '.private', 'note.txt'), 'hidden');
  await writeFile(join(temporary, 'outside.txt'), 'outside-root');
  await symlink(join(temporary, 'outside.txt'), join(root, 'escape.txt'));
  await symlink(join(root, '.env'), join(root, 'hidden-alias.txt'));
  const server = createFrontendServer({ root, proxyEnabled: false, ...options });
  if (remoteAddress) server.prependListener('request', request => Object.defineProperty(request.socket, 'remoteAddress', { value: remoteAddress }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  });
  const get = (path, method = 'GET', { headers = {}, body } = {}) => new Promise((resolve, reject) => {
    // Raw request paths preserve dot segments that fetch/URL would normalize away.
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
  get.origin = `http://127.0.0.1:${server.address().port}`;
  return get;
}

test('frontend serves index and assets with MIME types; HEAD returns headers without a body', async t => {
  const get = await fixture(t), index = await get('/?ticker=002920.SZ');
  assert.equal(index.status, 200); assert.equal(index.body, '<h1>投研看板</h1>');
  assert.equal(index.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(index.headers['content-length'], String(Buffer.byteLength(index.body)));
  assert.equal(index.headers['x-content-type-options'], 'nosniff');
  assert.equal(index.headers['cache-control'], 'no-cache');
  const head = await get('/', 'HEAD');
  assert.equal(head.status, 200); assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], index.headers['content-length']);
  const js = await get('/src/app.js'), css = await get('/styles.css');
  assert.equal(js.status, 200); assert.match(js.headers['content-type'], /^text\/javascript/);
  assert.equal(css.status, 200); assert.match(css.headers['content-type'], /^text\/css/);
});

test('frontend denies traversal, hidden paths and symlink escapes without revealing content', async t => {
  const get = await fixture(t);
  for (const path of ['/../outside.txt', '/%2e%2e/outside.txt', '/src/%2e%2e/%2e%2e/outside.txt',
    '/src%2f..%2f..%2foutside.txt', '/src%5c..%5coutside.txt', '/.env', '/%2eenv', '/.private/note.txt', '/escape.txt', '/hidden-alias.txt']) {
    const response = await get(path);
    assert.equal(response.status, 403, path); assert.equal(response.body, 'Forbidden.\n', path);
    assert.doesNotMatch(response.body, /secret|outside-root|company-frontend-test/);
  }
  for (const path of ['/%ZZ', '/%00', '//outside.txt']) assert.equal((await get(path)).status, 400, path);
});

test('frontend does not list directories or fall back to index for missing files; rejects other methods', async t => {
  const get = await fixture(t);
  for (const path of ['/src/', '/missing.js', '/api/health']) {
    const response = await get(path); assert.equal(response.status, 404, path); assert.equal(response.body, 'Not found.\n');
  }
  const head = await get('/missing.js', 'HEAD');
  assert.equal(head.status, 404); assert.equal(head.body, '');
  const post = await get('/', 'POST');
  assert.equal(post.status, 405); assert.equal(post.headers.allow, 'GET, HEAD');
});

async function backend(t) {
  const received = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const entry = { url: request.url, method: request.method, headers: request.headers, body: Buffer.concat(chunks).toString() };
    received.push(entry);
    const data=entry.url==='/api/auth/status'
      ? {provider:'deepseek',configured:true,authenticated:true,researchEnabled:true,model:'test-model'}
      : { ticker: '002920.SZ', url: entry.url, method: entry.method };
    const body = JSON.stringify({ data });
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body),
      'Set-Cookie': 'private=owner', 'Access-Control-Allow-Origin': 'http://untrusted.example' });
    response.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { origin: `http://127.0.0.1:${server.address().port}`, received };
}

test('local API proxy forwards JSON writes to a fixed backend without credentials or frontend Origin', async t => {
  const upstream = await backend(t), get = await fixture(t, { backendOrigin: upstream.origin, proxyEnabled: true });
  const result = await get('/api/debates/generate?upstream=https://untrusted.example', 'POST', {
    headers: { Origin: get.origin, 'Content-Type': 'application/json', Authorization: 'private-credential', Cookie: 'private=owner' },
    body: JSON.stringify({ ticker: '002920.SZ' }),
  });
  assert.equal(result.status, 200);
  assert.equal(upstream.received.length, 1);
  assert.equal(upstream.received[0].method, 'POST');
  assert.equal(upstream.received[0].body, '{"ticker":"002920.SZ"}');
  assert.equal(upstream.received[0].headers.host, new URL(upstream.origin).host);
  for (const name of ['origin', 'authorization', 'cookie']) assert.equal(upstream.received[0].headers[name], undefined);
  assert.equal(result.headers['set-cookie'], undefined);
  assert.equal(result.headers['access-control-allow-origin'], undefined);
  const head = await get('/api/market/quote?ticker=002920.SZ', 'HEAD');
  assert.equal(head.status, 200); assert.equal(head.body, ''); assert.equal(upstream.received[1].method, 'GET');
});

test('LAN proxy reads the same APIs and actual AI status as the local page', async t => {
  const upstream = await backend(t), get = await fixture(t, { backendOrigin: upstream.origin, proxyEnabled: true, remoteAddress: '192.0.2.55' });
  for (const path of ['/api/health', '/api/stocks', '/api/stocks/profile', '/api/market/quote', '/api/market/prices',
    '/api/market/bands', '/api/forecasts', '/api/relations', '/api/events', '/api/debates', '/api/market/attribution',
    '/api/market/attribution/jobs/00000000-0000-4000-8000-000000000001']) {
    const response = await get(`${path}?ticker=002920.SZ`);
    assert.equal(response.status, 200, path);
  }
  const auth = await get('/api/auth/status');
  assert.equal(auth.status, 200);
  const status=normalizeAuthStatus(JSON.parse(auth.body));
  assert.equal(status.provider,'deepseek');assert.equal(status.sharedReadOnly,undefined);
  assert.equal(canUseAIResearch(status),true);
  assert.equal(upstream.received.at(-1).url,'/api/auth/status');
  const local=await fixture(t,{backendOrigin:upstream.origin,proxyEnabled:true});
  assert.deepEqual(JSON.parse((await local('/api/auth/status')).body),JSON.parse(auth.body));
});

test('局域网与本机同权，可生成观点和归因、识别及人工修改关系、管理连接',async t=>{
  const upstream=await backend(t),get=await fixture(t,{backendOrigin:upstream.origin,proxyEnabled:true,remoteAddress:'192.0.2.55'});
  for (const [path, method] of [['/api/auth/chatgpt/start', 'POST'], ['/api/auth/test', 'POST'], ['/api/auth/logout', 'POST'],
    ['/api/auth/models', 'GET'], ['/api/debates/generate', 'POST'], ['/api/relations/manual', 'POST'],
    ['/api/relations/research','POST'],['/api/relations/research?ticker=002920.SZ','GET'],
    ['/api/market/attribution/generate', 'POST']]) {
    const body=method==='POST'?JSON.stringify({ticker:'002920.SZ'}):undefined;
    const response=await get(path,method,{headers:{Origin:get.origin,...(body?{'Content-Type':'application/json'}:{})},body});
    assert.equal(response.status,200,path);
    const received=upstream.received.at(-1);
    assert.equal(received.url,path);assert.equal(received.method,method);assert.equal(received.body,body??'');
    assert.equal(received.headers.origin,undefined);
  }
});

test('局域网可读取保存的研究及归因，HEAD仅取响应头',async t=>{
  const upstream=await backend(t),get=await fixture(t,{backendOrigin:upstream.origin,proxyEnabled:true,remoteAddress:'192.0.2.55'});
  const reports=['/api/debates?ticker=002920.SZ','/api/market/attribution?ticker=002920.SZ&asOf=2026-10-22'];
  for(const path of reports){
    const response=await get(path,'GET',{headers:{Origin:get.origin}});
    assert.equal(response.status,200);assert.equal(JSON.parse(response.body).data.url,path);
    const head=await get(path,'HEAD');assert.equal(head.status,200);assert.equal(head.body,'');
  }
  assert.ok(upstream.received.every(entry=>entry.method==='GET'));
});

test('关系修改代理保留JSON与修订令牌', async t => {
  const upstream = await backend(t), get = await fixture(t, { backendOrigin: upstream.origin, proxyEnabled: true });
  const body = JSON.stringify({ ticker: '002920.SZ', asOf: '2026-10-19', expectedRevision: '2', changes: [{ action: 'remove', relatedTicker: '000550.SZ' }] });
  const result = await get('/api/relations/manual', 'POST', { headers: { Origin: get.origin, 'Content-Type': 'application/json' }, body });
  assert.equal(result.status, 200);
  assert.equal(upstream.received.length, 1);
  assert.equal(upstream.received[0].url, '/api/relations/manual');
  assert.equal(upstream.received[0].method, 'POST');
  assert.equal(upstream.received[0].body, body);
  assert.equal(upstream.received[0].headers.origin, undefined);
});

test('proxy rejects hostile origins, DNS rebinding hosts and unsupported methods before forwarding', async t => {
  const upstream = await backend(t), get = await fixture(t, { backendOrigin: upstream.origin, proxyEnabled: true });
  for (const headers of [{ Origin: 'https://untrusted.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const response = await get('/api/auth/logout', 'POST', { headers });
    assert.equal(response.status, 403); assert.equal(JSON.parse(response.body).error.code, 'ORIGIN_NOT_ALLOWED');
  }
  for (const host of ['untrusted.example', '127.0.0.1:1', '127.0.0.1@untrusted.example', '2130706433:8000']) {
    const response = await get('/api/health', 'GET', { headers: { Host: host } });
    assert.equal(response.status, 403, host); assert.equal(JSON.parse(response.body).error.code, 'HOST_NOT_ALLOWED');
  }
  const unsupported = await get('/api/events', 'DELETE');
  assert.equal(unsupported.status, 405);
  assert.equal(upstream.received.length, 0);
  const lan = await fixture(t, { backendOrigin: upstream.origin, proxyEnabled: true, remoteAddress: '192.0.2.55' });
  assert.equal((await lan('/api/auth/test', 'POST', { headers: { Origin:'https://untrusted.example' } })).status, 403);
  assert.equal((await lan('/api/auth/test', 'DELETE')).status,405);
  assert.equal(upstream.received.length, 0);
});

test('proxy reports unavailable backend without leaking destination or raw network errors', async t => {
  const closed = createServer();
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const port = closed.address().port;
  await new Promise(resolve => closed.close(resolve));
  const get = await fixture(t, { backendOrigin: `http://127.0.0.1:${port}`, proxyEnabled: true });
  const response = await get('/api/events?ticker=002920.SZ');
  assert.equal(response.status, 502);
  assert.equal(JSON.parse(response.body).error.code, 'BACKEND_UNAVAILABLE');
  assert.doesNotMatch(response.body, /ECONNREFUSED|127\.0\.0\.1|stack|connect/u);
});

test('proxy configuration accepts only loopback HTTP destinations', () => {
  for (const backendOrigin of ['https://127.0.0.1:8000', 'http://192.0.2.55:8000', 'http://untrusted.example:8000',
    'http://user:secret@127.0.0.1:8000', 'http://127.0.0.1:8000/api', 'http://127.0.0.1:8000/?host=other']) {
    assert.throws(() => createFrontendServer({ backendOrigin }), /local HTTP origin/);
  }
});

test('TideOS mount redirects its entry and serves assets beneath its prefix only', async t => {
  const get = await fixture(t, { basePath: '/company-research' });
  const redirect = await get('/company-research?ticker=002920.SZ');
  assert.equal(redirect.status, 307); assert.equal(redirect.headers.location, '/company-research/?ticker=002920.SZ');
  assert.equal((await get('/company-research/')).status, 200);
  assert.equal((await get('/company-research/src/app.js')).status, 200);
  assert.equal((await get('/src/app.js')).status, 404);
  assert.equal((await get('/company-researcher/')).status, 404);
});
test('TideOS proxy supports preserved or rewritten Host and strips only the module prefix', async t => {
  const upstream = await backend(t);
  const get = await fixture(t, { basePath: '/company-research', publicOrigin: 'https://tideos.example.com', backendOrigin: upstream.origin, proxyEnabled: true });
  for (const host of ['tideos.example.com', new URL(get.origin).host]) {
    const result = await get('/company-research/api/notes?owner=%E6%BD%98%E9%97%BB', 'POST', {
      headers: { Host: host, Origin: 'https://tideos.example.com', 'Content-Type': 'application/json', Cookie: 'tideos=session' }, body: '{}',
    });
    assert.equal(result.status, 200); assert.equal(upstream.received.at(-1).url, '/api/notes?owner=%E6%BD%98%E9%97%BB');
    assert.equal(upstream.received.at(-1).headers.cookie, undefined);
  }
  assert.equal((await get('/company-research/api/health', 'POST', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  const lan = await fixture(t, { publicOrigin: 'https://tideos.example.com', backendOrigin: upstream.origin, proxyEnabled: true, remoteAddress: '192.0.2.55' });
  assert.equal((await lan('/api/health', 'GET', { headers: { Host: 'tideos.example.com' } })).status, 403);
  assert.equal((await lan('/api/health', 'POST', { headers: { Origin: 'https://tideos.example.com' } })).status, 403);
});
