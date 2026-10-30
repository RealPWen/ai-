import test from 'node:test';
import assert from 'node:assert/strict';
import { attributionSectorUrl, createAttributionSectorResolver } from '../backend/src/attribution-sector.mjs';
import { buildAttributionSnapshot } from '../backend/src/attribution-snapshot.mjs';
import { attributionSearchPlan, validateAttributionSnapshot } from '../backend/src/attribution-ai-evidence.mjs';

const response = (ticker = '00700.HK', industry = '软件服务', overrides = {}) => new Response(JSON.stringify({
  code: 0, success: true, result: { data: [{ SECUCODE: ticker, SECURITY_CODE: ticker.slice(0, 5), BELONG_INDUSTRY: industry }] }, ...overrides,
}));

test('A 股使用真实申万行业，随后回退数据库行业，不调用外网', async () => {
  const resolver = createAttributionSectorResolver({ fetchImpl: () => { throw new Error('must not fetch'); } });
  assert.deepEqual(await resolver.resolve({ ticker: '600095.SH', benchmark: { system: 'SW2021', industryName: '证券Ⅲ' } }), { name: '证券Ⅲ', source: 'sw2021', known: true });
  assert.deepEqual(await resolver.resolve({ ticker: '600095.SH', profile: { businesses: ['证券'] } }), { name: '证券', source: 'database', known: true });
  assert.equal((await resolver.resolve({ ticker: '600095.SH', benchmark: { system: 'HSI', industryName: '恒生指数' } })).known, false);
});

test('HK 从公开公司资料读取明确行业，固定 API 并验证完整股票代码', async () => {
  const resolver = createAttributionSectorResolver({ fetchImpl: async (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'datacenter.eastmoney.com');
    assert.equal(parsed.searchParams.get('reportName'), 'RPT_HKF10_INFO_ORGPROFILE');
    assert.equal(parsed.searchParams.get('filter'), '(SECUCODE="00700.HK")');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return response();
  } });
  const result = await resolver.resolve({ ticker: '00700.HK', benchmark: { system: 'HSI', industryName: '恒生指数' } });
  assert.equal(result.name, '软件服务'); assert.equal(result.source, 'eastmoney'); assert.equal(result.known, true);
  assert.equal(result.sourceUrl, attributionSectorUrl('00700.HK'));
});

test('HK 对错误代码、多行、错误响应和无效行业明确返回未知，不回退恒指', async () => {
  const payloads = [response('02359.HK'), response('00700.HK', '恒生指数'), response('00700.HK', 'a'.repeat(81)),
    response('00700.HK', '<script>bad</script>'), response('00700.HK', '--'), response('00700.HK', '未知'),
    response('00700.HK', '证券\n错误'), response('00700.HK', '软件服务', { success: false }),
    response('00700.HK', '软件服务', { result: { data: [{ SECUCODE: '00700.HK', SECURITY_CODE: '700', BELONG_INDUSTRY: '软件服务' }] } }),
    response('00700.HK', '软件服务', { result: { data: [] } }),
    response('00700.HK', '软件服务', { result: { data: [{}, {}] } }),
    new Response('invalid JSON'), new Response('unavailable', { status: 503 }),
    new Response('x'.repeat(100001)),
  ];
  for (const item of payloads) {
    const resolver = createAttributionSectorResolver({ fetchImpl: async () => item });
    assert.deepEqual(await resolver.resolve({ ticker: '00700.HK', benchmark: { system: 'HSI', industryName: '恒生指数' } }), { name: null, source: 'unavailable', known: false });
  }
});

test('HK cache 一天、同股票请求复用且调用者不能篡改缓存', async () => {
  let now = 100000, calls = 0;
  const resolver = createAttributionSectorResolver({ now: () => now, fetchImpl: async () => { calls++; return response(); } });
  const results = await Promise.all([resolver.resolve({ ticker: '00700.HK' }), resolver.resolve({ ticker: '00700.HK' })]);
  assert.equal(calls, 1); results[0].name = '错误行业';
  assert.equal((await resolver.resolve({ ticker: '00700.HK' })).name, '软件服务');
  now += 86400000 - 1; await resolver.resolve({ ticker: '00700.HK' }); assert.equal(calls, 1);
  now++; await resolver.resolve({ ticker: '00700.HK' }); assert.equal(calls, 2);
});

