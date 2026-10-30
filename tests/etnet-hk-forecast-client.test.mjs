import test from 'node:test';
import assert from 'node:assert/strict';
import { createEtnetHkForecastClient, parseEtnetHkForecastHtml } from '../backend/market-data/etnet-hk-forecast-client.mjs';

const range = { ticker: '00700.HK', startDate: '20251020', endDate: '20261019' };
function html({ code = '00700', unit = '分', rows = [['2026', '2,912.00', '美银', '08/10/2026'], ['2027', '-1,203.00', '美银', '08/10/2026'], ['2028', '--', '野村', '13/07/2026']], footer = true } = {}) {
  return `<html><head><title>${code} 测试公司 - 盈利预测</title></head><body>
    <table><tr><td>综合盈利预测</td><td>每股盈利 (分)</td></tr><tr><td>2026</td><td>9,999.00</td></tr></table>
    <div>盈利预测概览</div><table class="figureTable"><tr>
    <td>财政年度</td><td>纯利/(亏损)<br>(百万元人民币)</td><td>每股盈利*/<br>(亏损) (${unit})</td>
    <td>每股派息* (${unit})</td><td>证券商</td><td>评级</td><td colspan="2">目标价*<br>(港元)</td><td>更新日期</td></tr>
    ${rows.map(([year, eps, org, date]) => `<tr><td>${year}</td><td>1,000.00</td><td>${eps}</td><td>--</td><td>${org}</td><td>买入</td><td>780.00</td><td>&nbsp;</td><td>${date}</td></tr><tr><td>&nbsp;</td></tr>`).join('')}
    </table>${footer ? '<div>*每股盈利、每股派息及目标价会于合并、拆细及派红股后作调整。</div>' : ''}</body></html>`;
}
const response = body => ({ status: 200, async text() { return body; } });

test('ETNet reads only broker rows, preserves signed/missing EPS and scales cents with a raw audit', () => {
  const raw = html(), r = parseEtnetHkForecastHtml(raw, range);
  assert.equal(r.rows.length, 3); assert.equal(r.source, 'etnet'); assert.equal(r.apiName, 'etnet_hk_profit_forecast');
  assert.deepEqual(r.rows.map(x => [x.fiscal_year, x.fiscal_period, x.eps, x.currency, x.report_date]),
    [[2026, '2026', 29.12, 'CNY', '20261008'], [2027, '2027', -12.03, 'CNY', '20261008'], [2028, '2028', null, 'CNY', '20260713']]);
  assert.equal(r.raw.html, raw); assert.equal(r.rows[0].raw_data.eps, '2,912.00');
  assert.equal(r.rows[0].raw_data.eps_unit, '分'); assert.match(r.rows[0].eps_basis, /拆细/);
  assert.equal(r.rows[0].source_url, 'https://www.etnet.com.hk/www/sc/stocks/realtime/quote_profit.php?code=00700');
  assert.equal(r.rows[0].report_title, null); assert.equal(r.rows[0].author_name, null); assert.equal(r.rows[0].np, null);
  assert.equal(r.rows[0].pe, null); assert.equal(r.coverage.kind, 'current_snapshot');
  assert.equal(r.coverage.historicalArchiveAvailable, false); assert.equal(r.coverage.dateMeaning, 'broker_update_date');
});

