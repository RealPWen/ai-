import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createHkForecastStore, validateHkForecastRows, hkForecastWindow, HK_FORECAST_SOURCE, HK_FORECAST_LOCK_KEYS } from '../backend/market-data/hk-forecast-store.mjs';
import { validateHongKongUniverse } from '../backend/market-data/hk-pool-universe.mjs';
import { HK_POOL_LOCK_KEYS } from '../backend/market-data/hk-pool-store.mjs';
import { HK_VALUATION_LOCK_KEYS } from '../backend/market-data/hk-valuation-store.mjs';
import { ROLLING_UPDATE_LOCK_KEYS, HK_ROLLING_UPDATE_LOCK_KEYS } from '../backend/market-data/rolling-update-store.mjs';

const universe = validateHongKongUniverse(JSON.parse(await readFile(new URL('../backend/market-data/hk-universe.json', import.meta.url), 'utf8')));
const options = { ...hkForecastWindow('2026-10-19'), tickers: universe.tickers, universeHash: universe.universeHash };
const row = (overrides = {}) => ({ ts_code: '00700.HK', source_record_id: 'broker-a:2026-12:20261016', report_date: '20261016', report_title: null,
  org_name: '券商甲', author_name: null, fiscal_year: 2026, fiscal_period: '2026-12', eps: '1.234567890123456789', currency: 'HKD',
  eps_basis: null, np: null, pe: '-3.25', rating: null, source_url: 'https://www.etnet.com.hk/www/sc/stocks/realtime/quote_profit.php?code=700',
  raw_data: { sourceEps: '123.4567890123456789', sourceUnit: '港仙/股', shareUnitFactor: 100 }, ...overrides });
const symbol = (extra = {}) => ({ ...options, ticker: '00700.HK', rows: [row()], ...extra });
const compact = sql => sql.replace(/\s+/g, ' ').trim();

