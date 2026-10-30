import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { updateRollingHkForecasts } from '../backend/market-data/hk-forecast-sync.mjs';
import { validateHongKongUniverse } from '../backend/market-data/hk-pool-universe.mjs';

const TODAY = '2026-10-19';
const now = () => new Date('2026-10-19T01:00:00Z');
const universeOf = (tickers = ['00700.HK', '02313.HK']) => ({
  version: 1, source: { path: '/fixtures/hk.xlsx', sheet: '投资池' },
  securities: tickers.map((ticker, index) => ({ ticker, name: `公司${index + 1}`, row: index + 1 })),
});
const catalogOf=(tickers=['00700.HK','02313.HK'],asOf=TODAY)=>({version:1,complete:true,source:'hkex_tushare',apiName:'hkex_listed_equities',asOf,sourceDate:asOf,
  universeHash:createHash('sha256').update([...tickers].sort().join('\n')).digest('hex'),
  audit:{pendingRecords:0,confirmedRecords:tickers.length,tushareOnly:[]},
  securities:tickers.map((ticker,index)=>({ticker,name:`公司${index+1}`,listDate:'2010-01-01',board:'main',currency:'HKD'}))});
const errorOf = kind => Object.assign(new Error('secret connection detail should not appear'), { kind });
const rowOf = ticker => ({
  ts_code: ticker, source_record_id: `source:${ticker}`, report_date: '20261016',
  org_name: '证券商甲', report_title: null, author_name: null,
  fiscal_year: 2027, fiscal_period: '2027-12', eps: 1.25, np: null, pe: null, rating: null,
  currency: 'CNY', eps_basis: null,
  source_url: `https://www.etnet.com.hk/www/sc/stocks/realtime/quote_profit.php?code=${ticker.slice(0, 5)}`,
  raw_data: { eps: '125', eps_unit: '分', date_meaning: 'broker_update_date' },
});
function payloadOf(ticker, options = {}) {
  const rows = options.rows ?? [rowOf(ticker)];
  return {
    source: 'etnet', apiName: 'etnet_hk_profit_forecast', rows,
    coverage: { kind: 'current_snapshot', dateMeaning: 'broker_update_date', historicalArchiveAvailable: false,
      sourceRows: rows.length, rowsInRange: rows.length, outsideRange: 0, ...options.coverage },
    raw: { html: '<html>fixture</html>' }, ...options.extra,
  };
}

async function fixture(t, options = {}) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'hk-forecast-sync-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const universe = options.universe ?? universeOf(), universeHash = validateHongKongUniverse(universe).universeHash;
  const calls = { migrate: 0, lock: 0, begins: [], saves: [], finalized: [], failed: [], collected: [], attempts:[],confirmed:[] };
  const runs = new Map(), complete = new Set();
  const key = value => `${value.runDate}/${value.universeHash}`;
  const symbolKey = value => `${key(value)}/${value.ticker}`;
  const completedKey=value=>value.scope==='all'?[...complete].find(key=>key.startsWith(`${value.runDate}/`)&&key.endsWith(`/${value.ticker}`)):complete.has(symbolKey(value))?symbolKey(value):null;
  const scope = {
    async getRun(value) { return runs.get(key(value)) ?? null; },
    async beginRun(value) {
      calls.begins.push(value); runs.set(key(value), { status: 'running' });
    },
    async symbolComplete(value) { return !!completedKey(value); },
    async getSymbolCheckpoint(value) {const key=completedKey(value);if(!key)return null;const saved=calls.saves.find(row=>symbolKey(row)===key);return {rowsCount:saved?.rows.length??1,universeHash:key.split('/')[1],status:saved?.rows.length===0?'no_data':'available'};},
    async confirmSymbol(value) {calls.confirmed.push(value);},
    async markSymbol(value) {calls.attempts.push(value);},
    async saveSymbol(value) {
      calls.saves.push(value);
      await options.beforeSave?.(value, calls);
      complete.add(symbolKey(value));
      return { rowsCount: value.rows.length, brokerCount: new Set(value.rows.map(row => row.org_name)).size,
        fiscalPeriods: [...new Set(value.rows.map(row => row.fiscal_period))] };
    },
    async finalize(value) {
      assert.ok(value.tickers.every(ticker => completedKey({ ...value, ticker })), 'pruning must wait for every pool member');
      calls.finalized.push(value); runs.set(key(value), { status: 'succeeded', summary: value.summary });
      return { deleted: 3 };
    },
    async failRun(value) {
      calls.failed.push(value); runs.set(key(value), { status: value.partial ? 'partial' : 'failed', summary: value.summary });
    },
  };
  const store = {
    async migrate() { calls.migrate++; },
    async withLock(operation) { calls.lock++; return options.busy ? { status: 'busy' } : operation(scope); },
  };
  const collector = async identity => {
    calls.collected.push(identity);
    return options.collect ? options.collect(identity, calls) : payloadOf(identity.ticker);
  };
  const run = overrides => updateRollingHkForecasts({ store, cacheDir, universe, collector, runDate: TODAY, now, ...overrides });
  const cachePath = (ticker = universe.securities[0].ticker, runDate = TODAY) => join(cacheDir, 'HK-forecasts', universeHash, runDate, `${ticker}.json.gz`);
  return { cacheDir, universe, universeHash, calls, runs, complete, scope, store, collector, run, cachePath, symbolKey };
}

