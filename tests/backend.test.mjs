import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseInput, todayShanghai } from '../backend/src/input.mjs';
import { auditReport } from '../backend/src/source-audit.mjs';
import { createOpenAIClient } from '../backend/src/openai-client.mjs';
import { createFileCache } from '../backend/src/cache.mjs';
import { createDebatesService } from '../backend/src/research-service.mjs';
import { createResearchServer } from '../backend/app.mjs';
import { ResearchError } from '../backend/src/errors.mjs';
const now = () => new Date('2026-10-13T00:00:00Z');
const input = parseInput({ ticker: '002920.SZ', asOf: '2026-10-13' }, now());
const source = (id, author, overrides={}) => ({ id, author, title: `测试来源 ${id}`, url: `https://example.com/${id}`, publishedAt:'2026-10-01', platform:'sell_side', readingScope:'full_text', qualityLabel:'', ...overrides });
const sample = () => ({
  company:{name:'测试公司',ticker:'002920.SZ',identityStatus:'verified',description:'用于自动测试'}, summary:'测试摘要',
  debates:[{id:'d1',title:'测试问题',summary:'测试分歧',status:'documented_disagreement',bull:{summary:'测试正方',evidenceStatus:'source_view',sourceIds:['s1']},bear:{summary:'测试反方',evidenceStatus:'source_view',sourceIds:['s2']},metrics:['测试指标']}],
  sources:[source('s1','机构A'),source('s2','机构B')],coverage:[],limitations:[],
});
const response = (report=sample()) => ({ status:'completed',output:[{type:'web_search_call',status:'completed',action:{type:'search',sources:report.sources.map(source=>({url:source.url}))}},{type:'message',content:[{type:'output_text',text:JSON.stringify(report),annotations:[]}]}] });