test('ETNet respects USD/HKD EPS currencies, unknown units, true fiscal month and unspecified accounting basis', () => {
  for (const [unit, currency, eps] of [['美仙', 'USD', 29.12], ['港仙', 'HKD', 29.12], ['美元', 'USD', 2912], ['仙', null, null]]) {
    const row = parseEtnetHkForecastHtml(html({ unit, footer: false, rows: [['06/2027', '2,912.00', '摩根大通', '08/10/2026']] }), range).rows[0];
    assert.equal(row.currency, currency); assert.equal(row.eps, eps); assert.equal(row.fiscal_year, 2027);
    assert.equal(row.fiscal_period, '2027-06'); assert.equal(row.eps_basis, null);
  }
  for (const profitUnit of ['百万港元', '百万美元', '百万元人民币/美元', '金额不详']) {
    const result = parseEtnetHkForecastHtml(html().replaceAll('百万元人民币', profitUnit), range);
    assert.equal(result.rows[0].currency, null); assert.equal(result.rows[0].eps, null);
    assert.equal(result.rows[0].raw_data.eps, '2,912.00');
  }
  assert.equal(parseEtnetHkForecastHtml(html({ rows: [['2026', '243.30', '花旗', '08/10/2026']] }), range).rows[0].eps, 2.433);
});

test('ETNet filters real broker update dates, never invents calendar history and keeps stable record identity', () => {
  const first = parseEtnetHkForecastHtml(html(), { ...range, startDate: '20261001' });
  assert.equal(first.rows.length, 2); assert.equal(first.coverage.outsideRange, 1);
  const changed = parseEtnetHkForecastHtml(html().replace('2,912.00', '3,000.00'), range);
  assert.equal(first.rows[0].source_record_id, changed.rows[0].source_record_id);
  assert.equal(parseEtnetHkForecastHtml(html(), { ...range, startDate: '20261019' }).rows.length, 0);
});

test('ETNet distinguishes explicit no coverage from truncated HTML, wrong ticker and malformed rows', () => {
  const empty = '<html><title>00700 测试公司</title><body><div class="DivFigureContent">暂无资料</div></body></html>';
  assert.deepEqual(parseEtnetHkForecastHtml(empty, range).rows, []);
  assert.equal(parseEtnetHkForecastHtml(empty, range).coverage.noDataEvidence, '暂无资料');
  assert.equal(parseEtnetHkForecastHtml(html({ rows: [] }), range).coverage.noDataEvidence, 'identified_broker_overview_table_has_no_data_rows');
  for (const raw of [html({ code: '00005' }), html().slice(0, -7), '<html><title>00700 公司</title><body>error</body></html>',
    '<html><title>00700 公司</title><body><aside>暂无资料</aside><div class="DivFigureContent">error</div></body></html>',
    html({ rows: [['2026', 'bad', '机构', '08/10/2026']] }), html({ rows: [['2026', '1.00', '', '08/10/2026']] }),
    html({ rows: [['2026', '1.00', '机构', '30/02/2026']] }), html({ rows: [['13/2026', '1.00', '机构', '08/10/2026']] }),
    html().replace('<td>2,912.00</td>', ''), html({ rows: [['2026', '1.00', '机构', '08/10/2026'], ['2026', '2.00', '机构', '08/10/2026']] })])
    assert.throws(() => parseEtnetHkForecastHtml(raw, range), { kind: 'invalid_response' });
});

test('ETNet recognizes the real full-module no-coverage row without mistaking rating or sidebar blanks for no forecasts', () => {
  const noCoverage = '<html><title>02231 景业名邦集团 JY GRANDMARK - 盈利预测</title><body><div class="DivFigureContent"><table width="100%"><tr class="evenRow"><td height="300" valign="middle" align="center" colspan="7">没有相关资料。</td></tr></table></div></body></html>';
  const options = { ticker: '02231.HK', startDate: '20251020', endDate: '20261020' };
  const result = parseEtnetHkForecastHtml(noCoverage, options);
  assert.deepEqual(result.rows, []); assert.equal(result.coverage.noDataEvidence, '没有相关资料'); assert.equal(result.coverage.sourceRows, 0);
  assert.equal(result.raw.noDataEvidence, '没有相关资料'); assert.equal(result.raw.html, noCoverage);
  assert.equal(parseEtnetHkForecastHtml(noCoverage.replace('没有相关资料。', '沒有相關資料。'), options).rows.length, 0);
  for (const body of [
    '<div class="DivFigureContent"><div>评级总览 暂无资料</div><div>盈利预测概览 读取失败</div></div>',
    '<div class="DivFigureContent"><aside>暂无资料</aside></div>',
    '<div class="DivFigureContent">暂无资料</div><div class="DivFigureContent">盈利预测读取失败</div>',
    '<aside>没有相关资料。</aside><div class="DivFigureContent">读取失败</div>',
  ]) assert.throws(() => parseEtnetHkForecastHtml(`<html><title>02231 景业名邦集团</title><body>${body}</body></html>`, options), { kind: 'invalid_response' });
});

