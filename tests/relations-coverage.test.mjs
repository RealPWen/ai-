import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeepSeekClient, DEFAULT_DEEPSEEK_MODEL } from '../backend/src/deepseek-client.mjs';
import { applyRelationsRetention } from '../backend/src/relations-retention.mjs';
import { relationCandidates, relationsSearchContext, relevantRelationCandidates, relationsSupplementQueries,
  extendRelationsSearchContext, relationsCoverage, relationsCoverageQueries, auditRelationsAI } from '../backend/src/relations-ai-evidence.mjs';

const input = { ticker: '300750.SZ', companyName: '宁德时代', asOf: '2026-10-21', candidates: [
  { ticker: '300750.SZ', name: '宁德时代' }, { ticker: '688388.SH', name: '嘉元科技' },
  { ticker: '002594.SZ', name: '比亚迪' }, { ticker: '01023.HK', name: '时代集团控股' },
  { ticker: '06090.HK', name: '不同集团' }, { ticker: '09636.HK', name: '九方智投控股' },
] };
const candidates = relationCandidates(input);
const source = (n, content, changes = {}) => ({ url: `https://example.com/evidence-${n}`, title: '合成业务资料',
  content, date: '2026-10-20', ...changes });
const material = source(1, '宁德时代主营电池产品，嘉元科技与宁德时代签订电池材料供应协议。比亚迪生产电池产品，与宁德时代有竞争业务。');
const row = (overrides = {}) => ({ relatedTicker: '688388.SH', relationType: 'upstream', evidenceType: 'direct_business',
  rationale: '嘉元科技供应电池材料。', actualEntity: '广东嘉元科技股份有限公司', listedMappingBasis: '上市公司自身',
  notes: '', sources: [{ sourceId: 's1' }], ...overrides });
const peer = row({ relatedTicker: '002594.SZ', relationType: 'peer', evidenceType: 'business_comparable',
  rationale: '双方生产电池产品。', actualEntity: '比亚迪' });
const completed = relations => ({ status: 'completed', model: DEFAULT_DEEPSEEK_MODEL,
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ relations, gaps: [] }) }] }] });

test('满十家但九上游一同行仍补查下游和偏少的同行，不对均衡名单额外检索',()=>{
  const rows=[...Array.from({length:9},()=>({relationType:'upstream'})),{relationType:'peer'}];
  assert.deepEqual(relationsCoverageQueries(rows,input).map(row=>row.relationType),['peer','downstream']);
  assert.equal(relationsCoverage(rows).dominantType,'upstream');
  const balanced=['upstream','upstream','upstream','upstream','peer','peer','peer','downstream','downstream','downstream'];
  assert.deepEqual(relationsCoverageQueries(balanced.map(relationType=>({relationType})),input),[]);
  const missing=relationsCoverageQueries([{relationType:'peer'},{relationType:'downstream'}],input);
  assert.deepEqual(missing.map(row=>row.relationType),['upstream']);
  assert.match(missing[0].query,/before:2026-10-22$/);
});

