import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createCurlFetch } from '../backend/src/curl-fetch.mjs';

const URL = 'https://api.openai.com/v1/responses';
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const calls = [];
  function spawnImpl(executable, args, options) {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough()];
    child.kills = [];
    child.kill = signal => { child.kills.push(signal); return true; };
    child.config = '';
    child.body = '';
    child.stdin.on('data', chunk => { child.config += chunk; });
    child.stdio[3].on('data', chunk => { child.body += chunk; });
    calls.push({ executable, args, options, child });
    return child;
  }
  const fetch = createCurlFetch({ spawnImpl, proxyEnv: {
    HTTPS_PROXY: 'http://127.0.0.1:7897', NO_PROXY: '127.0.0.1,localhost',
    OPENAI_API_KEY: 'must-not-inherit', TUSHARE_TOKEN: 'must-not-inherit',
  } });
  return { fetch, calls, get child() { return calls.at(-1)?.child; } };
}

function complete(child, bytes) {
  if (bytes) child.stdout.write(bytes);
  child.stdout.end();
  child.emit('close', 0, null);
}

test('DeepSeek official routes use the same protected transport and reject lookalikes', async () => {
  for (const endpoint of ['/models', '/responses', '/v1/tools/search']) {
    const f = fixture();
    const pending = f.fetch(`https://api.deepseek.com${endpoint}`, { headers: { Authorization: 'Bearer mock-deepseek-secret' } });
    assert.ok(!JSON.stringify(f.calls[0].args).includes('mock-deepseek-secret'));
    assert.ok(!JSON.stringify(f.calls[0].options.env).includes('mock-deepseek-secret'));
    complete(f.child, 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{}');
    assert.deepEqual(await (await pending).json(), {});
  }
  const f = fixture();
  for (const url of ['http://api.deepseek.com/models', 'https://api.deepseek.com.evil.test/models', 'https://api.deepseek.com/other', 'https://api.deepseek.com/responses?secret=value']) {
    await assert.rejects(f.fetch(url), { code: 'ERR_CURL_URL' });
  }
  assert.equal(f.calls.length, 0);
});

test('returns a streaming Response after headers, handles interim blocks and split UTF-8', async () => {
  const f = fixture();
  const pending = f.fetch(URL, { method: 'POST', body: '{}' });
  f.child.stdout.write('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n');
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(response.url, URL);
  const reader = response.body.getReader();
  const bytes = Buffer.from('data: 中文\n\n');
  const first = reader.read();
  f.child.stdout.write(bytes.subarray(0, 8));
  const firstChunk = await first;
  assert.equal(firstChunk.done, false);
  assert.equal(f.child.kills.length, 0);
  const second = reader.read();
  f.child.stdout.write(bytes.subarray(8));
  const secondChunk = await second;
  assert.equal(Buffer.concat([Buffer.from(firstChunk.value), Buffer.from(secondChunk.value)]).toString(), 'data: 中文\n\n');
  complete(f.child);
  assert.equal((await reader.read()).done, true);
});

test('JSON/body/token remain off argv and environment; curl config safely escapes quotes and slashes', async () => {
  const f = fixture();
  const token = 'secret-token-\\"value';
  const body = JSON.stringify({ private: 'memo\nwith \\"quotes"' });
  const pending = f.fetch(URL, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body });
  const call = f.calls[0];
  assert.equal(call.executable, '/usr/bin/curl');
  assert.equal(call.args[0], '-q');
  assert.equal(call.options.shell, false);
  assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe', 'pipe']);
  assert.equal(JSON.stringify(call.args).includes(token), false);
  assert.equal(JSON.stringify(call.args).includes(body), false);
  assert.deepEqual(call.options.env, { https_proxy: 'http://127.0.0.1:7897', no_proxy: '127.0.0.1,localhost' });
  assert.ok(call.child.config.includes('authorization: Bearer secret-token-\\\\\\"value'));
  assert.ok(call.child.config.includes('data-binary = "@/dev/fd/3"'));
  assert.ok(call.child.config.includes('proxy = "http://127.0.0.1:7897"'));
  assert.ok(call.child.config.includes('noproxy = "127.0.0.1,localhost"'));
  assert.equal(call.child.body, body);
  assert.equal(call.args.includes('--insecure'), false);
  assert.equal(call.args.includes('-k'), false);
  assert.equal(call.args.includes('--location'), false);
  complete(f.child, 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"ok":true}');
  assert.deepEqual(await (await pending).json(), { ok: true });
});

