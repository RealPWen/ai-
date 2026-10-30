import test from 'node:test';
import assert from 'node:assert/strict';
import { createImaRetriever } from '../backend/src/ima-retriever.mjs';
import { IMA_LIBRARY, makeImaSource, auditImaReference } from '../backend/src/ima-evidence.mjs';
import { createDeepSeekClient } from '../backend/src/deepseek-client.mjs';
import { createDebatesService } from '../backend/src/research-service.mjs';
import { validateStoredDebateReport } from '../backend/src/debate-store.mjs';
import { auditReport } from '../backend/src/source-audit.mjs';
import { parseInput } from '../backend/src/input.mjs';

const now = () => new Date('2026-10-22T03:00:00Z');
const input = parseInput({ ticker: '002920.SZ', companyName: '测试公司' }, now());
const item = { media_id: 'pdf_test', title: '高盛-测试公司（002920.SZ）增长与风险-261013.pdf' };
const pages = [{ page: 1, method: 'ocr', text: `13 October 2026\n${'合成测试材料：增长有望恢复，但价格竞争与海外拓展成本仍需跟踪。'.repeat(20)}` }];
const source = () => makeImaSource(item, pages, { retrievedAt: now().toISOString() });
const reference = () => ({ views: [{ topic: '增长与竞争', view: '增长机会存在但竞争需核验', kind: 'model_inference', sourceIds: ['ima1'], supportingEvidence: '已有合成研报段落支持', counterQuestion: '竞争是否加剧？' }], searchTopics: ['产品增长', '价格竞争'], limitations: ['合成测试'] });
const completed = data => Response.json({ status: 'completed', model: 'test-model', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(data) }] }] });
const web = { id: 's1', title: '公开测试观点', url: 'https://example.com/research', author: '另一机构', publishedAt: '2026-10-20', platform: 'sell_side', readingScope: 'partial_text', qualityLabel: '' };
function report(ima = true) {
  return { company: { name: input.companyName, ticker: input.ticker, identityStatus: 'verified', description: '测试业务' }, summary: '依据研报和联网资料分析',
    debates: [{ id: 'growth', title: '增长与竞争', summary: '可观察的业务分歧', status: 'research_hypothesis',
      bull: { summary: '模型推断：增长可能恢复。', evidenceStatus: 'model_inference', sourceIds: [ima ? 'ima1' : 's1'] },
      bear: { summary: '另一机构关注价格竞争。', evidenceStatus: 'source_view', sourceIds: ['s1'] }, metrics: ['收入增长'] }],
    sources: [...(ima ? [{ id: 'ima1', title: '模型不能改写的标题', url: source().url, author: '伪造作者', publishedAt: '2026-10-01', platform: 'other', readingScope: 'full_text', qualityLabel: '' }] : []), web],
    coverage: [], limitations: [] };
}

test('ima原文→参考观点→定向联网/反证→最终生成→来源校验→保存读取完整顺序', async () => {
  const events = [], queries = []; let stored, finalPayload;
  const client = createDeepSeekClient({ apiKey: 'fake', now, imaRetriever: { retrieve: async () => {
    events.push('ima'); return { sources: [source()], status: 'used', message: '已读取 ima 部分正文', libraryName: IMA_LIBRARY.name, checkedAt: now().toISOString() };
  } }, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/v1/tools/search')) {
      assert.equal(events.includes('reference'), true); events.push('search'); queries.push(body.query);
      return Response.json({ results: [{ ...web, date: `${web.publishedAt}T00:00:00Z`, content: '真实检索接口返回的合成测试正文' }] });
    }
    if (body.text.format.name === 'ima_reference_views') {
      assert.deepEqual(events, ['ima']); events.push('reference'); assert.match(body.input[0].content, /合成测试材料/); return completed(reference());
    }
    assert.equal(events.filter(x => x === 'search').length, 3); events.push('final'); finalPayload = body; return completed(report());
  } });
  const service = createDebatesService({ client, provider: 'deepseek', model: 'test-model', prompt: 'prompt', promptVersion: 'ima-test', now,
    store: { get: async () => stored, set: async (key, value) => { stored = validateStoredDebateReport(key, value, { now }); return stored; } } });
  const result = await service.generate(input);
  assert.deepEqual(events, ['ima','reference','search','search','search','final']);
  assert.match(queries[1], /产品增长/); assert.match(queries[2], /价格竞争.*反证/);
  assert.match(finalPayload.input[0].content, /imaReference/); assert.match(finalPayload.input[0].content, /合成测试材料/);
  const saved = result.sources[0];
  assert.equal(saved.sourceKind, 'ima'); assert.equal(saved.title, item.title); assert.equal(saved.author, '高盛');
  assert.equal(saved.publishedAt, '2026-10-13'); assert.equal(saved.readingScope, 'partial_text'); assert.deepEqual(saved.excerpts, source().excerpts);
  assert.equal(result.pipeline.ima.citedCount, 1); assert.equal(result.pipeline.modelCalls, 2);
  assert.ok(result.coverage.some(c => c.platform === 'ima'));
  assert.deepEqual((await service.get(input)).sources, result.sources); assert.equal(events.length, 6);
});