test('输入遵循上海时区，90天窗口保留股票市场，拒绝不存在日期及未来日期', () => {
  assert.equal(todayShanghai(new Date('2026-10-12T17:00:00Z')), '2026-10-13');
  assert.equal(input.windowStart, '2026-07-16');
  assert.equal(parseInput({ticker:' 02313.hk '},now()).ticker,'02313.HK');
  assert.throws(()=>parseInput({ticker:'../.env'},now()));
  assert.throws(()=>parseInput({ticker:'002920.SZ',asOf:'2026-02-30'},now()));
  assert.throws(()=>parseInput({ticker:'002920.SZ',asOf:'2026-10-14'},now()));
});
test('真实搜索记录对应的URL才保留，雪球强制标签，未打开页面只能标摘要', () => {
  const report=sample(); report.sources[0]=source('s1','用户A',{url:'https://xueqiu.com/123/456',platform:'sell_side'});
  report.sources.push(source('invented','不存在'));
  const evidence=response(report); evidence.output[0].action.sources.pop();
  const audited=auditReport(report,evidence,input);
  assert.equal(audited.sources.length,2); assert.equal(audited.sources[0].platform,'xueqiu');
  assert.equal(audited.sources[0].qualityLabel,'低质量引用'); assert.equal(audited.sources[0].readingScope,'search_snippet');
  assert.equal(audited.sources[0].citationVerified,true);
  assert.ok(audited.limitations.some(text=>text.includes('已移除')));
});
test('公司事实、未知日期、旧观点和同一机构不能冒充近期独立正反分歧', () => {
  for (const overrides of [{platform:'company'},{publishedAt:null},{publishedAt:'2026-01-01'},{author:'未提供'},{author:'未披露'},{author:'测试公司',platform:'other'}]) {
    const report=sample(); report.sources[1]={...report.sources[1],...overrides};
    const audited=auditReport(report,response(report),input);
    assert.equal(audited.debates[0].bear.evidenceStatus,'model_inference');
    assert.equal(audited.debates[0].status,'research_hypothesis');
  }
  const report=sample(); report.sources[1].author='机构A';
  assert.equal(auditReport(report,response(report),input).debates[0].status,'research_hypothesis');
  report.sources[0].author='中信证券 / 作者A'; report.sources[1].author='中信证券研究所 / 作者B';
  assert.equal(auditReport(report,response(report),input).debates[0].status,'research_hypothesis');
});
test('未来资料与虚构引用被移除，缺少引用的一方标证据不足，证券不一致直接拒绝', () => {
  const report=sample(); report.sources[1].publishedAt='2026-10-14';
  const audited=auditReport(report,response(report),input);
  assert.equal(audited.sources.length,1); assert.equal(audited.debates[0].bear.evidenceStatus,'insufficient');
  assert.equal(audited.debates[0].status,'insufficient_evidence');
  report.company.ticker='02313.HK'; assert.throws(()=>auditReport(report,response(report),input),error=>error.code==='TICKER_MISMATCH');
  const unconfirmed=sample(); unconfirmed.company.identityStatus='uncertain';
  assert.deepEqual(auditReport(unconfirmed,response(unconfirmed),input).debates,[]);
});
test('OpenAI请求开启web_search及strict JSON，禁用存储，拒绝未实际搜索的结果', async () => {
  let payload;
  const client=createOpenAIClient({apiKey:'test-only-key',model:'test-model',fetchImpl:async(url,options)=>{assert.equal(url,'https://api.openai.com/v1/responses'); payload=JSON.parse(options.body);return Response.json(response());}});
  const result=await client.research(input,'研究提示词');
  assert.equal(result.report.company.ticker,input.ticker); assert.equal(payload.store,false);
  assert.equal(payload.tools[0].type,'web_search'); assert.equal(payload.text.format.strict,true);
  assert.deepEqual(payload.include,['web_search_call.action.sources']); assert.equal(payload.instructions,'研究提示词');
  const noSearch=createOpenAIClient({apiKey:'test-only-key',model:'test-model',fetchImpl:async()=>Response.json({status:'completed',output:response().output.slice(1)})});
  await assert.rejects(noSearch.research(input,'prompt'),error=>error.code==='SEARCH_NOT_USED');
  const insufficient=createOpenAIClient({apiKey:'test-only-key',model:'test-model',fetchImpl:async()=>Response.json({error:{code:'insufficient_quota',message:'private upstream message'}},{status:429})});
  await assert.rejects(insufficient.research(input,'prompt'),error=>error.code==='OPENAI_QUOTA_EXCEEDED' && !error.message.includes('private'));
  const quota=createOpenAIClient({apiKey:'test-only-key',model:'test-model',fetchImpl:async()=>new Response('secret upstream body',{status:429})});
  await assert.rejects(quota.research(input,'prompt'),error=>error.code==='OPENAI_RATE_OR_QUOTA' && !error.message.includes('secret'));
});
test('只读缓存不调用模型，同股跨日期并发生成合并一次，日期和版本均读取同份最新报告', async () => {
  const directory=await mkdtemp(path.join(os.tmpdir(),'research-test-'));
  try {
    let calls=0;
    const cache=createFileCache(directory,'test-prompt-version');
    const service=createDebatesService({cache,model:'test-model',prompt:'prompt',promptVersion:'test-version',now,client:{research:async()=>{calls++;return {report:sample(),response:response()};}}});
    assert.equal(await service.get(input),null); assert.equal(calls,0);
    const [a,b]=await Promise.all([service.generate(input),service.generate({...input,asOf:'2026-10-12'})]);
    assert.equal(calls,1);assert.deepEqual(a,b); assert.equal(a.cached,false);
    assert.equal((await service.get(input)).cached,true);
    assert.deepEqual(await service.get({...input,asOf:'2026-10-12'}),{...a,cached:true});
    assert.deepEqual(await createFileCache(directory,'new-version').get(input),{...a,cached:true});
    assert.equal(a.updatedAt,a.generatedAt);assert.equal(a.provider,'openai');
  } finally { await rm(directory,{recursive:true,force:true}); }
});
test('HTTP支持预览CORS、结构化输入错误、POST生成；不会提供.env', async () => {
  const server=createResearchServer({health:{status:'ok'},service:{get:async raw=>{parseInput(raw,now());return null;},generate:async raw=>({ticker:parseInput(raw,now()).ticker})}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const get=await fetch(`${base}/api/debates?ticker=002920.SZ&asOf=2026-10-13`,{headers:{Origin:'http://127.0.0.1:8765'}});
    assert.equal(get.headers.get('Access-Control-Allow-Origin'),'http://127.0.0.1:8765'); assert.deepEqual(await get.json(),{data:null});
    const invalid=await fetch(`${base}/api/debates?ticker=bad%20code`); assert.equal(invalid.status,400);
    const foreign=await fetch(`${base}/api/debates/generate`,{method:'POST',headers:{Origin:'https://example.com','Content-Type':'application/json'},body:JSON.stringify(input)});assert.equal(foreign.status,403);
    const post=await fetch(`${base}/api/debates/generate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}); assert.deepEqual(await post.json(),{data:{ticker:input.ticker}});
    assert.equal((await fetch(`${base}/.env`)).status,404);
    const malformed=await fetch(`${base}/api/debates/generate`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{' }); assert.equal(malformed.status,400);
  } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
});
test('HTTP 错误只返回固定阶段和有界诊断，不泄漏上游内容', async () => {
  const failure = new ResearchError('CHATGPT_CONNECTION_RESET', '连接中断', 502);
  failure.diagnostic = { stage: 'stream', elapsedMs: 42500, curlExitCode: 56, rawBody: 'private-token', stack: 'private-stack', url: 'https://private.example/' };
  const server = createResearchServer({ service: { generate: async () => { throw failure; } }, health: { status: 'ok' } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/debates/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.deepEqual(body.error.diagnostic, { stage: 'stream', elapsedMs: 42500, curlExitCode: 56 });
    assert.doesNotMatch(JSON.stringify(body), /private/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
