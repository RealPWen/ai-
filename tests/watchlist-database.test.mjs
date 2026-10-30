import test from 'node:test';
import assert from 'node:assert/strict';
import { watchlistOwner, watchlistCompany } from '../backend/src/watchlist-store.mjs';
import { createResearchServer } from '../backend/app.mjs';
test('owner normalization and A/H security validation',()=>{
 assert.equal(watchlistOwner('  潘闻  '),'潘闻');assert.equal(watchlistOwner('Ａ  B'),'A B');
 for(const owner of ['',null,'x'.repeat(41),'a\u200bb'])assert.throws(()=>watchlistOwner(owner));
 assert.deepEqual(watchlistCompany({ticker:'02313.hk',name:'申洲国际'}),{ticker:'02313.HK',name:'申洲国际'});
 for(const ticker of ['AAPL','02313','000001.US',"x'; DROP TABLE"])assert.throws(()=>watchlistCompany({ticker}));
});
test('API reads and mutations carry explicit owner; other origins cannot mutate',async()=>{
 const calls=[];const server=createResearchServer({watchlistStore:{list:async owner=>{calls.push(['list',owner]);return owner==='潘闻'?[{ticker:'002920.SZ'}]:[]},change:async body=>{calls.push(body);return[]}}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 try{
  let r=await fetch(base+'/api/watchlist?owner='+encodeURIComponent('潘闻'));assert.equal(r.status,200);assert.equal((await r.json()).data.length,1);
  r=await fetch(base+'/api/watchlist?owner='+encodeURIComponent('另一人'));assert.deepEqual((await r.json()).data,[]);
  r=await fetch(base+'/api/watchlist',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({owner:'潘闻',action:'remove',ticker:'002920.SZ'})});assert.equal(r.status,200);assert.equal(calls[2].owner,'潘闻');
  r=await fetch(base+'/api/watchlist',{method:'POST',headers:{'content-type':'application/json',origin:'https://evil.example'},body:'{}'});assert.equal(r.status,403);assert.equal(calls.length,3);
 }finally{await new Promise(r=>server.close(r))}
});
