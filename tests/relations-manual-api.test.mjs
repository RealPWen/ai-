import test from 'node:test';
import assert from 'node:assert/strict';
import { createResearchServer } from '../backend/app.mjs';
import { ResearchError } from '../backend/src/errors.mjs';

const payload = { ticker: '002920.SZ', asOf: '2026-10-19', expectedRevision: '0', changes: [{ action: 'remove', relatedTicker: '000550.SZ' }] };
const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function fixture(t, { save, remoteAddress } = {}) {
  const calls = [];
  const forbidden = () => { throw new Error('manual relation edits must not invoke AI or account operations'); };
  const server = createResearchServer({
    relationsManualService: save ? { save: async input => { calls.push(input); return save(input); } } : undefined,
    service: { get: forbidden, generate: forbidden }, auth: { status: forbidden }, chatClient: { probe: forbidden },
  });
  if (remoteAddress) server.prependListener('request', request => Object.defineProperty(request.socket, 'remoteAddress', { value: remoteAddress }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { base: `http://127.0.0.1:${server.address().port}`, calls };
}

test('人工修改POST直接写关系数据库，保留revision与变更，不依赖AI授权', async t => {
  const result = { ticker: payload.ticker, asOf: payload.asOf, revision: '1', changedCount: 1 };
  const f = await fixture(t, { save: async () => result });
  const response = await fetch(`${f.base}/api/relations/manual`, json(payload));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { data: result });
  assert.deepEqual(f.calls, [payload]);
});

test('人工修改校验JSON、大小与参数位置，失败不写数据库', async t => {
  const f = await fixture(t, { save: async () => assert.fail('invalid transport must not save') });
  for (const [suffix, options, status, code] of [
    ['', { method: 'POST', body: JSON.stringify(payload) }, 415, 'CONTENT_TYPE_REQUIRED'],
    ['', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{invalid' }, 400, 'INVALID_JSON'],
    ['?ticker=other', json(payload), 400, 'INVALID_PARAMETERS'],
    ['', json({ padding: 'x'.repeat(262144) }), 413, 'BODY_TOO_LARGE'],
  ]) {
    const response = await fetch(`${f.base}/api/relations/manual${suffix}`, options);
    assert.equal(response.status, status); assert.equal((await response.json()).error.code, code);
  }
  assert.equal(f.calls.length, 0);
});

test('人工修改拒绝外站和非本机，不能通过转发头冒充本机', async t => {
  const f = await fixture(t, { save: async () => assert.fail('foreign callers must not save') });
  for (const headers of [{ Origin: 'https://untrusted.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const response = await fetch(`${f.base}/api/relations/manual`, { ...json(payload), headers: { 'Content-Type': 'application/json', ...headers } });
    assert.equal(response.status, 403); assert.equal((await response.json()).error.code, 'ORIGIN_NOT_ALLOWED');
  }
  const remote = await fixture(t, { remoteAddress: '192.0.2.50', save: async () => assert.fail('remote caller must not save') });
  const response = await fetch(`${remote.base}/api/relations/manual`, { ...json(payload), headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '127.0.0.1' } });
  assert.equal(response.status, 403); assert.equal((await response.json()).error.code, 'LOCAL_ONLY_OPERATION');
  assert.equal(f.calls.length + remote.calls.length, 0);
});

test('乐观冲突返回409，数据库错误保留安全状态且不泄露SQL或凭据', async t => {
  for (const [error, status, code] of [
    [new ResearchError('RELATIONS_REVISION_CONFLICT', '关系已被其他修改更新，请重新读取。', 409), 409, 'RELATIONS_REVISION_CONFLICT'],
    [new ResearchError('RELATIONS_DATABASE_UNAVAILABLE', '公司关系数据库暂不可用。', 503), 503, 'RELATIONS_DATABASE_UNAVAILABLE'],
    [new Error('SELECT private_rows FROM secret_schema; postgresql://owner:secret@localhost/db'), 500, 'INTERNAL_ERROR'],
  ]) {
    const f = await fixture(t, { save: async () => { throw error; } });
    const response = await fetch(`${f.base}/api/relations/manual`, json(payload)), text = await response.text();
    assert.equal(response.status, status); assert.equal(JSON.parse(text).error.code, code);
    assert.doesNotMatch(text, /postgresql|private_rows|secret/);
    assert.equal(f.calls.length, 1);
  }
});

test('没有数据库配置时明确失败，预检不触发写入', async t => {
  const f = await fixture(t);
  const missing = await fetch(`${f.base}/api/relations/manual`, json(payload));
  assert.equal(missing.status, 503); assert.equal((await missing.json()).error.code, 'RELATIONS_DATABASE_NOT_CONFIGURED');
  const preflight = await fetch(`${f.base}/api/relations/manual`, { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:8765', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(preflight.status, 204); assert.match(preflight.headers.get('Access-Control-Allow-Methods'), /POST/);
  assert.equal(f.calls.length, 0);
});
