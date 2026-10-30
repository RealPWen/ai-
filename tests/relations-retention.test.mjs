import test from 'node:test';
import assert from 'node:assert/strict';
import { auditRelationChanges, applyRelationsRetention, proposeCoverageChanges } from '../backend/src/relations-retention.mjs';

const company = n => ({ ticker: `${String(100000+n)}.SZ`, name: `公司${n}` });
const catalog = new Map(Array.from({length:25},(_,n)=>[company(n).ticker,company(n)]));
const relation = (n, overrides={}) => ({relatedTicker:company(n).ticker,relatedName:company(n).name,
  relationType:'upstream',evidenceType:'industry_position',rank:n+1,rationale:`公司${n}提供电池材料产品。`,
  actualEntity:company(n).name,listedMappingBasis:'上市公司自身',notes:'',verifiedAt:'2026-10-19T01:00:00Z',
  sources:[{url:`https://example.com/old-${n}`,publishedAt:'2026-10-18',title:'原业务资料'}],...overrides});
const input = {ticker:'300750.SZ',companyName:'宁德时代',asOf:'2026-10-21',existingRelations:[relation(0)]};
const source = (content,overrides={})=>({id:'s1',url:'https://example.com/new',title:'合成业务公告',
  publishedAt:'2026-10-20',accessedAt:'2026-10-21T01:00:00Z',readingScope:'partial_text',sourceKind:'page_text',content,...overrides});
const change = (overrides={})=>({oldTicker:company(0).ticker,newTicker:company(10).ticker,
  reasonCode:'stronger_business_relevance',reason:'公司0仅有产业链业务可比依据；公司10已披露向宁德时代供货的订单，业务关联证据更强。',
  sources:[{sourceId:'s1'}],...overrides});
const audit = (changes,materials,overrides={})=>auditRelationChanges(changes,{input,candidates:catalog,
  sources:materials,proposedRelations:[relation(10,{evidenceType:'direct_business'})],...overrides});

test('补缺替换须满额集中、旧弱新强且双方有本次有日期的来源，仍通过原审计',()=>{
  const previous=Array.from({length:10},(_,n)=>relation(n));
  const next=relation(10,{relationType:'downstream',evidenceType:'direct_business',rationale:'公司10向宁德时代采购电池并签订供货订单。',sources:[{sourceId:'s1'}]});
  const sources=[source('公司0主营电池材料产品。公司10向宁德时代采购电池并签订供货订单。')];
  const options={previousRelations:previous,proposedRelations:[next],sources,asOf:input.asOf};
  const changes=proposeCoverageChanges(options);
  assert.equal(changes.length,1);
  assert.equal(auditRelationChanges(changes,{input:{...input,existingRelations:previous},candidates:catalog,sources,proposedRelations:[next]}).changes.length,1);
  for(const patch of [
    {previousRelations:previous.slice(0,9)},
    {previousRelations:previous.map(row=>({...row,evidenceType:'direct_business'}))},
    {previousRelations:previous.map(row=>({...row,origin:'manual'}))},
    {sources:[{...sources[0],publishedAt:null}]},
    {sources:[{...sources[0],publishedAt:'2026-10-22'}]},
    {sources:[source('公司10向宁德时代采购电池并签订供货订单。')]},
    {proposedRelations:[{...next,evidenceType:'industry_position'}]},
    {previousRelations:previous.map((row,i)=>({...row,relationType:i<4?'upstream':i<7?'peer':'downstream'}))},
  ])assert.deepEqual(proposeCoverageChanges({...options,...patch}),[]);
});

test('十家已有公司不会因模型整份换成另十家而被替换，旧次序及来源日期保留',()=>{
  const previous=Array.from({length:10},(_,n)=>relation(n));
  const result=applyRelationsRetention({previousRelations:previous,proposedRelations:Array.from({length:10},(_,n)=>relation(n+10)),candidates:catalog});
  assert.deepEqual(result.relations,previous);assert.equal(result.refreshSummary.retainedCount,10);
  assert.equal(result.refreshSummary.addedCount,0);assert.equal(result.refreshSummary.blockedCount,10);
});

test('不足十家时保留省略的旧项，仅在空位补充新项，不跨版本累积超过十家',()=>{
  const previous=[relation(0),relation(1),relation(2)];
  const result=applyRelationsRetention({previousRelations:previous,proposedRelations:Array.from({length:10},(_,n)=>relation(n+10)),candidates:catalog});
  assert.equal(result.relations.length,10);assert.deepEqual(result.relations.slice(0,3),previous);
  assert.equal(result.refreshSummary.retainedCount,3);assert.equal(result.refreshSummary.addedCount,7);
});