function fullCoverageFixture({terminal=false, failure=false,existing=false,badChange=false,balancedFirst=false}={}) {
  const names=Array.from({length:12},(_,i)=>({ticker:`${String(100001+i)}.SZ`,name:`业务公司${i+1}`}));
  const params={...input,candidates:[input.candidates[0],...names]};
  const rows=names.slice(0,10).map((company,i)=>row({relatedTicker:company.ticker,actualEntity:company.name,
    relationType:i===9?'peer':'upstream',evidenceType:i===9?'business_comparable':'industry_position',
    rationale:`${company.name}与宁德时代的电池产品业务关联。`}));
  if(existing)params.existingRelations=rows.map((row,i)=>({...row,relatedName:names[i].name,...(badChange&&i<9?{evidenceType:'direct_business'}:{})}));
  const finalRows=[...rows.slice(0,7),rows[9],...names.slice(10).map(company=>row({relatedTicker:company.ticker,
    actualEntity:company.name,relationType:'downstream',evidenceType:'direct_business',
    rationale:`${company.name}向宁德时代采购电池产品。`,sources:[{sourceId:'s2'}]}))];
  let generations=0;const calls=[];
  const client=createDeepSeekClient({apiKey:'synthetic-key',now:()=>new Date('2026-10-21T01:00:00Z'),
    fetchImpl:async(url,options)=>{
      const body=JSON.parse(options.body);calls.push({url,body});
      if(url.endsWith('/v1/tools/search')) {
        if(body.count===3 && failure)return new Response('',{status:503});
        return Response.json({results:[body.count===8
          ? source(1,`${names.slice(0,balancedFirst?12:10).map(row=>row.name).join('、')}均经营电池产品或材料业务，与宁德时代有业务关联。${balancedFirst?'业务公司11、业务公司12向宁德时代采购电池并签订供货订单。':''}`)
          : source(2,`${names.slice(10).map(row=>row.name).join('、')}向宁德时代采购电池，双方签订供货订单。`)]});
      }
      generations++;
      const firstRows=balancedFirst?finalRows.map(row=>({...row,sources:[{sourceId:'s1'}]})):rows;
      const result=completed(generations===1||terminal?firstRows:finalRows);
      if(existing){const raw=JSON.parse(result.output[0].content[0].text);raw.changes=[];result.output[0].content[0].text=JSON.stringify(raw);}
      if(terminal && generations>1)result.output[0].content[0].text=JSON.stringify({relations:rows,gaps:['核查目标主营处于终端，未找到有依据的在市下游企业，不为分类补齐凑数。']});
      return Response.json(result);
    }});
  return {client,params,calls};
}

test('十家已通过也会专项补查并重做完整名单，新增有依据的下游而不超过十家',async()=>{
  const f=fullCoverageFixture();const result=await f.client.researchRelations(f.params,'兼顾上下游和同行，不固定配额。');
  assert.equal(result.relations.length,10);
  assert.deepEqual(relationsCoverage(result.relations).counts,{upstream:7,peer:1,downstream:2});
  assert.equal(result.retrievalEvidence.initialAcceptedCount,10);
  assert.equal(result.retrievalEvidence.coverageRecovery.secondPass,true);
  assert.deepEqual(result.retrievalEvidence.coverageRecovery.categoryChecks,['peer','downstream']);
  assert.equal(f.calls.filter(call=>call.url.endsWith('/responses')).length,2);
  const second=f.calls.filter(call=>call.url.endsWith('/responses'))[1].body;
  assert.match(second.instructions,/可以缺类.*不为均衡硬换/);
});

test('核查后确实无下游允许保留缺类并说明原因，补查失败也保留原十家',async()=>{
  for(const options of [{terminal:true},{failure:true}]) {
    const f=fullCoverageFixture(options);const result=await f.client.researchRelations(f.params,'按实际业务识别。');
    assert.equal(result.relations.length,10);assert.equal(relationsCoverage(result.relations).counts.downstream,0);
    assert.equal(result.retrievalEvidence.coverageRecovery.attempted,true);
    if(options.terminal)assert.match(result.gaps.join(' '),/终端.*不为分类补齐凑数/);
    else assert.equal(result.retrievalEvidence.coverageRecovery.retainedFirstPass,true);
  }
});

