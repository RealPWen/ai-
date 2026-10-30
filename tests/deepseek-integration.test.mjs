import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createResearchServer } from '../backend/app.mjs';
import { DEFAULT_DEEPSEEK_MODEL } from '../backend/src/deepseek-client.mjs';
import { createDeepSeekResearchService } from '../backend/src/deepseek-service.mjs';
import { createSubscriptionResearchService } from '../backend/src/subscription-service.mjs';

const input = { ticker: '002920.SZ', asOf: '2026-10-13' };
const now = () => new Date('2026-10-13T00:00:00Z');
const options = directory => ({ directory, configured: true, model: DEFAULT_DEEPSEEK_MODEL, prompt: '研究提示词', promptVersion: 'test-prompt', fingerprint: 'test-audit', now });

function fixtureResult({ missingBearEvidence = false, model = DEFAULT_DEEPSEEK_MODEL } = {}) {
  const source = (id, author) => ({ id, author, title: `测试来源 ${id}`, url: `https://example.com/${id}`, publishedAt: '2026-10-01', platform: 'sell_side', readingScope: 'full_text', qualityLabel: '' });
  const report = {
    company: { name: '测试公司', ticker: input.ticker, identityStatus: 'verified', description: '用于自动测试' },
    summary: '测试摘要',
    debates: [{ id: 'd1', title: '测试问题', summary: '测试分歧', status: 'documented_disagreement', bull: { summary: '正方观点', evidenceStatus: 'source_view', sourceIds: ['s1'] }, bear: { summary: '反方观点', evidenceStatus: 'source_view', sourceIds: ['s2'] }, metrics: ['测试指标'] }],
    sources: [source('s1', '机构A'), source('s2', '机构B')], coverage: [], limitations: [],
  };
  const response = {
    status: 'completed', model,
    output: [
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(report), annotations: [] }] },
    ],
  };
  const retrievalEvidence = { origin: 'deepseek-search', sources: report.sources.slice(0, missingBearEvidence ? 1 : 2).map(item => ({ url: item.url, readingScope: 'search_snippet', publishedAt: item.publishedAt })) };
  return { report, response, retrievalEvidence };
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deepseek-integration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('DeepSeek安全状态和GET缓存读取不消耗模型，显式POST测试和研究无需订阅登录', async t => {
  const directory = await temporaryDirectory(t);
  let probes = 0, researchCalls = 0, modelLists = 0;
  const client = {
    models: async () => { modelLists++; return [{ id: DEFAULT_DEEPSEEK_MODEL, displayName: DEFAULT_DEEPSEEK_MODEL }]; },
    probe: async () => { probes++; return { ok: true, provider: 'deepseek', model: DEFAULT_DEEPSEEK_MODEL }; },
    research: async () => { researchCalls++; return fixtureResult(); },
  };
  const safeStatus = { provider: 'deepseek', model: DEFAULT_DEEPSEEK_MODEL, configured: true, authenticated: true, researchEnabled: true, error: null };
  const service = createDeepSeekResearchService({ ...options(directory), client });
  const base = await listen(t, createResearchServer({ service, aiStatus: async () => safeStatus, chatClient: client, health: { status: 'ok', provider: 'deepseek', model: DEFAULT_DEEPSEEK_MODEL } }));

  const statusResponse = await fetch(`${base}/api/auth/status`);
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.deepEqual(status, { data: safeStatus });
  assert.doesNotMatch(JSON.stringify(status), /test-only|apiKey|accessToken|refreshToken/);
  assert.deepEqual(await (await fetch(`${base}/api/debates?ticker=${input.ticker}&asOf=${input.asOf}`)).json(), { data: null });
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.equal((await fetch(`${base}/api/auth/test`)).status, 404);
  assert.equal((await fetch(`${base}/api/auth/test`, { method: 'POST' })).status, 415);
  assert.deepEqual([probes, researchCalls, modelLists], [0, 0, 0]);

  for (const endpoint of ['/api/auth/chatgpt/start', '/api/auth/logout']) assert.equal((await fetch(`${base}${endpoint}`, post({}))).status, 404);
  assert.equal((await fetch(`${base}/auth/callback?state=unused&code=unused`)).status, 404);
  assert.deepEqual([probes, researchCalls, modelLists], [0, 0, 0]);

  const models = await (await fetch(`${base}/api/auth/models`)).json();
  assert.deepEqual(models.data, [{ id: DEFAULT_DEEPSEEK_MODEL, displayName: DEFAULT_DEEPSEEK_MODEL }]);
  assert.deepEqual([probes, researchCalls, modelLists], [0, 0, 1]);
  const tested = await (await fetch(`${base}/api/auth/test`, post({}))).json();
  assert.equal(tested.data.provider, 'deepseek');
  assert.equal(tested.data.ok, true);
  assert.deepEqual([probes, researchCalls], [1, 0]);

  const generatedResponse = await fetch(`${base}/api/debates/generate`, post(input));
  assert.equal(generatedResponse.status, 200);
  const { data: generated } = await generatedResponse.json();
  assert.equal(generated.provider, 'deepseek');
  assert.equal(generated.model, DEFAULT_DEEPSEEK_MODEL);
  assert.equal(generated.cached, false);
  assert.equal(generated.debates[0].status, 'documented_disagreement');
  const { data: cached } = await (await fetch(`${base}/api/debates?ticker=${input.ticker}&asOf=${input.asOf}`)).json();
  assert.deepEqual(cached, { ...generated, cached: true });
  assert.deepEqual([probes, researchCalls], [1, 1]);
});