function mockPool({ locked = true, run = { status: 'running' }, completed = {}, failOn } = {}) {
  const calls = [], releases = [], clients = [];
  const pool = { calls, releases, clients,
    async query(sql, values) {
      calls.push({ sql, values }); const text = compact(sql);
      if (failOn?.(text, values)) throw new Error('postgresql://private-user:secret-token@private-host/private-db');
      if (text.includes('pg_try_advisory_lock')) return { rows: [{ locked }] };
      if (text.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
      if (text.startsWith('SELECT') && text.includes('FROM market_data.hk_forecast_update_runs')) return { rows: run ? [run] : [] };
      if (text.startsWith('SELECT') && text.includes('FROM market_data.hk_forecast_symbol_runs')) {
        const counts = Object.hasOwn(completed, values[2]) ? completed[values[2]] : { rows_count: 1, stored_count: 1 };
        return { rows: counts ? Array.isArray(counts)?counts:[counts] : [] };
      }
      return { rows: [], rowCount: 3 };
    },
    async connect() { const client = new EventEmitter(); client.query = pool.query; client.release = broken => releases.push(broken); clients.push(client); return client; },
    async end() {},
  };
  return pool;
}

test('HK forecast migration adds independent snapshot and success ledgers, retains signed nullable EPS and source currency', async () => {
  const pool = mockPool(); await createHkForecastStore({ pool }).migrate();
  const schema = pool.calls[0].sql;
  for (const table of ['hk_sell_side_forecasts', 'hk_forecast_update_runs', 'hk_forecast_symbol_runs']) assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS market_data\\.${table}`));
  assert.match(schema, /snapshot_date date NOT NULL/); assert.match(schema, /eps numeric\s*,/); assert.match(schema, /currency text CHECK \(currency IS NULL/);
  assert.match(schema, /source = 'etnet'/); assert.match(schema, /source_api = 'etnet_hk_profit_forecast'/); assert.match(schema, /CHECK \(report_date <= snapshot_date\)/);
  assert.match(schema, /PRIMARY KEY\(run_date,universe_hash\)/); assert.match(schema, /PRIMARY KEY\(run_date,universe_hash,ts_code\)/);
  assert.match(schema, /FOREIGN KEY\(run_date,universe_hash\)/); assert.match(schema, /raw_data jsonb NOT NULL/); assert.match(schema, /not a historical report archive/);
  assert.doesNotMatch(schema, /\b(?:DELETE|DROP|TRUNCATE)\b|CREATE TABLE IF NOT EXISTS market_data\.sell_side_forecasts\b/i);
  assert.deepEqual(HK_FORECAST_SOURCE, { source: 'etnet', apiName: 'etnet_hk_profit_forecast' });
});

test('HK validation keeps source precision, signed/zero/NULL EPS, known and unknown currency, and raw share-unit provenance', () => {
  const samples = [row(), row({ source_record_id: 'b', eps: -1.5, currency: 'CNY', eps_basis: '基本 EPS', pe: 0 }),
    row({ source_record_id: 'c', eps: 0, currency: 'USD', raw_data: { sourceEps: '0', sourceUnit: '美仙', shareUnitFactor: 100 } }),
    row({ source_record_id: 'd', eps: null, currency: null, pe: null })];
  const validated = validateHkForecastRows(samples, { ticker: '00700.HK', startDate: options.windowStart, endDate: options.windowEnd });
  assert.deepEqual(validated, samples); assert.equal(validated[0].eps, '1.234567890123456789'); assert.equal(validated[3].currency, null);
  assert.deepEqual(validated[0].raw_data, { sourceEps: '123.4567890123456789', sourceUnit: '港仙/股', shareUnitFactor: 100 });
  assert.deepEqual(validateHkForecastRows([], { ticker: '00700.HK', startDate: options.windowStart, endDate: options.windowEnd }), []);
});

test('identical HK snapshots deduplicate independent of object key order while distinct broker/currency/period observations survive', () => {
  const original = row(), reordered = Object.fromEntries(Object.entries(row()).reverse()); reordered.raw_data = Object.fromEntries(Object.entries(original.raw_data).reverse());
  const rows = [original, reordered, row({ org_name: '券商乙' }), row({ currency: 'CNY' }), row({ fiscal_period: '2026-06' }), row({ eps: '2' })];
  const result = validateHkForecastRows(rows, { ticker: '00700.HK', startDate: options.windowStart, endDate: options.windowEnd });
  assert.equal(result.length, 5); assert.equal(result[0], reordered); assert.equal(result.at(-1).eps, '2');
});

test('HK row validation rejects missing values, wrong stock, invalid fiscal period, nonfinite estimates and escaped source dates', () => {
  const missing = row(); delete missing.eps;
  for (const sample of [missing, row({ ts_code: '02020.HK' }), row({ ts_code: '002920.SZ' }), row({ org_name: ' ' }), row({ source_record_id: '' }),
    row({ fiscal_year: '2026' }), row({ fiscal_period: '2027-12' }), row({ fiscal_period: '2026-13' }), row({ raw_data: [] }), row({ raw_data: null }),
    row({ report_date: '2026-10-16' }), row({ report_date: '20261020' }), row({ report_date: '20251018' }), row({ report_date: '20260230' }),
    row({ currency: 'hkd' }), row({ currency: '港元' }), row({ eps_basis: {} }), row({ author_name: 1 })]) {
    assert.throws(() => validateHkForecastRows([sample], { ticker: '00700.HK', startDate: options.windowStart, endDate: options.windowEnd }));
  }
  for (const field of ['eps', 'np', 'pe']) for (const value of ['', ' ', 'NaN', 'Infinity', '0x10', true, [], {}, undefined, NaN, Infinity, -Infinity]) {
    assert.throws(() => validateHkForecastRows([row({ [field]: value })], { ticker: '00700.HK', startDate: options.windowStart, endDate: options.windowEnd }));
  }
});

test('HK source URLs require the canonical HTTPS ETNet endpoint and an unambiguous matching decimal stock code', () => {
  const base = 'https://www.etnet.com.hk/www/sc/stocks/realtime/quote_profit.php';
  for (const url of [`${base}?code=2020`, `${base}?code=700&code=2020`, `${base}?code=700&code=700`, `${base}?code=7e2`, `${base}?code=0x2bc`, `${base}?code=700.0`,
    `${base}?code=700&redirect=x`, `${base}?code=700#code=2020`, base, base.replace('https:', 'http:') + '?code=700',
    base.replace('www.etnet.com.hk', 'www.etnet.com.hk.evil.test') + '?code=700', base.replace('/quote_profit.php', '/quote.php') + '?code=700',
    base.replace('https://', 'https://user:pass@') + '?code=700', base.replace('www.etnet.com.hk', 'www.etnet.com.hk:8443') + '?code=700', 'javascript:alert(1)']) {
    assert.throws(() => validateHkForecastRows([row({ source_url: url })], { ticker: '00700.HK', startDate: options.windowStart, endDate: options.windowEnd }), { code: 'VALIDATION_ERROR' }, url);
  }
});

