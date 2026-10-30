import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { updateRollingHkValuations } from '../backend/market-data/hk-valuation-sync.mjs';
import { createHkValuationStore, HK_VALUATION_SOURCE } from '../backend/market-data/hk-valuation-store.mjs';
import { loadHongKongUniverse, validateHongKongUniverse } from '../backend/market-data/hk-pool-universe.mjs';

const runDate = '2026-10-19', startDate = '20251019', endDate = '20261018';
const error = kind => Object.assign(new Error('private provider or database details'), { kind });
const row = (ticker, trade_date = '20261016', extra = {}) => ({ ts_code: ticker, trade_date, pe_ttm: '15.123456789', pb: '2.5001', ...extra });
const universe = (tickers = ['00700.HK', '02020.HK', '02513.HK']) => ({ version: 1,
  source: { path: '/pool.xlsx', sheet: '合并价值投资池' },
  securities: tickers.map((ticker, index) => ({ ticker, name: `证券 ${index + 1}`, row: index + 2 })) });
const payload = (ticker, rows = [row(ticker)]) => ({ ...HK_VALUATION_SOURCE, rows, raw: { metrics: ['市盈率(TTM)', '市净率'], ticker } });
const catalog=(tickers=['00700.HK','02020.HK','02513.HK'],asOf=runDate)=>({version:1,complete:true,source:'hkex_tushare',apiName:'hkex_listed_equities',asOf,sourceDate:asOf,
  universeHash:createHash('sha256').update([...tickers].sort().join('\n')).digest('hex'),audit:{pendingRecords:0,confirmedRecords:tickers.length,tushareOnly:[]},
  securities:tickers.map((ticker,index)=>({ticker,name:`公司${index+1}`,board:'main',currency:'HKD',listDate:'2010-01-01'}))});
const marketPayload=(ticker,rows=[row(ticker)],coverage={kind:'available',metricStatus:{pe_ttm:'available',pb:'available'}})=>({...payload(ticker,rows),coverage});
const noDataPayload=ticker=>marketPayload(ticker,[],{kind:'no_data',metricStatus:{pe_ttm:'no_data',pb:'no_data'},noDataEvidence:'both_metric_charts_explicitly_empty_in_requested_window'});