test('ima额度不足跳过参考观点模型调用，仍执行联网并明确记录未使用ima', async () => {
  let modelCalls = 0;
  const client = createDeepSeekClient({ apiKey: 'fake', imaRetriever: { retrieve: async () => ({ status: 'quota', message: '额度不足，本次未使用 ima', sources: [] }) },
    fetchImpl: async (url, options) => {
      if (url.endsWith('/v1/tools/search')) return Response.json({ results: [{ ...web, date: `${web.publishedAt}T00:00:00Z`, content: '测试正文' }] });
      modelCalls++; assert.equal(JSON.parse(options.body).text.format.name, 'core_market_debates'); return completed(report(false));
    } });
  const result = await client.research(input, 'prompt');
  assert.equal(modelCalls, 1); assert.equal(result.pipeline.ima.status, 'quota'); assert.equal(result.pipeline.ima.referenceGenerated, false);
  assert.equal(result.retrievalEvidence.sources.some(s => s.sourceKind === 'ima'), false);
});

test('无效参考观点引用中止，不进入搜索与最终付费生成', async () => {
  let calls = 0;
  const client = createDeepSeekClient({ apiKey: 'fake', imaRetriever: { retrieve: async () => ({ sources: [source()] }) }, fetchImpl: async () => {
    calls++; const ref = reference(); ref.views[0].sourceIds = ['invented']; return completed(ref);
  } });
  await assert.rejects(client.research(input, 'prompt'), { code: 'IMA_REFERENCE_INVALID' }); assert.equal(calls, 1);
  assert.throws(() => auditImaReference(reference(), []));
});

test('ima引用必须对应可信正文与原始编号，模型不能创建ima引用或补造未知发布日期', () => {
  const raw = report(), s = source(); s.publishedAt = null;
  const evidence = { origin: 'ima-deepseek', sources: [s, web] };
  const audited = auditReport(raw, {}, input, evidence);
  assert.equal(audited.sources[0].publishedAt, null);
  const changed = report(); changed.sources[0].id = 'invented';
  assert.equal(auditReport(changed, {}, input, evidence).sources.some(s => s.sourceKind === 'ima'), false);
  assert.equal(auditReport(raw, {}, input, { origin: 'deepseek-search', sources: [s, web] }).sources.some(s => s.sourceKind === 'ima'), false);
  assert.equal(auditReport(raw, {}, input, { origin: 'ima-deepseek', sources: [{ ...s, content: '' }, web] }).sources.some(s => s.sourceKind === 'ima'), false);
  const unknown = makeImaSource(item, [{ page: 1, text: '没有日期的正文'.repeat(100) }]); assert.equal(unknown.publishedAt, null);
});

test('实时检索按日期筛选、仅读命中PDF，主密钥不发送COS，不持久化临时URL，缓存不重读', async () => {
  const calls = []; let extracted = 0;
  const retriever = await createImaRetriever({ credentials: { clientId: 'fake-id', apiKey: 'fake-key' }, now, intervalMs: 0,
    extractPdf: async bytes => { extracted++; assert.equal(bytes.toString(), '%PDF-test'); return pages; },
    fetchImpl: async (url, options) => {
      url = String(url); calls.push(url);
      if (url.includes('search_knowledge')) return Response.json({ code: 0, data: { info_list: [item, { ...item, media_id: 'future', title: '高盛-测试公司-261023.pdf' }, { media_id: 'irrelevant', title: '不相关公司.pdf' }] } });
      if (url.includes('get_media_info')) { assert.equal(JSON.parse(options.body).media_id, item.media_id); return Response.json({ code: 0, data: { media_type: 1, url_info: { url: 'https://example.myqcloud.com/doc?token=temporary-secret', headers: { 'x-cos-token': 'scoped' } } } }); }
      assert.equal(options.headers.has('ima-openapi-apikey'), false); assert.equal(options.headers.get('x-cos-token'), 'scoped'); assert.equal(options.redirect, 'error');
      return new Response('%PDF-test');
    } });
  const result = await retriever.retrieve(input);
  assert.equal(result.sources.length, 1); assert.equal(extracted, 1); assert.equal(calls.length, 4);
  assert.doesNotMatch(JSON.stringify(result), /fake-key|temporary-secret|x-cos-token/);
  assert.equal((await retriever.retrieve(input)).cacheHit, true); assert.equal(calls.length, 4);
});

test('额度业务码停止所有后续读取，下一请求不反复消耗；不回显上游凭证文本', async () => {
  let calls = 0;
  const retriever = await createImaRetriever({ credentials: { clientId: 'id', apiKey: 'secret' }, intervalMs: 0, now,
    fetchImpl: async () => { calls++; return Response.json({ code: 220021, msg: 'secret private error' }); } });
  assert.equal((await retriever.retrieve(input)).status, 'quota');
  const second = await retriever.retrieve({ ...input, ticker: '600519.SH' });
  assert.equal(second.status, 'quota'); assert.equal(calls, 1); assert.doesNotMatch(JSON.stringify(second), /secret|private/);
});

test('拒绝任意地址/主密钥媒体头和伪PDF，不向这些地址请求或将其当正文', async () => {
  for (const data of [
    { media_type: 1, url_info: { url: 'http://127.0.0.1/private' } },
    { media_type: 1, url_info: { url: 'https://example.myqcloud.com/doc', headers: { 'ima-openapi-apikey': 'secret' } } },
  ]) {
    let mediaFetches = 0;
    const retriever = await createImaRetriever({ credentials: { clientId: 'id', apiKey: 'key' }, intervalMs: 0, now,
      fetchImpl: async url => {
        if (String(url).includes('search_knowledge')) return Response.json({ code: 0, data: { info_list: [item] } });
        if (String(url).includes('get_media_info')) return Response.json({ code: 0, data });
        mediaFetches++; throw new Error('must not fetch');
      } });
    assert.equal((await retriever.retrieve(input)).sources.length, 0); assert.equal(mediaFetches, 0);
  }
});