test('a symbol transaction replaces only its daily pool snapshot and commits raw rows before the zero-safe completion ledger', async () => {
  const pool = mockPool(), raw = row({ report_title: "x'); DROP TABLE test; --" });
  const result = await createHkForecastStore({ pool }).withLock(scope => scope.saveSymbol(symbol({ rows: [raw, structuredClone(raw)] })));
  assert.deepEqual(result, { rowsCount: 1, brokerCount: 1, fiscalPeriods: ['2026-12'] });
  const deletion = pool.calls.find(call => call.sql.startsWith('DELETE FROM market_data.hk_sell_side_forecasts'));
  assert.match(compact(deletion.sql), /WHERE snapshot_date=\$1 AND universe_hash=\$2 AND ts_code=\$3$/);
  assert.deepEqual(deletion.values, ['2026-10-19', universe.universeHash, '00700.HK']);
  const write = pool.calls.find(call => call.sql.startsWith('INSERT INTO market_data.hk_sell_side_forecasts'));
  assert.match(write.values[0], /^[a-f0-9]{64}$/); assert.deepEqual(write.values.slice(1, 6), ['2026-10-19', universe.universeHash, '00700.HK', raw.source_record_id, '2026-10-16']);
  assert.equal(write.values[6], raw.report_title); assert.equal(write.values[11], raw.eps); assert.equal(write.values[12], 'HKD'); assert.equal(write.values[13], null);
  assert.deepEqual(write.values.slice(17, 20), ['etnet', 'etnet_hk_profit_forecast', raw.source_url]); assert.deepEqual(JSON.parse(write.values[20]), raw.raw_data);
  assert.doesNotMatch(write.sql, /DROP TABLE test/); assert.match(write.sql, /ON CONFLICT\(forecast_id\) DO NOTHING/);
  const checkpoint = pool.calls.find(call => call.sql.startsWith('INSERT INTO market_data.hk_forecast_symbol_runs'));
  assert.deepEqual(checkpoint.values, ['2026-10-19', universe.universeHash, '00700.HK', 1]);
  assert.ok(pool.calls.findIndex(call => call.sql === 'BEGIN') < pool.calls.indexOf(deletion)); assert.ok(pool.calls.indexOf(deletion) < pool.calls.indexOf(write));
  assert.ok(pool.calls.indexOf(write) < pool.calls.indexOf(checkpoint)); assert.ok(pool.calls.indexOf(checkpoint) < pool.calls.findIndex(call => call.sql === 'COMMIT'));
  assert.equal(pool.calls.some(call => /market_data\.(?:sell_side_forecasts|daily_prices|daily_valuations)\b/.test(call.sql)), false);
});