test('ETNet allows the inclusive leap-year snapshot window containing 367 calendar dates', () => {
  assert.equal(parseEtnetHkForecastHtml(html(), { ...range, startDate: '20230228', endDate: '20240229' }).rows.length, 0);
  assert.throws(() => parseEtnetHkForecastHtml(html(), { ...range, startDate: '20230227', endDate: '20240229' }), { kind: 'configuration' });
});

test('ETNet collector calls the fixed source with safe redirects and serializes retries', async () => {
  let calls = 0, clock = 0; const starts = [];
  const client = createEtnetHkForecastClient({ intervalMs: 1000, retryBaseMs: 100, maxRetries: 1, now: () => clock,
    sleep: async ms => { clock += ms; }, fetchImpl: async (url, options) => {
      starts.push(clock); assert.equal(url, 'https://www.etnet.com.hk/www/sc/stocks/realtime/quote_profit.php?code=00700');
      assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
      return ++calls === 1 ? { status: 503 } : response(html());
    } });
  const r = await Promise.all([client.collect(range), client.collect(range)]);
  assert.deepEqual(starts, [0, 1000, 2000]); assert.equal(r[0].rows.length, 3);
});

test('ETNet optional concurrency stays bounded at three and all starts share a global minimum 2s interval', async () => {
  let clock = 0, active = 0, peak = 0; const starts = [], release = [];
  const client = createEtnetHkForecastClient({ concurrency: 3, intervalMs: 0, maxRetries: 0, now: () => clock,
    sleep: async ms => { clock += ms; }, fetchImpl: async url => {
      starts.push(clock); active++; peak = Math.max(peak, active);
      await new Promise(resolve => release.push(resolve)); active--;
      return response(html({ code: new URL(url).searchParams.get('code') }));
    } });
  const pending = Array.from({ length: 5 }, (_, n) => client.collect({ ...range, ticker: `${String(n + 1).padStart(5, '0')}.HK` }));
  for (let i = 0; i < 30 && release.length < 3; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(release.length, 3); assert.equal(peak, 3); assert.deepEqual(starts, [0, 2000, 4000]);
  release[0]();
  for (let i = 0; i < 30 && release.length < 4; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(release.length, 4); assert.equal(peak, 3); assert.equal(starts[3], 6000);
  release[1]();
  for (let i = 0; i < 30 && release.length < 5; i++) await new Promise(resolve => setImmediate(resolve));
  for (const resolve of release) resolve();
  const results = await Promise.all(pending);
  assert.equal(results.length, 5); assert.equal(peak, 3); assert.deepEqual(starts, [0, 2000, 4000, 6000, 8000]);
});

test('ETNet concurrent retries use the same global start gate and invalid concurrency never creates a client', async () => {
  let clock = 0, requests = 0; const starts = [];
  const client = createEtnetHkForecastClient({ concurrency: 3, intervalMs: 100, maxRetries: 1, retryBaseMs: 0, now: () => clock,
    sleep: async ms => { clock += ms; }, fetchImpl: async url => {
      starts.push(clock); return ++requests === 1 ? { status: 503 } : response(html({ code: new URL(url).searchParams.get('code') }));
    } });
  await Promise.all(['00001.HK', '00002.HK', '00003.HK'].map(ticker => client.collect({ ...range, ticker })));
  assert.equal(requests, 4); assert.ok(starts.slice(1).every((start, n) => start - starts[n] >= 2000));
  for (const concurrency of [0, 4, -1, 1.5, '3']) assert.throws(() => createEtnetHkForecastClient({ concurrency }), { kind: 'configuration' });
});

test('ETNet 429 or 403 stops queued concurrent work and never retries or sends later requests from that client', async () => {
  for (const [status, kind] of [[429, 'rate_limit'], [403, 'permission']]) {
    let requests = 0, clock = 0;
    const client = createEtnetHkForecastClient({ concurrency: 3, maxRetries: 2, retryBaseMs: 0, now: () => clock,
      sleep: async ms => { clock += ms; }, fetchImpl: async () => { requests++; return { status }; } });
    const results = await Promise.allSettled(['00001.HK', '00002.HK', '00003.HK', '00004.HK'].map(ticker => client.collect({ ...range, ticker })));
    assert.ok(results.every(result => result.status === 'rejected' && result.reason.kind === kind)); assert.equal(requests, 1);
    await assert.rejects(client.collect(range), { kind }); assert.equal(requests, 1);
  }
});

test('ETNet rejects bad arguments before transport and redacts bounded HTTP, TLS and timeout errors', async () => {
  let calls = 0;
  const bad = createEtnetHkForecastClient({ intervalMs: 0, maxRetries: 0, fetchImpl: async () => { calls++; return response(html()); } });
  for (const changes of [{ ticker: '700.HK' }, { ticker: '00700.SH' }, { startDate: '20260230' }, { startDate: '20261020' }, { startDate: '20241019' }])
    await assert.rejects(bad.collect({ ...range, ...changes }), { kind: 'configuration' });
  assert.equal(calls, 0);
  const timeout = createEtnetHkForecastClient({ intervalMs: 0, maxRetries: 0, timeoutMs: 5, fetchImpl: async (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('secret')))) });
  await assert.rejects(timeout.collect(range), { kind: 'timeout' });
  const network = createEtnetHkForecastClient({ intervalMs: 0, maxRetries: 0, fetchImpl: async () => { throw new Error('secret'); } });
  await assert.rejects(network.collect(range), error => { assert.equal(error.kind, 'network'); assert.doesNotMatch(error.message, /secret/); return true; });
  const redirect = createEtnetHkForecastClient({ intervalMs: 0, maxRetries: 1, fetchImpl: async () => { calls++; return { status: 302 }; } });
  await assert.rejects(redirect.collect(range), { kind: 'http' }); assert.equal(calls, 1);
});