function memoryLedger({ busy = false, failSave,prices={} } = {}) {
  const calls = [], runs = new Map(), symbols = new Map(),attempts=new Map();
  const runKey = value => `${value.runDate}/${value.universeHash}`;
  const symbolKey = value => `${runKey(value)}/${value.ticker}`;
  const completeKey=value=>value.scope==='all'?[...symbols.keys()].find(key=>key.startsWith(`${value.runDate}/`)&&key.endsWith(`/${value.ticker}`)):symbols.has(symbolKey(value))?symbolKey(value):null;
  const complete = value => !!completeKey(value);
  const dates=ticker=>Object.hasOwn(prices,ticker)?prices[ticker]:['20261016'];
  const attemptKey=value=>`${value.runDate}/${value.ticker}`;
  const scope = {
    async getRun(value) { calls.push(['getRun', value]); return runs.get(runKey(value)) ?? null; },
    async symbolComplete(value) { calls.push(['symbolComplete', value]); return complete(value); },
    async getSymbolCheckpoint(value){const key=completeKey(value);return key?{rowsCount:symbols.get(key).length,expectedCount:dates(value.ticker).length,universeHash:key.split('/')[1]}:null;},
    async priceDates(value){calls.push(['priceDates',value]);return [...dates(value.ticker)];},
    async getSymbolAttempt(value){return attempts.get(attemptKey(value))??null;},
    async markSymbol(value){calls.push(['attempt',value]);attempts.set(attemptKey(value),{status:value.status,expectedCount:dates(value.ticker).length,
      coverage:{...value.coverage,priceDatesHash:createHash('sha256').update([...dates(value.ticker)].sort().join('\n')).digest('hex')}});},
    async confirmSymbol(value){calls.push(['confirm',value]);},
    async beginRun(value) { calls.push(['begin', value]); runs.set(runKey(value), { status: 'running' }); },
    async saveSymbol(value) {
      calls.push(['save', value]); const failure = await failSave?.(value); if (failure) throw error(typeof failure === 'string' ? failure : 'database');
      symbols.set(symbolKey(value), value.rows);
      return { rowsCount: value.rows.length, sourceRowsCount: value.rows.length, firstDate: value.rows[0].trade_date, lastDate: value.rows.at(-1).trade_date };
    },
    async failRun(value) { calls.push(['fail', value]); runs.set(runKey(value), { status: value.partial ? 'partial' : 'failed', summary: structuredClone(value.summary) }); },
    async finalize(value) {
      calls.push(['finalize', value]);
      assert.ok(value.tickers.every(ticker => complete({ ...value, ticker })), 'retention requires every pool symbol to have a durable checkpoint');
      runs.set(runKey(value), { status: 'succeeded', summary: structuredClone(value.summary) }); return { deleted: 7 };
    },
  };
  return { calls, runs, symbols,attempts,prices, async migrate() { calls.push(['migrate']); },
    async withLock(operation) { calls.push(['lock']); return busy ? { status: 'busy' } : operation(scope); } };
}
async function setup(t, extra = {}) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'hk-valuation-sync-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  return { runDate, cacheDir, store: memoryLedger(), universe: universe(), ...extra };
}
const cachePath = options => join(options.cacheDir, 'HK-valuations', validateHongKongUniverse(options.universe).universeHash, options.runDate, '00700.HK.json.gz');

test('all 28 manifest stocks use the bounded year and source-specific raw cache before final retention', async t => {
  const pool = await loadHongKongUniverse(), calls = [], logs = [];
  const options = await setup(t, { universe: pool, log: value => logs.push(value), collector: async value => {
    calls.push(value); return payload(value.ticker, [row(value.ticker, '20261015', { pe_ttm: null, pb: '-0.25' }), row(value.ticker)]);
  } });
  const result = await updateRollingHkValuations(options);
  assert.equal(pool.tickers.length, 28); assert.equal(result.status, 'succeeded');
  assert.deepEqual(calls.map(value => value.ticker), pool.tickers);
  for (const value of calls) {
    assert.equal(value.startDate, startDate); assert.equal(value.endDate, endDate);
    assert.equal(value.source, 'baidu'); assert.equal(value.apiName, 'baidu_hk_valuation'); assert.equal(value.universeHash, pool.universeHash);
  }
  assert.equal(result.summary.completedTickers, 28); assert.equal(result.summary.downloadedTickers, 28);
  assert.equal(result.summary.rows, 56); assert.equal(result.summary.deleted, 7);
  const finalIndex = options.store.calls.findIndex(([name]) => name === 'finalize');
  assert.equal(options.store.calls.filter(([name], index) => name === 'save' && index < finalIndex).length, 28);
  assert.equal(options.store.calls.filter(([name]) => name === 'fail').length, 0);
  const cached = JSON.parse(gunzipSync(await readFile(cachePath(options))).toString('utf8'));
  assert.equal(cached.version, 1); assert.equal(cached.source, 'baidu'); assert.equal(cached.apiName, 'baidu_hk_valuation');
  assert.equal(cached.universeHash, pool.universeHash); assert.equal(cached.startDate, startDate); assert.equal(cached.endDate, endDate);
  assert.equal(cached.raw.ticker, '00700.HK'); assert.equal(cached.rows[0].pe_ttm, null); assert.equal(cached.rows[0].pb, '-0.25');
  assert.equal(cached.rows[1].pe_ttm, '15.123456789'); assert.ok(!Object.hasOwn(cached, 'cached'));
  assert.equal(logs.filter(value => value.type === 'hk_valuation_ticker_completed').length, 28);
});