test('a successful empty current snapshot deletes old same-day rows and records zero so readers cannot revive a previous snapshot', async () => {
  const pool = mockPool({ completed: { '00700.HK': { rows_count: 0, stored_count: 0 } } });
  const result = await createHkForecastStore({ pool }).withLock(async scope => {
    const saved = await scope.saveSymbol(symbol({ rows: [] })); assert.equal(await scope.symbolComplete(symbol()), true); return saved;
  });
  assert.deepEqual(result, { rowsCount: 0, brokerCount: 0, fiscalPeriods: [] });
  assert.ok(pool.calls.some(call => call.sql.startsWith('DELETE FROM market_data.hk_sell_side_forecasts')));
  assert.equal(pool.calls.some(call => call.sql.startsWith('INSERT INTO market_data.hk_sell_side_forecasts')), false);
  const checkpoint = pool.calls.find(call => call.sql.startsWith('INSERT INTO market_data.hk_forecast_symbol_runs')); assert.equal(checkpoint.values[3], 0);
  assert.ok(pool.calls.some(call => call.sql === 'COMMIT'));
});

test('delete, row insert, checkpoint and commit failures roll the whole symbol back without leaking database credentials', async () => {
  for (const target of ['DELETE FROM market_data.hk_sell_side_forecasts', 'INSERT INTO market_data.hk_sell_side_forecasts', 'INSERT INTO market_data.hk_forecast_symbol_runs', 'COMMIT']) {
    const pool = mockPool({ failOn: sql => sql.startsWith(target) });
    await assert.rejects(createHkForecastStore({ pool }).withLock(scope => scope.saveSymbol(symbol())), error => error.code === 'DATABASE_ERROR' && !/private|secret|postgresql/.test(error.message));
    assert.ok(pool.calls.some(call => call.sql === 'ROLLBACK')); assert.equal(pool.calls.at(-2).sql, 'ROLLBACK'); assert.equal(pool.releases.length, 1);
  }
});

test('symbol checkpoints validate stored source-specific snapshot counts including zero, rather than trusting a success flag', async () => {
  for (const [counts, expected] of [[null, false], [{ rows_count: 0, stored_count: 0 }, true], [{ rows_count: 2, stored_count: 1 }, false], [{ rows_count: '2', stored_count: '2' }, true]]) {
    const pool = mockPool({ completed: { '00700.HK': counts } });
    assert.equal(await createHkForecastStore({ pool }).withLock(scope => scope.symbolComplete(symbol())), expected);
    const check = pool.calls.find(call => call.sql.includes('FROM market_data.hk_forecast_symbol_runs'));
    assert.match(check.sql, /f\.snapshot_date=\$1 AND f\.universe_hash=\$2 AND f\.ts_code=\$3/);
    assert.match(check.sql, /f\.source='etnet' AND f\.source_api='etnet_hk_profit_forecast'/); assert.match(check.sql, /s\.status='succeeded'/);
    assert.deepEqual(check.values, ['2026-10-19', universe.universeHash, '00700.HK']);
  }
});

test('all 28 current-pool stock checkpoints must complete before retention or successful finalization', async () => {
  assert.equal(universe.tickers.length, 28);
  for (const counts of [null, { rows_count: 2, stored_count: 1 }]) {
    const pool = mockPool({ completed: { [universe.tickers.at(-1)]: counts } });
    await assert.rejects(createHkForecastStore({ pool }).withLock(scope => scope.finalize({ ...options, summary: {} })));
    const checks = pool.calls.filter(call => compact(call.sql).startsWith('SELECT') && call.sql.includes('FROM market_data.hk_forecast_symbol_runs'));
    assert.deepEqual(checks.map(call => call.values[2]), universe.tickers);
    assert.equal(pool.calls.some(call => /^(?:DELETE|UPDATE)/.test(call.sql) || call.sql === 'COMMIT'), false); assert.equal(pool.calls.at(-2).sql, 'ROLLBACK');
  }
});

