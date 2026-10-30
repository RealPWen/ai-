import test from 'node:test';
import assert from 'node:assert/strict';
import { createTushareClient, TushareError } from '../backend/market-data/tushare-client.mjs';

const TOKEN = 'private-test-token';
const rows = (items, fields = ['ts_code', 'trade_date', 'close']) => new Response(JSON.stringify({
  code: 0, data: { fields, items },
}));
const options = extra => ({ token: TOKEN, intervalMs: 0, retryBaseMs: 0, ...extra });

test('explicit credential or permission denial is not retried just because guidance mentions a quota', async () => {
  for (const [message, kind] of [
    ['当前没有历史数据权限；正式接口每小时30次', 'permission'],
    ['当前权限只支持最近数据；正式权限每小时30次', 'permission'],
    ['当前积分不足；开通后每分钟400次', 'permission'],
    ['该接口需单独开通，开通后每分钟400次', 'permission'],
    ['Token无效；每小时30次，详见权限说明', 'authentication'],
  ]) {
    let calls = 0;
    const client = createTushareClient(options({ fetchImpl: async () => {
      calls++; return new Response(JSON.stringify({ code: 40203, msg: message }));
    } }));
    await assert.rejects(client.query('major_news'), error => error.kind === kind && !error.retryable && !error.message.includes(message));
    assert.equal(calls, 1);
  }
});

test('genuine day or hour limits retain rate classification with a neutral permissions documentation footer', async () => {
  for (const message of ['每日最多访问30次', '每小时最多访问该接口30次，详情参阅权限说明', '访问过于频繁']) {
    const client = createTushareClient(options({ maxRetries: 0, fetchImpl: async () => new Response(JSON.stringify({ code: -2002, msg: message })) }));
    await assert.rejects(client.query('major_news'), error => error.kind === 'rate_limit' && error.retryable && error.code === -2002);
  }
});

test('explicit hourly and daily quotas stop immediately without short backoff or upstream text leakage', async () => {
  for (const [message, period] of [
    [`接口(hk_daily)频率超限(1次/小时)，${TOKEN}`, 'hour'],
    ['每小时最多访问30次，详情参阅权限说明', 'hour'],
    ['每日最多访问30次', 'day'],
  ]) {
    let calls = 0;
    const sleeps = [];
    const client = createTushareClient(options({ sleep: async ms => sleeps.push(ms), fetchImpl: async () => {
      calls++; return new Response(JSON.stringify({ code: 40203, msg: message }));
    } }));
    await assert.rejects(client.query('hk_daily'), error => error.kind === 'rate_limit'
      && error.quotaPeriod === period && !error.message.includes(TOKEN));
    assert.equal(calls, 1);
    assert.deepEqual(sleeps, []);
  }
});

test('posts only to the fixed HTTPS endpoint, matches returned field order, and blocks redirects', async () => {
  const calls = [];
  const client = createTushareClient(options({ fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return rows([[12.3, '002920.SZ']], ['close', 'ts_code']);
  } }));
  assert.deepEqual(await client.query('daily', { trade_date: '20261013' }, 'ts_code,close'), [{ close: 12.3, ts_code: '002920.SZ' }]);
  assert.equal(calls[0].url, 'https://api.tushare.pro');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { api_name: 'daily', token: TOKEN, params: { trade_date: '20261013' }, fields: 'ts_code,close' });
  assert.equal(Object.values(calls[0].init.headers).some(value => value.includes(TOKEN)), false);
});

test('reads until an empty page, using actual row counts even when the provider caps pages', async () => {
  const offsets = [];
  const pages = [[[ 'A.SZ', '20261013', 1 ]], [[ 'B.SZ', '20261013', 2 ]], []];
  const client = createTushareClient(options({ fetchImpl: async (_url, init) => {
    const { params } = JSON.parse(init.body);
    offsets.push(params.offset);
    assert.equal(params.limit, 6000);
    return rows(pages.shift());
  } }));
  const data = await client.queryAll('daily', { trade_date: '20261013' });
  assert.equal(data.length, 2);
  assert.deepEqual(offsets, [0, 1, 2]);
});

test('rejects repeated pages, overlapping keys, excess rows, wrong dates and malformed rows', async () => {
  const cases = [
    { pages: [[[ 'A.SZ', '20261013', 1 ]], [[ 'A.SZ', '20261013', 1 ]]] },
    { pages: [[[ 'A.SZ', '20261013', 1 ]], [[ 'A.SZ', '20261013', 2 ]]] },
    { pages: [[[ 'A.SZ', '20261013', 1 ], [ 'B.SZ', '20261013', 2 ]]], pageSize: 1 },
    { pages: [[[ 'A.SZ', '20261014', 1 ]]] },
    { pages: [[[ 'A.SZ', '20261013' ]]] },
  ];
  for (const fixture of cases) {
    const client = createTushareClient(options({ fetchImpl: async () => rows(fixture.pages.shift() || []) }));
    await assert.rejects(client.queryAll('daily', { trade_date: '20261013' }, '', { pageSize: fixture.pageSize || 2 }), error => error.kind === 'invalid_response');
  }
});

