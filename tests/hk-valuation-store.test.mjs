import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { createHkValuationStore, validateHkValuationRows, HK_VALUATION_LOCK_KEYS } from '../backend/market-data/hk-valuation-store.mjs';
import { HK_POOL_LOCK_KEYS } from '../backend/market-data/hk-pool-store.mjs';
import { validateHongKongUniverse } from '../backend/market-data/hk-pool-universe.mjs';

const universe = validateHongKongUniverse({ version: 1, source: { path: '/pool.xlsx', sheet: '合并价值投资池' },
  securities: [{ ticker: '00700.HK', name: '腾讯控股', row: 2 }, { ticker: '02020.HK', name: '安踏体育', row: 3 }] });
const options = { runDate: '2026-10-19', windowStart: '20251019', windowEnd: '20261018',
  tickers: universe.tickers, universeHash: universe.universeHash };
const running = { status: 'running', tickers: universe.tickers, universe_hash: universe.universeHash, universeHash: universe.universeHash,
  window_start: '2025-10-19', window_end: '2026-10-18', windowStart: '2025-10-19', windowEnd: '2026-10-18' };
const row = (date = '20261016', overrides = {}) => ({ ts_code: '00700.HK', trade_date: date, pe_ttm: '15.25001', pb: '3.725', ...overrides });
const symbol = (extra = {}) => ({ ...options, ticker: '00700.HK', rows: [row()], ...extra });
const compact = sql => sql.replace(/\s+/g, ' ').trim();