test('completed pool retention removes only expired HK EPS snapshots for current members and source, then commits success', async () => {
  const pool = mockPool(), summary = { completedTickers: 28, emptyTickers: 1 };
  const result = await createHkForecastStore({ pool }).withLock(scope => scope.finalize({ ...options, summary }));
  assert.deepEqual(result, { deleted: 3 });
  const checks = pool.calls.filter(call => compact(call.sql).startsWith('SELECT') && call.sql.includes('FROM market_data.hk_forecast_symbol_runs')); assert.equal(checks.length, 28);
  const prune = pool.calls.find(call => call.sql.startsWith('DELETE FROM market_data.hk_sell_side_forecasts'));
  assert.match(compact(prune.sql), /snapshot_date < \$1 AND ts_code=ANY\(\$2::text\[\]\)/); assert.match(prune.sql, /source='etnet' AND source_api='etnet_hk_profit_forecast'/);
  assert.deepEqual(prune.values, ['2025-10-19', universe.tickers]); assert.ok(pool.calls.indexOf(checks.at(-1)) < pool.calls.indexOf(prune));
  const success = pool.calls.find(call => call.sql.startsWith('UPDATE market_data.hk_forecast_update_runs'));
  assert.match(success.sql, /status='succeeded'/); assert.deepEqual(success.values, ['2026-10-19', universe.universeHash, JSON.stringify(summary)]);
  assert.ok(pool.calls.indexOf(prune) < pool.calls.indexOf(success)); assert.equal(pool.calls.at(-2).sql, 'COMMIT');
  assert.equal(pool.calls.some(call => /DELETE FROM market_data\.(?:daily_prices|daily_valuations|hk_daily_valuations|sell_side_forecasts)\b/.test(call.sql)), false);
});

test('a failed final success record rolls retention back, and a non-running run cannot authorize a symbol replacement or prune', async () => {
  const pool = mockPool({ failOn: sql => sql.startsWith('UPDATE market_data.hk_forecast_update_runs') });
  await assert.rejects(createHkForecastStore({ pool }).withLock(scope => scope.finalize({ ...options, summary: {} })), { code: 'DATABASE_ERROR' });
  assert.ok(pool.calls.some(call => call.sql.startsWith('DELETE FROM market_data.hk_sell_side_forecasts'))); assert.equal(pool.calls.at(-2).sql, 'ROLLBACK'); assert.equal(pool.calls.some(call => call.sql === 'COMMIT'), false);
  for (const run of [null, { status: 'succeeded' }, { status: 'failed' }]) {
    const stopped = mockPool({ run });
    await assert.rejects(createHkForecastStore({ pool: stopped }).withLock(scope => scope.saveSymbol(symbol())));
    assert.equal(stopped.calls.some(call => /^(?:DELETE|INSERT|UPDATE)/.test(call.sql)), false); assert.equal(stopped.calls.at(-2).sql, 'ROLLBACK');
  }
});

test('forecast advisory lock is independent, busy callbacks do no work, and expired scopes reject every method before SQL', async () => {
  for (const other of [HK_POOL_LOCK_KEYS, HK_VALUATION_LOCK_KEYS, ROLLING_UPDATE_LOCK_KEYS, HK_ROLLING_UPDATE_LOCK_KEYS]) assert.notDeepEqual(HK_FORECAST_LOCK_KEYS, other);
  const pool = mockPool(), store = createHkForecastStore({ pool }); let expired;
  await store.withLock(scope => { expired = scope; }); assert.deepEqual(pool.calls[0].values, HK_FORECAST_LOCK_KEYS);
  const count = pool.calls.length;
  for (const [method, value] of [['getRun', options], ['symbolComplete', symbol()], ['beginRun', options], ['saveSymbol', symbol()], ['finalize', { ...options, summary: {} }], ['failRun', { ...options, summary: {} }]]) {
    await assert.rejects(expired[method](value), { code: 'VALIDATION_ERROR' }); assert.equal(pool.calls.length, count, method);
  }
  assert.equal(pool.clients[0].listenerCount('error'), 0); assert.equal(pool.releases.length, 1);
  const busy = mockPool({ locked: false }); assert.deepEqual(await createHkForecastStore({ pool: busy }).withLock(() => assert.fail('busy lock invoked callback')), { status: 'busy' }); assert.equal(busy.calls.length, 1);
});