test('a successful same-date run verifies every symbol then skips all collection and retention', async t => {
  let collected = 0;
  const options = await setup(t, { collector: async ({ ticker }) => { collected++; return payload(ticker); } });
  assert.equal((await updateRollingHkValuations(options)).status, 'succeeded');
  const writes = options.store.calls.filter(([name]) => ['begin', 'save', 'finalize', 'fail'].includes(name)).length;
  options.collector = async () => assert.fail('already-completed symbols must not require a provider request');
  const result = await updateRollingHkValuations(options);
  assert.equal(result.status, 'already_completed'); assert.equal(collected, 3);
  assert.equal(options.store.calls.filter(([name]) => ['begin', 'save', 'finalize', 'fail'].includes(name)).length, writes);
  assert.equal(result.summary.completedTickers, 3);
});

test('a partial rate-limited run never prunes and resumes only remaining symbols', async t => {
  const calls = [];
  const options = await setup(t, { collector: async ({ ticker }) => {
    calls.push(ticker); if (ticker === '02020.HK') throw error('rate_limit'); return payload(ticker);
  } });
  const partial = await updateRollingHkValuations(options);
  assert.equal(partial.status, 'partial'); assert.equal(partial.errorCode, 'rate_limited');
  assert.equal(partial.summary.completedTickers, 1); assert.deepEqual(calls, ['00700.HK', '02020.HK']);
  assert.equal(options.store.calls.some(([name]) => name === 'finalize'), false);
  assert.doesNotMatch(JSON.stringify(partial), /private|database details/);
  options.collector = async ({ ticker }) => { calls.push(ticker); return payload(ticker); };
  const resumed = await updateRollingHkValuations(options);
  assert.equal(resumed.status, 'succeeded'); assert.equal(resumed.summary.skippedTickers, 1);
  assert.deepEqual(calls, ['00700.HK', '02020.HK', '02020.HK', '02513.HK']);
  assert.equal(options.store.calls.filter(([name]) => name === 'finalize').length, 1);
});

test('one unavailable stock does not masquerade as a completed 28-stock run or authorize retention', async t => {
  const pool = await loadHongKongUniverse(), missing = pool.tickers[10], calls = [];
  const options = await setup(t, { universe: pool, collector: async ({ ticker }) => {
    calls.push(ticker); if (ticker === missing) throw error('network'); return payload(ticker);
  } });
  const result = await updateRollingHkValuations(options);
  assert.equal(result.status, 'partial'); assert.equal(result.errorCode, 'network_error');
  assert.equal(result.summary.plannedTickers, 28); assert.equal(result.summary.completedTickers, 27);
  assert.equal(calls.length, 28); assert.equal(options.store.calls.some(([name]) => name === 'finalize'), false);
  const failed = options.store.calls.find(([name]) => name === 'fail')[1];
  assert.equal(failed.partial, true); assert.equal(failed.errorCode, 'network_error');
  assert.equal(result.summary.tickers.filter(value => value.status === 'failed').length, 1);
});

test('a database failure preserves validated raw cache so a retry needs no second download', async t => {
  let failOnce = true, collected = 0;
  const store = memoryLedger({ failSave: () => { if (!failOnce) return false; failOnce = false; return true; } });
  const options = await setup(t, { store, universe: universe(['00700.HK']), collector: async ({ ticker }) => {
    collected++; return payload(ticker, [row(ticker, '20261016', { pe_ttm: '-12.375', pb: null })]);
  } });
  const failure = await updateRollingHkValuations(options);
  assert.equal(failure.status, 'failed'); assert.equal(failure.errorCode, 'database_error');
  assert.equal(store.calls.some(([name]) => name === 'finalize'), false);
  const cachedBefore = await readFile(cachePath(options));
  options.collector = async () => assert.fail('database retry must reuse the durable successful source response');
  const result = await updateRollingHkValuations(options);
  assert.equal(result.status, 'succeeded'); assert.equal(collected, 1); assert.equal(result.summary.cachedTickers, 1);
  assert.deepEqual(await readFile(cachePath(options)), cachedBefore);
  const saved = store.calls.filter(([name]) => name === 'save').at(-1)[1];
  assert.equal(saved.rows[0].pe_ttm, '-12.375'); assert.equal(saved.rows[0].pb, null);
});