test('满额集中旧名单可用更强直接客户依据少量补缺，已有直接业务公司不被挤出',async()=>{
  for(const badChange of [false,true]) {
    const f=fullCoverageFixture({existing:true,badChange});
    const result=await f.client.researchRelations(f.params,'默认保留，替换须有具体事实与来源。');
    assert.equal(f.calls.filter(call=>call.url.endsWith('/responses')).length,2);
    assert.equal(result.retrievalEvidence.coverageRecovery.changeReview?.attempted??false,!badChange);
    assert.equal(result.changes.length,badChange?0:2);
    assert.equal(result.retrievalEvidence.coverageRecovery.changeReview?.approvedCount??0,badChange?0:2);
    if(!badChange)assert.ok(result.changes.every(change=>change.sources.some(source=>source.sourceId==='s2')));
    const saved=applyRelationsRetention({previousRelations:f.params.existingRelations,proposedRelations:result.relations,
      changes:result.changes,candidates:relationCandidates(f.params)});
    assert.equal(saved.relations.length,10);
    assert.equal(relationsCoverage(saved.relations).counts.downstream,badChange?0:2);
    assert.equal(saved.refreshSummary.retainedCount,badChange?10:8);
  }
});

test('提议名单已有三类但旧名单合并后仍集中，也按实际保留结构补查',async()=>{
  const f=fullCoverageFixture({existing:true,balancedFirst:true});
  const result=await f.client.researchRelations(f.params,'兼顾业务环节，保留已有强依据公司。');
  const audit=result.retrievalEvidence.coverageRecovery;
  assert.deepEqual(audit.initialCoverage.counts,{upstream:7,peer:1,downstream:2});
  assert.deepEqual(audit.initialRetainedCoverage.counts,{upstream:9,peer:1,downstream:0});
  assert.deepEqual(audit.categoryChecks,['peer','downstream']);
  assert.equal(audit.secondPass,true);
  assert.deepEqual(audit.finalRetainedCoverage.counts,{upstream:7,peer:1,downstream:2});
});

test('上市公司简称和业务资料足够，不要求法人全称，不把交易待核实当作证券身份不明', () => {
  const sources = relationsSearchContext([[material]], input).sources;
  const shortName = row({ actualEntity: '嘉元科技', evidenceType: 'industry_position', notes: '目前无法核实双方直接交易。' });
  const result = auditRelationsAI({ relations: [shortName], gaps: [] }, { input, candidates, sources });
  assert.equal(result.relations.length, 1); assert.equal(result.relations[0].actualEntity, '嘉元科技');
  const unmapped = row({ actualEntity: '嘉元科技', listedMappingBasis: '无法核实。' });
  assert.equal(auditRelationsAI({ relations: [unmapped], gaps: [] }, { input, candidates, sources }).relations.length, 0);
});

test('补证只查询未通过的在市候选，限8次并保留截止日期', () => {
  const raw = { relations: [row(), peer, row(), row({ relatedTicker: input.ticker }), row({ relatedTicker: '000000.SZ' })] };
  const queries = relationsSupplementQueries(raw, { input, candidates, acceptedRelations: [peer] });
  assert.equal(queries.length, 1); assert.equal(queries[0].ticker, '688388.SH');
  assert.match(queries[0].query, /嘉元科技/); assert.match(queries[0].query, /广东嘉元科技/);
  assert.match(queries[0].query, /before:2026-10-22$/);
  const longInput = { ...input, companyName: '很长的公司名称'.repeat(15) };
  const long = relationsSupplementQueries({ relations: [row({ actualEntity: '长名称'.repeat(100) })] },
    { input: longInput, candidates })[0].query;
  assert.ok(Array.from(long).length <= 128); assert.match(long, /before:2026-10-22$/);
});

test('补证保留已有来源ID和内容，仅追加去重、截止日以内且有文本的来源', () => {
  const initial = relationsSearchContext([[material]], input);
  const result = extendRelationsSearchContext(initial, [[material, source(2, '嘉元科技业务资料。'),
    source(3, '未来业务。', { date: '2026-10-22' }), source(4, '')]], input);
  assert.deepEqual(result.sources[0], initial.sources[0]); assert.equal(result.sources.length, 2);
  assert.equal(result.sources[1].id, 's2'); assert.equal(result.rejectedFutureCount, 1);
  assert.equal(result.rejectedWithoutTextCount, 1);
  const full = relationsSearchContext([Array.from({ length: 24 }, (_, n) => source(n, '业务资料。'))], input);
  const more = extendRelationsSearchContext(full, [Array.from({ length: 24 }, (_, n) => source(n + 100, '业务资料。'))], input);
  assert.equal(more.sources.length, 40); assert.ok(JSON.stringify(more.sources).length < 120000);
});