test('a connection error event during the advisory scope cannot return success and releases its broken connection', async () => {
  const pool = mockPool();
  await assert.rejects(createHkForecastStore({ pool }).withLock(async () => { pool.clients[0].emit('error', new Error('private-host secret-token')); return { status: 'succeeded' }; }), error => error.code === 'DATABASE_ERROR' && !/private|secret/.test(error.message));
  assert.equal(pool.calls.some(call => call.sql.includes('pg_advisory_unlock')), false); assert.deepEqual(pool.releases, [true]); assert.equal(pool.clients[0].listenerCount('error'), 0);
});

test('canonical forecast window includes collection day, uses natural-year and leap-year bounds, and invalid identities authorize no writes', async () => {
  assert.deepEqual(hkForecastWindow('2026-01-01'), { runDate: '2026-01-01', windowStart: '20250101', windowEnd: '20260101' });
  assert.deepEqual(hkForecastWindow('2024-02-29'), { runDate: '2024-02-29', windowStart: '20230228', windowEnd: '20240229' });
  assert.deepEqual(hkForecastWindow('2025-03-01'), { runDate: '2025-03-01', windowStart: '20240301', windowEnd: '20250301' });
  const pool = mockPool();
  await createHkForecastStore({ pool }).withLock(async scope => {
    for (const value of [{ ...options, universeHash: '0'.repeat(64) }, { ...options, windowStart: '20251020' }, { ...options, windowEnd: '20261018' }, { ...options, tickers: [...options.tickers, options.tickers[0]] }, { ...options, tickers: ['002920.SZ'] }]) await assert.rejects(scope.beginRun(value));
    await assert.rejects(scope.saveSymbol(symbol({ ticker: '00001.HK', rows: [row({ ts_code: '00001.HK' })] })));
  });
  assert.equal(pool.calls.some(call => /^(?:BEGIN|INSERT|DELETE|UPDATE)/.test(call.sql)), false);
});

test('run/symbol identity is idempotent, failures use fixed codes, and failure recording cannot overwrite completed runs', async () => {
  const pool = mockPool();
  await createHkForecastStore({ pool }).withLock(async scope => {
    await scope.beginRun(options); await scope.beginRun(options); await scope.saveSymbol(symbol()); await scope.saveSymbol(symbol());
    await scope.failRun({ ...options, partial: true, summary: { completedTickers: 1 }, errorCode: 'secret-token' });
  });
  const starts = pool.calls.filter(call => call.sql.startsWith('INSERT INTO market_data.hk_forecast_update_runs')); assert.equal(starts.length, 2);
  assert.match(starts[0].sql, /ON CONFLICT\(run_date,universe_hash\) DO UPDATE/); assert.deepEqual(starts[0].values, ['2026-10-19', universe.universeHash, universe.tickers, '2025-10-19', '2026-10-19']);
  const writes = pool.calls.filter(call => call.sql.startsWith('INSERT INTO market_data.hk_sell_side_forecasts')); assert.equal(writes[0].values[0], writes[1].values[0]);
  const failed = pool.calls.find(call => call.sql.startsWith('UPDATE market_data.hk_forecast_update_runs'));
  assert.match(failed.sql, /AND status<>'succeeded'/); assert.deepEqual(failed.values.slice(2), ['partial', '{"completedTickers":1}', 'provider_error']);
});