test('a previously incomplete source payload is quarantined and a retry can download the newly complete history', async t => {
  let incompleteOnce = true, collected = 0;
  const store = memoryLedger({ failSave: () => { if (!incompleteOnce) return false; incompleteOnce = false; return 'incomplete_window'; } });
  const options = await setup(t, { store, universe: universe(['00700.HK']), collector: async ({ ticker }) => {
    collected++; return payload(ticker, collected === 1 ? [row(ticker, '20261015')] : [row(ticker, '20261015'), row(ticker)]);
  } });
  const partial = await updateRollingHkValuations(options);
  assert.equal(partial.status, 'failed'); assert.equal(partial.errorCode, 'incomplete_window');
  assert.equal(store.calls.some(([name]) => name === 'finalize'), false);
  const result = await updateRollingHkValuations(options);
  assert.equal(result.status, 'succeeded'); assert.equal(collected, 2); assert.equal(result.summary.downloadedTickers, 1);
  const saved = store.calls.filter(([name]) => name === 'save').at(-1)[1]; assert.equal(saved.rows.length, 2);
  const files = await readdir(join(options.cacheDir, 'HK-valuations', validateHongKongUniverse(options.universe).universeHash, runDate));
  assert.equal(files.filter(name => name.includes('.rejected-')).length, 1);
});

test('corrupt or mismatched caches are quarantined and never masquerade as validated source data', async t => {
  for (const corrupt of [() => Buffer.from('not a gzip response'), cached => gzipSync(JSON.stringify({ ...cached, source: 'tushare' })),
    cached => gzipSync(JSON.stringify({ ...cached, universeHash: '0'.repeat(64) })),
    cached => gzipSync(JSON.stringify({ ...cached, rows: [row('02020.HK')] }))]) {
    let failOnce = true, collected = 0;
    const store = memoryLedger({ failSave: () => { if (!failOnce) return false; failOnce = false; return true; } });
    const options = await setup(t, { store, universe: universe(['00700.HK']), collector: async ({ ticker }) => { collected++; return payload(ticker); } });
    assert.equal((await updateRollingHkValuations(options)).status, 'failed');
    const path = cachePath(options), cached = JSON.parse(gunzipSync(await readFile(path)).toString('utf8'));
    await writeFile(path, corrupt(cached));
    const result = await updateRollingHkValuations(options);
    assert.equal(result.status, 'succeeded'); assert.equal(result.summary.downloadedTickers, 1); assert.equal(collected, 2);
    const refreshed = JSON.parse(gunzipSync(await readFile(path)).toString('utf8'));
    assert.equal(refreshed.source, 'baidu'); assert.equal(refreshed.rows[0].ts_code, '00700.HK');
    assert.equal((await readdir(join(path, '..'))).filter(name => name.includes('.rejected-')).length, 1);
  }
});

test('a succeeded ledger with missing actual symbol checkpoints is rechecked and restored from its own raw cache', async t => {
  const options = await setup(t, { collector: async ({ ticker }) => payload(ticker) });
  assert.equal((await updateRollingHkValuations(options)).status, 'succeeded');
  options.store.symbols.clear();
  options.collector = async () => assert.fail('valid cached payloads can restore invalidated symbol coverage without network access');
  const result = await updateRollingHkValuations(options);
  assert.equal(result.status, 'succeeded'); assert.equal(result.summary.cachedTickers, 3); assert.equal(result.summary.skippedTickers, 0);
  assert.equal(options.store.calls.filter(([name]) => name === 'finalize').length, 2);
});