test('HK forecast sync archives all 28 current snapshots and prunes only after the whole pool completes', async t => {
  const universe = JSON.parse(await readFile(new URL('../backend/market-data/hk-universe.json', import.meta.url), 'utf8'));
  assert.equal(universe.securities.length, 28);
  const f = await fixture(t, { universe }), result = await f.run();
  assert.equal(result.status, 'succeeded');
  assert.equal(result.summary.plannedTickers, 28);
  assert.equal(result.summary.completedTickers, 28);
  assert.equal(result.summary.downloadedTickers, 28);
  assert.equal(result.summary.rows, 28);
  assert.equal(result.summary.deleted, 3);
  assert.equal(f.calls.finalized.length, 1);
  assert.equal(f.calls.failed.length, 0);
  assert.ok(f.calls.collected.every(value => value.snapshotDate === TODAY && value.endDate === '20261019'));
});

test('HK forecast sync rejects past/future run dates before migration or fetching, using Shanghai today', async t => {
  const f = await fixture(t);
  for (const runDate of ['2026-10-18', '2026-10-20', '2026-02-30']) {
    const result = await f.run({ runDate });
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'validation_error');
  }
  assert.equal(f.calls.migrate, 0);
  assert.equal(f.calls.collected.length, 0);
  const shanghaiToday = await f.run({ now: () => new Date('2026-10-18T16:01:00Z') });
  assert.equal(shanghaiToday.status, 'succeeded');
});

test('HK forecast completed same-day runs verify checkpoints and skip all source and database writes', async t => {
  const f = await fixture(t);
  assert.equal((await f.run()).status, 'succeeded');
  const counts = [f.calls.begins.length, f.calls.saves.length, f.calls.collected.length, f.calls.finalized.length];
  assert.equal((await f.run()).status, 'already_completed');
  assert.deepEqual([f.calls.begins.length, f.calls.saves.length, f.calls.collected.length, f.calls.finalized.length], counts);
});

test('HK forecast partial runs retain success checkpoints and resume only missing members without pruning early', async t => {
  let fail = true;
  const f = await fixture(t, { collect(identity) {
    if (identity.ticker === '02313.HK' && fail) throw errorOf('network');
    return payloadOf(identity.ticker);
  } });
  const first = await f.run();
  assert.equal(first.status, 'partial');
  assert.equal(first.summary.completedTickers, 1);
  assert.equal(first.errorCode, 'network_error');
  assert.equal(f.calls.finalized.length, 0);
  assert.equal(f.calls.failed[0].partial, true);
  fail = false;
  const retried = await f.run();
  assert.equal(retried.status, 'succeeded');
  assert.equal(retried.summary.skippedTickers, 1);
  assert.equal(retried.summary.completedTickers, 2);
  assert.equal(f.calls.collected.filter(value => value.ticker === '00700.HK').length, 1);
  assert.equal(f.calls.finalized.length, 1);
});