test('all-market identities admit more than one thousand verified HK codes without weakening the pool guard', async () => {
  const tickers=Array.from({length:1201},(_,index)=>`${String(index+1).padStart(5,'0')}.HK`);
  const large={...options,tickers,universeHash:createHash('sha256').update(tickers.join('\n')).digest('hex')};
  const pool=mockPool();
  await createHkForecastStore({pool}).withLock(async scope=>{
    await assert.rejects(scope.beginRun(large),{code:'VALIDATION_ERROR'});
    await scope.beginRun({...large,scope:'all'});
  });
  const start=pool.calls.find(call=>call.sql.startsWith('INSERT INTO market_data.hk_forecast_update_runs'));
  assert.equal(start.values[2].length,1201);
});

test('all-market per-company completion reuses same-day source snapshots across catalog hashes and rejects corrupt counts', async () => {
  const oldHash='a'.repeat(64),pool=mockPool({completed:{'00700.HK':[
    {universe_hash:options.universeHash,rows_count:9,stored_count:8},
    {universe_hash:oldHash,rows_count:2,stored_count:2},
  ]}});
  const checkpoint=await createHkForecastStore({pool}).withLock(scope=>scope.getSymbolCheckpoint({...symbol(),scope:'all'}));
  assert.deepEqual(checkpoint,{snapshotDate:'2026-10-19',universeHash:oldHash,rowsCount:2,status:'available'});
  const query=pool.calls.find(call=>call.sql.includes('FROM market_data.hk_forecast_symbol_runs'));
  assert.match(query.sql,/f\.universe_hash=s\.universe_hash/);
  assert.doesNotMatch(query.sql,/WHERE s\.run_date=\$1 AND s\.universe_hash=\$2/);
  const empty=mockPool({completed:{'00700.HK':{universe_hash:oldHash,rows_count:0,stored_count:0}}});
  assert.equal((await createHkForecastStore({pool:empty}).withLock(scope=>scope.getSymbolCheckpoint({...symbol(),scope:'all'}))).status,'no_data');
});

test('all-market empty snapshots require source evidence, store distinct no-data attempts, and prune only expired observations', async () => {
  const pool=mockPool(),store=createHkForecastStore({pool});
  await store.withLock(async scope=>{
    await assert.rejects(scope.saveSymbol({...symbol({rows:[]}),scope:'all'}),{code:'VALIDATION_ERROR'});
    const saved=await scope.saveSymbol({...symbol({rows:[]}),scope:'all',coverage:{kind:'current_snapshot',dateMeaning:'broker_update_date',historicalArchiveAvailable:false,sourceRows:0,rowsInRange:0,noDataEvidence:'identified earnings module states no forecasts'}});
    assert.equal(saved.rowsCount,0);
  });
  const attempt=pool.calls.find(call=>call.sql.startsWith('INSERT INTO market_data.hk_forecast_symbol_attempts'));
  assert.deepEqual(attempt.values,['2026-10-19','00700.HK',options.universeHash,'no_data',0]);
  const retention=pool.calls.find(call=>call.sql.includes('snapshot_date < $1 AND ts_code=$2'));
  assert.deepEqual(retention.values,['2025-10-19','00700.HK']);
  assert.match(retention.sql,/source='etnet' AND source_api='etnet_hk_profit_forecast'/);
  assert.equal(pool.calls.some(call=>call.sql.startsWith('INSERT INTO market_data.hk_sell_side_forecasts')),false);
});

test('all-market checkpoint confirmation preserves original observation rows and stores safe failure attempts separately', async () => {
  const oldHash='a'.repeat(64),pool=mockPool({completed:{'00700.HK':{universe_hash:oldHash,rows_count:2,stored_count:2}}});
  await createHkForecastStore({pool}).withLock(async scope=>{
    await scope.confirmSymbol({...symbol(),scope:'all'});
    await scope.markSymbol({...symbol(),scope:'all',status:'running'});
    await scope.markSymbol({...symbol(),scope:'all',status:'failed',errorCode:'private-provider-message'});
  });
  const attempts=pool.calls.filter(call=>call.sql.startsWith('INSERT INTO market_data.hk_forecast_symbol_attempts'));
  assert.deepEqual(attempts[0].values,['2026-10-19','00700.HK',oldHash,'succeeded',2]);
  assert.deepEqual(attempts[1].values.slice(-2),['running',null]);
  assert.deepEqual(attempts[2].values.slice(-2),['failed','provider_error']);
  assert.equal(pool.calls.some(call=>/^(?:DELETE|INSERT INTO market_data\.hk_sell_side_forecasts)/.test(call.sql)),false);
});