test('an invalid provider identity or invalid rows never save, finalize or create a usable checkpoint', async t => {
  for (const change of [value => ({ ...value, source: 'tushare' }), value => ({ ...value, apiName: 'hk_daily' }),
    value => ({ ...value, rows: [row('02020.HK')] }), value => ({ ...value, rows: [row('00700.HK', '20261019')] }),
    value => ({ ...value, rows: [] })]) {
    const options = await setup(t, { universe: universe(['00700.HK']), collector: async ({ ticker }) => change(payload(ticker)) });
    const result = await updateRollingHkValuations(options);
    assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'validation_error');
    assert.equal(options.store.calls.some(([name]) => name === 'save' || name === 'finalize'), false);
  }
});

test('a changed pool or next run date has its own checkpoints and bounded source request', async t => {
  const calls = [], options = await setup(t, { universe: universe(['00700.HK']), collector: async value => { calls.push(value); return payload(value.ticker); } });
  assert.equal((await updateRollingHkValuations(options)).status, 'succeeded');
  const next = await updateRollingHkValuations({ ...options, runDate: '2026-10-20' });
  assert.equal(next.status, 'succeeded'); assert.equal(next.summary.skippedTickers, 0);
  assert.equal(calls.at(-1).startDate, '20251020'); assert.equal(calls.at(-1).endDate, '20261019');
  const changed = await updateRollingHkValuations({ ...options, universe: universe(['00700.HK', '02020.HK']) });
  assert.equal(changed.status, 'succeeded'); assert.equal(changed.summary.skippedTickers, 0);
  assert.notEqual(calls[0].universeHash, calls.at(-1).universeHash);
});

test('leap-day windows still cover one natural year through yesterday without a fabricated anniversary', async t => {
  const calls = [], options = await setup(t, { universe: universe(['00700.HK']), runDate: '2028-02-29', collector: async value => {
    calls.push(value); return payload(value.ticker, [row(value.ticker, value.endDate)]);
  } });
  const result = await updateRollingHkValuations(options);
  assert.equal(result.status, 'succeeded'); assert.equal(calls[0].startDate, '20270228'); assert.equal(calls[0].endDate, '20280228');
});

test('a busy independent lock performs neither provider requests nor symbol writes', async t => {
  const store = memoryLedger({ busy: true });
  const options = await setup(t, { store, collector: async () => assert.fail('busy lock must not collect') });
  const result = await updateRollingHkValuations(options);
  assert.equal(result.status, 'busy'); assert.equal(result.summary.completedTickers, 0);
  assert.deepEqual(store.calls.map(([name]) => name), ['migrate', 'lock']);
});

