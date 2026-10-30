import test from 'node:test';
import assert from 'node:assert/strict';
import { canUseAIResearch, canUseChatgptPlan, createAuthService, isAuthCallbackMessage, normalizeAuthStatus, officialChatgptLoginUrl } from '../frontend/src/services/auth.js';
import { initChatgptAuth } from '../frontend/src/features/chatgpt-auth.js';
import { endpoints } from '../frontend/src/api/endpoints.js';

const notLoggedIn = () => ({ provider: 'chatgpt', authenticated: false, planEnabled: false, expiresAt: null });
const loggedIn = () => ({ provider: 'chatgpt', authenticated: true, planEnabled: true, expiresAt: null, account: { name: '<script>safe text</script>' } });
const deepseekConfigured = () => ({ provider: 'deepseek', configured: true, authenticated: true, researchEnabled: true, model: 'deepseek-v4-pro' });

class FakeElement {
  constructor() { this.hidden = false; this.textContent = ''; this.disabled = false; this.listeners = new Map(); this.attributes = new Map(); this.classList = { toggle() {} }; }
  get href() { return this.attributes.get('href') ?? ''; }
  set href(value) { this.attributes.set('href', String(value)); }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  removeEventListener(name) { this.listeners.delete(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  async click() { if (!this.disabled && this.listeners.get('click')) await this.listeners.get('click')(); }
}
function browserFixture() {
  const elements = new Map();
  const documentImpl = { getElementById: id => { if (!elements.has(id)) elements.set(id, new FakeElement()); return elements.get(id); } };
  const timers = new Map(); let timerId = 0;
  let openCalls = 0;
  const windowImpl = new FakeElement();
  Object.assign(windowImpl, { location: { origin: 'http://127.0.0.1:8765' },
    open: () => { openCalls += 1; throw new Error('内置浏览器不支持 window.open'); },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  return { elements, documentImpl, windowImpl, timers, get openCalls() { return openCalls; } };
}

async function runTimer(fixture, delay) {
  const entry = [...fixture.timers.entries()].find(([, timer]) => timer.delay === delay);
  assert.ok(entry, `应有 ${delay}ms 定时器`);
  fixture.timers.delete(entry[0]);
  await entry[1].callback();
}

test('登录地址只允许 OpenAI 官方 HTTPS 授权路径，拒绝用户信息和相似域名', () => {
  const valid = 'https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client&state=example';
  assert.equal(officialChatgptLoginUrl(valid), valid);
  for (const value of ['http://auth.openai.com/api/accounts/authorize', 'https://auth.openai.com.evil.test/api/accounts/authorize', 'https://user:password@auth.openai.com/api/accounts/authorize', 'javascript:alert(1)', 'https://auth.openai.com/other', 'https://auth.openai.com:444/api/accounts/authorize']) {
    assert.throws(() => officialChatgptLoginUrl(value));
  }
});

test('浏览器状态仅保存安全账号信息，未获得套餐权限时不能生成', () => {
  const result = normalizeAuthStatus({ data: { ...loggedIn(), accessToken: 'do-not-forward', account: { name: '用户', idToken: 'do-not-forward' } } });
  assert.deepEqual(result.account, { name: '用户', email: '' }); assert.equal(Object.hasOwn(result, 'accessToken'), false);
  assert.equal(canUseChatgptPlan(result), true);
  assert.equal(canUseChatgptPlan({ ...result, planEnabled: false }), false);
  assert.equal(canUseChatgptPlan({ ...result, provider: 'api_key' }), false);
  assert.throws(() => normalizeAuthStatus({ data: { authenticated: true } }));
});

test('共享只读状态清除本机身份与授权，不能使用套餐用量', () => {
  const status = normalizeAuthStatus({ data: {
    ...loggedIn(), sharedReadOnly: true, expiresAt: '2026-10-17T00:00:00Z',
    error: { code: 'OWNER_ERROR', message: 'owner-only' },
  } });
  assert.deepEqual(status, { provider: 'chatgpt', authenticated: false, planEnabled: false, expiresAt: null, account: null, error: null, sharedReadOnly: true });
  assert.equal(canUseChatgptPlan(status), false);
  assert.equal(canUseChatgptPlan({ ...loggedIn(), sharedReadOnly: true }), false);
  assert.equal(Object.hasOwn(normalizeAuthStatus({ data: { ...notLoggedIn(), sharedReadOnly: false } }), 'sharedReadOnly'), false);
});

test('共享访问隐藏登录与本机身份，刷新和点击均不发出授权或推理 POST', async () => {
  const fixture = browserFixture(), calls = [];
  const service = createAuthService({ routes: endpoints, config: {}, client: {
    get: async path => { calls.push({ method: 'GET', path }); return { data: { ...loggedIn(), sharedReadOnly: true } }; },
    post: async path => { calls.push({ method: 'POST', path }); throw new Error('共享访问不能 POST'); },
  } });
  const ui = initChatgptAuth({ ...fixture, service, baseUrl: '' });
  await ui.ready;
  assert.equal(fixture.elements.get('chatgpt-auth-state').textContent, '局域网只读');
  assert.equal(fixture.elements.get('chatgpt-account').hidden, true);
  assert.equal(fixture.elements.get('chatgpt-account').textContent, '');
  for (const id of ['chatgpt-login', 'chatgpt-test', 'chatgpt-logout', 'chatgpt-refresh']) {
    const button = fixture.elements.get(id);
    assert.equal(button.hidden, true, id); assert.equal(button.disabled, true, id);
    // The event handlers also reject actions if a hidden control is manipulated.
    if (id !== 'chatgpt-refresh') { button.disabled = false; await button.click(); }
  }
  await ui.refresh();
  assert.equal(fixture.elements.get('chatgpt-feedback').hidden, true);
  assert.equal(fixture.elements.get('chatgpt-login-link-panel').hidden, true);
  assert.equal(fixture.timers.size, 0);
  assert.ok(calls.every(call => call.method === 'GET' && call.path === endpoints.authStatus));
  ui.dispose();
});

test('状态转为共享只读时取消未完成的登录准备，旧返回不显示授权链接', async () => {
  const fixture = browserFixture(); let status = notLoggedIn(), finishStart;
  const service = { status: async () => status, start: () => new Promise(resolve => { finishStart = resolve; }) };
  const ui = initChatgptAuth({ ...fixture, service, baseUrl: '' }); await ui.ready;
  const preparing = fixture.elements.get('chatgpt-login').click();
  status = { ...notLoggedIn(), sharedReadOnly: true }; await ui.refresh();
  finishStart({ url: 'https://auth.openai.com/api/accounts/authorize?state=old' }); await preparing;
  assert.equal(ui.busy, null); assert.equal(fixture.timers.size, 0);
  assert.equal(fixture.elements.get('chatgpt-login-link-panel').hidden, true);
  assert.equal(fixture.elements.get('chatgpt-login-link').getAttribute('href'), null);
  assert.equal(fixture.elements.get('chatgpt-login').hidden, true);
  ui.dispose();
});

test('auth service 的状态及模型查询只 GET；只有显式 test 才 POST 推理测试', async () => {
  const calls = [];
  const service = createAuthService({ routes: endpoints, config: { generationTimeoutMs: 1234 }, client: {
    get: async path => { calls.push({ method: 'GET', path }); return { data: path === endpoints.authModels ? [{ id: 'allowed-model' }] : loggedIn() }; },
    post: async (path, options) => { calls.push({ method: 'POST', path, options }); return { data: path === endpoints.authStart ? { url: 'https://auth.openai.com/api/accounts/authorize?state=example' } : path === endpoints.authLogout ? { authenticated: false } : { ok: true, model: 'allowed-model', message: '连接正常' } }; },
  } });
  await service.status(); await service.models();
  assert.deepEqual(calls.map(item => item.method), ['GET', 'GET']);
  await service.start(); await service.test(); await service.logout();
  assert.equal(calls[3].path, endpoints.authTest); assert.deepEqual(calls[3].options.body, {}); assert.equal(calls[3].options.timeoutMs, 1234);
  assert.equal(calls.some(item => item.path === endpoints.debatesGenerate), false);
});

test('OAuth popup 消息必须同时匹配本次窗口、后端 origin 和指定 type', () => {
  const popup = {}; const backendOrigin = 'http://127.0.0.1:8000';
  const event = { source: popup, origin: backendOrigin, data: { type: 'chatgpt-auth-complete' } };
  assert.equal(isAuthCallbackMessage(event, { backendOrigin, popup }), true);
  assert.equal(isAuthCallbackMessage({ ...event, source: {} }, { backendOrigin, popup }), false);
  assert.equal(isAuthCallbackMessage({ ...event, origin: 'https://evil.test' }, { backendOrigin, popup }), false);
  assert.equal(isAuthCallbackMessage({ ...event, data: { authenticated: true } }, { backendOrigin, popup }), false);
});

test('页面初始化不消耗推理用量，登录后测试只由按钮触发，退出清除状态', async () => {
  const fixture = browserFixture(); let tests = 0; let status = notLoggedIn(); const changes = [];
  const service = { status: async () => status, test: async () => { tests += 1; return { model: 'allowed', message: '<script>raw</script>' }; }, logout: async () => { status = notLoggedIn(); return status; } };
  const ui = initChatgptAuth({ ...fixture, service, baseUrl: 'http://127.0.0.1:8000', onChange: next => changes.push(canUseChatgptPlan(next)) });
  await ui.ready; assert.equal(tests, 0); assert.equal(fixture.elements.get('chatgpt-test').hidden, true);
  status = loggedIn(); await ui.refresh(); assert.equal(tests, 0); assert.equal(fixture.elements.get('chatgpt-test').hidden, false);
  assert.equal(fixture.elements.get('chatgpt-account').textContent, '<script>safe text</script>');
  await fixture.elements.get('chatgpt-test').click(); assert.equal(tests, 1); assert.match(fixture.elements.get('chatgpt-feedback').textContent, /<script>raw<\/script>/);
  await fixture.elements.get('chatgpt-logout').click(); assert.equal(canUseChatgptPlan(ui.status), false); assert.equal(changes.at(-1), false);
  ui.dispose(); assert.equal(fixture.timers.size, 0);
});

test('登录准备完成立即显示官方链接，不调用会抛错的 window.open，也不自动推理', async () => {
  const fixture = browserFixture(); let finishStart; let tests = 0;
  const service = {
    status: async () => notLoggedIn(),
    start: () => new Promise(resolve => { finishStart = resolve; }),
    test: async () => { tests += 1; throw new Error('不应自动测试'); },
    models: async () => { throw new Error('准备登录时不应查询模型'); },
  };
  const ui = initChatgptAuth({ ...fixture, service, baseUrl: 'http://127.0.0.1:8000' }); await ui.ready;
  const preparation = fixture.elements.get('chatgpt-login').click();
  assert.equal(ui.busy, 'login'); assert.equal(fixture.elements.get('chatgpt-login').disabled, true);
  finishStart({ url: 'https://auth.openai.com/api/accounts/authorize?state=example' }); await preparation;
  assert.equal(fixture.openCalls, 0);
  assert.equal(fixture.elements.get('chatgpt-login-link-panel').hidden, false);
  assert.equal(fixture.elements.get('chatgpt-login-link').href, 'https://auth.openai.com/api/accounts/authorize?state=example');
  assert.equal(ui.busy, null); assert.equal(fixture.elements.get('chatgpt-login').disabled, false);
  assert.equal(canUseChatgptPlan(ui.status), false); assert.equal(tests, 0);
  await runTimer(fixture, 5000); assert.equal(tests, 0); assert.equal(fixture.openCalls, 0);
  assert.equal(fixture.windowImpl.listeners.has('message'), false);
  ui.dispose();
});



test('登录准备失败显示原因并允许重试，没有遗留链接、定时器或空白窗口', async () => {
  const fixture = browserFixture(); let failed = true;
  const service = { status: async () => notLoggedIn(), start: async () => {
    if (failed) throw new Error('账号尚无资格');
    return { url: 'https://auth.openai.com/api/accounts/authorize?state=retry' };
  } };
  const ui = initChatgptAuth({ ...fixture, service, baseUrl: 'http://127.0.0.1:8000' }); await ui.ready;
  await fixture.elements.get('chatgpt-login').click();
  assert.equal(fixture.openCalls, 0); assert.equal(ui.busy, null); assert.equal(fixture.timers.size, 0);
  assert.equal(fixture.elements.get('chatgpt-login').disabled, false);
  assert.equal(fixture.elements.get('chatgpt-login-link-panel').hidden, true);
  assert.equal(fixture.elements.get('chatgpt-login-link').getAttribute('href'), null);
  assert.equal(fixture.elements.get('chatgpt-feedback').textContent, '账号尚无资格');
  failed = false; await fixture.elements.get('chatgpt-login').click();
  assert.equal(fixture.elements.get('chatgpt-login-link-panel').hidden, false);
  assert.match(fixture.elements.get('chatgpt-login-link').href, /state=retry/);
  ui.dispose();
});

test('状态轮询确认授权后清除登录链接和等待，只有点击测试才使用推理', async () => {
  const fixture = browserFixture(); let status = notLoggedIn(); let tests = 0;
  const service = {
    status: async () => status,
    start: async () => ({ url: 'https://auth.openai.com/api/accounts/authorize?state=example' }),
    test: async () => { tests += 1; return { model: 'allowed', message: 'OK' }; },
  };
  const ui = initChatgptAuth({ ...fixture, service, baseUrl: 'http://127.0.0.1:8000' }); await ui.ready;
  await fixture.elements.get('chatgpt-login').click(); status = loggedIn();
  await runTimer(fixture, 5000);
  assert.equal(canUseChatgptPlan(ui.status), true); assert.equal(ui.busy, null);
  assert.equal(fixture.timers.size, 0); assert.equal(fixture.elements.get('chatgpt-login-link-panel').hidden, true);
  assert.equal(fixture.elements.get('chatgpt-login-link').getAttribute('href'), null);
  assert.equal(fixture.elements.get('chatgpt-test').hidden, false); assert.equal(tests, 0);
  await fixture.elements.get('chatgpt-test').click(); assert.equal(tests, 1);
  ui.dispose();
});

test('重新准备链接取消上次轮询与过期回调，新链接仍然可用', async () => {
  const fixture = browserFixture(); let starts = 0; let statusCalls = 0;
  const service = {
    status: async () => { statusCalls += 1; return notLoggedIn(); },
    start: async () => ({ url: `https://auth.openai.com/api/accounts/authorize?state=attempt-${++starts}` }),
  };
  const ui = initChatgptAuth({ ...fixture, service, baseUrl: 'http://127.0.0.1:8000' }); await ui.ready;
  await fixture.elements.get('chatgpt-login').click();
  const oldTimers = [...fixture.timers.entries()];
  await fixture.elements.get('chatgpt-login').click();
  assert.equal(starts, 2); assert.equal(fixture.timers.size, 2);
  assert.equal(fixture.elements.get('chatgpt-login-link').href, 'https://auth.openai.com/api/accounts/authorize?state=attempt-2');
  for (const [id, timer] of oldTimers) { assert.equal(fixture.timers.has(id), false); await timer.callback(); }
  assert.equal(statusCalls, 1); assert.equal(fixture.timers.size, 2);
  assert.equal(fixture.elements.get('chatgpt-login-link-panel').hidden, false);
  assert.match(fixture.elements.get('chatgpt-login-link').href, /state=attempt-2/);
  ui.dispose();
});

test('登录链接十分钟过期后移除地址并结束轮询，提示重新点击', async () => {
  const fixture = browserFixture();
  const service = { status: async () => notLoggedIn(), start: async () => ({ url: 'https://auth.openai.com/api/accounts/authorize?state=example' }) };
  const ui = initChatgptAuth({ ...fixture, service, baseUrl: 'http://127.0.0.1:8000' }); await ui.ready;
  await fixture.elements.get('chatgpt-login').click(); await runTimer(fixture, 600000);
  assert.equal(fixture.elements.get('chatgpt-login-link-panel').hidden, true);
  assert.equal(fixture.elements.get('chatgpt-login-link').getAttribute('href'), null);
  assert.match(fixture.elements.get('chatgpt-feedback').textContent, /过期/);
  assert.match(fixture.elements.get('chatgpt-feedback').textContent, /重新.*点击|重新.*登录/);
  assert.equal(ui.busy, null); assert.equal(fixture.elements.get('chatgpt-login').disabled, false);
  assert.equal(fixture.timers.size, 0); assert.equal(fixture.openCalls, 0);
  ui.dispose();
});

test('状态刷新失败按未确认授权处理，阻止旧的已登录状态继续生成', async () => {
  const fixture = browserFixture(); let fail = false;
  const service = { status: async () => { if (fail) throw new Error('后端离线'); return loggedIn(); } };
  const ui = initChatgptAuth({ ...fixture, service, baseUrl: 'http://127.0.0.1:8000' }); await ui.ready;
  assert.equal(canUseChatgptPlan(ui.status), true); fail = true; await ui.refresh();
  assert.equal(ui.status, null); assert.equal(fixture.elements.get('chatgpt-test').hidden, true);
  ui.dispose();
});

test('已保存授权不掩盖续期网络错误，读取本地状态不宣称连接成功', async () => {
  const fixture = browserFixture();
  let status = { ...loggedIn(), error: { code: 'CHATGPT_AUTH_CONNECTION_RESET', message: '授权续期连接中断，请检查代理后重试。' } };
  const service = { status: async () => status };
  const ui = initChatgptAuth({ ...fixture, service, baseUrl: 'http://127.0.0.1:8000' }); await ui.ready;
  assert.equal(canUseChatgptPlan(ui.status), true);
  assert.equal(fixture.elements.get('chatgpt-feedback').textContent, status.error.message);
  await ui.refresh();
  assert.equal(fixture.elements.get('chatgpt-feedback').textContent, status.error.message);
  status = loggedIn(); await ui.refresh();
  assert.match(fixture.elements.get('chatgpt-feedback').textContent, /本地.*不验证网络连接/);
  assert.doesNotMatch(fixture.elements.get('chatgpt-feedback').textContent, /登录授权完成|连接成功/);
  ui.dispose();
});

test('DeepSeek 状态仅保留安全字段，通用研究门禁同时检查配置、授权、开关和只读权限', () => {
  const status = normalizeAuthStatus({ data: { ...deepseekConfigured(), apiKey: 'secret', account: { name: 'private' } } });
  assert.deepEqual(status, { ...deepseekConfigured(), error: null });
  assert.equal(canUseAIResearch(status), true); assert.equal(canUseChatgptPlan(status), false);
  assert.equal(canUseAIResearch(loggedIn()), true); assert.equal(canUseAIResearch(notLoggedIn()), false);
  for (const field of ['configured', 'authenticated', 'researchEnabled']) {
    assert.equal(canUseAIResearch({ ...status, [field]: false }), false, field);
    assert.throws(() => normalizeAuthStatus({ ...status, [field]: 'true' }), /DeepSeek.*无效/);
  }
  assert.equal(canUseAIResearch(null), false);
  assert.equal(canUseAIResearch({ ...status, sharedReadOnly: true }), false);
  assert.deepEqual(normalizeAuthStatus({ ...status, sharedReadOnly: true, error: { message: 'owner-only' } }), {
    provider: 'deepseek', configured: false, authenticated: false, researchEnabled: false, model: '', error: null, sharedReadOnly: true,
  });
});

test('DeepSeek 配置完成后无需登录，初始化不自动推理，连接测试由按钮显式触发', async () => {
  const fixture = browserFixture(), calls = [];
  const service = createAuthService({ routes: endpoints, config: {}, client: {
    get: async path => { calls.push(['GET', path]); return { data: deepseekConfigured() }; },
    post: async path => { calls.push(['POST', path]); return { data: { provider: 'deepseek', model: 'deepseek-v4-pro', message: 'OK', apiKey: 'secret' } }; },
  } });
  const ui = initChatgptAuth({ ...fixture, service, baseUrl: '' }); await ui.ready;
  assert.deepEqual(calls, [['GET', endpoints.authStatus]]);
  assert.equal(canUseAIResearch(ui.status), true);
  assert.equal(fixture.elements.get('chatgpt-title').textContent, 'DeepSeek');
  assert.match(fixture.elements.get('chatgpt-account').textContent, /deepseek-v4-pro/);
  assert.equal(fixture.elements.get('chatgpt-auth-state').textContent, 'API 已配置');
  for (const id of ['chatgpt-login', 'chatgpt-logout']) {
    assert.equal(fixture.elements.get(id).hidden, true);
    assert.equal(fixture.elements.get(id).disabled, true);
    fixture.elements.get(id).disabled = false; await fixture.elements.get(id).click();
  }
  assert.equal(calls.length, 1);
  assert.equal(fixture.elements.get('chatgpt-login-link-panel').hidden, true);
  assert.equal(fixture.elements.get('chatgpt-login-link').getAttribute('href'), null);
  assert.match(fixture.elements.get('ai-provider-description').textContent, /无需登录/);
  assert.equal(fixture.elements.get('chatgpt-test').hidden, false);
  await fixture.elements.get('chatgpt-test').click();
  assert.deepEqual(calls.at(-1), ['POST', endpoints.authTest]);
  assert.match(fixture.elements.get('chatgpt-feedback').textContent, /DeepSeek 连接成功.*deepseek-v4-pro/);
  assert.equal(fixture.timers.size, 0); ui.dispose();
});

test('DeepSeek 未配置 Key 时提示后端环境变量，不能触发登录、退出或测试', async () => {
  const fixture = browserFixture(), posts = [];
  const service = { status: async () => ({ ...deepseekConfigured(), configured: false, authenticated: false, researchEnabled: false }),
    test: async () => { posts.push('test'); }, start: async () => { posts.push('start'); }, logout: async () => { posts.push('logout'); } };
  const ui = initChatgptAuth({ ...fixture, service, baseUrl: '' }); await ui.ready;
  assert.equal(canUseAIResearch(ui.status), false);
  assert.match(fixture.elements.get('chatgpt-feedback').textContent, /后端 \.env.*DEEPSEEK_API_KEY/);
  for (const id of ['chatgpt-login', 'chatgpt-logout', 'chatgpt-test']) {
    assert.equal(fixture.elements.get(id).hidden, true);
    fixture.elements.get(id).disabled = false; await fixture.elements.get(id).click();
  }
  assert.deepEqual(posts, []); ui.dispose();
});

test('DeepSeek 局域网共享访问隐藏连接操作且不能发送任何授权或推理 POST', async () => {
  const fixture = browserFixture(), calls = [];
  const service = createAuthService({ routes: endpoints, config: {}, client: {
    get: async path => { calls.push(['GET', path]); return { data: { ...deepseekConfigured(), sharedReadOnly: true } }; },
    post: async path => { calls.push(['POST', path]); throw new Error('共享访问不能 POST'); },
  } });
  const ui = initChatgptAuth({ ...fixture, service, baseUrl: '' }); await ui.ready;
  assert.equal(canUseAIResearch(ui.status), false);
  assert.equal(fixture.elements.get('chatgpt-auth-state').textContent, '局域网只读');
  assert.equal(fixture.elements.get('chatgpt-account').hidden, true);
  for (const id of ['chatgpt-login', 'chatgpt-logout', 'chatgpt-test', 'chatgpt-refresh']) {
    const button = fixture.elements.get(id); assert.equal(button.hidden, true); assert.equal(button.disabled, true);
    button.disabled = false; await button.click();
  }
  assert.ok(calls.every(([method, path]) => method === 'GET' && path === endpoints.authStatus));
  assert.equal(fixture.elements.get('chatgpt-feedback').hidden, true); ui.dispose();
});

test('切换到 DeepSeek 会取消旧 ChatGPT 登录等待，迟到的旧授权链接不再显示', async () => {
  const fixture = browserFixture(); let status = notLoggedIn(), finishStart;
  const service = { status: async () => status, start: () => new Promise(resolve => { finishStart = resolve; }) };
  const ui = initChatgptAuth({ ...fixture, service, baseUrl: '' }); await ui.ready;
  const preparing = fixture.elements.get('chatgpt-login').click();
  status = deepseekConfigured(); await ui.refresh();
  finishStart({ url: 'https://auth.openai.com/api/accounts/authorize?state=old' }); await preparing;
  assert.equal(ui.busy, null); assert.equal(fixture.timers.size, 0); assert.equal(canUseAIResearch(ui.status), true);
  assert.equal(fixture.elements.get('chatgpt-login-link-panel').hidden, true);
  assert.equal(fixture.elements.get('chatgpt-login-link').getAttribute('href'), null); ui.dispose();
});

test('DeepSeek 显式失败或畸形连接测试响应不能显示为成功', async () => {
  let response;
  const service = createAuthService({ routes: endpoints, config: {}, client: { post: async () => ({ data: response }) } });
  for (response of [null, { provider: 'deepseek', ok: false, model: 'deepseek-v4-pro', message: 'failed' }, { provider: 'deepseek', model: 'deepseek-v4-pro' }]) {
    await assert.rejects(service.test(), /AI 连接测试结果无效/);
  }
});

test('DeepSeek 测试等待期间切换为共享只读，迟到的测试结果不会重新显示', async () => {
  const fixture = browserFixture(); let status = deepseekConfigured(), finishTest;
  const service = { status: async () => status, test: () => new Promise(resolve => { finishTest = resolve; }) };
  const ui = initChatgptAuth({ ...fixture, service, baseUrl: '' }); await ui.ready;
  const testing = fixture.elements.get('chatgpt-test').click();
  assert.match(fixture.elements.get('chatgpt-feedback').textContent, /DeepSeek API/);
  status = { ...deepseekConfigured(), sharedReadOnly: true }; await ui.refresh();
  finishTest({ model: 'deepseek-v4-pro', message: 'owner-only' }); await testing;
  assert.equal(fixture.elements.get('chatgpt-feedback').hidden, true);
  assert.equal(fixture.elements.get('chatgpt-test').hidden, true);
  assert.equal(canUseAIResearch(ui.status), false); ui.dispose();
});
