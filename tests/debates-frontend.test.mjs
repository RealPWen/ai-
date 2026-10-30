import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient } from '../frontend/src/api/client.js';
import { createResearchService } from '../frontend/src/services/research-service.js';
import { endpoints } from '../frontend/src/api/endpoints.js';
import { adapters } from '../frontend/src/services/adapters.js';
import { researchToday, validResearchDate } from '../frontend/src/features/research-date.js';

const config = { enabled: true, baseUrl: 'http://127.0.0.1:8000', timeoutMs: 500, generationTimeoutMs: 180000 };
const example = () => ({
  ticker: '002920.SZ', asOf: '2026-10-13', windowStart: '2026-07-15', company: { name: '德赛西威', ticker: '002920.SZ', identityStatus: 'verified' },
  summary: '可用证据有限。', debates: [{ id: 'growth', title: '利润率能否保持？', status: 'research_hypothesis', bull: { summary: '乐观观点', evidenceStatus: 'source_view', sourceIds: ['s1'] }, bear: { summary: '反方证据不足', evidenceStatus: 'insufficient', sourceIds: [] }, metrics: ['利润率'] }],
  sources: [{ id: 's1', title: '观点', url: 'https://xueqiu.com/example', author: '作者', publishedAt: null, platform: 'xueqiu', qualityLabel: '', readingScope: 'search_snippet', citationVerified: true }],
  coverage: [{ platform: 'alpha', status: 'needs_import', note: '需上传授权材料。' }], limitations: ['仅取得搜索摘要。'],
});

test('读取单股分歧仅使用 GET 与证券代码，不随数据截止日变化或调用付费生成', async () => {
  const calls = [];
  const client = createApiClient(config, async (url, options) => { calls.push({ url: new URL(url), options }); return Response.json({ data: null }); });
  const service = createResearchService({ config, routes: endpoints, client, mappers: adapters });
  const result = await service.load('debates', { ticker: '02313.HK', asOf: '2026-10-13' });
  assert.equal(result.status, 'empty'); assert.equal(result.data, null);
  assert.equal(calls.length, 1); assert.equal(calls[0].url.pathname, '/api/debates');
  assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].url.searchParams.get('ticker'), '02313.HK'); assert.equal(calls[0].url.searchParams.has('asOf'), false);
  await service.load('debates', { ticker: '02313.HK', asOf: '2024-01-01', model: 'other-model' });
  assert.equal(calls[1].url.search, calls[0].url.search);
});

test('手动生成单独 POST JSON，长超时和取消信号交给 API 层', async () => {
  const observed = []; const controller = new AbortController();
  const client = { post: async (path, options) => { observed.push({ path, options }); return { data: example() }; }, get: async () => { throw new Error('不能在生成时 GET'); } };
  const service = createResearchService({ config, routes: endpoints, client, mappers: adapters });
  const result = await service.generateDebates({ ticker: '002920.SZ', asOf: '2026-10-13', companyName: '德赛西威' }, { signal: controller.signal });
  assert.equal(result.status, 'ready'); assert.equal(observed.length, 1);
  assert.equal(observed[0].path, '/api/debates/generate'); assert.equal(observed[0].options.timeoutMs, 180000); assert.equal(observed[0].options.signal, controller.signal);
  assert.deepEqual(observed[0].options.body, { ticker: '002920.SZ', companyName: '德赛西威' });
});

test('POST 使用 JSON body，后端错误消息和错误码原样保留为文本', async () => {
  let observed;
  const client = createApiClient(config, async (_url, options) => { observed = options; return Response.json({ error: { code: 'OPENAI_QUOTA', message: '账户额度不足' } }, { status: 502 }); });
  await assert.rejects(client.post('/api/debates/generate', { body: { ticker: 'AAPL', asOf: '2026-10-13' } }), error => error.code === 'OPENAI_QUOTA' && error.message === '账户额度不足' && error.status === 502);
  assert.equal(observed.method, 'POST'); assert.equal(observed.headers['Content-Type'], 'application/json'); assert.deepEqual(JSON.parse(observed.body), { ticker: 'AAPL', asOf: '2026-10-13' });
});

test('正反方证据状态保留，雪球强制低质量标记，不把没有分歧的报告伪装成失败', () => {
  const report = adapters.debates({ data: example() });
  assert.equal(report.sources[0].qualityLabel, '低质量引用'); assert.equal(report.sources[0].publishedAt, null);
  assert.equal(report.debates[0].bear.evidenceStatus, 'insufficient'); assert.deepEqual(report.debates[0].bear.sourceIds, []);
  const empty = example(); empty.debates = []; empty.sources = [];
  assert.deepEqual(adapters.debates({ data: empty }).debates, []);
  assert.equal(adapters.debates({ data: null }), null);
});

test('未知来源编号、重复来源、旧式观点列表不能被当成有效联网报告', () => {
  const unknown = example(); unknown.debates[0].bull.sourceIds = ['invented']; assert.throws(() => adapters.debates(unknown), /不存在/);
  const repeated = example(); repeated.sources.push({ ...repeated.sources[0] }); assert.throws(() => adapters.debates(repeated), /重复/);
  assert.throws(() => adapters.debates([{ title: '旧观点' }]));
});

test('研究日期使用上海时区，拒绝不存在的日历日期和未来日期', () => {
  assert.equal(researchToday(new Date('2026-10-12T17:00:00Z')), '2026-10-13');
  assert.equal(validResearchDate('2026-02-30', '2026-10-13'), false);
  assert.equal(validResearchDate('2026-10-14', '2026-10-13'), false);
  assert.equal(validResearchDate('2026-10-13', '2026-10-13'), true);
});