test('cannot silently stop at a configured page limit', async () => {
  const client = createTushareClient(options({ fetchImpl: async () => rows([[ 'A.SZ', '20261013', 1 ]]) }));
  await assert.rejects(client.queryAll('daily', {}, '', { maxPages: 1 }), /分页次数/);
});

test('rejects changed page schemas and uses the Hong Kong pagination limit', async () => {
  let calls = 0;
  const client = createTushareClient(options({ fetchImpl: async (_url, init) => {
    assert.equal(JSON.parse(init.body).params.limit, 5000);
    calls += 1;
    return calls === 1 ? rows([[ '00001.HK', '20261013', 1 ]])
      : rows([[ '00002.HK', '20261013', 1 ]], ['ts_code', 'trade_date', 'open']);
  } }));
  await assert.rejects(client.queryAll('hk_daily'), /分页字段/);
});

test('rejects invalid configuration before contacting the upstream', async () => {
  let calls = 0;
  const client = createTushareClient(options({ fetchImpl: async () => { calls += 1; return rows([]); } }));
  await assert.rejects(client.query('https://example.com'), error => error.kind === 'configuration');
  await assert.rejects(client.query('daily', { limit: NaN }), error => error.kind === 'configuration');
  await assert.rejects(client.queryAll('daily', { offset: 0 }), error => error.kind === 'configuration');
  await assert.rejects(client.queryAll('daily', null), error => error.kind === 'configuration');
  assert.equal(calls, 0);
});

test('serializes concurrent queries and spaces every attempt using the shared rate limiter', async () => {
  let clock = 0;
  let active = 0;
  let peak = 0;
  const starts = [];
  const sleeps = [];
  const client = createTushareClient({ token: TOKEN, intervalMs: 350, now: () => clock,
    sleep: async ms => { sleeps.push(ms); clock += ms; },
    fetchImpl: async () => {
      starts.push(clock); active += 1; peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return rows([]);
    },
  });
  await Promise.all([client.query('daily'), client.query('daily'), client.query('daily')]);
  assert.equal(peak, 1);
  assert.deepEqual(starts, [0, 350, 700]);
  assert.deepEqual(sleeps, [350, 350]);
});

test('retries transient network, HTTP and upstream frequency errors with bounded backoff', async () => {
  for (const first of [
    () => { throw new Error(`socket reset ${TOKEN}`); },
    () => new Response('', { status: 429 }),
    () => new Response('', { status: 503 }),
    () => new Response(JSON.stringify({ code: -2002, msg: '每分钟最多访问 200 次', token: TOKEN })),
  ]) {
    let calls = 0;
    const sleeps = [];
    const client = createTushareClient(options({ retryBaseMs: 100, sleep: async ms => sleeps.push(ms), fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? first() : rows([]);
    } }));
    assert.deepEqual(await client.query('daily'), []);
    assert.equal(calls, 2);
    assert.deepEqual(sleeps, [100]);
  }
  let calls = 0;
  const client = createTushareClient(options({ maxRetries: 2, fetchImpl: async () => { calls += 1; throw new Error(TOKEN); } }));
  await assert.rejects(client.query('daily'), error => error.kind === 'network' && !JSON.stringify(error).includes(TOKEN) && !error.stack.includes(TOKEN));
  assert.equal(calls, 3);
});

test('permission and bad-token failures are classified without retries or leaked upstream text', async () => {
  for (const fixture of [
    { code: -2002, msg: `抱歉，您没有访问该接口的权限，${TOKEN}`, kind: 'permission' },
    { code: 2002, msg: `积分不足 ${TOKEN}`, kind: 'permission' },
    { code: -2001, msg: `token不正确 ${TOKEN}`, kind: 'authentication' },
  ]) {
    let calls = 0;
    const client = createTushareClient(options({ fetchImpl: async () => {
      calls += 1; return new Response(JSON.stringify(fixture));
    } }));
    await assert.rejects(client.query('hk_daily'), error => {
      assert.ok(error instanceof TushareError);
      assert.equal(error.kind, fixture.kind);
      assert.equal(error.permission, fixture.kind === 'permission');
      assert.equal(`${error.stack} ${JSON.stringify(error)}`.includes(TOKEN), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('a failed query does not poison the queue and pending params are copied', async () => {
  const calls = [];
  const client = createTushareClient(options({ maxRetries: 0, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body); calls.push(body.params);
    if (calls.length === 1) throw new Error('offline');
    return rows([]);
  } }));
  const params = { trade_date: '20261013' };
  const first = client.query('daily');
  const second = client.query('daily', params);
  params.trade_date = '20261014';
  await assert.rejects(first);
  await second;
  assert.equal(calls[1].trade_date, '20261013');
});