test('ETNet dedicated curl transport uses fixed HTTPS, IPv4, verified TLS, no redirects and isolated proxy environment', async () => {
  let calls = 0;
  const client = createEtnetHkForecastClient({ intervalMs: 0, maxRetries: 0, timeoutMs: 12345,
    proxyEnv: { HTTPS_PROXY: 'http://127.0.0.1:1234', HTTP_PROXY: 'http://127.0.0.1:1234', NO_PROXY: 'localhost',
      NODE_OPTIONS: 'private-value', TUSHARE_TOKEN: 'private-value' },
    runFileImpl: async (executable, args, options) => {
      calls++; assert.equal(executable, '/usr/bin/curl'); assert.equal(args[0], '-q');
      assert.equal(options.shell, false); assert.ok(options.signal instanceof AbortSignal);
      assert.ok(args.includes('--http1.1')); assert.ok(args.includes('--ipv4'));
      assert.equal(args[args.indexOf('--tls-max') + 1], '1.2');
      assert.equal(args[args.indexOf('--proto') + 1], '=https');
      assert.equal(args[args.indexOf('--max-redirs') + 1], '0');
      assert.equal(args[args.indexOf('--max-time') + 1], '13');
      assert.equal(args[args.indexOf('--max-filesize') + 1], '2097152');
      assert.equal(args[args.indexOf('--url') + 1], 'https://www.etnet.com.hk/www/sc/stocks/realtime/quote_profit.php?code=00700');
      assert.equal(args.some(arg => ['-k', '--insecure', '-L', '--location', '--location-trusted'].includes(arg)), false);
      assert.deepEqual(options.env, { https_proxy: 'http://127.0.0.1:1234', http_proxy: 'http://127.0.0.1:1234', no_proxy: 'localhost' });
      return { stdout: `${html()}\n__ETNET_STATUS__200` };
    },
  });
  assert.equal((await client.collect(range)).rows.length, 3); assert.equal(calls, 1);
});