test('临时网络失败保留未知，一分钟后允许重试，不中断归因', async () => {
  let now = 0, calls = 0;
  const resolver = createAttributionSectorResolver({ now: () => now, fetchImpl: async () => { if (++calls === 1) throw new Error('network'); return response(); } });
  assert.equal((await resolver.resolve({ ticker: '00700.HK' })).known, false);
  now = 59999; assert.equal((await resolver.resolve({ ticker: '00700.HK' })).known, false); assert.equal(calls, 1);
  now = 60000; assert.equal((await resolver.resolve({ ticker: '00700.HK' })).known, true); assert.equal(calls, 2);
});

test('港股板块接口不可用时规范未知名称，行情快照可校验并继续检索，恒指不会冒充行业', async () => {
  const ticker = '00700.HK', asOf = '2026-10-20', period = '1m';
  const prices = { ticker, meta: { requestedAsOf: asOf, period, adjustment: 'none', currency: 'HKD' },
    points: [{ date: '2026-09-21', close: 100 }, { date: '2026-10-19', close: 110 }],
    benchmark: { status: 'available', system: 'HSI', indexCode: 'HSI', industryName: '恒生指数', level: 'market',
      points: [{ date: '2026-09-21', close: 1000 }, { date: '2026-10-19', close: 1040 }] } };
  const resolver = createAttributionSectorResolver({ fetchImpl: async () => new Response('unavailable', { status: 503 }) });
  const sector = await resolver.resolve({ ticker, benchmark: prices.benchmark });
  assert.deepEqual(sector, { name: null, source: 'unavailable', known: false });
  const snapshot = buildAttributionSnapshot({ ticker, period, asOf, profile: { name: '腾讯控股' }, prices, sector });
  assert.deepEqual(snapshot.sector, { name: '', source: 'unavailable', known: false });
  assert.equal(sector.name, null, '规范化快照不修改解析器结果');
  assert.equal(validateAttributionSnapshot(snapshot), snapshot);
  const plan = attributionSearchPlan(snapshot);
  assert.equal(plan.length, 5);
  for (const row of plan.filter(row => row.kind === 'sector')) {
    assert.match(row.query, /港股.*行业 板块/); assert.doesNotMatch(row.query, /恒生|HSI|腾讯|00700/);
  }
  assert.match(plan[0].query, /00700.HK.*腾讯控股/);
  const invalidKnown = buildAttributionSnapshot({ ticker, period, asOf, prices, sector: { name: null, source: 'eastmoney', known: true } });
  assert.throws(() => validateAttributionSnapshot(invalidKnown), { code: 'INVALID_ATTRIBUTION_INPUT' });
});

test('超时八秒以内返回未知，即使注入的 fetch 未响应 abort', async () => {
  const resolver = createAttributionSectorResolver({ timeoutMs: 10, fetchImpl: async () => new Promise(() => {}) });
  const keepAlive = setTimeout(() => {}, 1000);
  try { assert.equal((await resolver.resolve({ ticker: '00700.HK' })).known, false); }
  finally { clearTimeout(keepAlive); }
});

test('不同股票有限并发，队列容量有限', async () => {
  let active = 0, maximum = 0;
  const resolver = createAttributionSectorResolver({ maxConcurrency: 2, maxQueued: 1, fetchImpl: async url => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    const ticker = /"(\d{5}\.HK)"/.exec(new URL(url).searchParams.get('filter'))[1]; return response(ticker);
  } });
  const results = await Promise.all(['00700.HK', '02359.HK', '00001.HK', '00002.HK'].map(ticker => resolver.resolve({ ticker })));
  assert.equal(maximum, 2); assert.equal(results.filter(row => row.known).length, 3); assert.equal(results[3].known, false);
});

test('输入不能构造任意 URL，未知证券不发请求', async () => {
  assert.equal(attributionSectorUrl('00700.HK&x=1'), null);
  const resolver = createAttributionSectorResolver({ fetchImpl: async () => { throw new Error('must not fetch'); } });
  assert.equal((await resolver.resolve({ ticker: '00700.HK&x=1' })).known, false);
  assert.throws(() => createAttributionSectorResolver({ timeoutMs: 8001 }), TypeError);
});
