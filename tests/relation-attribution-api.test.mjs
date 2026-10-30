import test from 'node:test';import assert from 'node:assert/strict';import {createResearchServer} from '../backend/app.mjs';
test('read/generate/job/batch APIs delegate without paid calls on reads or cross-origin writes',async()=>{
 const calls=[];const service={get:async p=>{calls.push(['get',p]);return{freshness:'missing'}},start:async p=>{calls.push(['start',p]);return{jobId:'job'}},getJob:async id=>({jobId:id}),status:()=>({enabled:true}),triggerAll:()=>calls.push(['batch'])};
 const server=createResearchServer({relationAttributionService:service});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/api/relations/attribution`;
 try{let r=await fetch(base+'?ticker=002920.SZ');assert.equal((await r.json()).data.freshness,'missing');assert.equal(calls.length,1);
 r=await fetch(base+'/generate',{method:'POST',headers:{'content-type':'application/json'},body:'{"ticker":"002920.SZ"}'});assert.equal(r.status,202);assert.equal(calls[1][0],'start');
 r=await fetch(base+'/jobs/job');assert.equal((await r.json()).data.jobId,'job');
 r=await fetch(base+'/batch');assert.equal((await r.json()).data.enabled,true);assert.equal(calls.length,2);
 r=await fetch(base+'/generate',{method:'POST',headers:{'content-type':'application/json',origin:'https://evil.example'},body:'{}'});assert.equal(r.status,403);assert.equal(calls.length,2);
 }finally{await new Promise(r=>server.close(r))}
});
