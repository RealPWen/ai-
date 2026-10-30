import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDeepSeekClient, DEFAULT_DEEPSEEK_MODEL } from '../backend/src/deepseek-client.mjs';
import { relationsAISchema } from '../backend/src/relations-ai-evidence.mjs';
import { relationChangesSchema } from '../backend/src/relations-retention.mjs';

const input = { ticker: '00700.HK', companyName: '腾讯控股', asOf: '2026-10-21', candidates: [
  { ticker: '00700.HK', name: '腾讯控股' }, { ticker: '002415.SZ', name: '海康威视' }, { ticker: '09988.HK', name: '阿里巴巴-W' },
] };
const row = (overrides = {}) => ({ relatedTicker: '002415.SZ', relationType: 'upstream', evidenceType: 'technical_cooperation',
  rationale: '公司与海康威视开展云平台技术合作。', actualEntity: '海康威视', listedMappingBasis: '上市主体自身', notes: '',
  sources: [{ sourceId: 's1' }], ...overrides });
const oldRelation = { ...row(), relatedName: '海康威视',
  sources: [{ title: '已保存合作资料', url: 'https://example.com/old-cooperation', publishedAt: '2025-01-01',
    evidenceSummary: '已保存的业务依据', extra: '不会重新当作本次来源' }] };
const material = { url: 'https://example.com/cooperation', title: '腾讯控股业务公告', date: '2026-10-20',
  content: '腾讯控股与海康威视开展云平台技术合作。阿里巴巴-W经营云平台和软件服务业务。' };
const completed = value => ({ status: 'completed', model: DEFAULT_DEEPSEEK_MODEL,
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
const prompt = await readFile(new URL('../backend/prompts/relations-ai.md', import.meta.url), 'utf8');
const readInput = body => JSON.parse(body.input[0].content.split('\n').slice(1).join('\n'));
function fixture(responses, { initial = material, supplement = material } = {}) {
  const calls = []; let count = 0;
  const client = createDeepSeekClient({ apiKey: 'test-retention-key', now: () => new Date('2026-10-21T01:00:00Z'),
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body); calls.push({ url, body });
      if (url.endsWith('/v1/tools/search')) return Response.json({ results: [body.count === 3 ? supplement : initial] });
      return Response.json(completed(responses[count++]));
    } });
  return { client, calls };
}

test('首次识别仍使用原schema，不要求不存在的旧关系变更', async () => {
  const f = fixture([{ relations: [row()], gaps: [] }]);
  const report = await f.client.researchRelations(input, prompt);
  const body = f.calls.find(call => call.url.endsWith('/responses')).body;
  assert.deepEqual(body.text.format.schema, relationsAISchema);
  assert.equal(Object.hasOwn(readInput(body), 'existingRelations'), false);
  assert.deepEqual(report.changes, []); assert.deepEqual(report.changeGaps, []);
});

test('重识别传入旧名单及来源元信息，优先提示已有公司且仅追加变更schema', async () => {
  const f = fixture([{ relations: [row({ relatedTicker: '09988.HK', relationType: 'peer', evidenceType: 'business_comparable',
    actualEntity: '阿里巴巴-W', rationale: '云平台和软件业务可比。' })], gaps: [], changes: [] }]);
  const params = { ...input, existingRelations: [oldRelation] };
  const report = await f.client.researchRelations(params, prompt);
  const body = f.calls.find(call => call.url.endsWith('/responses')).body, data = readInput(body);
  assert.deepEqual(body.text.format.schema.properties.changes, relationChangesSchema);
  assert.deepEqual(body.text.format.schema.required, [...relationsAISchema.required, 'changes']);
  assert.equal(Object.hasOwn(relationsAISchema.properties, 'changes'), false);
  assert.deepEqual(data.existingRelations, [{ relatedTicker: oldRelation.relatedTicker, relatedName: oldRelation.relatedName,
    relationType: oldRelation.relationType, evidenceType: oldRelation.evidenceType, rationale: oldRelation.rationale,
    sources: [{ title: '已保存合作资料', url: 'https://example.com/old-cooperation', publishedAt: '2025-01-01' }] }]);
  assert.deepEqual(data.candidateHints[0], { ticker: '002415.SZ', name: '海康威视' });
  assert.match(body.instructions, /默认保留并复核已有公司/); assert.match(body.instructions, /未检索到不等于关系消失/);
  assert.match(body.instructions, /人工修改由后端保护/);
  assert.deepEqual(report.changes, []); assert.deepEqual(report.changeGaps, []);
  assert.doesNotMatch(JSON.stringify(report), /test-retention-key/);
});