test('all-market source-specific yearly retention includes delisted companies only after every current symbol completes', async () => {
  const pool=mockPool();
  await createHkForecastStore({pool}).withLock(scope=>scope.finalize({...options,scope:'all',summary:{completedTickers:28}}));
  const prune=pool.calls.find(call=>call.sql.startsWith('DELETE FROM market_data.hk_sell_side_forecasts'));
  assert.match(prune.sql,/snapshot_date < \$1 AND source='etnet' AND source_api='etnet_hk_profit_forecast'/);
  assert.deepEqual(prune.values,['2025-10-19']);
  assert.ok(pool.calls.some(call=>call.sql==='DELETE FROM market_data.hk_forecast_symbol_attempts WHERE run_date < $1'));
});

test('all-market restart closes only interrupted running attempts through today while holding the forecast lock',async()=>{
  const pool=mockPool();
  await createHkForecastStore({pool}).withLock(scope=>scope.beginRun({...options,scope:'all'}));
  const recovery=pool.calls.find(call=>call.sql.startsWith('UPDATE market_data.hk_forecast_symbol_attempts'));
  assert.ok(recovery);
  assert.match(compact(recovery.sql),/SET status='failed',rows_count=0, error_code='incomplete_window',updated_at=clock_timestamp\(\) WHERE status='running' AND run_date<=\$1::date$/);
  assert.deepEqual(recovery.values,['2026-10-19']);
  assert.doesNotMatch(recovery.sql,/SET[\s\S]*run_date\s*=/);
  const lock=pool.calls.findIndex(call=>call.sql.includes('pg_try_advisory_lock'));
  const begin=pool.calls.findIndex(call=>call.sql==='BEGIN');
  const start=pool.calls.findIndex(call=>call.sql.startsWith('INSERT INTO market_data.hk_forecast_update_runs'));
  const commit=pool.calls.findIndex(call=>call.sql==='COMMIT');
  assert.ok(lock<begin&&begin<pool.calls.indexOf(recovery)&&pool.calls.indexOf(recovery)<start&&start<commit);
  assert.equal(pool.calls.some(call=>/^(?:DELETE|UPDATE|INSERT INTO) market_data\.hk_sell_side_forecasts/.test(call.sql)),false);
  const legacy=mockPool();
  await createHkForecastStore({pool:legacy}).withLock(scope=>scope.beginRun(options));
  assert.equal(legacy.calls.some(call=>call.sql.includes('hk_forecast_symbol_attempts')),false);
});

test('interrupted-attempt recovery rolls back with a failed run initialization and expired scopes cannot begin recovery',async()=>{
  const pool=mockPool({failOn:sql=>sql.startsWith('INSERT INTO market_data.hk_forecast_update_runs')});
  await assert.rejects(createHkForecastStore({pool}).withLock(scope=>scope.beginRun({...options,scope:'all'})),{code:'DATABASE_ERROR'});
  assert.ok(pool.calls.some(call=>call.sql.startsWith('UPDATE market_data.hk_forecast_symbol_attempts')));
  assert.ok(pool.calls.some(call=>call.sql==='ROLLBACK'));
  assert.equal(pool.calls.some(call=>call.sql==='COMMIT'),false);
  const expiredPool=mockPool();let expired;
  await createHkForecastStore({pool:expiredPool}).withLock(scope=>{expired=scope;});
  const before=expiredPool.calls.length;
  await assert.rejects(expired.beginRun({...options,scope:'all'}),{code:'VALIDATION_ERROR'});
  assert.equal(expiredPool.calls.length,before);
});
