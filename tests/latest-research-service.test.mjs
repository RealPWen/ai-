import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createDebatesService } from '../backend/src/research-service.mjs';
import { createDeepSeekResearchService } from '../backend/src/deepseek-service.mjs';
import { createSubscriptionResearchService } from '../backend/src/subscription-service.mjs';
import { createFileCache } from '../backend/src/cache.mjs';
import { ResearchError } from '../backend/src/errors.mjs';

const ticker = '002920.SZ';
const now = () => new Date('2026-10-20T16:30:00.001Z'); // Shanghai 2026-10-21.
function result(code = ticker, changes = {}) {
  const report = { company: { ticker: code, name: '测试公司', identityStatus: 'verified', description: '测试业务' },
    summary: '新研究摘要', debates: [], sources: [{ id: 's1', title: '公开研究正文', url: 'https://www.example.com/research',
      author: '测试机构', publishedAt: '2026-10-19', platform: 'other', readingScope: 'partial_text', qualityLabel: '' }],
    coverage: [], limitations: [], ...changes };
  return { report, response: { model: 'actual-response-model', output: [{ type: 'web_search_call', status: 'completed', action: { type: 'search', sources: report.sources.map(source => ({ url: source.url })) } }] } };
}
function oldReport() {
  return { ...result().report, ticker, asOf: '2026-10-13', windowStart: '2026-07-16', provider: 'chatgpt',
    model: 'old-model', promptVersion: 'old-prompt', generatedAt: '2026-10-13T02:00:00.000Z', updatedAt: '2026-10-13T02:00:00.000Z', cached: false };
}
function storage(initial = null) {
  const state = { report: initial, getCalls: [], setCalls: [], failWrite: false };
  return { state, key: () => assert.fail('inflight identity must not depend on a cache/date/model key'),
    async get(input) { state.getCalls.push(input); return state.report ? structuredClone(state.report) : null; },
    async set(input, report) {
      state.setCalls.push({ input, report });
      if (state.failWrite) throw new ResearchError('DEBATES_DATABASE_UNAVAILABLE', '研究数据库暂不可用。', 503);
      state.report = structuredClone(report); return structuredClone(report);
    } };
}
const options = { prompt: '研究提示词', promptVersion: 'current-prompt', model: 'configured-model', provider: 'deepseek', now };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('注入的数据库GET仅按ticker读取，跨日期/配置复用原报告且绝不重贴provider或时间', async () => {
  const cache = storage(oldReport()); let calls = 0;
  const service = createDeepSeekResearchService({ ...options, directory: '/must-not-use-files', cache, configured: false,
    client: { research: async () => { calls++; assert.fail('GET must not call AI'); }, resolveModel: async () => assert.fail('GET must not resolve a model') } });
  const report = await service.get({ ticker: ' 002920.sz ', asOf: '2035-01-01' });
  assert.deepEqual(cache.state.getCalls, [{ ticker }]); assert.equal(report.provider, 'chatgpt'); assert.equal(report.asOf, '2026-10-13');
  assert.equal(report.generatedAt, oldReport().generatedAt); assert.equal(report.updatedAt, oldReport().updatedAt);
  assert.equal(report.model, 'old-model'); assert.equal(report.promptVersion, 'old-prompt'); assert.equal(report.cached, true); assert.equal(calls, 0);
  await assert.rejects(service.generate({ ticker }), { code: 'DEEPSEEK_MISSING_API_KEY' }); assert.equal(cache.state.setCalls.length, 0);
});