test('变更理由引用不存在的来源时返回独立changeGaps，不借已存来源绕过本次审计', async () => {
  const f = fixture([{ relations: [row({ relatedTicker: '09988.HK', relationType: 'peer', evidenceType: 'business_comparable',
    actualEntity: '阿里巴巴-W', rationale: '云平台和软件业务可比。' })], gaps: [], changes: [{
      oldTicker: '002415.SZ', newTicker: '09988.HK', reasonCode: 'relationship_ended',
      reason: '已公告终止旧技术合作。', sources: [{ sourceId: 'old-cooperation' }],
    }] }]);
  const report = await f.client.researchRelations({ ...input, existingRelations: [oldRelation] }, prompt);
  assert.equal(report.relations.length, 1); assert.deepEqual(report.changes, []);
  assert.ok(report.changeGaps.length > 0); assert.ok(report.changeGaps.every(gap => typeof gap === 'string' && gap));
});

test('有日期的具体终止合作公告支持删除旧公司，输出已绑定的调整依据', async () => {
  const reason = '腾讯控股已公告与海康威视终止云平台技术合作。';
  const f = fixture([{ relations: [row({ relatedTicker: '09988.HK', relationType: 'peer', evidenceType: 'business_comparable',
    actualEntity: '阿里巴巴-W', rationale: '云平台和软件业务可比。' })], gaps: [], changes: [{
      oldTicker: '002415.SZ', newTicker: null, reasonCode: 'relationship_ended', reason, sources: [{ sourceId: 's1' }],
    }] }], { initial: { ...material, content: reason + '阿里巴巴-W经营云平台和软件服务业务。' } });
  const report = await f.client.researchRelations({ ...input, existingRelations: [oldRelation] }, prompt);
  assert.equal(report.changes.length, 1); assert.deepEqual(report.changeGaps, []);
  const change = report.changes[0];
  assert.equal(change.oldTicker, oldRelation.relatedTicker); assert.equal(change.oldName, oldRelation.relatedName);
  assert.equal(change.newTicker, null); assert.equal(change.reasonCode, 'relationship_ended');
  assert.equal(change.sources[0].url, material.url); assert.equal(change.sources[0].publishedAt, '2026-10-20');
  assert.equal(change.sources[0].sourceId, 's1'); assert.equal(change.sources[0].evidenceSummary, reason);
});

test('补证重做继续传旧名单，拒绝用有无效更换理由的较多关系覆盖可信首轮', async () => {
  const first = { relations: [row(), row({ relatedTicker: '09988.HK', relationType: 'peer', evidenceType: 'business_comparable',
    actualEntity: '未能核实的阿里业务实体', rationale: '云平台和软件业务可比。' })], gaps: [], changes: [] };
  const second = { relations: [row(), row({ relatedTicker: '09988.HK', relationType: 'peer', evidenceType: 'business_comparable',
    actualEntity: '阿里巴巴-W', rationale: '云平台和软件业务可比。', sources: [{ sourceId: 's2' }] })], gaps: [], changes: [{
      oldTicker: '002415.SZ', newTicker: '09988.HK', reasonCode: 'business_changed',
      reason: '旧公司的主营已经变化。', sources: [{ sourceId: 'invented' }],
    }] };
  const f = fixture([first, second], { supplement: { ...material, url: 'https://example.com/supplement', title: '阿里巴巴-W业务介绍' } });
  const report = await f.client.researchRelations({ ...input, existingRelations: [oldRelation] }, prompt);
  const analyses = f.calls.filter(call => call.url.endsWith('/responses'));
  assert.equal(analyses.length, 2);
  for (const { body } of analyses) {
    assert.deepEqual(readInput(body).existingRelations.map(row => row.relatedTicker), ['002415.SZ']);
    assert.ok(body.text.format.schema.required.includes('changes'));
  }
  assert.deepEqual(report.relations.map(row => row.relatedTicker), ['002415.SZ']);
  assert.equal(report.retrievalEvidence.coverageRecovery.secondAcceptedCount, 2);
  assert.equal(report.retrievalEvidence.coverageRecovery.retainedFirstPass, true);
  assert.deepEqual(report.changes, []); assert.deepEqual(report.changeGaps, []);
});
