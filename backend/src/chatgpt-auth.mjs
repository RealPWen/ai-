import { replaceFile } from './replace-file.mjs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ResearchError } from './errors.mjs';
import { createIDTokenVerifier, secureEqual } from './oauth-jwt.mjs';

const ISSUER = 'https://auth.openai.com';
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`;
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const REVOKE_URL = `${ISSUER}/api/accounts/oauth/revoke`;
const RESOURCE = 'https://api.openai.com/v1';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const REQUIRED_SCOPES = ['resource.invoke', 'chatgpt.tokens.use.direct'];
const DYNAMIC_CLIENT = 'dynamic_agent_client';
const random = () => randomBytes(32).toString('base64url');
const safeText = value => typeof value === 'string' && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
const validClient = value => typeof value === 'string' && value.length <= 256 && /^[A-Za-z0-9._-]+$/.test(value) && value !== DYNAMIC_CLIENT;
const hasPlan = scopes => REQUIRED_SCOPES.every(scope => scopes.includes(scope));
const error = (code, message, status = 401) => new ResearchError(code, message, status);
const TERMINAL_GRANT_ERRORS = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);
const AUTH_TRANSPORT_ERRORS = new Map([
  ...['ENOTFOUND', 'EAI_AGAIN'].map(code => [code, ['CHATGPT_DNS_ERROR', '无法解析 ChatGPT 授权服务域名，请检查 DNS 或代理配置后重试']]),
  ['ECONNREFUSED', ['CHATGPT_CONNECTION_REFUSED', '连接 ChatGPT 授权服务被拒绝，请检查本地代理是否运行及网络配置后重试']],
  ...['ECONNRESET', 'UND_ERR_SOCKET'].map(code => [code, ['CHATGPT_CONNECTION_RESET', '连接 ChatGPT 授权服务被重置或中断，请检查代理与网络连接后重试']]),
  ...['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].map(code => [code, ['CHATGPT_AUTH_TIMEOUT', 'ChatGPT 授权请求超时，请检查代理或网络连接后重试']]),
  ...['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION', 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE'].map(code => [code, ['CHATGPT_TLS_ERROR', 'ChatGPT 授权服务的 HTTPS 连接验证失败，请检查系统证书或代理配置后重试']]),
]);

function authNetworkFailure(failure, timedOut = false) {
  if (timedOut) return error('CHATGPT_AUTH_TIMEOUT', 'ChatGPT 授权请求超时，请检查代理或网络连接后重试', 502);
  const pending = [failure], seen = new Set();
  while (pending.length && seen.size < 16) {
    const current = pending.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const details = AUTH_TRANSPORT_ERRORS.get(current.code);
    if (details) return error(details[0], details[1], 502);
    if (current.cause) pending.push(current.cause);
    if (Array.isArray(current.errors)) pending.push(...current.errors.slice(0, 8));
  }
  // Neither upstream exception text nor credential-bearing request details leave this module.
  return error('CHATGPT_CONNECTION_ERROR', '无法连接 ChatGPT 授权服务，请检查代理或网络连接后重试', 502);
}

/** OAuth credentials stay in this app's private backend storage, never in browser storage. */
export async function createChatGPTAuth({ directory, redirectUri, appName = '公司投研看板', fetchImpl = globalThis.fetch, now = () => new Date() }) {
  const callbackURL = new URL(redirectUri);
  if (callbackURL.protocol !== 'http:' || callbackURL.hostname !== '127.0.0.1' || callbackURL.pathname !== '/auth/callback' || callbackURL.search || callbackURL.hash || callbackURL.username || callbackURL.password) {
    throw error('CHATGPT_CALLBACK_CONFIG', 'ChatGPT 回调必须是 http://127.0.0.1:<端口>/auth/callback', 500);
  }
  if (!directory) throw error('CHATGPT_STORAGE_CONFIG', '尚未配置 ChatGPT 授权存储目录', 500);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const hostPath = join(directory, 'host.json');
  // Registration and its token set are one atomic record; sign-out retains only registration.
  const connectionPath = join(directory, 'connection.json');
  async function readJSON(path) {
    try { await chmod(path, 0o600); return JSON.parse(await readFile(path, 'utf8')); }
    catch (failure) { if (failure.code === 'ENOENT') return null; throw error('CHATGPT_STORAGE_INVALID', '本地 ChatGPT 授权记录无法读取，请退出并重新登录', 500); }
  }
  async function atomicWrite(path, value) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    let file;
    try {
      file = await open(temporary, 'wx', 0o600);
      await file.writeFile(`${JSON.stringify(value)}\n`);
      await file.sync(); await file.close(); file = undefined;
      await replaceFile(temporary, path); await chmod(path, 0o600);
    } finally { await file?.close(); await rm(temporary, { force: true }); }
  }
  let host = await readJSON(hostPath);
  if (host && !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(host.ext_agent_host_id ?? '')) throw error('CHATGPT_STORAGE_INVALID', '本项目 ChatGPT 主机标识损坏，请修复本地授权记录后重新登录', 500);
  if (!host) {
    host = { ext_agent_host_id: `urn:uuid:${randomUUID()}` };
    await atomicWrite(hostPath, host);
  }
  const stored = await readJSON(connectionPath);
  let registration = stored?.registration ?? null;
  let session = stored?.session ?? null;
  if (registration && (!validClient(registration.client_id) || registration.issuer !== ISSUER || !safeText(registration.subject))) throw error('CHATGPT_STORAGE_INVALID', '本地 ChatGPT 注册记录无效，请清理本项目授权记录后重新登录', 500);
  if (session && (!registration || session.client_id !== registration.client_id || session.subject !== registration.subject || typeof session.access_token !== 'string' || !Number.isFinite(session.expires_at) || !Array.isArray(session.scopes))) throw error('CHATGPT_STORAGE_INVALID', '本地 ChatGPT 会话记录无效，请退出并重新登录', 500);
  const attempts = new Map();
  let lastError = null; let epoch = 0; let refreshPromise; let retryClientId;
  let writes = Promise.resolve();
  const serialize = action => { const result = writes.then(action, action); writes = result.catch(() => {}); return result; };
  const remember = failure => {
    const safe = failure instanceof ResearchError ? failure : authNetworkFailure(failure);
    lastError = { code: safe.code, message: safe.message }; return safe;
  };
  async function fetchJSON(url, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'error' });
      let data;
      try { data = await response.json(); }
      catch (failure) { if (failure instanceof SyntaxError) data = null; else throw failure; }
      if (!response.ok) {
        // A server/proxy outage must not invalidate a renewable grant, even if
        // its diagnostic body happens to resemble an OAuth rejection.
        if (response.status >= 500) throw error('CHATGPT_AUTH_UPSTREAM_ERROR', 'ChatGPT 授权服务暂不可用，请检查代理或网络连接，稍后重试', 502);
        if (response.status === 429) throw error('CHATGPT_AUTH_RATE_LIMIT', 'ChatGPT 登录请求过于频繁，请稍后重试', 429);
        const upstreamCode = typeof data?.error === 'string' ? data.error : data?.error?.code ?? data?.error?.type ?? data?.code;
        if (TERMINAL_GRANT_ERRORS.has(upstreamCode)) throw error('CHATGPT_RELOGIN_REQUIRED', 'ChatGPT 授权已失效，请重新登录');
        if (upstreamCode === 'invalid_client') throw error('CHATGPT_CLIENT_CONFIG', 'ChatGPT 应用注册配置无效，请检查 client_id 与应用注册配置', 502);
        if (upstreamCode === 'access_denied' || response.status === 403) throw error('CHATGPT_ACCESS_DENIED', '此账号未允许本应用使用 ChatGPT 套餐，请在授权页面检查权限', 403);
        throw error('CHATGPT_AUTH_UPSTREAM_ERROR', 'ChatGPT 授权服务暂不可用，请检查代理或网络连接后重试', 502);
      }
      if (!data || typeof data !== 'object') throw error('CHATGPT_AUTH_INVALID_RESPONSE', 'ChatGPT 授权服务返回无效结果，请检查代理或网络连接后重试', 502);
      return data;
    } catch (failure) {
      if (failure instanceof ResearchError) throw failure;
      throw authNetworkFailure(failure, controller.signal.aborted);
    } finally { clearTimeout(timer); }
  }
  const verifyIDToken = createIDTokenVerifier({ fetchJSON, now });
  const exchange = body => fetchJSON(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  function tokenFields(data, previous) {
    if (typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 65536 || String(data.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 31536000) throw error('CHATGPT_AUTH_INVALID_RESPONSE', 'ChatGPT 授权凭据不完整，请重新登录', 502);
    const scopes = data.scope === undefined && previous ? previous.scopes : typeof data.scope === 'string' ? [...new Set(data.scope.split(/\s+/).filter(Boolean))] : [];
    if (!hasPlan(scopes)) throw error('CHATGPT_PLAN_NOT_ENABLED', '登录成功，但尚未授权使用 ChatGPT 套餐；请重新登录并允许套餐用量权限', 403);
    return {
      access_token: data.access_token,
      refresh_token: typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : previous?.refresh_token ?? null,
      id_token: typeof data.id_token === 'string' ? data.id_token : previous?.id_token ?? null,
      token_type: 'Bearer', expires_at: now().getTime() + data.expires_in * 1000,
      scopes, saved_at: now().toISOString(),
    };
  }
  const cancelled = () => error('CHATGPT_AUTH_CANCELLED', '本次 ChatGPT 授权已取消，请重新登录');
  return {
    async start() {
      for (const [state, attempt] of attempts) if (attempt.expiresAt <= now().getTime()) attempts.delete(state);
      if (attempts.size >= 5) attempts.delete(attempts.keys().next().value);
      const state = random(); const nonce = random(); const verifier = random();
      const clientId = registration?.client_id ?? retryClientId ?? DYNAMIC_CLIENT;
      const expiresAt = now().getTime() + 600000;
      attempts.set(state, { state, nonce, verifier, clientId, subject: registration?.subject, redirectUri, epoch, expiresAt });
      const query = new URLSearchParams({ client_id: clientId, ext_agent_host_id: host.ext_agent_host_id, response_type: 'code', redirect_uri: redirectUri, scope: SCOPE, resource: RESOURCE, state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
      if (clientId === DYNAMIC_CLIENT) query.set('agent_name_hint', appName);
      // Email is a display hint; avoid exposing a retained ID token in a frontend URL.
      else if (registration?.email) query.set('login_hint', registration.email);
      lastError = null;
      return { url: `${AUTHORIZE_URL}?${query}`, expiresAt: new Date(expiresAt).toISOString() };
    },
    async callback(params) {
      try {
        for (const field of ['state', 'code', 'client_id', 'error']) if (params.getAll(field).length > 1) throw error('CHATGPT_CALLBACK_INVALID', 'ChatGPT 登录回调参数无效，请重新登录');
        const state = params.get('state');
        const attempt = [...attempts.values()].find(item => secureEqual(item.state, state));
        if (!attempt) throw error('CHATGPT_STATE_INVALID', 'ChatGPT 登录验证已失效或已使用，请重新登录');
        attempts.delete(attempt.state); // Codes and state are consumed once, including failed exchanges.
        if (attempt.epoch !== epoch) throw cancelled();
        if (attempt.expiresAt <= now().getTime()) throw error('CHATGPT_LOGIN_EXPIRED', 'ChatGPT 登录窗口已过期，请重新登录');
        if (params.has('error')) throw error(params.get('error') === 'access_denied' ? 'CHATGPT_ACCESS_DENIED' : 'CHATGPT_LOGIN_FAILED', params.get('error') === 'access_denied' ? '你取消了授权，或该账号未获准使用 ChatGPT 套餐；可以重新尝试登录' : 'ChatGPT 登录未完成，请重新登录', 403);
        const suppliedId = params.get('client_id');
        const newRegistration = attempt.clientId === DYNAMIC_CLIENT;
        if ((newRegistration && !validClient(suppliedId)) || (!newRegistration && suppliedId !== null && suppliedId !== attempt.clientId)) throw error('CHATGPT_CLIENT_INVALID', 'ChatGPT 返回的应用注册信息不匹配，请重新登录');
        const clientId = newRegistration ? suppliedId : attempt.clientId;
        const code = params.get('code');
        if (typeof code !== 'string' || !code || code.length > 8192) throw error('CHATGPT_CODE_MISSING', 'ChatGPT 授权码缺失，请重新登录');
        const data = await exchange({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: RESOURCE }).catch(failure => {
          if (newRegistration && failure.code === 'CHATGPT_RELOGIN_REQUIRED') retryClientId = clientId;
          throw failure;
        });
        const claims = await verifyIDToken(data.id_token, { clientId, nonce: attempt.nonce, subject: attempt.subject });
        const fields = tokenFields(data);
        const nextRegistration = { issuer: ISSUER, subject: claims.sub, client_id: clientId, ...(safeText(claims.name) ? { name: claims.name } : {}), ...(safeText(claims.email) ? { email: claims.email } : {}) };
        const nextSession = { ...fields, client_id: clientId, subject: claims.sub };
        await serialize(async () => {
          if (attempt.epoch !== epoch) throw cancelled();
          await atomicWrite(connectionPath, { registration: nextRegistration, session: nextSession });
          if (attempt.epoch !== epoch) throw cancelled();
          registration = nextRegistration; session = nextSession; retryClientId = undefined; lastError = null;
        });
        return { success: true };
      } catch (failure) { throw remember(failure); }
    },
    async status() {
      const authenticated = Boolean(session && (session.expires_at > now().getTime() || session.refresh_token));
      const account = registration ? { ...(registration.name ? { name: registration.name } : {}), ...(registration.email ? { email: registration.email } : {}) } : null;
      return { authenticated, planEnabled: authenticated && hasPlan(session.scopes), expiresAt: session ? new Date(session.expires_at).toISOString() : null, account, authorizationPending: [...attempts.values()].some(attempt => attempt.expiresAt > now().getTime()), ...(lastError ? { error: { ...lastError } } : {}) };
    },
    async cacheIdentity() {
      return session ? createHash('sha256').update(`${session.subject}\u0000${session.client_id}`).digest('hex') : 'signed-out';
    },
    async getAccessToken() {
      if (!session) throw remember(error('CHATGPT_LOGIN_REQUIRED', '请先点击 Continue with ChatGPT 登录'));
      if (!hasPlan(session.scopes)) throw remember(error('CHATGPT_PLAN_NOT_ENABLED', '请重新登录并授权使用 ChatGPT 套餐', 403));
      if (session.expires_at > now().getTime() + 120000) return session.access_token;
      if (refreshPromise) return refreshPromise;
      const before = session; const refreshEpoch = epoch;
      if (!before.refresh_token) throw remember(error('CHATGPT_RELOGIN_REQUIRED', 'ChatGPT 登录已过期，请重新登录'));
      const inFlight = (async () => {
        try {
          const data = await exchange({ grant_type: 'refresh_token', client_id: before.client_id, refresh_token: before.refresh_token, resource: RESOURCE });
          if (data.id_token) await verifyIDToken(data.id_token, { clientId: before.client_id, subject: before.subject });
          const replacement = { ...before, ...tokenFields(data, before) };
          await serialize(async () => {
            if (epoch !== refreshEpoch || session !== before) throw cancelled();
            await atomicWrite(connectionPath, { registration, session: replacement });
            if (epoch !== refreshEpoch) throw cancelled();
            session = replacement; lastError = null;
          });
          return replacement.access_token;
        } catch (failure) {
          if (failure.code === 'CHATGPT_RELOGIN_REQUIRED' && epoch === refreshEpoch && session === before) await serialize(async () => { if (session === before) { await atomicWrite(connectionPath, { registration, session: null }); session = null; } });
          throw remember(failure);
        } finally { if (refreshPromise === inFlight) refreshPromise = undefined; }
      })();
      refreshPromise = inFlight;
      return inFlight;
    },
    async logout() {
      epoch += 1; const logoutEpoch = epoch; attempts.clear(); retryClientId = undefined;
      const previous = session; session = null; lastError = null;
      await serialize(() => atomicWrite(connectionPath, { registration, session: null }));
      if (previous?.refresh_token) {
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000);
        try {
          const response = await fetchImpl(REVOKE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: previous.refresh_token, token_type_hint: 'refresh_token', client_id: previous.client_id }).toString(), redirect: 'error', signal: controller.signal });
          if (!response.ok) throw new Error('revocation-not-confirmed');
        } catch {
          if (epoch === logoutEpoch && !session) lastError = { code: 'CHATGPT_REVOCATION_UNCONFIRMED', message: '已在本项目退出；远端撤销未确认，可在 ChatGPT 设置中断开本应用' };
        } finally { clearTimeout(timer); }
      }
    },
  };
}