test('HK forecast database failure keeps downloaded cache and retries import without another API request', async t => {
  let failSave = true;
  const f = await fixture(t, { beforeSave() { if (failSave) throw errorOf('database'); } });
  const first = await f.run();
  assert.equal(first.status, 'failed');
  assert.equal(first.errorCode, 'database_error');
  assert.equal(f.calls.collected.length, 1, 'database failure stops the run');
  assert.equal(f.calls.finalized.length, 0);
  const cached = JSON.parse(gunzipSync(await readFile(f.cachePath())).toString('utf8'));
  assert.equal(cached.snapshotDate, TODAY);
  assert.equal(cached.rows.length, 1);
  failSave = false;
  const retried = await f.run();
  assert.equal(retried.status, 'succeeded');
  assert.equal(retried.summary.cachedTickers, 1);
  assert.equal(f.calls.collected.filter(value => value.ticker === '00700.HK').length, 1);
  assert.equal(f.calls.finalized.length, 1);
});

test('HK forecast succeeded runs with a missing checkpoint restore that member from cache', async t => {
  const f = await fixture(t);
  await f.run();
  const removedKey = f.symbolKey({ runDate: TODAY, universeHash: f.universeHash, ticker: '02313.HK' });
  f.complete.delete(removedKey);
  const retried = await f.run();
  assert.equal(retried.status, 'succeeded');
  assert.equal(retried.summary.skippedTickers, 1);
  assert.equal(retried.summary.cachedTickers, 1);
  assert.equal(f.calls.collected.length, 2);
});

test('HK forecast next-day runs collect new observations instead of reusing yesterday checkpoints or caches', async t => {
  const f = await fixture(t);
  await f.run();
  const second = await f.run({ runDate: '2026-10-20', now: () => new Date('2026-10-20T01:00:00Z') });
  assert.equal(second.status, 'succeeded');
  assert.equal(second.summary.downloadedTickers, 2);
  assert.equal(second.summary.skippedTickers, 0);
  assert.equal(f.calls.collected.length, 4);
  assert.ok(f.calls.saves.slice(2).every(value => value.runDate === '2026-10-20'));
  assert.notEqual(f.cachePath('00700.HK'), f.cachePath('00700.HK', '2026-10-20'));
  assert.equal(JSON.parse(gunzipSync(await readFile(f.cachePath('00700.HK', '2026-10-20')))).snapshotDate, '2026-10-20');
});

test('HK forecast explicit no-data evidence and fully outside-window coverage can save empty successful snapshots', async t => {
  for (const coverage of [
    { sourceRows: 0, rowsInRange: 0, outsideRange: 0, noDataEvidence: 'identified broker table has no rows' },
    { sourceRows: 3, rowsInRange: 0, outsideRange: 3 },
  ]) {
    const f = await fixture(t, { collect: identity => payloadOf(identity.ticker, { rows: [], coverage }) });
    const result = await f.run();
    assert.equal(result.status, 'succeeded');
    assert.equal(result.summary.emptyTickers, 2);
    assert.equal(result.summary.rows, 0);
    assert.ok(f.calls.saves.every(value => value.rows.length === 0));
  }
});

test('HK forecast unproven or inconsistent empty coverage cannot erase an earlier successful observation', async t => {
  const invalidCoverages = [
    { sourceRows: 0, rowsInRange: 0, noDataEvidence: undefined },
    { sourceRows: 3, rowsInRange: 0, outsideRange: undefined },
    { sourceRows: 3, rowsInRange: 0, outsideRange: 1 },
    { sourceRows: 1, rowsInRange: 0, outsideRange: -1 },
    { sourceRows: 0, rowsInRange: 0, noDataEvidence: '' },
  ];
  for (const coverage of invalidCoverages) {
    const f = await fixture(t, { collect: identity => payloadOf(identity.ticker, { rows: [], coverage }) });
    const result = await f.run();
    assert.equal(result.status, 'failed', JSON.stringify(coverage));
    assert.equal(result.errorCode, 'validation_error');
    assert.equal(f.calls.saves.length, 0);
    assert.equal(f.calls.finalized.length, 0);
  }
});

