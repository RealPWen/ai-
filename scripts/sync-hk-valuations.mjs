import { fileURLToPath } from 'node:url';
import { createHkValuationStore } from '../backend/market-data/hk-valuation-store.mjs';
import { updateRollingHkValuations } from '../backend/market-data/hk-valuation-sync.mjs';
import { todayShanghai } from '../backend/src/input.mjs';
import { createTushareClient } from '../backend/market-data/tushare-client.mjs';

let store;
try{
  if(process.argv.includes('--help'))console.log('用法：npm run data:hk:valuations -- [--scope all|pool] [--concurrency 1|2|3]；默认同步全部在市港股百度股市通PE-TTM/PB，保留截至昨天一自然年，与库内实际HK交易日相交，失败可续传。估值来源无需Token，刷新在市名册需要TUSHARE_TOKEN。');
  else{
    const args=process.argv.slice(2),options={};
    for(let index=0;index<args.length;index+=2){
      if(!['--scope','--concurrency'].includes(args[index])||!args[index+1]||Object.hasOwn(options,args[index]))throw new Error('invalid_arguments');
      options[args[index]]=args[index+1];
    }
    const scope=options['--scope']??process.env.HK_VALUATION_SCOPE??'all';
    const concurrency=options['--concurrency']===undefined?(scope==='all'?3:1):Number(options['--concurrency']);
    if(!['all','pool'].includes(scope)||!Number.isInteger(concurrency)||concurrency<1||concurrency>3)throw new Error('invalid_arguments');
    store=createHkValuationStore({connectionString:process.env.DATABASE_URL});
    const client=scope==='all'&&process.env.TUSHARE_TOKEN?.trim()?createTushareClient({token:process.env.TUSHARE_TOKEN,intervalMs:400,maxRetries:0}):undefined;
    const result=await updateRollingHkValuations({store,client,scope,concurrency,runDate:todayShanghai(),cacheDir:fileURLToPath(new URL('../backend/storage/market-data/',import.meta.url)),log:value=>console.log(JSON.stringify(value))});
    process.exitCode=['succeeded','already_completed'].includes(result.status)?0:2;
  }
}catch{console.error(JSON.stringify({type:'hk_valuation_update_failed',errorCode:'configuration_or_runtime'}));process.exitCode=1;}
finally{await store?.close();}
