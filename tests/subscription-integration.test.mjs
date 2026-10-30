import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createResearchServer } from '../backend/app.mjs';
import { ResearchError } from '../backend/src/errors.mjs';
import { createSubscriptionResearchService } from '../backend/src/subscription-service.mjs';
const input={ticker:'002920.SZ',asOf:'2026-10-13'};
const now=()=>new Date('2026-10-13T00:00:00Z');
function fixtureResult(){
  const report={company:{name:'测试公司',ticker:input.ticker,identityStatus:'verified',description:'测试'},summary:'测试',debates:[],sources:[{id:'s1',title:'测试背景',url:'https://example.com/background',author:'测试作者',publishedAt:input.asOf,platform:'other',readingScope:'search_snippet',qualityLabel:''}],coverage:[],limitations:[]};
  return {report,response:{model:'model-snapshot',output:[{type:'web_search_call',status:'completed',action:{type:'search',sources:[{url:report.sources[0].url}]}}]}};
}

test('本机已保存报告可跨账号或退出后只读，生成仍需登录且GET不解析模型或授权',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'chatgpt-provider-test-'));
  let identity='signed-out',calls=0,authChecks=0,modelLookups=0;
  const auth={status:async()=>{authChecks++;return{authenticated:identity!=='signed-out',planEnabled:identity!=='signed-out'};},cacheIdentity:async()=>identity,getAccessToken:async()=>{if(identity==='signed-out')throw new ResearchError('CHATGPT_LOGIN_REQUIRED','先登录',401);return 'mock-oauth';}};
  const client={resolveModel:async()=>{modelLookups++;return'catalog-model';},research:async()=>{calls++;return fixtureResult();}};
  const service=createSubscriptionResearchService({auth,client,directory:dir,prompt:'prompt',fingerprint:'version',promptVersion:'version',now});
  try{
    assert.equal(await service.get(input),null);await assert.rejects(service.generate(input),e=>e.code==='CHATGPT_LOGIN_REQUIRED');assert.equal(calls,0);
    identity='account-a';const generated=await service.generate(input);assert.equal(generated.provider,'chatgpt');assert.equal(generated.model,'model-snapshot');
    const checks=authChecks,lookups=modelLookups;
    assert.equal((await service.get(input)).cached,true);identity='account-b';assert.equal((await service.get(input)).provider,'chatgpt');
    identity='signed-out';assert.equal((await service.get({...input,asOf:'2026-10-01'})).cached,true);
    assert.equal(authChecks,checks);assert.equal(modelLookups,lookups);assert.equal(calls,1);
    await assert.rejects(service.generate(input),e=>e.code==='CHATGPT_LOGIN_REQUIRED');assert.equal(calls,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('研究完成前退出，结果不会保存到新账号或失去授权的缓存',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'chatgpt-account-change-'));
  let identity='a';let finish;
  const auth={status:async()=>({authenticated:identity!=='signed-out',planEnabled:true}),cacheIdentity:async()=>identity,getAccessToken:async()=>'test'};
  const client={resolveModel:async()=>'model',research:async()=>new Promise(resolve=>{finish=()=>resolve(fixtureResult());})};
  const service=createSubscriptionResearchService({auth,client,directory:dir,prompt:'prompt',fingerprint:'version',promptVersion:'version',now});
  try{
    const pending=service.generate(input);while(!finish)await new Promise(resolve=>setTimeout(resolve,1));
    identity='signed-out';finish();await assert.rejects(pending,e=>e.code==='CHATGPT_ACCOUNT_CHANGED');
    identity='a';assert.equal(await service.get(input),null);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('HTTP登录接口返回安全状态，callback只发通知与escaped说明，test必须显式POST',async()=>{
  let probes=0,received;
  const auth={status:async()=>({authenticated:false,planEnabled:false,expiresAt:null}),start:async()=>({url:'https://auth.openai.com/api/accounts/authorize?state=test-state',expiresAt:new Date(Date.now()+60000).toISOString()}),logout:async()=>{},callback:async params=>{received=params.get('state');throw new ResearchError('CHATGPT_STATE_INVALID','<script>private-test</script>',400);}};
  const server=createResearchServer({auth,chatClient:{models:async()=>[{id:'test-model',displayName:'Test'}],probe:async()=>{probes++;return{ok:true,model:'test-model',message:'test'};}},service:{get:async()=>null,generate:async()=>null},health:{status:'ok',provider:'chatgpt'}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const status=await(await fetch(`${base}/api/auth/status`)).json();assert.equal(status.data.provider,'chatgpt');assert.equal(probes,0);
    const start=await(await fetch(`${base}/api/auth/chatgpt/start`,{method:'POST',headers:{Origin:'http://localhost:8765','Content-Type':'application/json'},body:'{}'})).json();assert.equal(new URL(start.data.url).origin,'https://auth.openai.com');
    const callback=await fetch(`${base}/auth/callback?state=test-state&code=never-show-this-code`);const html=await callback.text();assert.equal(received,'test-state');assert.equal(callback.status,400);
    assert.ok(callback.headers.get('content-security-policy').includes("default-src 'none'"));assert.equal(callback.headers.get('referrer-policy'),'no-referrer');
    assert.ok(html.includes('&lt;script&gt;private-test&lt;/script&gt;'));assert.ok(!html.includes('never-show-this-code'));assert.ok(html.includes('chatgpt-auth-complete'));assert.ok(html.includes('http://localhost:8765'));
    assert.equal((await fetch(`${base}/api/auth/test`)).status,404);assert.equal(probes,0);
    assert.equal((await fetch(`${base}/api/auth/test`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,200);assert.equal(probes,1);
    assert.deepEqual(await(await fetch(`${base}/api/auth/logout`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).json(),{data:{authenticated:false}});
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