test('HK forecast provider/API errors are sanitized and never mark an uncovered page successful', async t => {
  for (const kind of ['network', 'invalid_response', 'rate_limit', 'http']) {
    const f = await fixture(t, { collect() { throw errorOf(kind); } });
    const result = await f.run();
    assert.equal(result.status, 'failed');
    assert.equal(result.summary.completedTickers, 0);
    assert.equal(f.calls.saves.length, 0);
    assert.equal(f.calls.finalized.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /secret|connection detail/);
    if (['rate_limit', 'http'].includes(kind)) assert.equal(f.calls.collected.length, 1);
  }
});

test('HK forecast malformed source metadata, mismatched stocks and invalid EPS all reject before saving', async t => {
  for (const mutate of [
    value => { value.source = 'other'; },
    value => { value.apiName = 'other_api'; },
    value => { value.coverage.dateMeaning = 'report_publication_date'; },
    value => { value.coverage.historicalArchiveAvailable = true; },
    value => { value.rows[0].ts_code = '00001.HK'; },
    value => { value.rows[0].eps = Infinity; },
    value => { value.coverage.rowsInRange = 2; },
  ]) {
    const f = await fixture(t, { collect(identity) { const value = payloadOf(identity.ticker); mutate(value); return value; } });
    const result = await f.run();
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'validation_error');
    assert.equal(f.calls.saves.length, 0);
    assert.equal(f.calls.finalized.length, 0);
  }
});

test('HK forecast corrupt or wrong-identity caches are quarantined before a fresh validated download', async t => {
  for (const mutate of [
    () => Buffer.from('not a gzip file'),
    value => gzipSync(Buffer.from(JSON.stringify({ ...value, snapshotDate: '2026-10-18' }))),
    value => gzipSync(Buffer.from(JSON.stringify({ ...value, source: 'other' }))),
    value => gzipSync(Buffer.from(JSON.stringify({ ...value, rows: [{ ...value.rows[0], ts_code: '00001.HK' }] }))),
  ]) {
    const f = await fixture(t);
    const cachePath = f.cachePath(), identity = {
      version: 1, universeHash: f.universeHash, source: 'etnet', apiName: 'etnet_hk_profit_forecast',
      ticker: '00700.HK', snapshotDate: TODAY, startDate: '20251019', endDate: '20261019',
      ...payloadOf('00700.HK'), fetchedAt: '2026-10-19T01:00:00.000Z',
    };
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, mutate(identity));
    const result = await f.run();
    assert.equal(result.status, 'succeeded');
    assert.equal(f.calls.collected.length, 2);
    const files = await readdir(dirname(cachePath));
    assert.equal(files.filter(file => file.startsWith('00700.HK.json.gz.rejected-')).length, 1);
    assert.equal(JSON.parse(gunzipSync(await readFile(cachePath))).source, 'etnet');
  }
});

test('HK forecast advisory-lock contention does not collect, finalize or fail a run', async t => {
  const f = await fixture(t, { busy: true }), result = await f.run();
  assert.equal(result.status, 'busy');
  assert.equal(f.calls.collected.length, 0);
  assert.equal(f.calls.begins.length, 0);
  assert.equal(f.calls.finalized.length, 0);
  assert.equal(f.calls.failed.length, 0);
});

test('all-market forecasts use the verified current listing catalog and explicit source-empty snapshots outside the pool',async t=>{
  const tickers=['00001.HK','00700.HK','02313.HK'],f=await fixture(t,{collect:identity=>payloadOf(identity.ticker,identity.ticker==='00001.HK'?{rows:[],coverage:{noDataEvidence:'identified forecast module states no data'}}:{})});
  const result=await f.run({scope:'all',catalog:catalogOf(tickers)});
  assert.equal(result.status,'succeeded');assert.equal(result.forecastScope,'all');
  assert.equal(result.summary.plannedTickers,3);assert.equal(result.summary.noDataTickers,1);assert.equal(result.summary.failedTickers,0);
  assert.deepEqual(f.calls.saves.map(value=>value.ticker),tickers);
  assert.ok(f.calls.saves.every(value=>value.scope==='all'&&value.coverage.kind==='current_snapshot'));
  assert.ok(f.calls.attempts.every(value=>value.status==='running'));
  const cache=JSON.parse(gunzipSync(await readFile(join(f.cacheDir,'HK-forecasts','all',TODAY,'00001.HK.json.gz'))));
  assert.equal(cache.universeHash,undefined);assert.equal(cache.snapshotDate,TODAY);assert.equal(cache.fetchedAt,now().toISOString());
});