test('显式生成忽略legacy asOf，在上海今日检索并原子替换每股唯一报告，次日读取仍保留真实报告日期', async () => {
  let current = now(); const cache = storage(oldReport()), inputs = [];
  const service = createDebatesService({ ...options, now: () => current, store: cache, client: { async research(input) { inputs.push(input); return result(); } } });
  const report = await service.generate({ ticker, asOf: '2001-02-30', companyName: '测试公司' });
  assert.equal(inputs[0].asOf, '2026-10-21'); assert.equal(inputs[0].windowStart, '2026-07-24');
  assert.equal(report.provider, 'deepseek'); assert.equal(report.model, 'actual-response-model'); assert.equal(report.asOf, '2026-10-21');
  assert.equal(report.generatedAt, current.toISOString()); assert.equal(report.updatedAt, report.generatedAt);
  assert.deepEqual(cache.state.setCalls[0].input, { ticker }); assert.equal(cache.state.setCalls.length, 1);
  current = new Date('2026-10-22T02:00:00Z');
  const saved = await service.get({ ticker, asOf: '1990-01-01' }); assert.equal(saved.asOf, '2026-10-21'); assert.equal(saved.updatedAt, report.updatedAt);
  assert.equal(inputs.length, 1); assert.deepEqual(cache.state.getCalls, [{ ticker }]);
});

