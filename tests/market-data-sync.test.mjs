import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncDailyData, validateDailyRows } from '../backend/market-data/sync.mjs';

const row = date => ({ ts_code: '002920.SZ', trade_date: date, open: 70, high: 72, low: 69, close: 71, pre_close: 70, change: 1, pct_chg: 1.4286, vol: 100, amount: 710 });
const options = { markets: ['A'], startDate: '20251014', endDate: '20261013' };
async function cache(t) { const directory = await mkdtemp(join(tmpdir(), 'market-sync-')); t.after(() => rm(directory, { recursive: true, force: true })); return directory; }
function provider(dates = ['20261012', '20261013']) {
  let calls = 0;
  return { get calls() { return calls; }, query: async () => dates.map(cal_date => ({ cal_date, is_open: 1 })), queryAll: async (_, params) => { calls += 1; return [row(params.trade_date)]; } };
}
function database(completed = new Set()) {
  const saved = [], failures = [];
  return { saved, failures, migrate: async () => {}, getCompletedDays: async () => completed,
    saveDay: async value => { saved.push(value); }, markFailedDay: async value => { failures.push(value); }, summary: async () => ({}) };
}

test('完整分页数据先落缓存，离线入库不重复请求Tushare，重跑跳过完成日期', async t => {
  const cacheDir = await cache(t), client = provider();
  const downloaded = await syncDailyData({ ...options, client, cacheDir, mode: 'download' });
  assert.equal(downloaded.status, 'completed'); assert.equal(downloaded.markets[0].downloadedDays, 2); assert.equal(client.calls, 2);
  assert.ok((await readdir(join(cacheDir, 'A'))).includes('20261013.json.gz'));
  const store = database();
  const imported = await syncDailyData({ ...options, store, cacheDir, mode: 'import' });
  assert.equal(imported.status, 'completed'); assert.equal(imported.markets[0].importedDays, 2);
  assert.deepEqual(store.saved.map(value => value.tradeDate), ['20261013', '20261012']);
  const resumed = database(new Set(['20261013', '20261012']));
  const result = await syncDailyData({ ...options, store: resumed, cacheDir, mode: 'import' });
  assert.equal(result.markets[0].skippedDays, 2); assert.equal(resumed.saved.length, 0); assert.equal(client.calls, 2);
});

test('缺字段、开市日空响应、重复代码、越界日期不能冒充成功', () => {
  assert.throws(() => validateDailyRows([], 'A', '20261013'));
  const missing = row('20261013'); delete missing.vol;
  assert.throws(() => validateDailyRows([missing], 'A', '20261013'), /必需字段/);
  assert.throws(() => validateDailyRows([row('20261013'), row('20261013')], 'A', '20261013'), /唯一键/);
  assert.throws(() => validateDailyRows([row('20261012')], 'A', '20261013'));
  assert.throws(() => validateDailyRows([{ ...row('20261013'), close: null }], 'A', '20261013'));
  assert.throws(() => validateDailyRows([{ ...row('20261013'), amount: -1 }], 'A', '20261013'));
  const suspended = { ...row('20261013'), ts_code: '600519.SH', open: null, high: null, low: null, close: null, vol: null, amount: null };
  assert.equal(validateDailyRows([row('20261013'), suspended], 'A', '20261013')[1].close, null);
  assert.throws(() => validateDailyRows([suspended], 'A', '20261013'), /全市场/);
});

test('分页或权限失败不写入半个交易日，并留下可重跑的失败状态', async t => {
  const cacheDir = await cache(t), client = provider(), store = database();
  client.queryAll = async () => { const error = new Error('固定错误'); error.kind = 'permission'; throw error; };
  const result = await syncDailyData({ ...options, client, store, cacheDir });
  assert.equal(result.status, 'incomplete'); assert.equal(store.saved.length, 0);
  assert.equal(result.markets[0].blockedBy, 'permission'); assert.equal(store.failures.length, 1);
  assert.equal((await readdir(join(cacheDir, 'A'))).some(name => name.endsWith('.json.gz')), false);
});

test('开市日空响应保存失败记录，后续日期仍可下载，不能标记完整', async t => {
  const cacheDir = await cache(t), client = provider();
  client.queryAll = async (_, { trade_date }) => trade_date === '20261013' ? [] : [row(trade_date)];
  const result = await syncDailyData({ ...options, client, cacheDir, mode: 'download' });
  assert.equal(result.status, 'incomplete'); assert.equal(result.markets[0].completedDays, 1);
  assert.deepEqual(result.markets[0].failedDates, [{ date: '20261013', kind: 'validation' }]);
});

test('港股独立使用香港交易日历、分页上限与完成记录，保留原始股/港元数值', async t => {
  const cacheDir = await cache(t), store = database();
  const client = {
    async query(api, params) {
      assert.equal(api, 'hk_tradecal');
      assert.equal(params.exchange, undefined);
      return [{ cal_date: '20261002', is_open: 1 }];
    },
    async queryAll(api, params, fields, pagination) {
      assert.equal(api, 'hk_daily');
      assert.equal(pagination.pageSize, 5000);
      return [{ ...row(params.trade_date), ts_code: '00700.HK', vol: 12345, amount: 67890.12 }];
    },
  };
  const result = await syncDailyData({ client, store, cacheDir, markets: ['HK'], startDate: '20261001', endDate: '20261007' });
  assert.equal(result.status, 'completed');
  assert.equal(store.saved[0].market, 'HK');
  assert.equal(store.saved[0].apiName, 'hk_daily');
  assert.equal(store.saved[0].tradeDate, '20261002');
  assert.equal(store.saved[0].rows[0].vol, 12345);
  assert.equal(store.saved[0].rows[0].amount, 67890.12);
  assert.ok((await readdir(join(cacheDir, 'HK'))).includes('20261002.json.gz'));
  await assert.rejects(readdir(join(cacheDir, 'A')), { code: 'ENOENT' });
});