test('sync and real store intersect IPO and calendar payloads with actual stored price dates', async t => {
  const calls = []; let status = null, completed = false;
  const priceDates = ['20260108', '20260109', '20261016'];
  const pool = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (sql.startsWith('SELECT') && sql.includes('FROM market_data.hk_valuation_update_runs')) return { rows: status ? [{ status }] : [] };
      if (sql.startsWith('SELECT') && sql.includes('FROM market_data.hk_valuation_symbol_runs')) return { rows: completed ? [{ rows_count: 3, expected_count: 3, stored_count: 3 }] : [] };
      if (sql.startsWith('SELECT to_char(trade_date')) return { rows: priceDates.map(trade_date => ({ trade_date })) };
      if (sql.startsWith('INSERT INTO market_data.hk_valuation_update_runs')) status = 'running';
      if (sql.startsWith('INSERT INTO market_data.hk_valuation_symbol_runs')) completed = true;
      if (sql.startsWith('UPDATE market_data.hk_valuation_update_runs') && sql.includes("status='succeeded'")) status = 'succeeded';
      return { rows: [], rowCount: 0 };
    },
    async connect() { return { query: pool.query, release() {} }; }, async end() {},
  };
  const sourceRows = ['20251020', ...priceDates.slice(0, 2), '20260110', priceDates.at(-1), '20261018'].map(date => row('02513.HK', date));
  const options = await setup(t, { universe: universe(['02513.HK']), store: createHkValuationStore({ pool }), collector: async value => {
    assert.equal(value.startDate, startDate); assert.equal(value.endDate, endDate); return payload(value.ticker, sourceRows);
  } });
  const result = await updateRollingHkValuations(options);
  assert.equal(result.status, 'succeeded'); assert.equal(result.summary.rows, 3);
  const insert = calls.find(value => value.sql.startsWith('INSERT INTO market_data.hk_daily_valuations'));
  assert.ok(insert); const writtenDates = insert.values.filter((_, index) => index % 6 === 1);
  assert.deepEqual(writtenDates, ['2026-01-08', '2026-01-09', '2026-10-16']);
  assert.ok(calls.find(value => value.sql.startsWith('DELETE FROM market_data.hk_daily_valuations')));
  assert.equal(calls.some(value => /(?:INSERT|DELETE|UPDATE).*market_data\.(?:daily_prices|daily_valuations)\b/.test(value.sql)), false);
});

test('all-market valuations separate unavailable prices, explicit source-empty history and usable partial metrics',async t=>{
  const tickers=['00001.HK','00002.HK','00003.HK'],collected=[],store=memoryLedger({prices:{'00001.HK':[]}});
  const options=await setup(t,{store,scope:'all',catalog:catalog(tickers),collector:async identity=>{
    collected.push(identity);assert.equal(identity.allowPartialMetrics,true);assert.equal(identity.allowEmpty,true);
    return identity.ticker==='00002.HK'?noDataPayload(identity.ticker):marketPayload(identity.ticker,[row(identity.ticker,'20261016',{pe_ttm:null,pb:'1.25'})],{kind:'partial_metrics',metricStatus:{pe_ttm:'no_data',pb:'available'}});
  }});
  const result=await updateRollingHkValuations(options);
  assert.equal(result.status,'partial');assert.equal(result.summary.completedTickers,1);assert.equal(result.summary.noDataTickers,1);assert.equal(result.summary.noPriceTickers,1);assert.equal(result.summary.failedTickers,0);
  assert.deepEqual(collected.map(row=>row.ticker),['00002.HK','00003.HK']);
  assert.equal(store.calls.filter(([name])=>name==='save').length,1);assert.equal(store.calls.some(([name])=>name==='finalize'),false);
  assert.equal(store.attempts.get(`${runDate}/00001.HK`).status,'no_price_data');assert.equal(store.attempts.get(`${runDate}/00002.HK`).status,'no_data');
  const again=await updateRollingHkValuations(options);
  assert.equal(again.status,'partial');assert.equal(again.summary.skippedTickers,3);assert.equal(collected.length,2);
});

test('same-day no-price and source-empty checkpoints invalidate when actual price coverage is supplemented or replaced',async t=>{
  const tickers=['00001.HK','00002.HK'],calls=[],prices={'00001.HK':[],'00002.HK':['20261015']},store=memoryLedger({prices});
  const options=await setup(t,{store,scope:'all',catalog:catalog(tickers),collector:async identity=>{calls.push(identity);return noDataPayload(identity.ticker);}});
  await updateRollingHkValuations(options);assert.deepEqual(calls.map(row=>row.ticker),['00002.HK']);
  prices['00001.HK']=['20261016'];prices['00002.HK']=['20261016'];
  const changed=await updateRollingHkValuations(options);
  assert.equal(changed.summary.noPriceTickers,0);assert.equal(changed.summary.noDataTickers,2);
  assert.deepEqual(calls.map(row=>row.ticker),['00002.HK','00001.HK','00002.HK']);
  assert.notEqual(calls[0].priceDatesHash,calls.at(-1).priceDatesHash,'same count but changed dates must invalidate the source-empty cache');
  const files=await readdir(join(options.cacheDir,'HK-valuations','all',runDate));assert.ok(files.some(name=>name.startsWith('00002.HK.json.gz.rejected-')));
});

