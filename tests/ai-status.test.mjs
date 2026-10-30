import test from 'node:test';
import assert from 'node:assert/strict';
import { initAIStatus } from '../frontend/src/features/ai-status.js';
import { canUseAIResearch, createAuthService } from '../frontend/src/services/auth.js';
import { endpoints } from '../frontend/src/api/endpoints.js';

const configured = () => ({ provider: 'deepseek', configured: true, authenticated: true, researchEnabled: true, model: 'deepseek-v4-pro', error: null });

function windowFixture() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(name, handler) { listeners.set(name, handler); },
    removeEventListener(name, handler) { if (listeners.get(name) === handler) listeners.delete(name); },
    focus() { return listeners.get('focus')?.(); },
    setTimeout() { throw new Error('Status reads must not poll'); },
    setInterval() { throw new Error('Status reads must not poll'); },
    get document() { throw new Error('Status reads must not access the DOM'); },
  };
}

function deferred() {
  let resolve; let reject;
  const promise = new Promise((succeed, fail) => { resolve = succeed; reject = fail; });
  return { promise, resolve, reject };
}

test('initialization and refresh only GET status without DOM, login, or inference calls', async () => {
  const calls = [], changes = [];
  const service = createAuthService({ routes: endpoints, config: {}, client: {
    async get(path) { calls.push(['GET', path]); return { data: configured() }; },
    async post(path) { calls.push(['POST', path]); throw new Error('No automatic POST allowed'); },
  } });
  const windowImpl = windowFixture();
  const tracker = initAIStatus({ service, windowImpl, onChange: (...args) => changes.push(args) });
  assert.deepEqual(changes, [[null, { busy: null, error: '' }]]);
  assert.equal(tracker.status, null);
  assert.equal(tracker.busy, null);
  assert.deepEqual([...windowImpl.listeners.keys()], ['focus']);
  assert.deepEqual(await tracker.ready, configured());
  assert.equal(canUseAIResearch(tracker.status), true);
  assert.deepEqual(changes.at(-1), [configured(), { busy: null, error: '' }]);
  await tracker.refresh();
  assert.deepEqual(calls, [['GET', endpoints.authStatus], ['GET', endpoints.authStatus]]);
  tracker.dispose();
});

test('focus reads the latest state, fails closed on errors, and allows recovery', async () => {
  const windowImpl = windowFixture(), changes = [];
  let response = configured(), failure;
  const tracker = initAIStatus({ windowImpl, service: { status: async () => {
    if (failure) throw failure;
    return response;
  } }, onChange: (...args) => changes.push(args) });
  await tracker.ready;
  response = { ...configured(), researchEnabled: false };
  await windowImpl.focus();
  assert.strictEqual(tracker.status, response);
  assert.equal(canUseAIResearch(tracker.status), false);
  response = configured(); await windowImpl.focus();
  assert.equal(canUseAIResearch(tracker.status), true);
  failure = new Error('后端离线'); await windowImpl.focus();
  assert.equal(tracker.status, null);
  assert.equal(canUseAIResearch(tracker.status), false);
  assert.deepEqual(changes.at(-1), [null, { busy: null, error: '后端离线' }]);
  failure = { unexpected: true }; await windowImpl.focus();
  assert.deepEqual(changes.at(-1), [null, { busy: null, error: '无法读取 AI 连接状态，请检查后端服务后重试。' }]);
  failure = null; await windowImpl.focus();
  assert.strictEqual(tracker.status, response);
  assert.deepEqual(changes.at(-1), [response, { busy: null, error: '' }]);
  tracker.dispose();
});

test('latest refresh wins; late success cannot restore permission and late failure cannot erase new status', async () => {
  const requests = [], changes = [];
  const tracker = initAIStatus({ windowImpl: windowFixture(), service: { status: () => {
    const request = deferred(); requests.push(request); return request.promise;
  } }, onChange: (...args) => changes.push(args) });
  const latest = tracker.refresh();
  requests[1].reject(new Error('当前请求失败')); await latest;
  requests[0].resolve(configured()); await tracker.ready;
  assert.equal(tracker.status, null);
  assert.equal(changes.length, 2);
  assert.equal(changes.at(-1)[1].error, '当前请求失败');

  const old = tracker.refresh(), current = tracker.refresh();
  const currentStatus = configured();
  requests[3].resolve(currentStatus); await current;
  requests[2].reject(new Error('迟到的旧错误')); await old;
  assert.strictEqual(tracker.status, currentStatus);
  assert.equal(changes.length, 3);
  assert.deepEqual(changes.at(-1), [currentStatus, { busy: null, error: '' }]);
  tracker.dispose();
});

test('dispose removes focus and ignores outstanding success or failure without further reads', async () => {
  for (const outcome of ['success', 'failure']) {
    const pending = deferred(), windowImpl = windowFixture(), changes = [];
    let reads = 0;
    const tracker = initAIStatus({ windowImpl, service: { status: () => { reads += 1; return pending.promise; } }, onChange: (...args) => changes.push(args) });
    tracker.dispose(); tracker.dispose();
    assert.equal(windowImpl.listeners.size, 0);
    await windowImpl.focus(); await tracker.refresh();
    assert.equal(reads, 1);
    if (outcome === 'success') pending.resolve(configured());
    else pending.reject(new Error('迟到的连接错误'));
    await tracker.ready;
    assert.equal(tracker.status, null);
    assert.deepEqual(changes, [[null, { busy: null, error: '' }]]);
  }
});

test('normalized LAN read-only status is passed through unchanged and never grants research', async () => {
  const shared = { provider: 'deepseek', configured: false, authenticated: false, researchEnabled: false, model: '', error: null, sharedReadOnly: true };
  const changes = [];
  const tracker = initAIStatus({ windowImpl: windowFixture(), service: { status: async () => shared }, onChange: (...args) => changes.push(args) });
  await tracker.ready;
  assert.strictEqual(tracker.status, shared);
  assert.strictEqual(changes.at(-1)[0], shared);
  assert.equal(canUseAIResearch(tracker.status), false);
  assert.deepEqual(changes.at(-1)[1], { busy: null, error: '' });
  tracker.dispose();
});

test('backend status errors remain available to the caller without introducing controls', async () => {
  const status = { ...configured(), error: { code: 'DEEPSEEK_UNAVAILABLE', message: '研究服务当前不可用' } };
  const changes = [];
  const tracker = initAIStatus({ windowImpl: windowFixture(), service: { status: async () => status }, onChange: (...args) => changes.push(args) });
  await tracker.ready;
  assert.strictEqual(tracker.status, status);
  assert.deepEqual(changes.at(-1), [status, { busy: null, error: '研究服务当前不可用' }]);
  tracker.dispose();
});
