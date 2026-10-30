import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncHkPoolSecurities } from '../backend/market-data/pool-securities-sync.mjs';

const universe = { version: 1, source: { path: '/source.xlsx', sheet: 'pool' }, securities: [{ ticker: '00700.HK', name: '腾讯', row: 6 }] };
const security = ticker => ({ ts_code: ticker, name: ticker, list_date: '20040616', delist_date: null, list_status: 'L' });
async function directory(t) { const p = await mkdtemp(join(tmpdir(), 'hk-pool-ref-')); t.after(() => rm(p, { recursive: true, force: true })); return p; }
function store() { return { rows: [], async migrate() {}, async upsertSecurities({ rows }) { this.rows.push(...rows); } }; }

test('旧全市场缓存只导入名单股票，刷新也只向源端请求名单股票', async t => {
  const cacheDir = await directory(t), db = store();
  await mkdir(join(cacheDir, 'securities/HK'), { recursive: true });
  await writeFile(join(cacheDir, 'securities/HK/snapshot.json'), JSON.stringify({ source: 'tushare', apiName: 'hk_basic', status: 'completed',
    fetchedAt: '2026-10-19T00:00:00Z', rows: [security('00700.HK'), security('02020.HK')] }));
  const imported = await syncHkPoolSecurities({ universe, store: db, cacheDir, mode: 'import' });
  assert.equal(imported.referenceRecords, 1); assert.deepEqual(db.rows.map(s => s.ts_code), ['00700.HK']);
  const calls = [];
  await syncHkPoolSecurities({ universe, store: db, cacheDir, refresh: true, client: { async query(api, params) {
    calls.push([api, params]); return [security(params.ts_code)];
  } } });
  assert.deepEqual(calls, [['hk_basic', { ts_code: '00700.HK' }]]);
});

test('名单外响应或不完整名单缓存不能写入数据库', async t => {
  const cacheDir = await directory(t), db = store();
  await assert.rejects(syncHkPoolSecurities({ universe, store: db, cacheDir, refresh: true,
    client: { query: async () => [security('02020.HK')] } }), /无效/);
  assert.equal(db.rows.length, 0);
  await mkdir(join(cacheDir, 'securities/HK'), { recursive: true });
  await writeFile(join(cacheDir, 'securities/HK/snapshot.json'), JSON.stringify({ source: 'tushare', apiName: 'hk_basic', status: 'completed', fetchedAt: '2026-10-19T00:00:00Z', rows: [] }));
  await assert.rejects(syncHkPoolSecurities({ universe, store: db, cacheDir, mode: 'import' }));
  assert.equal(db.rows.length, 0);
});
