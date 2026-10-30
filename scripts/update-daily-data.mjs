import { fileURLToPath } from 'node:url';
import { createMarketUpdateRuntime } from '../backend/market-data/update-runtime.mjs';
import { todayShanghai, validDate } from '../backend/src/input.mjs';

let runtime;
try {
  const args = process.argv.slice(2);
  if (args.includes('--help')) console.log('用法：npm run data:update -- [--markets A,HK] [--provider tencent|eastmoney|yahoo|tushare] [--hk-scope pool|all] [--hk-forecast-scope all|pool] [--hk-valuation-scope all|pool] [--run-date YYYY-MM-DD] [--skip-news]；更新行情、港股PE-TTM/PB、港股逐券商EPS快照及前一日财联社公开新闻。--hk-scope all 使用腾讯日线及 Tushare 在市名单；EPS和PE/PB默认覆盖全部在市港股，可用各自scope pool限制工作簿名单。--skip-news只跳过新闻；行情和估值截至昨天，EPS为当日采集快照。A股和港股日线保留最近一年及起点前一个交易日，A股同步保留对应复权因子；估值和EPS保留一年。');
  else {
    const options = {};
    let skipNews = false;
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === '--skip-news') {
        if (skipNews) throw new Error('invalid_arguments');
        skipNews = true; continue;
      }
      if (!['--run-date', '--markets', '--provider', '--hk-scope', '--hk-forecast-scope', '--hk-valuation-scope'].includes(args[index]) || !args[index + 1] || Object.hasOwn(options, args[index])) throw new Error('invalid_arguments');
      options[args[index]] = args[index + 1]; index += 1;
    }
    const runDate = options['--run-date'] ?? todayShanghai();
    const markets = (options['--markets'] ?? 'A,HK').split(',').map(value => value.trim().toUpperCase());
    const hkProvider = options['--provider'] ?? process.env.HK_PRICE_PROVIDER ?? 'eastmoney';
    const hkPriceScope = options['--hk-scope'] ?? process.env.HK_PRICE_SCOPE ?? 'pool';
    const hkForecastScope = options['--hk-forecast-scope'] ?? process.env.HK_FORECAST_SCOPE ?? 'all';
    const hkValuationScope = options['--hk-valuation-scope'] ?? process.env.HK_VALUATION_SCOPE ?? 'all';
    if (!['tencent', 'eastmoney', 'yahoo', 'tushare'].includes(hkProvider)) throw new Error('invalid_provider');
    if (!markets.length || new Set(markets).size !== markets.length || markets.some(value => !['A', 'HK'].includes(value))) throw new Error('invalid_markets');
    if (!validDate(runDate) || runDate !== todayShanghai()) throw new Error('invalid_date');
    runtime = createMarketUpdateRuntime({ connectionString: process.env.DATABASE_URL, token: process.env.TUSHARE_TOKEN, markets, hkProvider, hkPriceScope, hkForecastScope, hkValuationScope,
      hkValuationEnabled: process.env.HK_VALUATION_AUTO_UPDATE_ENABLED !== 'false',
      hkForecastEnabled: process.env.HK_FORECAST_AUTO_UPDATE_ENABLED !== 'false',
      newsEnabled: !skipNews && process.env.CLS_NEWS_AUTO_UPDATE_ENABLED !== 'false',
      cacheDir: fileURLToPath(new URL('../backend/storage/market-data/', import.meta.url)), log: value => console.log(JSON.stringify(value)) });
    const result = await runtime.runOnce({ runDate });
    process.exitCode = ['succeeded', 'already_completed'].includes(result.status) ? 0 : 2;
    if (result.status === 'disabled') console.error(JSON.stringify({ type: 'daily_update_failed', reason: result.reason }));
  }
} catch { console.error(JSON.stringify({ type: 'daily_update_failed', reason: 'configuration_or_runtime' })); process.exitCode = 1; }
finally { if (runtime) await runtime.close(); }