test('all-market membership expansion reuses verified same-day old-pool stocks without refetching on catalog hash changes',async t=>{
  const calls=[],options=await setup(t,{universe:universe(['00700.HK']),collector:async identity=>{calls.push(identity);return payload(identity.ticker);}});
  await updateRollingHkValuations(options);
  const result=await updateRollingHkValuations({...options,scope:'all',catalog:catalog(['00001.HK','00700.HK']),collector:async identity=>{calls.push(identity);return marketPayload(identity.ticker);}});
  assert.equal(result.status,'succeeded');assert.equal(result.summary.skippedTickers,1);assert.equal(result.summary.downloadedTickers,1);
  assert.equal(calls.filter(row=>row.ticker==='00700.HK').length,1);assert.equal(options.store.calls.filter(([name])=>name==='confirm').length,1);
});

test('all-market no-data proof and catalog identity are mandatory, and malformed payloads never become source-empty successes',async t=>{
  for(const mutate of [value=>{value.coverage.noDataEvidence='';},value=>{value.coverage.metricStatus.pb='available';},value=>{value.coverage.kind='available';}]){
    const options=await setup(t,{universe:universe(['00700.HK']),scope:'all',catalog:catalog(['00700.HK']),collector:async identity=>{const value=noDataPayload(identity.ticker);mutate(value);return value;}});
    const result=await updateRollingHkValuations(options);assert.equal(result.status,'failed');assert.equal(result.errorCode,'validation_error');
    assert.equal(result.summary.noDataTickers,0);assert.equal(options.store.calls.some(([name])=>name==='save'),false);
    assert.equal(options.store.attempts.get(`${runDate}/00700.HK`).status,'failed');
  }
  const options=await setup(t,{scope:'all',catalog:{...catalog(),complete:false},collector:()=>assert.fail('invalid catalog cannot collect')});
  assert.equal((await updateRollingHkValuations(options)).status,'failed');assert.equal(options.store.calls.length,0);
});

test('all-market worker overlap is bounded and database transactions remain sequential; fatal limits stop new assignments',async t=>{
  const tickers=['00001.HK','00002.HK','00003.HK','00004.HK','00005.HK','00006.HK'];
  let activeCollect=0,maxCollect=0,activeSave=0,maxSave=0;
  const store=memoryLedger({async failSave(){activeSave++;maxSave=Math.max(maxSave,activeSave);await new Promise(resolve=>setTimeout(resolve,5));activeSave--;return false;}});
  const options=await setup(t,{store,scope:'all',catalog:catalog(tickers),concurrency:3,collector:async identity=>{activeCollect++;maxCollect=Math.max(maxCollect,activeCollect);await new Promise(resolve=>setTimeout(resolve,5));activeCollect--;return marketPayload(identity.ticker);}});
  assert.equal((await updateRollingHkValuations(options)).status,'succeeded');assert.equal(maxCollect,3);assert.equal(maxSave,1);
  const calls=[],limited=await setup(t,{scope:'all',catalog:catalog(tickers),concurrency:3,collector:async identity=>{calls.push(identity.ticker);if(identity.ticker==='00001.HK')throw error('rate_limit');await new Promise(resolve=>setTimeout(resolve,5));return marketPayload(identity.ticker);}});
  const partial=await updateRollingHkValuations(limited);assert.equal(partial.status,'partial');assert.equal(partial.errorCode,'rate_limited');assert.ok(calls.length<=3);
  assert.equal(limited.store.calls.some(([name])=>name==='finalize'),false);
});
