import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatGPTAuth } from '../backend/src/chatgpt-auth.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const ISSUER = 'https://auth.openai.com';
const CLIENT = 'oaiapp_test-client';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
function jwt(claims, header = { alg: 'RS256', kid: 'test-key' }) {
  const body = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`;
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'research-oauth-test-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const settings = { milliseconds: Date.parse('2026-10-13T00:00:00Z'), claims: {}, header: undefined, invalidSignature: false, scope: SCOPES, expires: 3600, refreshToken: 'test-refresh-1', tokenFailure: null, refreshFailure: null, refreshFailureStatus: 400, refreshThrow: null, refreshWaitForAbort: false, defer: null, revokeFailure: false };
  const requests = [];
  let nonce; let refreshed = 0;
  const now = () => new Date(settings.milliseconds);
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url === `${ISSUER}/.well-known/jwks.json`) return Response.json({ keys: [jwk] });
    if (url === `${ISSUER}/api/accounts/oauth/revoke`) return new Response(null, { status: settings.revokeFailure ? 500 : 200 });
    assert.equal(url, `${ISSUER}/api/accounts/oauth/token`);
    const body = new URLSearchParams(options.body);
    const refreshing = body.get('grant_type') === 'refresh_token';
    if (settings.defer) await settings.defer;
    if (refreshing && settings.refreshWaitForAbort) await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('private-timeout-body'), { name: 'AbortError' })), { once: true }));
    if (refreshing && settings.refreshThrow) throw settings.refreshThrow;
    const failure = refreshing ? settings.refreshFailure : settings.tokenFailure;
    if (failure) return Response.json(failure, { status: refreshing ? settings.refreshFailureStatus : 400 });
    if (refreshing) {
      refreshed += 1;
      return Response.json({ access_token: `test-access-refreshed-${refreshed}`, refresh_token: `test-refresh-${refreshed + 1}`, token_type: 'Bearer', expires_in: 3600 });
    }
    let idToken = jwt({ iss: ISSUER, aud: CLIENT, exp: Math.floor(settings.milliseconds / 1000) + 3600, iat: Math.floor(settings.milliseconds / 1000), sub: 'test-subject', name: 'Test User', email: 'test@example.invalid', nonce, ...settings.claims }, settings.header);
    if (settings.invalidSignature) {
      const segments = idToken.split('.'); const signature = Buffer.from(segments[2], 'base64url'); signature[0] ^= 1;
      idToken = `${segments[0]}.${segments[1]}.${signature.toString('base64url')}`;
    }
    return Response.json({
      access_token: 'test-access-1', ...(settings.refreshToken ? { refresh_token: settings.refreshToken } : {}), token_type: 'Bearer', expires_in: settings.expires, scope: settings.scope,
      id_token: idToken,
    });
  };
  const options = { directory, redirectUri: 'http://127.0.0.1:8000/auth/callback', fetchImpl, now };
  const auth = await createChatGPTAuth(options);
  async function start() {
    const result = await auth.start(); const query = new URL(result.url).searchParams;
    nonce = query.get('nonce'); return query;
  }
  async function login(extra = {}) {
    const query = await start();
    return auth.callback(new URLSearchParams({ code: 'test-code', state: query.get('state'), client_id: CLIENT, ...extra }));
  }
  return { auth, settings, requests, options, start, login, directory };
}

test('OAuth start generates fresh state/nonce/PKCE and a stable owner-only host record', async t => {
  const f = await fixture(t);
  const first = await f.start(); const second = await f.start();
  assert.equal(first.get('client_id'), 'dynamic_agent_client');
  assert.equal(first.get('agent_name_hint'), '公司投研看板');
  assert.equal(first.get('redirect_uri'), f.options.redirectUri);
  assert.equal(first.get('resource'), 'https://api.openai.com/v1');
  assert.equal(first.get('scope'), SCOPES);
  assert.equal(first.get('code_challenge_method'), 'S256');
  assert.match(first.get('ext_agent_host_id'), /^urn:uuid:/);
  for (const field of ['state', 'nonce', 'code_challenge']) assert.notEqual(first.get(field), second.get(field));
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.directory, 'host.json'))).mode & 0o777, 0o600);
  const restarted = await createChatGPTAuth(f.options);
  assert.equal(new URL((await restarted.start()).url).searchParams.get('ext_agent_host_id'), first.get('ext_agent_host_id'));
  assert.equal(f.requests.length, 0);
});

test('validated login exchanges exact redirect/resource with issued client and persists protected credentials', async t => {
  const f = await fixture(t); const query = await f.start();
  assert.deepEqual(await f.auth.callback(new URLSearchParams({ code: 'test-code', state: query.get('state'), client_id: CLIENT })), { success: true });
  const form = new URLSearchParams(f.requests.find(request => request.url.endsWith('/oauth/token')).options.body);
  assert.equal(form.get('client_id'), CLIENT);
  assert.equal(form.get('redirect_uri'), f.options.redirectUri);
  assert.equal(form.get('resource'), 'https://api.openai.com/v1');
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), query.get('code_challenge'));
  assert.equal(form.has('client_secret'), false);
  assert.equal(await f.auth.getAccessToken(), 'test-access-1');
  const status = await f.auth.status();
  assert.equal(status.authenticated, true); assert.equal(status.planEnabled, true);
  assert.deepEqual(status.account, { name: 'Test User', email: 'test@example.invalid' });
  assert.equal(JSON.stringify(status).includes('test-access'), false);
  assert.equal(JSON.stringify(status).includes('test-refresh'), false);
  assert.equal((await stat(join(f.directory, 'connection.json'))).mode & 0o777, 0o600);
  assert.match(await f.auth.cacheIdentity(), /^[0-9a-f]{64}$/);
  const restarted = await createChatGPTAuth(f.options);
  assert.equal(await restarted.getAccessToken(), 'test-access-1');
  const returning = new URL((await restarted.start()).url).searchParams;
  assert.equal(returning.get('client_id'), CLIENT); assert.equal(returning.has('agent_name_hint'), false);
  assert.equal(returning.has('id_token_hint'), false);
});

test('callbacks reject invalid state, duplicate fields, expired attempts, denial and replay without exchanging', async t => {
  const f = await fixture(t); const query = await f.start();
  await assert.rejects(f.auth.callback(new URLSearchParams({ code: 'test-code', state: 'wrong', client_id: CLIENT })), { code: 'CHATGPT_STATE_INVALID' });
  const duplicate = new URLSearchParams({ code: 'test-code', state: query.get('state'), client_id: CLIENT }); duplicate.append('state', query.get('state'));
  await assert.rejects(f.auth.callback(duplicate), { code: 'CHATGPT_CALLBACK_INVALID' });
  const denied = new URLSearchParams({ error: 'access_denied', error_description: 'untrusted-private-error', state: query.get('state') });
  await assert.rejects(f.auth.callback(denied), { code: 'CHATGPT_ACCESS_DENIED' });
  await assert.rejects(f.auth.callback(denied), { code: 'CHATGPT_STATE_INVALID' });
  const expired = await f.start(); f.settings.milliseconds += 600001;
  await assert.rejects(f.auth.callback(new URLSearchParams({ code: 'test-code', state: expired.get('state'), client_id: CLIENT })), { code: 'CHATGPT_LOGIN_EXPIRED' });
  assert.equal(f.requests.length, 0);
  assert.equal(JSON.stringify(await f.auth.status()).includes('untrusted-private-error'), false);
});

test('ID tokens reject invalid signature, issuer, audience, nonce, subject and timestamps', async t => {
  const invalid = [
    { claims: { iss: 'https://untrusted.invalid' } }, { claims: { aud: 'another-client' } },
    { claims: { nonce: 'wrong-nonce' } }, { claims: { sub: '' } }, { claims: { exp: 1 } },
    { claims: { iat: 9999999999 } }, { header: { alg: 'none', kid: 'test-key' } },
    { header: { alg: 'RS256', kid: 'unknown-key' } }, { invalidSignature: true },
  ];
  for (const change of invalid) {
    const f = await fixture(t); Object.assign(f.settings, change);
    await assert.rejects(f.login(), { code: 'CHATGPT_IDENTITY_INVALID' });
    assert.equal((await f.auth.status()).authenticated, false);
  }
});

test('new registration requires an issued ID; reauthorization rejects another client or subject and preserves session', async t => {
  const f = await fixture(t); const query = await f.start();
  await assert.rejects(f.auth.callback(new URLSearchParams({ code: 'test-code', state: query.get('state'), client_id: 'dynamic_agent_client' })), { code: 'CHATGPT_CLIENT_INVALID' });
  await f.login(); const identity = await f.auth.cacheIdentity();
  await assert.rejects(f.login({ client_id: 'oaiapp_another-client' }), { code: 'CHATGPT_CLIENT_INVALID' });
  f.settings.claims = { sub: 'another-subject' };
  await assert.rejects(f.login(), { code: 'CHATGPT_IDENTITY_INVALID' });
  assert.equal(await f.auth.getAccessToken(), 'test-access-1');
  assert.equal(await f.auth.cacheIdentity(), identity);
});

test('missing direct usage scopes never enable inference or replace an existing validated session', async t => {
  const f = await fixture(t); f.settings.scope = 'openid email profile offline_access';
  await assert.rejects(f.login(), { code: 'CHATGPT_PLAN_NOT_ENABLED' });
  assert.equal((await f.auth.status()).authenticated, false);
  f.settings.scope = SCOPES; await f.login();
  f.settings.scope = 'openid resource.invoke';
  await assert.rejects(f.login(), { code: 'CHATGPT_PLAN_NOT_ENABLED' });
  assert.equal((await f.auth.status()).authenticated, true);
  assert.equal(await f.auth.getAccessToken(), 'test-access-1');
});

test('refresh is serialized, rotates credentials atomically and omits scope', async t => {
  const f = await fixture(t); await f.login(); f.settings.milliseconds += 3480000;
  const values = await Promise.all([f.auth.getAccessToken(), f.auth.getAccessToken(), f.auth.getAccessToken()]);
  assert.deepEqual(values, ['test-access-refreshed-1', 'test-access-refreshed-1', 'test-access-refreshed-1']);
  const refreshes = f.requests.filter(request => new URLSearchParams(request.options.body).get('grant_type') === 'refresh_token');
  assert.equal(refreshes.length, 1);
  const form = new URLSearchParams(refreshes[0].options.body);
  assert.equal(form.get('client_id'), CLIENT); assert.equal(form.get('resource'), 'https://api.openai.com/v1');
  assert.equal(form.has('scope'), false);
  const stored = JSON.parse(await readFile(join(f.directory, 'connection.json'), 'utf8'));
  assert.equal(stored.session.access_token, values[0]); assert.equal(stored.session.refresh_token, 'test-refresh-2');
  assert.deepEqual(stored.session.scopes, SCOPES.split(' '));
});

test('invalid refresh grant clears the local session and reports a safe re-login error', async t => {
  const f = await fixture(t); await f.login(); f.settings.milliseconds += 3480000;
  f.settings.refreshFailure = { error: 'invalid_grant', error_description: 'private-provider-body' };
  await assert.rejects(f.auth.getAccessToken(), { code: 'CHATGPT_RELOGIN_REQUIRED' });
  const status = await f.auth.status(); assert.equal(status.authenticated, false);
  assert.equal(JSON.stringify(status).includes('private-provider-body'), false);
  assert.equal((await f.start()).get('client_id'), CLIENT);
});

test('overnight refresh network failures preserve the grant, classify bounded causes and permit a later retry', async t => {
  const unknown = new Error('private-network-message'); unknown.cause = unknown;
  const cases = [
    [{ cause: { code: 'ECONNRESET', message: 'private-connection' } }, 'CHATGPT_CONNECTION_RESET'],
    [new AggregateError([{ code: 'UNKNOWN', message: 'private-first' }, { cause: { code: 'ENOTFOUND' } }], 'private-dns'), 'CHATGPT_DNS_ERROR'],
    [{ cause: { code: 'ECONNREFUSED', address: 'private-address' } }, 'CHATGPT_CONNECTION_REFUSED'],
    [{ errors: [{ cause: { code: 'CERT_HAS_EXPIRED' } }], message: 'private-certificate' }, 'CHATGPT_TLS_ERROR'],
    [{ cause: { code: 'ETIMEDOUT' } }, 'CHATGPT_AUTH_TIMEOUT'],
    [unknown, 'CHATGPT_CONNECTION_ERROR'],
  ];
  for (const [failure, code] of cases) {
    const f = await fixture(t); await f.login();
    const original = await readFile(join(f.directory, 'connection.json'), 'utf8');
    f.settings.milliseconds += 86400000; f.settings.refreshThrow = failure;
    await assert.rejects(f.auth.getAccessToken(), rejection => {
      assert.equal(rejection.code, code); assert.equal(rejection.status, 502);
      assert.match(rejection.message, /检查/); assert.match(rejection.message, /重试/);
      assert.doesNotMatch(rejection.message, /重新登录|private/);
      assert.doesNotMatch(JSON.stringify(rejection), /private/); return true;
    });
    const status = await f.auth.status();
    assert.equal(status.authenticated, true); assert.equal(status.planEnabled, true);
    assert.equal(status.error.code, code); assert.doesNotMatch(JSON.stringify(status), /private|test-access|test-refresh/);
    assert.equal(await readFile(join(f.directory, 'connection.json'), 'utf8'), original);
    const refreshRequests = () => f.requests.filter(request => new URLSearchParams(request.options.body).get('grant_type') === 'refresh_token');
    assert.equal(refreshRequests().length, 1, 'a potentially sent rotating refresh is never automatically retried');
    f.settings.refreshThrow = null;
    assert.equal(await f.auth.getAccessToken(), 'test-access-refreshed-1');
    assert.equal(refreshRequests().length, 2); assert.equal((await f.auth.status()).error, undefined);
  }
});

test('network cause traversal has a fixed depth and AggregateError breadth limit', async t => {
  let deep = { code: 'ECONNRESET' };
  for (let i = 0; i < 20; i++) deep = { cause: deep, message: 'private-nested' };
  const broad = { errors: [...Array.from({ length: 8 }, () => ({ code: 'UNKNOWN' })), { code: 'ECONNRESET' }] };
  for (const failure of [deep, broad]) {
    const f = await fixture(t); await f.login(); f.settings.milliseconds += 86400000; f.settings.refreshThrow = failure;
    await assert.rejects(f.auth.getAccessToken(), { code: 'CHATGPT_CONNECTION_ERROR' });
    assert.equal((await f.auth.status()).authenticated, true);
  }
});

test('an authorization timeout keeps the renewable session and does not demand a new login', async t => {
  const f = await fixture(t); await f.login(); f.settings.milliseconds += 86400000; f.settings.refreshWaitForAbort = true;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const rejected = assert.rejects(f.auth.getAccessToken(), rejection => {
    assert.equal(rejection.code, 'CHATGPT_AUTH_TIMEOUT');
    assert.match(rejection.message, /检查代理或网络连接后重试/);
    assert.doesNotMatch(rejection.message, /重新登录|private/); return true;
  });
  t.mock.timers.tick(20000); await rejected;
  assert.equal((await f.auth.status()).authenticated, true);
});

test('server outages and rate limits do not erase a session or trust a misleading terminal error body', async t => {
  for (const statusCode of [500, 502, 503, 429]) {
    const f = await fixture(t); await f.login();
    const original = await readFile(join(f.directory, 'connection.json'), 'utf8');
    f.settings.milliseconds += 86400000;
    f.settings.refreshFailure = { error: 'invalid_grant', error_description: 'private-upstream-body' };
    f.settings.refreshFailureStatus = statusCode;
    await assert.rejects(f.auth.getAccessToken(), rejection => {
      assert.equal(rejection.code, statusCode === 429 ? 'CHATGPT_AUTH_RATE_LIMIT' : 'CHATGPT_AUTH_UPSTREAM_ERROR');
      assert.doesNotMatch(rejection.message, /重新登录|private/); return true;
    });
    assert.equal((await f.auth.status()).authenticated, true);
    assert.equal(await readFile(join(f.directory, 'connection.json'), 'utf8'), original);
  }
});

test('all explicit terminal refresh errors clear unusable credentials and preserve the registered app', async t => {
  const codes = ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'];
  for (let i = 0; i < codes.length; i++) {
    const f = await fixture(t); await f.login(); f.settings.milliseconds += 86400000;
    f.settings.refreshFailure = i % 2 ? { error: { code: codes[i], message: 'private-refresh-failure' } } : { error: codes[i], error_description: 'private-refresh-failure' };
    await assert.rejects(f.auth.getAccessToken(), { code: 'CHATGPT_RELOGIN_REQUIRED', status: 401 });
    const status = await f.auth.status(); assert.equal(status.authenticated, false); assert.equal(status.planEnabled, false);
    const stored = JSON.parse(await readFile(join(f.directory, 'connection.json'), 'utf8'));
    assert.equal(stored.session, null); assert.equal(stored.registration.client_id, CLIENT);
    assert.doesNotMatch(JSON.stringify(status), /private-refresh-failure|test-access|test-refresh/);
    assert.equal(f.requests.filter(request => new URLSearchParams(request.options.body).get('grant_type') === 'refresh_token').length, 1);
  }
});

test('invalid client reports an application configuration error without erasing or reauthorizing the grant', async t => {
  const f = await fixture(t); await f.login();
  const original = await readFile(join(f.directory, 'connection.json'), 'utf8');
  f.settings.milliseconds += 86400000;
  f.settings.refreshFailure = { error: 'invalid_client', error_description: 'private-client-details' };
  f.settings.refreshFailureStatus = 401;
  await assert.rejects(f.auth.getAccessToken(), rejection => {
    assert.equal(rejection.code, 'CHATGPT_CLIENT_CONFIG'); assert.equal(rejection.status, 502);
    assert.match(rejection.message, /注册配置/); assert.doesNotMatch(rejection.message, /重新登录|private/); return true;
  });
  assert.equal((await f.auth.status()).authenticated, true);
  assert.equal(await readFile(join(f.directory, 'connection.json'), 'utf8'), original);
});

test('sign out revokes the renewable session, clears all tokens and preserves host/registration', async t => {
  const f = await fixture(t); const host = (await f.start()).get('ext_agent_host_id'); await f.login();
  await f.auth.logout();
  assert.equal((await f.auth.status()).authenticated, false); assert.equal(await f.auth.cacheIdentity(), 'signed-out');
  const revoke = f.requests.find(request => request.url.endsWith('/oauth/revoke'));
  assert.equal(new URLSearchParams(revoke.options.body).get('client_id'), CLIENT);
  const stored = JSON.parse(await readFile(join(f.directory, 'connection.json'), 'utf8'));
  assert.equal(stored.session, null); assert.equal(JSON.stringify(stored).includes('test-access'), false);
  const returning = await f.start();
  assert.equal(returning.get('client_id'), CLIENT); assert.equal(returning.get('ext_agent_host_id'), host);
});

test('sign out prevents an in-flight login from restoring credentials', async t => {
  const f = await fixture(t); const query = await f.start();
  let finish; f.settings.defer = new Promise(resolve => { finish = resolve; });
  const attempt = f.auth.callback(new URLSearchParams({ code: 'test-code', state: query.get('state'), client_id: CLIENT }));
  const rejected = assert.rejects(attempt, { code: 'CHATGPT_AUTH_CANCELLED' });
  await f.auth.logout(); finish(); await rejected;
  assert.equal((await f.auth.status()).authenticated, false);
  assert.equal(JSON.parse(await readFile(join(f.directory, 'connection.json'), 'utf8')).session, null);
});

test('sign out prevents an in-flight refresh from restoring credentials', async t => {
  const f = await fixture(t); await f.login(); f.settings.milliseconds += 3480000;
  let finish; f.settings.defer = new Promise(resolve => { finish = resolve; });
  const refreshing = f.auth.getAccessToken(); const rejected = assert.rejects(refreshing, { code: 'CHATGPT_AUTH_CANCELLED' });
  await f.auth.logout(); finish(); await rejected;
  assert.equal((await f.auth.status()).authenticated, false);
  assert.equal(JSON.parse(await readFile(join(f.directory, 'connection.json'), 'utf8')).session, null);
});

test('remote revocation failure still signs out locally and gives a safe actionable status', async t => {
  const f = await fixture(t); await f.login(); f.settings.revokeFailure = true;
  await f.auth.logout(); const status = await f.auth.status();
  assert.equal(status.authenticated, false); assert.equal(status.error.code, 'CHATGPT_REVOCATION_UNCONFIRMED');
});

test('expired access without refresh asks for re-login; invalid grant retries with issued client', async t => {
  const f = await fixture(t); f.settings.refreshToken = null; await f.login(); f.settings.milliseconds += 3600001;
  assert.equal((await f.auth.status()).authenticated, false);
  await assert.rejects(f.auth.getAccessToken(), { code: 'CHATGPT_RELOGIN_REQUIRED' });
  const fresh = await fixture(t); fresh.settings.tokenFailure = { error: 'invalid_grant' };
  await assert.rejects(fresh.login(), { code: 'CHATGPT_RELOGIN_REQUIRED' });
  assert.equal((await fresh.start()).get('client_id'), CLIENT);
});

test('callback must use a loopback IP with the exact auth/callback path', async () => {
  for (const redirectUri of ['http://localhost:8000/auth/callback', 'https://127.0.0.1:8000/auth/callback', 'http://127.0.0.1:8000/callback', 'http://127.0.0.1:8000/auth/callback?next=remote']) {
    await assert.rejects(createChatGPTAuth({ directory: '/unused', redirectUri }), { code: 'CHATGPT_CALLBACK_CONFIG' });
  }
});