test('ETNet defaults to two bounded TLS retries with 2s exponential backoff and exposes only a safe integer curl exit code', async () => {
  let calls = 0; const sleeps = [];
  const client = createEtnetHkForecastClient({ intervalMs: 0, proxyEnv: {}, sleep: async ms => sleeps.push(ms),
    runFileImpl: async () => { calls++; const error = new Error('private proxy and raw curl error');
      error.code = 35; error.stderr = 'private credentials'; throw error; },
  });
  await assert.rejects(client.collect(range), error => {
    assert.equal(error.kind, 'network'); assert.equal(error.retryable, true); assert.equal(error.curlExitCode, 35);
    assert.doesNotMatch(JSON.stringify(error), /private|credentials/); assert.doesNotMatch(error.message, /private|proxy/); return true;
  });
  assert.equal(calls, 3); assert.deepEqual(sleeps, [2000, 4000]);
  for (const code of [-1, 101, 35.5, '35', 'ENOENT', undefined]) {
    const unsafe = createEtnetHkForecastClient({ intervalMs: 0, maxRetries: 0, proxyEnv: {},
      runFileImpl: async () => { const error = new Error('private'); error.code = code; throw error; } });
    await assert.rejects(unsafe.collect(range), error => { assert.equal(error.curlExitCode, undefined); return true; });
  }
  const timeout = createEtnetHkForecastClient({ intervalMs: 0, maxRetries: 0, proxyEnv: {},
    runFileImpl: async () => { const error = new Error('private'); error.code = 28; throw error; } });
  await assert.rejects(timeout.collect(range), { kind: 'timeout', curlExitCode: 28 });
});

test('ETNet uses the next bounded retry after curl TLS 35 to negotiate TLS 1.2 or newer with certificate verification intact', async () => {
  const requests = [];
  const client = createEtnetHkForecastClient({ intervalMs: 0, retryBaseMs: 0, proxyEnv: {},
    runFileImpl: async (executable, args, options) => {
      requests.push(args); assert.equal(executable, '/usr/bin/curl'); assert.equal(options.shell, false);
      assert.equal(args.some(arg => ['-k', '--insecure', '-L', '--location', '--location-trusted'].includes(arg)), false);
      if (requests.length === 1) { const error = new Error('private TLS detail'); error.code = 35; throw error; }
      return { stdout: `${html()}\n__ETNET_STATUS__200` };
    },
  });
  const result = await client.collect(range);
  assert.equal(requests.length, 2); assert.ok(requests[0].includes('--tls-max'));
  assert.equal(requests[0][requests[0].indexOf('--tls-max') + 1], '1.2'); assert.equal(requests[0].includes('--tlsv1.2'), false);
  assert.ok(requests[1].includes('--tlsv1.2')); assert.equal(requests[1].includes('--tls-max'), false);
  assert.ok(requests.every(args => args.includes('--ipv4') && args.includes('--http1.1')));
  assert.deepEqual(result.rows, parseEtnetHkForecastHtml(html(), range).rows);
  let failures = 0;
  const bounded = createEtnetHkForecastClient({ intervalMs: 0, retryBaseMs: 0, proxyEnv: {}, runFileImpl: async (_, args) => {
    if (++failures > 1) assert.ok(args.includes('--tlsv1.2'));
    const error = new Error('private'); error.code = 35; throw error;
  } });
  await assert.rejects(bounded.collect(range), { kind: 'network', curlExitCode: 35 }); assert.equal(failures, 3);
});
