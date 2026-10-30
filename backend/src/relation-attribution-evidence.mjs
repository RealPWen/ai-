import { createHash } from 'node:crypto';
import { relationReturnGap, summarizeRelationReturnGaps } from '../../frontend/src/features/relations-return-gap.js';
import { ResearchError } from './errors.mjs';
import { validateShape } from './schema.mjs';
import { canonicalUrl } from './source-audit.mjs';
import { todayShanghai, validDate } from './input.mjs';
export const RELATION_ATTRIBUTION_VERSION='relation-relative-v2-explicit-gap';
export const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const scopes=['all','upstream','peer','downstream'];
const err=(code,message)=>new ResearchError(code,message,409);
export function buildRelationAttributionSnapshot(data,asOf){
 const subject=data?.subject;
 if(!subject?.ticker||!data.relations?.length)throw err('RELATIVE_NO_RELATIONS','请先保存上下游与同行名单。');
 const relations=data.relations.slice(0,10).map(r=>({ticker:r.relatedTicker,name:r.relatedName||r.relatedTicker,type:r.relationType,basis:r.relationshipBasis||r.relationBasis||r.notes||'',market:r.market,
  gaps:Object.fromEntries(['w1','m6'].map(p=>[p,relationReturnGap(subject.market,r.market,p)]))}));
 if(!relations.some(r=>Object.values(r.gaps).some(g=>g.value!==null)))throw err('RELATIVE_NO_COMPARISON','暂无日期一致且可比较的关联公司行情，未调用AI。');
 const groups=Object.fromEntries(scopes.map(key=>{
  const rows=relations.filter(r=>key==='all'||r.type===key);
  return [key,{tickers:rows.map(r=>r.ticker),stats:Object.fromEntries(['w1','m6'].map(p=>[p,summarizeRelationReturnGaps(subject.market,rows,p)]))}];
 }).filter(([,v])=>v.tickers.length));
 const relationHash=hash(relations.map(({ticker,name,type,basis})=>({ticker,name,type,basis})).sort((a,b)=>a.ticker.localeCompare(b.ticker)));
 const quoteDate=subject.market.tradeDate;
 const six=new Date(`${quoteDate}T00:00:00Z`);six.setUTCMonth(six.getUTCMonth()-6);
 const week=new Date(`${quoteDate}T00:00:00Z`);week.setUTCDate(week.getUTCDate()-7);
 const windows={w1:{from:subject.market.returnBaseDates?.w1||week.toISOString().slice(0,10),to:quoteDate},m6:{from:subject.market.returnBaseDates?.m6||six.toISOString().slice(0,10),to:quoteDate}};
 const coverageHash=hash(relations.map(r=>({ticker:r.ticker,w1:r.gaps.w1.value!==null,m6:r.gaps.m6.value!==null})).sort((a,b)=>a.ticker.localeCompare(b.ticker)));
 const basis={version:RELATION_ATTRIBUTION_VERSION,relationHash,subject:{ticker:subject.ticker,name:subject.name,market:subject.market},relations,groups,windows};
 // Do not hash request dates or valuation quote timestamps: only comparison inputs.
 const numeric={subject:{ticker:subject.ticker,tradeDate:quoteDate,returns:Object.fromEntries(['w1','m6'].map(p=>[p,subject.market.returns?.[p]])),baseDates:Object.fromEntries(['w1','m6'].map(p=>[p,subject.market.returnBaseDates?.[p]]))},relations:relations.map(r=>({ticker:r.ticker,type:r.type,gaps:r.gaps,tradeDate:r.market?.tradeDate,baseDates:Object.fromEntries(['w1','m6'].map(p=>[p,r.market?.returnBaseDates?.[p]]))})),relationHash,version:RELATION_ATTRIBUTION_VERSION};
 return {...basis,ticker:subject.ticker,requestedAsOf:asOf,quoteDate,coverageHash,inputHash:hash(numeric)};
}
export function relationSearchPlan(snapshot){
 const companies=[{ticker:snapshot.ticker,name:snapshot.subject.name},...snapshot.relations];
 const query=(c,p,extra='')=>`${c.name} ${c.ticker} 公告 业绩 订单 产品 经营 ${extra} after:${snapshot.windows[p].from} before:${new Date(Date.parse(snapshot.quoteDate)+86400000).toISOString().slice(0,10)}`.slice(0,128);
 const initial=companies.flatMap(c=>['w1','m6'].map(p=>({ticker:c.ticker,period:p,query:query(c,p)})));
 const ranked=[...snapshot.relations].sort((a,b)=>Math.max(...Object.values(b.gaps).map(x=>Math.abs(x.value??0)))-Math.max(...Object.values(a.gaps).map(x=>Math.abs(x.value??0))));
 const selected=ranked.slice(0,2);const reversal=ranked.find(r=>r.gaps.w1.value*r.gaps.m6.value<0&&!selected.includes(r));if(reversal)selected.push(reversal);
 return {initial,supplement:selected.map(c=>({ticker:c.ticker,period:'m6',query:query(c,'m6','增长 毛利率 盈利变化 主要原因')}))};
}
export function relationSearchSources(batches,snapshot){
 const seen=new Map();let failures=0;
 for(const b of batches){if(b.error){failures++;continue;}for(const r of b.results||[]){
  const url=canonicalUrl(r?.url);const stamp=typeof r?.date==='string'?new Date(r.date):null;
  const date=stamp&&Number.isFinite(stamp.getTime())?todayShanghai(stamp):null;
  const body=typeof r.content==='string'?r.content.trim():'';
  const text=body||[r.summary,r.snippet,r.description].find(x=>typeof x==='string'&&x.trim())||'';
  if(!url||!/^https?:/.test(url)||!date||date<snapshot.windows[b.period].from||date>snapshot.quoteDate||text.length<8||typeof r.title!=='string')continue;
  const mentions=[snapshot.subject,...snapshot.relations].filter(c=>(r.title+' '+text).includes(c.name)||(r.title+' '+text).includes(c.ticker)).map(c=>c.ticker);
  const old=seen.get(url);const tickers=[...new Set([...(old?.tickers||[]),b.ticker,...mentions])];const periods=[...new Set([...(old?.periods||[]),b.period])];
  const item={url,title:r.title.slice(0,300),publishedAt:date,content:text.slice(0,1800),readingScope:body?'partial_text':'search_snippet',tickers,periods};
  seen.set(url,old&&old.content.length>item.content.length?{...old,tickers,periods}:item);
 }}
 // Fair allocation by company/window, then fill remaining slots within budget.
 const all=[...seen.values()],chosen=[];const add=s=>{if(!chosen.includes(s)&&chosen.length<36&&JSON.stringify([...chosen,s]).length<65000)chosen.push(s)};
 for(const c of [snapshot.subject,...snapshot.relations])for(const p of ['w1','m6']){let n=0;for(const s of all)if(s.tickers.includes(c.ticker)&&s.periods.includes(p)&&n++<1)add(s);}
 for(const s of all)add(s);
 return {sources:chosen.map((s,i)=>({...s,id:`s${i+1}`})),searchFailureCount:failures};
}
const str={type:'string'},arr={type:'array',items:str};const object=p=>({type:'object',properties:p,required:Object.keys(p),additionalProperties:false});
export const analysisWordCount=text=>(text.match(/\p{Script=Han}|[A-Za-z0-9][A-Za-z0-9_.%+-]*/gu)||[]).length;
export const gapDirection=value=>value===null?'unavailable':Math.abs(value)<0.005?'flat':value>0?'leading':'lagging';
export const relationAttributionSchema=object({analyses:{type:'array',items:object({scope:{type:'string',enum:scopes},weeklyDirection:{type:'string',enum:['leading','lagging','flat','unavailable']},halfYearDirection:{type:'string',enum:['leading','lagging','flat','unavailable']},text:str,comparedTickers:{...arr,minItems:1,maxItems:10},sourceIds:{...arr,maxItems:8},limitations:arr,reasons:{type:'array',maxItems:4,items:object({ticker:str,event:str,impact:str,sourceIds:arr})}})}});
export function auditRelationAttribution(raw,snapshot,sources){
 try{validateShape(raw,relationAttributionSchema)}catch(e){throw err('RELATIVE_INVALID_SHAPE','相对归因返回格式不完整：'+e.message);}
 const allowed=new Map(sources.map(s=>[s.id,s]));const analyses={};
 for(const original of raw.analyses){
  // Parent citations are the validated union, not a second opportunity to invent sources.
  const a={...original,sourceIds:[...new Set([...original.sourceIds,...original.reasons.flatMap(r=>r.sourceIds)])]};
  const group=snapshot.groups[a.scope];
  if(!group||analyses[a.scope])throw err('RELATIVE_INVALID_SHAPE','scope不在groups内或重复。');
  if(!a.text.trim()||!a.comparedTickers.length||a.comparedTickers.length>10||a.sourceIds.length>36||a.reasons.length>12)throw err('RELATIVE_INVALID_SHAPE','正文为空或比较/引用结构超出本次资料范围。');
  // Length is an editorial preference, never a correctness or retry decision.
  a.presentation={readableWords:analysisWordCount(a.text),longerThanPreferred:analysisWordCount(a.text)>400};
  if(a.weeklyDirection!==gapDirection(group.stats.w1.value)||a.halfYearDirection!==gapDirection(group.stats.m6.value))throw err('RELATIVE_INVALID_SHAPE','领先方向错误：group.stats.value是差值，正数为当前标的领先，负数落后；不足0.005视为flat，无值为unavailable。');
  if(a.comparedTickers.some(t=>!group.tickers.includes(t)))throw err('RELATIVE_INVALID_EVIDENCE','comparedTickers包含当前分类以外的公司。');
  if(a.sourceIds.some(id=>!allowed.has(id)))throw err('RELATIVE_INVALID_EVIDENCE','sourceIds包含资料中不存在的ID。');
  if(!/一周|1周|短期/.test(a.text)||!/半年|6个月|六个月|中期/.test(a.text))throw err('RELATIVE_INVALID_SHAPE','分析需要同时融合一周和六个月。');
  if(!a.comparedTickers.some(t=>(a.text.includes(snapshot.relations.find(r=>r.ticker===t).name)||a.text.includes(t))))throw err('RELATIVE_INVALID_SHAPE','分析需点名具体关联公司。');
  for(const id of a.sourceIds)if(!allowed.get(id).tickers.some(t=>t===snapshot.ticker||group.tickers.includes(t)))throw err('RELATIVE_INVALID_EVIDENCE','引用来源超出当前分类。');
  for(const r of a.reasons){
   if(![snapshot.ticker,...group.tickers].includes(r.ticker))throw err('RELATIVE_INVALID_EVIDENCE','reasons.ticker不属于当前标的或当前分类。');
   if(!r.event.trim()||!r.impact.trim()||!r.sourceIds.length)throw err('RELATIVE_INVALID_EVIDENCE','reasons必须包含具体事件、作用路径和来源。');
   if(r.sourceIds.some(id=>!a.sourceIds.includes(id)))throw err('RELATIVE_INVALID_EVIDENCE','reasons.sourceIds必须同时列在该分析的sourceIds内。');
   if(r.sourceIds.some(id=>!allowed.get(id)?.tickers.includes(r.ticker)))throw err('RELATIVE_INVALID_EVIDENCE','原因引用的source.tickers未包含该原因的公司。');
  }
  if(!a.reasons.length&&!a.limitations.length)throw err('RELATIVE_INVALID_EVIDENCE','资料不足时需要说明缺口。');
  analyses[a.scope]=a;
 }
 if(Object.keys(snapshot.groups).some(k=>!analyses[k]))throw err('RELATIVE_INVALID_SHAPE','缺少分类分析；需要 '+Object.keys(snapshot.groups).join(',')+'；实际返回 '+Object.keys(analyses).join(','));
 return {analyses,sources:sources.filter(s=>Object.values(analyses).some(a=>a.sourceIds.includes(s.id))).map(({content,...s})=>s)};
}