test('同一公司的新资料可以更新，较弱证据不能覆盖已有直接披露',()=>{
  const old=relation(0,{evidenceType:'direct_business'}),weak=relation(0,{rationale:'新的但较弱资料。'});
  const kept=applyRelationsRetention({previousRelations:[old],proposedRelations:[weak],candidates:catalog});
  assert.equal(kept.relations[0].rationale,old.rationale);
  const fresh={...old,rationale:'新的直接供货订单。',verifiedAt:'2026-10-21T01:00:00Z'};
  const updated=applyRelationsRetention({previousRelations:[old],proposedRelations:[fresh],candidates:catalog});
  assert.equal(updated.relations[0].rationale,fresh.rationale);assert.equal(updated.refreshSummary.retainedCount,1);
});

test('具体业务比较、有日期的双方资料和更强直接业务证据才批准替换，并保存理由',()=>{
  const checked=audit([change()],[source('公司0提供电池材料，未披露直接交易。公司10与宁德时代签署供货订单。')]);
  assert.equal(checked.changes.length,1);assert.equal(checked.changes[0].sources[0].sourceId,'s1');
  const previous=Array.from({length:10},(_,n)=>relation(n));
  const result=applyRelationsRetention({previousRelations:previous,proposedRelations:[relation(10,{evidenceType:'direct_business'})],
    changes:checked.changes,candidates:catalog});
  assert.equal(result.relations.length,10);assert.equal(result.relations[0].relatedTicker,company(10).ticker);
  assert.equal(result.refreshSummary.retainedCount,9);assert.equal(result.refreshSummary.removedCount,1);
  assert.equal(result.refreshSummary.changes[0].reason,change().reason);
});

test('泛泛相关性、缺少本次来源、未知日期和未来材料均不足以换股',()=>{
  const good=source('公司0提供材料。公司10向宁德时代供货并取得订单。');
  for(const [decision,materials] of [
    [change({reason:'公司0和公司10相比，公司10更相关。'}),[good]],
    [change({sources:[{sourceId:'old-source'}]}),[good]],
    [change(),[{...good,publishedAt:null}]],
    [change(),[{...good,publishedAt:'2026-10-22'}]],
  ]){const result=audit([decision],materials);assert.equal(result.changes.length,0);assert.equal(result.rejectedChanges.length,1);}
});

test('未终止合作和无关业务出售公告不能误当移除理由',()=>{
  const ended=change({newTicker:null,reasonCode:'relationship_ended',reason:'公司0已与宁德时代终止供货协议。'});
  assert.equal(audit([ended],[source('公司0与宁德时代未终止合作，供货协议继续执行。')]).changes.length,0);
  assert.equal(audit([ended],[source('公司0与宁德时代合作继续。宁德时代终止与其他公司供货协议。')]).changes.length,0);
  assert.equal(audit([ended],[source('公司0与宁德时代解除供货合同并停止合作。')]).changes.length,1);
  const changed=change({newTicker:null,reasonCode:'business_changed',reason:'公司0已退出电池材料业务。'});
  assert.equal(audit([changed],[source('宁德时代出售无关办公楼资产。')]).changes.length,0);
});

test('人工指定公司不可由AI替换，人工占位不被新增AI挤占',()=>{
  const checked=audit([change()],[source('公司0与宁德时代终止合作。')],{input:{...input,existingRelations:[relation(0,{origin:'manual',evidenceType:'manual'})]}});
  assert.equal(checked.changes.length,0);assert.match(checked.rejectedChanges[0].reason,/人工/);
  const decision={...change(),oldName:'公司0',newName:'公司10',sources:[]};
  const result=applyRelationsRetention({previousRelations:[relation(0)],proposedRelations:Array.from({length:10},(_,n)=>relation(n+10)),
    changes:[decision],candidates:catalog,protectedTickers:[company(0).ticker],reservedManualCount:2,excludedNewTickers:[company(11).ticker]});
  assert.equal(result.relations[0].relatedTicker,company(0).ticker);assert.equal(result.relations.length,8);
  assert.equal(result.relations.some(row=>row.relatedTicker===company(11).ticker),false);
});

test('证券目录确认为非在市才自动移除，并记录目录依据',()=>{
  const current=new Map(catalog);current.delete(company(0).ticker);
  const result=applyRelationsRetention({previousRelations:[relation(0),relation(1)],proposedRelations:[],candidates:current});
  assert.equal(result.relations.length,1);assert.equal(result.refreshSummary.changes[0].reasonCode,'not_listed');
});