test('同股跨日期并发只支付一次，两个股票上限保留，同股在满槽时仍可复用，close等写入后结束', async () => {
  const gate = deferred(), cache = storage(); let calls = 0, closed = false;
  const service = createDebatesService({ ...options, cache, client: { async research(input) { calls++; await gate.promise; return result(input.ticker); } } });
  const one = service.generate({ ticker, asOf: '2026-10-01' }), same = service.generate({ ticker, asOf: '2020-01-01' });
  const two = service.generate({ ticker: '00700.HK' });
  const repeated = service.generate({ ticker, asOf: null });
  await assert.rejects(service.generate({ ticker: '600519.SH' }), { code: 'RESEARCH_BUSY', status: 429 }); assert.equal(calls, 2);
  const closing = service.close().then(() => { closed = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  await assert.rejects(service.generate({ ticker: '600519.SH' }), { code: 'RESEARCH_CLOSING', status: 503 });
  gate.resolve(); const reports = await Promise.all([one, same, two, repeated]); await closing;
  assert.deepEqual(reports[0], reports[1]); assert.deepEqual(reports[0], reports[3]); assert.equal(calls, 2);
  assert.equal(cache.state.setCalls.length, 2); assert.equal(closed, true);
});

test('生成失败、证券/证据核验失败、数据库写入失败都保留上一份，成功零分歧仍可保存', async () => {
  for (const mode of ['provider', 'identity', 'no_sources', 'unverified_company', 'empty_summary', 'database']) {
    const prior = oldReport(), cache = storage(prior); if (mode === 'database') cache.state.failWrite = true;
    const service = createDebatesService({ ...options, cache, client: { async research() {
      if (mode === 'provider') throw new ResearchError('DEEPSEEK_UPSTREAM_ERROR', 'AI服务暂不可用。', 502);
      if (mode === 'identity') return result('00700.HK');
      if (mode === 'no_sources') return result(ticker, { sources: [] });
      if (mode === 'unverified_company') return result(ticker, { company: { ...result().report.company, identityStatus: 'uncertain' } });
      if (mode === 'empty_summary') return result(ticker, { summary: ' ' });
      return result();
    } } });
    await assert.rejects(service.generate({ ticker }));
    assert.deepEqual(await service.get({ ticker }), { ...prior, cached: true });
    assert.equal(cache.state.setCalls.length, mode === 'database' ? 1 : 0);
  }
  const cache = storage(oldReport()), service = createDebatesService({ ...options, cache, client: { research: async () => result() } });
  const saved = await service.generate({ ticker }); assert.deepEqual(saved.debates, []); assert.equal(cache.state.setCalls.length, 1);
});

test('数据库并发CAS返回更新版本时，服务保留其provider/日期/缓存状态，不伪称本次模型已覆盖', async () => {
  const newer = { ...oldReport(), generatedAt: '2026-10-22T00:00:00Z', updatedAt: '2026-10-22T00:00:00Z', cached: true };
  const service = createDeepSeekResearchService({ ...options, cache: { get: async () => newer, set: async () => newer }, configured: true,
    client: { research: async () => result() } });
  assert.deepEqual(await service.generate({ ticker }), newer);
});

test('订阅只读共享DeepSeek报告不查登录/模型，生成仍验证账号且账号变化不覆盖旧报告', async () => {
  const prior = { ...oldReport(), provider: 'deepseek' }, cache = storage(prior), gate = deferred();
  let identity = 'account-a', researches = 0, models = 0, statuses = 0;
  const service = createSubscriptionResearchService({ ...options, cache, auth: { status: async () => { statuses++; return { authenticated: identity !== 'signed-out', planEnabled: true }; },
    cacheIdentity: async () => identity, getAccessToken: async () => { throw new ResearchError('CHATGPT_LOGIN_REQUIRED', '请先登录。', 401); } },
    client: { resolveModel: async () => { models++; return 'subscription-model'; }, research: async () => { researches++; await gate.promise; return result(); } } });
  assert.equal((await service.get({ ticker })).provider, 'deepseek'); assert.deepEqual([statuses, models, researches], [0, 0, 0]);
  const pending = service.generate({ ticker });
  for (let i = 0; i < 20 && researches === 0; i++) await new Promise(resolve => setImmediate(resolve));
  identity = 'signed-out'; gate.resolve(); await assert.rejects(pending, { code: 'CHATGPT_ACCOUNT_CHANGED', status: 409 });
  assert.deepEqual(await service.get({ ticker }), { ...prior, cached: true }); assert.equal(cache.state.setCalls.length, 0);
  await service.close();
});

test('两个provider wrapper的close都等待已开始的研究保存，不依赖HTTP连接是否还在', async () => {
  for (const provider of ['deepseek', 'chatgpt']) {
    const gate = deferred(), cache = storage(); let researched = false, finished = false;
    const client = { resolveModel: async () => 'model', research: async () => { researched = true; await gate.promise; return result(); } };
    const service = provider === 'deepseek' ? createDeepSeekResearchService({ ...options, configured: true, cache, client })
      : createSubscriptionResearchService({ ...options, cache, client, auth: { status: async () => ({ authenticated: true, planEnabled: true }), cacheIdentity: async () => 'same-account' } });
    const pending = service.generate({ ticker });
    for (let i = 0; i < 20 && !researched; i++) await new Promise(resolve => setImmediate(resolve));
    const closing = service.close().then(() => { finished = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false);
    gate.resolve(); await pending; await closing; assert.equal(cache.state.setCalls.length, 1); assert.equal(finished, true);
  }
});

test('文件fallback只有ticker键且原子替换同一文件，从不自动读取日期/账号旧partition', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'latest-research-file-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacyName = `${createHash('sha256').update(JSON.stringify([ticker, '2026-10-13', 'unknown-account-partition'])).digest('hex')}.json`;
  await writeFile(path.join(directory, legacyName), JSON.stringify(oldReport()));
  const cache = createFileCache(directory, 'ignored-old-fingerprint');
  assert.equal(await cache.get({ ticker, asOf: '2026-10-13' }), null);
  assert.equal(cache.key({ ticker, asOf: '2026-10-13' }), cache.key({ ticker: ' 002920.sz ', asOf: '2030-01-01' }));
  const fresh = { ...oldReport(), provider: 'deepseek', generatedAt: now().toISOString(), updatedAt: now().toISOString() };
  await cache.set({ ticker }, fresh); await cache.set({ ticker, asOf: '2026-10-21' }, { ...fresh, summary: '更新后的唯一报告' });
  assert.equal((await createFileCache(directory, 'another-provider-model-prompt').get({ ticker })).summary, '更新后的唯一报告');
  assert.equal((await readdir(directory)).filter(name => name.endsWith('.json')).length, 2); // One untouched legacy file + one latest file.
  assert.equal(JSON.parse(await readFile(path.join(directory, legacyName), 'utf8')).provider, 'chatgpt');
});