test('每股共享最新报告跨provider、模型、prompt和日期复用，读取保留原始来源且不查询模型目录', async t => {
  const directory = await temporaryDirectory(t);
  let calls = 0;
  const client = {
    resolveModel: async () => { assert.fail('DeepSeek缓存读取不应解析登录或模型目录'); },
    research: async () => { calls++; return fixtureResult({ model: undefined }); },
  };
  const shared = options(directory);
  // Subscription evidence still comes from its native search response.
  const subscriptionResult = fixtureResult();
  subscriptionResult.response.output.unshift({ type: 'web_search_call', status: 'completed', action: { type: 'search', sources: subscriptionResult.report.sources.map(item => ({ url: item.url })) } });
  const seededSubscription = createSubscriptionResearchService({ ...shared, auth: { status: async () => ({ authenticated: true, planEnabled: true }), cacheIdentity: async () => 'test-account' }, client: { resolveModel: async () => shared.model, research: async () => { calls++; return subscriptionResult; } } });
  await seededSubscription.generate(input);
  const service = createDeepSeekResearchService({ ...shared, client });
  const prior = await service.get(input);
  assert.equal(prior.provider, 'chatgpt');
  assert.equal(calls, 1);
  const generated = await service.generate(input);
  assert.equal(generated.provider, 'deepseek');
  assert.equal((await service.get(input)).cached, true);
  const recreated = createDeepSeekResearchService({ ...shared, client });
  assert.equal((await recreated.get(input)).provider, 'deepseek');
  assert.deepEqual(await createDeepSeekResearchService({ ...shared, client, model: 'different-model' }).get(input), { ...generated, cached: true });
  assert.deepEqual(await createDeepSeekResearchService({ ...shared, client, fingerprint: 'changed-prompt-and-audit' }).get(input), { ...generated, cached: true });
  assert.deepEqual(await service.get({ ...input, asOf: '2026-10-12' }), { ...generated, cached: true });
  assert.equal(calls, 2);
});

test('缺少DeepSeek Key时保留缓存读取，拒绝生成且不调用上游', async t => {
  const directory = await temporaryDirectory(t);
  const shared = options(directory);
  await createDeepSeekResearchService({ ...shared, client: { research: async () => fixtureResult() } }).generate(input);
  let calls = 0;
  const service = createDeepSeekResearchService({ ...shared, configured: false, client: { research: async () => { calls++; assert.fail('缺Key不能调用模型'); } } });
  assert.equal((await service.get(input)).cached, true);
  assert.equal((await service.get({ ...input, asOf: '2026-10-12' })).asOf, input.asOf);
  await assert.rejects(service.generate(input), error => error.code === 'DEEPSEEK_MISSING_API_KEY' && error.status === 503);
  assert.equal(calls, 0);
});

test('DeepSeek联网研究仍审核真实来源，无法对应搜索记录的来源被移除并降低证据等级', async t => {
  const directory = await temporaryDirectory(t);
  const client = { research: async () => fixtureResult({ missingBearEvidence: true }) };
  const service = createDeepSeekResearchService({ ...options(directory), client });
  const generated = await service.generate(input);
  assert.deepEqual(generated.sources.map(item => item.id), ['s1']);
  assert.equal(generated.sources[0].citationVerified, true);
  assert.equal(generated.sources[0].readingScope, 'search_snippet');
  assert.deepEqual(generated.debates[0].bear.sourceIds, []);
  assert.equal(generated.debates[0].bear.evidenceStatus, 'insufficient');
  assert.equal(generated.debates[0].status, 'insufficient_evidence');
  assert.ok(generated.limitations.some(text => text.includes('已移除未出现在本次搜索记录中的来源')));
  assert.deepEqual((await service.get(input)).sources, generated.sources);
});
