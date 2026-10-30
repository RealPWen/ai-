import test from 'node:test';
import assert from 'node:assert/strict';
import { auditRelationsAI, relationCandidates, relationsSearchContext } from '../backend/src/relations-ai-evidence.mjs';

// Synthetic materials test the summary contract, not actual corporate ties.
const subject = { ticker: '002920.SZ', name: '德赛西威' };
const peer = { ticker: '002906.SZ', name: '华阳集团' };
const input = { ticker: subject.ticker, companyName: subject.name, asOf: '2026-10-20', candidates: [subject, peer] };
const row = (overrides = {}) => ({ relatedTicker: peer.ticker, relationType: 'peer', evidenceType: 'business_comparable',
  rationale: '双方智能座舱及汽车电子业务可以比较。', actualEntity: peer.name, listedMappingBasis: '上市主体自身', notes: '',
  sources: [{ sourceId: 's1' }, { sourceId: 's2' }], ...overrides });
const material = (content, n, changes = {}) => ({ url: 'https://example.com/synthetic-' + n, title: '合成业务资料',
  content, date: '2026-10-19T02:00:00Z', ...changes });
function audit(rows, materials) {
  const sources = relationsSearchContext([materials], input, '2026-10-20T01:00:00Z').sources;
  return auditRelationsAI({ relations: rows, gaps: [] }, { input, candidates: relationCandidates(input), sources });
}
const materials = () => [material('德赛西威业务包括智能座舱、智能驾驶等汽车电子产品。', 1),
  material('华阳集团提供汽车电子及智能座舱产品。', 2)];

test('允许归纳业务相似性，无须复制原句或让双方名称出现在同一材料', () => {
  const result = audit([row()], materials());
  assert.equal(result.relations.length, 1);
  assert.equal(result.relations[0].rationale, row().rationale);
  assert.equal(result.relations[0].sources.every(source => !Object.hasOwn(source, 'excerpt')), true);
  assert.match(result.relations[0].sources[0].evidenceSummary, /AI 综合/);
});

test('搜索摘要中分散的具体业务依据可以支持同行，明确标注只读摘要', () => {
  const result = audit([row()], materials().map(source => ({ ...source, summary: source.content, content: '' })));
  assert.equal(result.relations.length, 1);
  assert.equal(result.relations[0].sources.every(source => source.readingScope === 'search_snippet'), true);
  assert.match(result.relations[0].notes, /搜索摘要/);
});

test('错误证券或一条形状错误的关系不会令另一个合格结果消失', () => {
  const result = audit([null, row({ relatedTicker: '00000.HK' }), row({ sources: [] }), row()], materials());
  assert.equal(result.relations.length, 1);
  assert.equal(result.relations[0].relatedTicker, peer.ticker);
  assert.equal(result.gaps.filter(gap => gap.startsWith('已排除')).length, 3);
});

test('同一来源正文中业务主体相距很远也可综合判断，不以300字邻近限制丢失', () => {
  const content = '德赛西威智能座舱产品介绍。' + '其他业务背景。'.repeat(100)
    + '华阳集团在相同市场提供智能座舱和汽车电子产品。';
  const result = audit([row({ sources: [{ sourceId: 's1' }] })], [material(content, 1)]);
  assert.equal(result.relations.length, 1);
});

test('明确未核实上市映射只留待核实缺口，不冒充已经证实的关系', () => {
  const result = audit([row({ actualEntity: '华阳业务子公司', listedMappingBasis: '尚未核实该法人对应的上市主体。' })], materials());
  assert.equal(result.relations.length, 0); assert.match(result.gaps.join(' '), /待核实候选/);
});

test('未来材料被过滤后，不把只有单方业务资料的候选编为同行', () => {
  const result = audit([row()], [materials()[0], { ...materials()[1], date: '2026-10-21T02:00:00Z' }]);
  assert.equal(result.relations.length, 0); assert.match(result.gaps.join(' '), /业务或合作依据/);
});