function mockPool({ locked = true, run = running, dates = ['20261016'], completed = {}, attempt=null, failOn } = {}) {
  const calls = [], releases = [], clients = [];
  async function query(sql, values) {
    calls.push({ sql, values }); const text = compact(sql);
    if (failOn?.(text, values)) throw Object.assign(new Error('postgresql://private-user:secret-password@private-host/db'), { code: '08006' });
    if (text.includes('pg_try_advisory_lock')) return { rows: [{ locked }] };
    if (text.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
    if (text.startsWith('SELECT') && text.includes('FROM market_data.hk_valuation_update_runs')) return { rows: run ? [run] : [] };
    if (text.startsWith('SELECT') && text.includes('FROM market_data.hk_valuation_symbol_attempts'))return {rows:attempt?[attempt]:[]};
    if (text.startsWith('SELECT') && text.includes('FROM market_data.hk_valuation_symbol_runs')) {
      const value = Object.hasOwn(completed, values[2]) ? completed[values[2]] : { rows_count: dates.length, expected_count: dates.length, stored_count: dates.length };
      return { rows: value === null ? [] : Array.isArray(value)?value:[value] };
    }
    if (text.startsWith('SELECT') && text.includes('FROM market_data.daily_prices')) return { rows: dates.map(trade_date => ({ trade_date })) };
    return { rows: [], rowCount: 2 };
  }
  return { calls, releases, clients, query,
    async connect() { const client = new EventEmitter(); client.query = query; client.release = broken => releases.push(broken); clients.push(client); return client; },
    async end() {},
  };
}

test('HK valuation schema is additive with distinct tables, HK keys, provider identity and nullable signed multiples', async () => {
  const pool = mockPool(); await createHkValuationStore({ pool }).migrate();
  const schema = pool.calls.find(call => call.sql.includes('CREATE TABLE IF NOT EXISTS market_data.hk_daily_valuations')).sql;
  assert.match(schema, /PRIMARY KEY\s*\(ts_code,\s*trade_date\)/);
  assert.match(schema, /PRIMARY KEY\s*\(run_date,\s*universe_hash\)/);
  assert.match(schema, /PRIMARY KEY\s*\(run_date,\s*universe_hash,\s*ts_code\)/);
  assert.match(schema, /pe_ttm numeric\s*,/); assert.match(schema, /pb numeric\s*,/);
  assert.match(schema, /source = 'baidu'/); assert.match(schema, /source_api = 'baidu_hk_valuation'/);
  assert.match(schema, /\[0-9\]\{5\}\\\.HK/);
  assert.doesNotMatch(schema, /\b(?:DROP|TRUNCATE|DELETE)\b|CREATE TABLE.*market_data\.daily_valuations/i);
});

test('source validation preserves explicit NULL, negative, zero and exact decimal values without coercion', () => {
  const values = [row('20261015', { pe_ttm: null, pb: '-0.50' }), row('20261016', { pe_ttm: -12.375, pb: 0 }),
    row('20261017', { pe_ttm: '1e2', pb: '0.1234567890123456789' })];
  assert.equal(validateHkValuationRows(values, { ticker: '00700.HK', startDate: options.windowStart, endDate: options.windowEnd }), values);
  const missing = row(); delete missing.pb;
  for (const rows of [[], [missing], [row(), row()], [row('20261019')], [row('20250230')],
    [row('2026-10-16')], [row('20261016', { ts_code: '002920.SZ' })], [row('20261016', { ts_code: '02020.HK' })]]) {
    assert.throws(() => validateHkValuationRows(rows, { ticker: '00700.HK', startDate: options.windowStart, endDate: options.windowEnd }));
  }
  for (const value of ['', ' ', 'NaN', 'Infinity', '0x10', true, {}, [], Infinity, -Infinity, NaN, undefined]) {
    assert.throws(() => validateHkValuationRows([row('20261016', { pe_ttm: value })], { ticker: '00700.HK', startDate: options.windowStart, endDate: options.windowEnd }));
  }
});

test('calendar carry-forwards are excluded and only actual stored HK trade dates commit atomically', async () => {
  const pool = mockPool({ dates: ['20261015', '20261016'] });
  const result = await createHkValuationStore({ pool }).withLock(scope => scope.saveSymbol(symbol({ rows: [
    row('20261015', { pe_ttm: null, pb: '-0.50' }), row('20261016', { pe_ttm: '-12.375', pb: null }), row('20261017'), row('20261018'),
  ] })));
  assert.deepEqual(result, { rowsCount: 2, sourceRowsCount: 4, firstDate: '20261015', lastDate: '20261016' });
  const prices = pool.calls.find(call => call.sql.includes('SELECT to_char(trade_date'));
  assert.match(compact(prices.sql), /market\s*=\s*'HK' AND ts_code\s*=\s*\$1 AND trade_date BETWEEN \$2 AND \$3/);
  assert.deepEqual(prices.values, ['00700.HK', '2025-10-19', '2026-10-18']);
  const write = pool.calls.find(call => call.sql.startsWith('INSERT INTO market_data.hk_daily_valuations'));
  assert.deepEqual(write.values, ['00700.HK', '2026-10-15', null, '-0.50', 'baidu', 'baidu_hk_valuation',
    '00700.HK', '2026-10-16', '-12.375', null, 'baidu', 'baidu_hk_valuation']);
  assert.match(compact(write.sql), /ON CONFLICT\s*\(ts_code,\s*trade_date\) DO UPDATE/);
  const ledger = pool.calls.find(call => call.sql.startsWith('INSERT INTO market_data.hk_valuation_symbol_runs'));
  assert.deepEqual(ledger.values, ['2026-10-19', universe.universeHash, '00700.HK', 2, '2026-10-18']);
  assert.ok(pool.calls.findIndex(call => call.sql === 'BEGIN') < pool.calls.indexOf(write));
  assert.ok(pool.calls.indexOf(write) < pool.calls.indexOf(ledger));
  assert.ok(pool.calls.indexOf(ledger) < pool.calls.findIndex(call => call.sql === 'COMMIT'));
  assert.equal(pool.calls.some(call => /market_data\.daily_valuations|sync_days|DELETE FROM market_data\.daily_prices/.test(call.sql)), false);
});

test('missing an actual trade date or an empty price window cannot save or prune an apparently complete calendar response', async () => {
  for (const dates of [['20261015', '20261016'], []]) {
    const pool = mockPool({ dates });
    await assert.rejects(createHkValuationStore({ pool }).withLock(scope => scope.saveSymbol(symbol({ rows: [row('20261015')] }))), { kind: 'incomplete_window' });
    assert.equal(pool.calls.some(call => /^(?:INSERT|DELETE|UPDATE)/.test(call.sql)), false);
    assert.equal(pool.calls.some(call => call.sql === 'COMMIT'), false); assert.equal(pool.calls.at(-2).sql, 'ROLLBACK');
  }
});

test('symbol checkpoint failure rolls back its valuation rows without marking a global completed day', async () => {
  const pool = mockPool({ failOn: sql => sql.startsWith('INSERT INTO market_data.hk_valuation_symbol_runs') });
  await assert.rejects(createHkValuationStore({ pool }).withLock(scope => scope.saveSymbol(symbol())), error => {
    assert.equal(error.code, 'DATABASE_ERROR'); assert.doesNotMatch(error.message, /postgresql|private|secret-password/); return true;
  });
  assert.ok(pool.calls.some(call => call.sql.startsWith('INSERT INTO market_data.hk_daily_valuations')));
  assert.equal(pool.calls.at(-2).sql, 'ROLLBACK'); assert.equal(pool.calls.some(call => call.sql === 'COMMIT' || call.sql.startsWith('DELETE')), false);
});

test('per-symbol completion verifies both price session count and source-specific stored valuation count', async () => {
  for (const counts of [null, { rows_count: 0, expected_count: 0, stored_count: 0 },
    { rows_count: 1, expected_count: 2, stored_count: 1 }, { rows_count: 2, expected_count: 2, stored_count: 1 },
    { rows_count: '2', expected_count: '2', stored_count: '2' }]) {
    const pool = mockPool({ completed: { '00700.HK': counts } });
    const complete = await createHkValuationStore({ pool }).withLock(scope => scope.symbolComplete(symbol()));
    assert.equal(complete, counts?.rows_count === '2');
    const query = pool.calls.find(call => call.sql.includes('FROM market_data.hk_valuation_symbol_runs'));
    assert.match(compact(query.sql), /p\.market\s*=\s*'HK'/);
    assert.match(compact(query.sql), /JOIN market_data\.daily_prices p USING\s*\(ts_code,\s*trade_date\)/);
    assert.match(compact(query.sql), /v\.source\s*=\s*'baidu' AND v\.source_api\s*=\s*'baidu_hk_valuation'/);
  }
});

test('finalization checks every current ticker before deleting only expired current-pool HK valuations', async () => {
  const pool = mockPool(); const summary = { completedTickers: 2 };
  const result = await createHkValuationStore({ pool }).withLock(scope => scope.finalize({ ...options, summary }));
  assert.equal(result.deleted, 2);
  const checks = pool.calls.filter(call => compact(call.sql).startsWith('SELECT') && call.sql.includes('FROM market_data.hk_valuation_symbol_runs'));
  assert.deepEqual(checks.map(call => call.values[2]), universe.tickers);
  const prune = pool.calls.find(call => call.sql.startsWith('DELETE FROM market_data.hk_daily_valuations'));
  assert.match(compact(prune.sql), /trade_date < \$1/);
  assert.match(compact(prune.sql), /ts_code\s*=\s*ANY\(\$2::text\[\]\)/);
  assert.match(prune.sql, /source\s*=\s*'baidu'/); assert.match(prune.sql, /source_api\s*=\s*'baidu_hk_valuation'/);
  assert.deepEqual(prune.values, ['2025-10-19', universe.tickers]);
  assert.ok(pool.calls.indexOf(checks.at(-1)) < pool.calls.indexOf(prune));
  const success = pool.calls.find(call => call.sql.startsWith('UPDATE market_data.hk_valuation_update_runs'));
  assert.match(success.sql, /status\s*=\s*'succeeded'/); assert.ok(pool.calls.indexOf(success) > pool.calls.indexOf(prune));
  assert.equal(success.values[2], JSON.stringify(summary)); assert.equal(pool.calls.at(-2).sql, 'COMMIT');
  assert.equal(pool.calls.some(call => /DELETE FROM market_data\.(?:daily_prices|daily_valuations)\b/.test(call.sql)), false);
});

test('an incomplete ticker prevents retention and success; failed success recording rolls retention back', async () => {
  const missing = mockPool({ completed: { '02020.HK': null } });
  await assert.rejects(createHkValuationStore({ pool: missing }).withLock(scope => scope.finalize({ ...options, summary: {} })), { kind: 'incomplete_window' });
  assert.equal(missing.calls.some(call => /^(?:DELETE|UPDATE)/.test(call.sql) || call.sql === 'COMMIT'), false);
  assert.equal(missing.calls.at(-2).sql, 'ROLLBACK');
  const failure = mockPool({ failOn: sql => sql.startsWith('UPDATE market_data.hk_valuation_update_runs') });
  await assert.rejects(createHkValuationStore({ pool: failure }).withLock(scope => scope.finalize({ ...options, summary: {} })), { code: 'DATABASE_ERROR' });
  assert.ok(failure.calls.some(call => call.sql.startsWith('DELETE FROM market_data.hk_daily_valuations')));
  assert.equal(failure.calls.some(call => call.sql === 'COMMIT'), false); assert.equal(failure.calls.at(-2).sql, 'ROLLBACK');
});

test('HK valuation lock is independent, busy lock runs no callback, and every expired scope rejects before SQL', async () => {
  assert.notDeepEqual(HK_VALUATION_LOCK_KEYS, HK_POOL_LOCK_KEYS);
  const pool = mockPool(), store = createHkValuationStore({ pool }); let expired;
  await store.withLock(scope => { expired = scope; });
  assert.deepEqual(pool.calls[0].values, HK_VALUATION_LOCK_KEYS);
  const count = pool.calls.length;
  for (const [method, value] of [['getRun', options], ['priceDates', symbol()], ['symbolComplete', symbol()],
    ['beginRun', options], ['saveSymbol', symbol()], ['finalize', { ...options, summary: {} }], ['failRun', { ...options, summary: {} }]]) {
    await assert.rejects(expired[method](value), { code: 'VALIDATION_ERROR' });
    assert.equal(pool.calls.length, count, `${method} must not send SQL through a released connection`);
  }
  assert.equal(pool.clients[0].listenerCount('error'), 0);
  const busy = mockPool({ locked: false });
  assert.deepEqual(await createHkValuationStore({ pool: busy }).withLock(() => assert.fail('busy lock callback')), { status: 'busy' });
  assert.equal(busy.calls.length, 1); assert.equal(busy.releases.length, 1);
});

test('connection error during a lock scope cannot return apparent success and releases a broken connection', async () => {
  const pool = mockPool();
  await assert.rejects(createHkValuationStore({ pool }).withLock(async () => {
    pool.clients[0].emit('error', new Error('secret-password@private-host')); return { status: 'succeeded' };
  }), error => error.code === 'DATABASE_ERROR' && !/secret-password|private-host/.test(error.message));
  assert.equal(pool.calls.some(call => call.sql.includes('pg_advisory_unlock')), false);
  assert.equal(pool.releases.length, 1); assert.ok(pool.releases[0]); assert.equal(pool.clients[0].listenerCount('error'), 0);
});

test('run and symbol keys are idempotent per date and pool; invalid identities never authorize writes', async () => {
  const pool = mockPool(), store = createHkValuationStore({ pool });
  await store.withLock(async scope => {
    await scope.beginRun(options); await scope.beginRun(options);
    await scope.saveSymbol(symbol()); await scope.saveSymbol(symbol());
    for (const value of [{ ...options, universeHash: '0'.repeat(64) }, { ...options, tickers: ['00700.HK', '00700.HK'] },
      { ...options, tickers: ['002920.SZ'] }, { ...options, windowEnd: '20261019' }]) {
      await assert.rejects(scope.beginRun(value));
    }
    await assert.rejects(scope.saveSymbol(symbol({ ticker: '00941.HK', rows: [row('20261016', { ts_code: '00941.HK' })] })), { code: 'VALIDATION_ERROR' });
    await scope.failRun({ ...options, partial: true, summary: { completedTickers: 1 }, errorCode: 'secret-token-value' });
  });
  const runs = pool.calls.filter(call => call.sql.startsWith('INSERT INTO market_data.hk_valuation_update_runs'));
  assert.equal(runs.length, 2); assert.match(compact(runs[0].sql), /ON CONFLICT\s*\(run_date,\s*universe_hash\) DO UPDATE/);
  assert.deepEqual(runs[0].values, ['2026-10-19', universe.universeHash, universe.tickers, '2025-10-19', '2026-10-18']);
  const checkpoints = pool.calls.filter(call => call.sql.startsWith('INSERT INTO market_data.hk_valuation_symbol_runs'));
  assert.equal(checkpoints.length, 2); assert.match(compact(checkpoints[0].sql), /ON CONFLICT\s*\(run_date,\s*universe_hash,\s*ts_code\) DO UPDATE/);
  const failed = pool.calls.find(call => call.sql.startsWith('UPDATE market_data.hk_valuation_update_runs'));
  assert.match(compact(failed.sql), /status\s*<>\s*'succeeded'/); assert.equal(failed.values[2], 'partial'); assert.equal(failed.values[4], 'provider_error');
});

test('all-market migration adds per-company attempts and restarts only orphan running states under its advisory lock',async()=>{
  const pool=mockPool(),store=createHkValuationStore({pool});await store.migrate();
  const schema=pool.calls[0].sql;
  assert.match(schema,/CREATE TABLE IF NOT EXISTS market_data\.hk_valuation_symbol_attempts/);
  assert.match(schema,/status IN \('running','succeeded','no_data','no_price_data','failed'\)/);
  assert.match(schema,/coverage jsonb NOT NULL/);assert.match(schema,/expected_count integer NOT NULL/);
  await store.withLock(scope=>scope.beginRun({...options,scope:'all'}));
  const recovery=pool.calls.find(call=>call.sql.startsWith('UPDATE market_data.hk_valuation_symbol_attempts'));
  assert.match(compact(recovery.sql),/status='failed',rows_count=0,error_code='incomplete_window',updated_at=clock_timestamp\(\) WHERE status='running' AND run_date<=\$1::date/);
  assert.deepEqual(recovery.values,['2026-10-19']);
  assert.ok(pool.calls.findIndex(call=>call.sql==='BEGIN')<pool.calls.indexOf(recovery));
  assert.ok(pool.calls.indexOf(recovery)<pool.calls.findIndex(call=>call.sql==='COMMIT'));
});

test('all-market identities accept thousands of HK companies while pool scope retains its bounded manifest',async()=>{
  const tickers=Array.from({length:1201},(_,index)=>`${String(index+1).padStart(5,'0')}.HK`);
  const large={...options,tickers,universeHash:createHash('sha256').update(tickers.join('\n')).digest('hex')};
  const pool=mockPool();await createHkValuationStore({pool}).withLock(async scope=>{
    await assert.rejects(scope.beginRun(large),{code:'VALIDATION_ERROR'});await scope.beginRun({...large,scope:'all'});
  });
  assert.equal(pool.calls.find(call=>call.sql.startsWith('INSERT INTO market_data.hk_valuation_update_runs')).values[2].length,1201);
});

test('all-market completion reuses the same-day verified price intersection across hashes and rejects new price gaps',async()=>{
  const oldHash='a'.repeat(64),pool=mockPool({completed:{'00700.HK':[
    {universe_hash:options.universeHash,rows_count:1,expected_count:2,stored_count:2},
    {universe_hash:oldHash,rows_count:2,expected_count:2,stored_count:2},
  ]}});
  const checkpoint=await createHkValuationStore({pool}).withLock(scope=>scope.getSymbolCheckpoint({...symbol(),scope:'all'}));
  assert.deepEqual(checkpoint,{rowsCount:2,expectedCount:2,universeHash:oldHash});
  const query=pool.calls.find(call=>call.sql.includes('FROM market_data.hk_valuation_symbol_runs'));
  assert.doesNotMatch(query.sql,/WHERE s\.run_date=\$1 AND s\.universe_hash=\$2/);
  assert.match(query.sql,/ORDER BY \(s\.universe_hash=\$2::text\)/);
});

test('no-price and explicit source-empty attempts never authorize valuation writes or retention',async()=>{
  const noPrice=mockPool({dates:[]});
  await createHkValuationStore({pool:noPrice}).withLock(async scope=>{
    await scope.markSymbol({...symbol(),scope:'all',status:'no_price_data',coverage:{kind:'no_price_data'}});
    await assert.rejects(scope.markSymbol({...symbol(),scope:'all',status:'no_data',noDataEvidence:'explicit source empty'}),{code:'VALIDATION_ERROR'});
  });
  const empty=mockPool();
  await createHkValuationStore({pool:empty}).withLock(async scope=>{
    await assert.rejects(scope.markSymbol({...symbol(),scope:'all',status:'no_price_data'}),{kind:'incomplete_window'});
    await assert.rejects(scope.markSymbol({...symbol(),scope:'all',status:'no_data'}),{code:'VALIDATION_ERROR'});
    await scope.markSymbol({...symbol(),scope:'all',status:'no_data',noDataEvidence:'both metric charts empty',coverage:{kind:'no_data',metricStatus:{pe_ttm:'no_data',pb:'no_data'}}});
  });
  for(const pool of [noPrice,empty])assert.equal(pool.calls.some(call=>/^(?:INSERT INTO market_data\.hk_daily_valuations|INSERT INTO market_data\.hk_valuation_symbol_runs|DELETE)/.test(call.sql)),false);
  const a=noPrice.calls.find(call=>call.sql.startsWith('INSERT INTO market_data.hk_valuation_symbol_attempts'));
  assert.deepEqual(a.values.slice(3,7),['no_price_data',0,0,'no_price_data']);
  const b=empty.calls.find(call=>call.sql.startsWith('INSERT INTO market_data.hk_valuation_symbol_attempts'));
  assert.deepEqual(b.values.slice(3,7),['no_data',0,1,'no_data']);
  assert.equal(JSON.parse(b.values[7]).noDataEvidence,'both metric charts empty');
});

test('a successful partial-metric symbol stores nullable independent values and only then prunes its own expired rows',async()=>{
  const pool=mockPool(),coverage={kind:'partial_metrics',metricStatus:{pe_ttm:'no_data',pb:'available'}};
  const result=await createHkValuationStore({pool}).withLock(scope=>scope.saveSymbol({...symbol({rows:[row('20261016',{pe_ttm:null,pb:'2.345'})]}),scope:'all',coverage}));
  assert.equal(result.rowsCount,1);assert.equal(result.deleted,2);
  const write=pool.calls.find(call=>call.sql.startsWith('INSERT INTO market_data.hk_daily_valuations'));
  assert.deepEqual(write.values.slice(2,4),[null,'2.345']);
  const attempt=pool.calls.find(call=>call.sql.startsWith('INSERT INTO market_data.hk_valuation_symbol_attempts'));
  assert.deepEqual(attempt.values.slice(3,7),['succeeded',1,1,null]);assert.deepEqual(JSON.parse(attempt.values[7]),{...coverage,priceDatesHash:createHash('sha256').update('20261016').digest('hex'),expectedPriceRows:1});
  const prune=pool.calls.find(call=>call.sql.startsWith('DELETE FROM market_data.hk_daily_valuations'));
  assert.deepEqual(prune.values,['2025-10-19','00700.HK']);assert.ok(pool.calls.indexOf(write)<pool.calls.indexOf(attempt)&&pool.calls.indexOf(attempt)<pool.calls.indexOf(prune));
  const broken=mockPool({failOn:sql=>sql.startsWith('INSERT INTO market_data.hk_valuation_symbol_attempts')});
  await assert.rejects(createHkValuationStore({pool:broken}).withLock(scope=>scope.saveSymbol({...symbol(),scope:'all',coverage})),{code:'DATABASE_ERROR'});
  assert.equal(broken.calls.some(call=>call.sql.startsWith('DELETE')),false);assert.ok(broken.calls.some(call=>call.sql==='ROLLBACK'));
});

test('confirming same-day cross-hash valuation coverage updates only attempt metadata and does not rewrite old values',async()=>{
  const oldHash='a'.repeat(64),coverage={kind:'partial_metrics',metricStatus:{pe_ttm:'no_data',pb:'available'}};
  const pool=mockPool({completed:{'00700.HK':{rows_count:2,expected_count:2,stored_count:2,universe_hash:oldHash}},attempt:{status:'succeeded',rows_count:2,expected_count:2,coverage,universe_hash:oldHash}});
  await createHkValuationStore({pool}).withLock(scope=>scope.confirmSymbol({...symbol(),scope:'all'}));
  assert.equal(pool.calls.some(call=>/^(?:INSERT INTO market_data\.hk_daily_valuations|DELETE)/.test(call.sql)),false);
  const attempt=pool.calls.find(call=>call.sql.startsWith('INSERT INTO market_data.hk_valuation_symbol_attempts'));
  assert.equal(attempt.values[2],oldHash);assert.deepEqual(JSON.parse(attempt.values[7]),coverage);
});
