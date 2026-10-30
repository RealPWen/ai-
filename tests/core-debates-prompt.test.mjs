import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDeepSeekClient } from '../backend/src/deepseek-client.mjs';
import { createChatGPTClient } from '../backend/src/chatgpt-client.mjs';
import { createOpenAIClient } from '../backend/src/openai-client.mjs';
import { createDebatesService } from '../backend/src/research-service.mjs';
import { reportSchema } from '../backend/src/schema.mjs';

const prompt = await readFile(new URL('../backend/prompts/core-debates.md', import.meta.url), 'utf8');
const input = { ticker: '002920.SZ', companyName: '合成测试公司' };
const now = () => new Date('2026-10-20T02:00:00Z');
// Synthetic opinions test prompt delivery, citations and persistence. They do
// not claim any real institution holds these views about an actual security.
function fixture() {
  return { company: { ticker: input.ticker, name: input.companyName, identityStatus: 'verified', description: '合成产品业务' },
    summary: '合成测试：产品增长能否抵消竞争压力。',
    debates: [{ id: 'd1', title: '产品增长是否可持续', summary: '两家独立机构对同一问题存在不同判断。', status: 'documented_disagreement',
      bull: { summary: '合成机构甲认为产品增长有韧性。', evidenceStatus: 'source_view', sourceIds: ['s1'] },
      bear: { summary: '合成机构乙认为竞争可能削弱增长。', evidenceStatus: 'source_view', sourceIds: ['s2'] }, metrics: ['产品收入增长与毛利率'] }],
    sources: ['甲', '乙'].map((name, index) => ({ id: `s${index + 1}`, title: `合成机构${name}的研究观点`,
      url: `https://example.com/synthetic-view-${index + 1}`, author: `合成机构${name} / 研究员`, publishedAt: '2026-10-19',
      platform: 'sell_side', readingScope: 'partial_text', qualityLabel: '合成测试材料' })), coverage: [], limitations: [] };
}
function response(report, native = false) {
  return { status: 'completed', model: 'mock-model', output: [
    ...(native ? [{ type: 'web_search_call', status: 'completed', action: { type: 'search', sources: report.sources.map(({ url }) => ({ url })) } }] : []),
    { type: 'message', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(report) }] },
  ] };
}

for (const provider of ['deepseek', 'chatgpt', 'openai']) {
  test(`实际精简提示词经 ${provider} 请求、来源审计和保存读取流程可用`, async () => {
    const report = fixture(), payloads = []; let networkCalls = 0;
    const fetchImpl = async (url, options) => {
      networkCalls++;
      if (url.endsWith('/models')) return Response.json({ models: [{ slug: 'mock-model', display_name: 'Mock', visibility: 'list' }] });
      const body = JSON.parse(options.body);
      if (url.endsWith('/v1/tools/search')) return Response.json({ results: report.sources.map(source => ({
        url: source.url, title: source.title, content: `${source.author}对合成测试公司的产品增长表达研究观点。`,
        date: `${source.publishedAt}T02:00:00Z`,
      })) });
      payloads.push(body);
      if (provider === 'chatgpt') return new Response(`event: response.completed\ndata: ${JSON.stringify({
        type: 'response.completed', response: response(report, true),
      })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
      return Response.json(response(report, provider === 'openai'));
    };
    const client = provider === 'deepseek' ? createDeepSeekClient({ apiKey: 'mock-key', fetchImpl })
      : provider === 'chatgpt' ? createChatGPTClient({ auth: { getAccessToken: async () => 'mock-token' }, model: 'mock-model', fetchImpl })
        : createOpenAIClient({ apiKey: 'mock-key', model: 'mock-model', fetchImpl });
    let saved;
    const service = createDebatesService({ client, prompt, promptVersion: 'test-short-core', model: 'mock-model', provider, now,
      store: { get: async () => saved ?? null, set: async (key, value) => { saved = structuredClone(value); return saved; } } });
    const generated = await service.generate(input);
    assert.equal(payloads.length, 1);
    assert.ok(payloads[0].instructions.startsWith(prompt));
    assert.deepEqual(payloads[0].text.format.schema, reportSchema);
    assert.equal(payloads[0].tool_choice, provider === 'deepseek' ? 'none' : 'required');
    assert.equal(generated.debates[0].status, 'documented_disagreement');
    assert.equal(generated.sources.every(source => source.citationVerified), true);
    assert.equal(generated.coverage.length, 7);
    assert.equal(generated.windowStart, '2026-07-23');
    assert.equal(saved.provider, provider);
    const beforeRead = networkCalls, stored = await service.get(input);
    assert.equal(stored.cached, true); assert.equal(stored.updatedAt, generated.generatedAt);
    assert.equal(networkCalls, beforeRead);
    await service.close();
  });
}