test('URLSearchParams and bodies beginning @ are literal pipe bytes, never file paths', async () => {
  for (const body of [new URLSearchParams({ refresh_token: 'private-secret' }), '@/Users/example/.env']) {
    const f = fixture();
    const pending = f.fetch('https://auth.openai.com/api/accounts/oauth/token', { method: 'POST', body });
    assert.equal(f.child.body, String(body));
    assert.equal(JSON.stringify(f.calls[0].args).includes(String(body)), false);
    assert.equal(f.child.config.includes(String(body)), false);
    if (body instanceof URLSearchParams) assert.ok(f.child.config.includes('application/x-www-form-urlencoded'));
    complete(f.child, 'HTTP/1.1 200 OK\r\n\r\n{}');
    assert.deepEqual(await (await pending).json(), {});
  }
});

test('curl failure classification never exposes private stderr', async () => {
  for (const [exit, code] of [[6, 'ENOTFOUND'], [7, 'ECONNREFUSED'], [28, 'ETIMEDOUT'], [60, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'], [56, 'ECONNRESET']]) {
    const f = fixture();
    const pending = f.fetch(URL);
    f.child.stderr.write('Authorization: Bearer private-secret\n{"confidential":"report"}');
    f.child.emit('close', exit, null);
    await assert.rejects(pending, error => error.code === code && error.curlExitCode === exit && !error.message.includes('private-secret') && !error.stack.includes('confidential'));
  }
});

test('abort before spawn and before headers rejects and cleans up child pipes', async () => {
  const f = fixture();
  const early = new AbortController(); early.abort();
  await assert.rejects(f.fetch(URL, { signal: early.signal }), { name: 'AbortError' });
  assert.equal(f.calls.length, 0);
  const controller = new AbortController();
  const pending = f.fetch(URL, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(f.child.kills, ['SIGTERM']);
  assert.equal(f.child.stdin.destroyed, true);
  assert.equal(f.child.stdio[3].destroyed, true);
  f.child.emit('close', null, 'SIGTERM');
});

test('abort after headers errors the streamed body; cancel also kills the process', async () => {
  const f = fixture();
  const controller = new AbortController();
  const pending = f.fetch(URL, { signal: controller.signal });
  f.child.stdout.write('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n');
  const response = await pending;
  controller.abort();
  await assert.rejects(response.text(), { name: 'AbortError' });
  assert.equal(f.child.kills[0], 'SIGTERM');
  f.child.emit('close', null, 'SIGTERM');
  const pending2 = f.fetch(URL);
  f.child.stdout.write('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n');
  const response2 = await pending2;
  await response2.body.cancel();
  assert.equal(f.child.kills[0], 'SIGTERM');
  f.child.emit('close', null, 'SIGTERM');
});

test('nonzero exit after headers errors the body without leaking diagnostics', async () => {
  const f = fixture();
  const pending = f.fetch(URL);
  f.child.stdout.write('HTTP/1.1 200 OK\r\n\r\npartial');
  const response = await pending;
  f.child.stderr.write('private diagnostic');
  f.child.emit('close', 56, null);
  await assert.rejects(response.text(), error => error.code === 'ECONNRESET' && !error.message.includes('private'));
});

test('stream applies backpressure while the consumer waits, rather than buffering the whole result', async () => {
  const f = fixture();
  const pending = f.fetch(URL);
  f.child.stdout.write('HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n');
  const response = await pending;
  const payload = Buffer.alloc(70 * 1024, 120);
  f.child.stdout.write(payload);
  assert.equal(f.child.stdout.isPaused(), true);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.value.byteLength, payload.length);
  await tick();
  assert.equal(f.child.stdout.isPaused(), false);
  complete(f.child);
  assert.equal((await reader.read()).done, true);
});

test('rejects redirects without visiting Location; bounds and validates headers', async () => {
  for (const [bytes, code] of [
    ['HTTP/1.1 302 Found\r\nLocation: http://private.invalid/secret\r\n\r\n', 'ERR_CURL_REDIRECT'],
    ['HTTP/1.1 200 OK\r\nX-Long: ' + 'x'.repeat(65536), 'ERR_CURL_HEADERS'],
    ['HTTP/1.1 200 OK\r\nmalformed\r\n\r\n', 'ERR_CURL_RESPONSE'],
    ['HTTP/1.1 101 Switching Protocols\r\n\r\n', 'ERR_CURL_RESPONSE'],
  ]) {
    const f = fixture();
    const pending = f.fetch(URL);
    f.child.stdout.write(bytes);
    await assert.rejects(pending, error => error.code === code && !error.message.includes('private.invalid'));
    assert.equal(f.calls.length, 1);
    assert.equal(f.child.kills[0], 'SIGTERM');
    f.child.emit('close', null, 'SIGTERM');
  }
});

test('rejects unapproved URLs, methods, headers and body types before spawning', async () => {
  const f = fixture();
  for (const url of ['http://api.openai.com/v1/models', 'https://api.openai.com.evil.test/v1/models', 'https://auth.openai.com.evil.test/.well-known/jwks.json', 'https://x:y@api.openai.com/v1/models', 'https://api.openai.com:8443/v1/models', 'https://api.openai.com/v1/models?secret=private', 'https://api.openai.com/v1/models#fragment', 'https://api.openai.com/unapproved']) {
    await assert.rejects(f.fetch(url), { code: 'ERR_CURL_URL' });
  }
  await assert.rejects(f.fetch(URL, { method: 'DELETE' }), { code: 'ERR_CURL_METHOD' });
  await assert.rejects(f.fetch(URL, { body: '{}' }), { code: 'ERR_CURL_BODY' });
  await assert.rejects(f.fetch(URL, { method: 'POST', body: Buffer.from('bytes') }), { code: 'ERR_CURL_BODY' });
  await assert.rejects(f.fetch(URL, { headers: { Host: 'evil.example' } }), { code: 'ERR_CURL_HEADER' });
  await assert.rejects(f.fetch(URL, { headers: { Authorization: 'secret\r\nheader' } }), error => error.code === 'ERR_CURL_CONFIGURATION' && !error.message.includes('secret'));
  assert.equal(f.calls.length, 0);
});

test('preserves empty 204 responses and safely rejects executable failures', async () => {
  const f = fixture();
  const pending = f.fetch('https://auth.openai.com/api/accounts/oauth/revoke', { method: 'POST', body: 'token=private' });
  complete(f.child, 'HTTP/1.1 204 No Content\r\n\r\n');
  assert.equal((await pending).body, null);
  const missing = createCurlFetch({ spawnImpl() { throw new Error('private executor failure'); }, proxyEnv: {} });
  await assert.rejects(missing(URL), error => error.code === 'ERR_CURL_EXECUTABLE' && !error.message.includes('private'));
  const pending2 = f.fetch(URL);
  f.child.emit('error', new Error('private child error'));
  await assert.rejects(pending2, error => error.code === 'ERR_CURL_EXECUTABLE' && !error.message.includes('private'));
  f.child.emit('close', null, null);
  await tick();
});

test('validates explicit proxy configuration and separates curl option errors from network resets', async () => {
  for (const proxy of ['not-a-url', 'file:///private/file', 'http://user:secret@127.0.0.1:7897', 'http://127.0.0.1:7897/path', 'http://127.0.0.1:7897\nheader']) {
    assert.throws(() => createCurlFetch({ proxyEnv: { HTTPS_PROXY: proxy } }), error => error.code === 'ERR_CURL_CONFIGURATION' && !error.message.includes('secret'));
  }
  const f = fixture();
  const pending = f.fetch(URL);
  f.child.stderr.write('private curl config diagnostic');
  f.child.emit('close', 2, null);
  await assert.rejects(pending, error => error.code === 'ERR_CURL_CONFIGURATION' && error.curlExitCode === 2 && !error.message.includes('private'));
});