test('普通词及新闻平台尾缀不会成为候选，完整证券名和代码仍可匹配', () => {
  const noise = [{ title: '宁德时代业务资料_九方智投控股', content: '宁德时代与嘉元科技开展产品供应业务，双方采用不同产品。' }];
  assert.deepEqual(relevantRelationCandidates(candidates, noise, input.ticker), [{ ticker: '688388.SH', name: '嘉元科技' }]);
  assert.deepEqual(relevantRelationCandidates(candidates, [{ title: '时代集团控股公告', content: '公司经营产品业务。' }], input.ticker),
    [{ ticker: '01023.HK', name: '时代集团控股' }]);
  assert.deepEqual(relevantRelationCandidates(candidates, [{ title: '06090.HK 业务介绍', content: '公司经营产品业务。' }], input.ticker),
    [{ ticker: '06090.HK', name: '不同集团' }]);
});

function fixture({ recovery = 'success' } = {}) {
  let inferenceCount = 0; const calls = [];
  const client = createDeepSeekClient({ apiKey: 'synthetic-key', now: () => new Date('2026-10-21T01:00:00Z'),
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body); calls.push({ url, body });
      if (url.endsWith('/v1/tools/search')) {
        if (body.count === 8) return Response.json({ results: [material] });
        if (recovery === 'search-fails') return new Response('', { status: 503 });
        if (recovery === 'duplicate') return Response.json({ results: [material] });
        return Response.json({ results: [source(2,
          '广东嘉元科技股份有限公司（简称嘉元科技，股票代码688388）向宁德时代供应电池材料。')] });
      }
      inferenceCount++;
      if (inferenceCount === 1) return Response.json(completed([peer, row()]));
      if (recovery === 'inference-fails') return new Response('', { status: 503 });
      if (recovery === 'fewer') return Response.json(completed([]));
      return Response.json(completed([peer, row({ sources: [{ sourceId: 's1' }, { sourceId: 's2' }] })]));
    } });
  return { client, calls, count: () => inferenceCount };
}

test('名称补证后重新生成完整关系，保持首轮引用稳定，不绕过证券和来源验证', async () => {
  const f = fixture(); const result = await f.client.researchRelations(input, '根据资料识别上下游。');
  assert.equal(f.count(), 2); assert.equal(result.relations.length, 2);
  assert.equal(result.relations.find(item => item.relatedTicker === '688388.SH').actualEntity, '广东嘉元科技股份有限公司');
  assert.equal(result.retrievalEvidence.initialProposedCount, 2); assert.equal(result.retrievalEvidence.initialAcceptedCount, 1);
  assert.equal(result.retrievalEvidence.finalAcceptedCount, 2);
  assert.equal(result.retrievalEvidence.coverageRecovery.addedSourceCount, 1);
  assert.equal(result.retrievalEvidence.sources[0].id, 's1'); assert.equal(result.retrievalEvidence.sources[1].id, 's2');
  assert.equal(Object.hasOwn(result.retrievalEvidence.sources[1], 'content'), false);
  assert.equal(f.calls.filter(call => call.body.count === 3).length, 3);
});

for (const recovery of ['search-fails', 'duplicate', 'inference-fails', 'fewer']) {
  test(`补证${recovery}保留首轮整份有效结果，不累加或清空`, async () => {
    const f = fixture({ recovery }); const result = await f.client.researchRelations(input, '根据资料识别上下游。');
    assert.deepEqual(result.relations.map(item => item.relatedTicker), ['002594.SZ']);
    assert.equal(result.retrievalEvidence.finalAcceptedCount, 1);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-key/);
  });
}
