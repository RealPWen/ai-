import { fileURLToPath } from 'node:url';
import { createHkForecastStore } from '../backend/market-data/hk-forecast-store.mjs';
import { updateRollingHkForecasts } from '../backend/market-data/hk-forecast-sync.mjs';
import { todayShanghai } from '../backend/src/input.mjs';
import { createTushareClient } from '../backend/market-data/tushare-client.mjs';

let store;
try {
  if(process.argv.includes('--help'))console.log('用法：npm run data:hk:forecasts -- [--scope all|pool] [--concurrency 1|2|3]；默认采集全部在市港股当前逐券商EPS预测，每2秒最多发起一个请求。EPS来源经济通无需Token；全市场名册刷新需要Tushare Token。明确无覆盖与失败，断点续传、保存一年，从实际采集日起积累，不回填历史预测。');
  else {
    const args=process.argv.slice(2), options={};
    for(let index=0;index<args.length;index+=2) {
      if(!['--scope','--concurrency'].includes(args[index]) || !args[index+1] || Object.hasOwn(options,args[index]))throw new Error('invalid_arguments');
      options[args[index]]=args[index+1];
    }
    const scope=options['--scope']??process.env.HK_FORECAST_SCOPE??'all';
    const concurrency=options['--concurrency']===undefined?(scope==='all'?3:1):Number(options['--concurrency']);
    if(!['all','pool'].includes(scope)||!Number.isInteger(concurrency)||concurrency<1||concurrency>3)throw new Error('invalid_arguments');
    store=createHkForecastStore({connectionString:process.env.DATABASE_URL});
    const client=scope==='all'&&process.env.TUSHARE_TOKEN?.trim()?createTushareClient({token:process.env.TUSHARE_TOKEN,intervalMs:400,maxRetries:0}):undefined;
    const result=await updateRollingHkForecasts({store,client,scope,concurrency,runDate:todayShanghai(),cacheDir:fileURLToPath(new URL('../backend/storage/market-data/',import.meta.url)),log:value=>console.log(JSON.stringify(value))});
    process.exitCode=['succeeded','already_completed'].includes(result.status)?0:2;
  }
} catch {console.error(JSON.stringify({type:'hk_forecast_update_failed',errorCode:'configuration_or_runtime'}));process.exitCode=1;}
finally {await store?.close();}
