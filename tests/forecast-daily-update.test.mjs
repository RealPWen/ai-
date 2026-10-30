import test from 'node:test';
import assert from 'node:assert/strict';
import { updateRollingForecasts } from '../backend/market-data/forecast-daily-update.mjs';
for (const failure of [null, 0, 1]) test(`daily EPS resumes history, refreshes late reports and prunes only on success: ${failure}`, async () => {
 const calls=[];let pruned=false;
 const store={withDailyLock: fn=>fn(),pruneBefore:async date=>{assert.equal(date,'20251029');pruned=true;return 2}};
 const result=await updateRollingForecasts({store,runDate:'2026-10-29',sync:async opts=>{calls.push(opts);return {status:calls.length-1===failure?'incomplete':'completed'}}});
 assert.equal(result.status,failure===null?'succeeded':'failed');assert.equal(pruned,failure===null);
 assert.equal(calls[0].endDate,'20261028');
 if(failure!==0){assert.equal(calls[1].startDate,'2026-10-22');assert.equal(calls[1].refresh,true)}
});
test('busy EPS lock skips all downloads',async()=>{const r=await updateRollingForecasts({runDate:'2026-10-29',store:{withDailyLock:async()=>({status:'busy'})},sync:()=>assert.fail()});assert.equal(r.status,'busy')});