test('all-market membership changes reuse current-day per-symbol checkpoints without refetching the original pool',async t=>{
  const f=await fixture(t);
  await f.run();
  const result=await f.run({scope:'all',catalog:catalogOf(['00001.HK','00700.HK','02313.HK'])});
  assert.equal(result.status,'succeeded');assert.equal(result.summary.skippedTickers,2);assert.equal(result.summary.downloadedTickers,1);
  assert.equal(f.calls.collected.filter(value=>value.ticker==='00700.HK').length,1);
  assert.equal(f.calls.collected.filter(value=>value.ticker==='02313.HK').length,1);
  assert.equal(f.calls.confirmed.length,2);
  assert.equal(result.summary.rows,3);
});

test('all-market corrupt or stale listings cannot trigger imports and today observations are never backdated after midnight',async t=>{
  const f=await fixture(t);
  for(const change of [{complete:false},{asOf:'2026-10-18'},{universeHash:'0'.repeat(64)},{audit:{pendingRecords:1,confirmedRecords:2,tushareOnly:[]}}]){
    const result=await f.run({scope:'all',catalog:{...catalogOf(),...change}});
    assert.equal(result.status,'failed');assert.equal(result.errorCode,'validation_error');
  }
  assert.equal(f.calls.migrate,0);assert.equal(f.calls.collected.length,0);
  let observed=now();
  const midnight=await f.run({scope:'all',catalog:catalogOf(),now:()=>observed,collector:async identity=>{
    observed=new Date('2026-10-19T16:00:00Z');return payloadOf(identity.ticker);
  }});
  assert.equal(midnight.status,'failed');assert.equal(midnight.errorCode,'observation_date_changed');
  assert.equal(f.calls.saves.length,0);assert.equal(f.calls.attempts.at(-1).status,'failed');
});

test('all-market workers overlap source latency while all complete database transactions remain serialized',async t=>{
  let activeCollect=0,maxCollect=0,activeSave=0,maxSave=0;
  const tickers=['00001.HK','00002.HK','00003.HK','00004.HK','00005.HK','00006.HK'];
  const f=await fixture(t,{async collect(identity){activeCollect++;maxCollect=Math.max(maxCollect,activeCollect);await new Promise(resolve=>setTimeout(resolve,5));activeCollect--;return payloadOf(identity.ticker);},
    async beforeSave(){activeSave++;maxSave=Math.max(maxSave,activeSave);await new Promise(resolve=>setTimeout(resolve,5));activeSave--;}});
  const result=await f.run({scope:'all',catalog:catalogOf(tickers),concurrency:3});
  assert.equal(result.status,'succeeded');assert.equal(result.summary.completedTickers,6);
  assert.equal(maxCollect,3);assert.equal(maxSave,1);
});

test('all-market fatal provider errors stop new assignments while started requests can finish safely',async t=>{
  const tickers=['00001.HK','00002.HK','00003.HK','00004.HK','00005.HK','00006.HK'];
  const f=await fixture(t,{async collect(identity){if(identity.ticker==='00001.HK')throw errorOf('rate_limit');await new Promise(resolve=>setTimeout(resolve,5));return payloadOf(identity.ticker);}});
  const result=await f.run({scope:'all',catalog:catalogOf(tickers),concurrency:3});
  assert.equal(result.status,'partial');assert.equal(result.errorCode,'rate_limited');
  assert.ok(f.calls.collected.length<=3);assert.ok(f.calls.saves.every(value=>['00002.HK','00003.HK'].includes(value.ticker)));
  assert.equal(f.calls.finalized.length,0);assert.equal(f.calls.attempts.filter(value=>value.status==='failed').length,1);
});
