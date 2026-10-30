import test from 'node:test';
import assert from 'node:assert/strict';
import { createBaiduHkValuationClient } from '../backend/market-data/baidu-hk-valuation-client.mjs';

const range = { ticker: '00700.HK', startDate: '20261014', endDate: '20261018' };
const PE = '市盈率(TTM)', PB = '市净率';
const points = [['2026-10-13', '20.00'], ['2026-10-14', '19.20'], ['2026-10-15', '-12.34'], ['2026-10-16', '0'], ['2026-10-17', null], ['2026-10-18', '--']];
function body(tag, changes = {}) { return { ResultCode: 0, Result: [{ DisplayData: { resultData: { tplData: { result: {
  code: '00700', chartInfo: [{ header: [tag], dimensions: ['date', 'curTagValue'], type: '近三年', unit: '',
    releaseDate: '2004-06-16 00:00:00', body: structuredClone(points), ...changes }],
} } } } }] }; }
const chart = value => value.Result[0].DisplayData.resultData.tplData.result.chartInfo[0];
const response = value => ({ status: 200, async json() { return value; } });
function collector(transform = value => value) { return createBaiduHkValuationClient({ intervalMs: 0, maxRetries: 0,
  fetchImpl: async url => response(transform(body(new URL(url).searchParams.get('tag')))) }); }

test('Baidu separately requests real PE-TTM and PB histories, filters a year, preserves signed raw values and audits both responses', async () => {
  const requests = [];
  const client = createBaiduHkValuationClient({ intervalMs: 0, maxRetries: 0, fetchImpl: async (url, options) => {
    const u = new URL(url); requests.push(u); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    assert.equal(u.origin, 'https://finance.baidu.com'); assert.equal(u.pathname, '/opendata');
    assert.equal(u.searchParams.get('code'), '00700'); assert.equal(u.searchParams.get('market'), 'hk');
    assert.equal(u.searchParams.get('resource_id'), '51171'); assert.equal(u.searchParams.get('chart_select'), '近三年');
    assert.equal(u.searchParams.get('query'), u.searchParams.get('tag')); return response(body(u.searchParams.get('tag')));
  } });
  const result = await client.collect(range);
  assert.deepEqual(requests.map(u => u.searchParams.get('tag')), [PE, PB]);
  assert.equal(result.source, 'baidu'); assert.equal(result.apiName, 'baidu_hk_valuation');
  assert.equal(result.sourceUrl, 'https://finance.baidu.com');
  assert.deepEqual(result.rows.map(row => [row.ts_code, row.trade_date, row.pe_ttm, row.pb]),
    [['00700.HK', '20261014', '19.20', '19.20'], ['00700.HK', '20261015', '-12.34', '-12.34'],
      ['00700.HK', '20261016', '0', '0'], ['00700.HK', '20261017', null, null], ['00700.HK', '20261018', null, null]]);
  assert.deepEqual(result.raw.peTtm.response, body(PE)); assert.deepEqual(result.raw.pb.response, body(PB));
  assert.deepEqual(result.raw.metricDateCoverage.pe_ttm, { firstDate: '20261013', lastDate: '20261018', count: 6,
    requestedFirstDate: '20261014', requestedLastDate: '20261018', requestedCount: 5, releaseDate: '20040616', missingValueCount: 2 });
  assert.equal(result.raw.methodology.tradingDayFilter, 'caller_must_intersect_with_actual_hk_daily_prices');
});

test('Baidu accepts the real IPO 全部 fallback and does not invent history or carry missing days', async () => {
  const c = collector(value => { const c = chart(value); c.type = '全部'; c.releaseDate = '2026-10-16 00:00:00'; c.body = [['2026-10-16', -4.5], ['2026-10-18', '-']]; return value; });
  const result = await c.collect(range);
  assert.deepEqual(result.rows.map(x => [x.trade_date, x.pe_ttm]), [['20261016', -4.5], ['20261018', null]]);
});

test('Baidu validates identity, metric, period, unit, date validity, duplicate dates and value types', async () => {
  for (const transform of [
    v => ({ ...v, ResultCode: 1, message: 'raw secret' }),
    v => { v.Result[0].DisplayData.resultData.tplData.result.code = '00001'; return v; },
    v => { chart(v).header = ['市盈率(静)']; return v; }, v => { chart(v).dimensions = ['date', 'wrong']; return v; },
    v => { chart(v).type = '近一年'; return v; }, v => { chart(v).unit = '%'; return v; },
    v => { chart(v).type = '全部'; return v; },
    v => { chart(v).body[0][0] = '2026-02-30'; return v; },
    v => { chart(v).body.push(chart(v).body[0]); return v; },
    v => { chart(v).releaseDate = '2026-10-17 00:00:00'; return v; },
    ...['NaN', 'Infinity', '12%', false, {}, 'N/A'].map(bad => v => { chart(v).body[0][1] = bad; return v; }),
  ]) await assert.rejects(collector(transform).collect(range), error => { assert.equal(error.kind, 'invalid_response'); assert.doesNotMatch(error.message, /secret/); return true; });
});

test('Baidu rejects one missing metric date and does not convert an independently failed metric to null', async () => {
  await assert.rejects(collector(v => { if (chart(v).header[0] === PB) chart(v).body.pop(); return v; }).collect(range), { kind: 'incomplete_window' });
  await assert.rejects(collector(v => { if (chart(v).header[0] === PB) v.ResultCode = 1; return v; }).collect(range), { kind: 'invalid_response' });
  await assert.rejects(collector(v => { chart(v).body = []; return v; }).collect(range), { kind: 'no_data' });
  await assert.rejects(collector(v => { chart(v).body = [['2026-10-13', '1']]; return v; }).collect(range), { kind: 'no_data' });
});

test('Baidu all-market mode preserves one valid metric when the other chart explicitly has no data', async () => {
  const all = { ...range, allowPartialMetrics: true, allowEmpty: true };
  for (const emptyTag of [PE, PB]) {
    const result = await collector(value => { if (chart(value).header[0] === emptyTag) chart(value).body = []; return value; }).collect(all);
    assert.equal(result.rows.length, 5); assert.equal(result.coverage.kind, 'partial_metrics');
    assert.deepEqual(result.coverage.metricStatus, emptyTag === PE ? { pe_ttm: 'no_data', pb: 'available' } : { pe_ttm: 'available', pb: 'no_data' });
    const missing = emptyTag === PE ? 'pe_ttm' : 'pb', available = emptyTag === PE ? 'pb' : 'pe_ttm';
    assert.ok(result.rows.every(row => row[missing] === null)); assert.equal(result.rows[0][available], '19.20');
    assert.equal(result.raw.metricDateCoverage[missing].noDataEvidence, 'identified_metric_chart_body_empty');
    assert.equal(result.coverage.missingDateCount[missing], 5);
  }
});

test('Baidu all-market mode returns proven empty evidence only after both correctly identified charts are empty', async () => {
  const all = { ...range, allowPartialMetrics: true, allowEmpty: true };
  const empty = await collector(value => { chart(value).body = []; chart(value).releaseDate = ''; return value; }).collect(all);
  assert.deepEqual(empty.rows, []); assert.equal(empty.coverage.kind, 'no_data');
  assert.deepEqual(empty.coverage.metricStatus, { pe_ttm: 'no_data', pb: 'no_data' });
  assert.equal(empty.coverage.noDataEvidence, 'both_metric_charts_explicitly_empty_in_requested_window');
  assert.deepEqual(chart(empty.raw.peTtm.response).body, []); assert.deepEqual(chart(empty.raw.pb.response).body, []);
  const outside = await collector(value => { chart(value).body = [['2026-10-13', '1']]; return value; }).collect(all);
  assert.deepEqual(outside.rows, []); assert.equal(outside.raw.metricDateCoverage.pb.noDataEvidence, 'identified_metric_chart_has_no_dates_in_requested_window');
  for (const bad of [
    value => { value.ResultCode = 1; return value; },
    value => { value.Result[0].DisplayData.resultData.tplData.result.chartInfo = []; return value; },
    value => { chart(value).body = []; chart(value).releaseDate = 'invalid'; return value; },
    value => { chart(value).body = []; chart(value).header = ['unknown']; return value; },
  ]) await assert.rejects(collector(bad).collect(all), { kind: 'invalid_response' });
});

test('Baidu partial metrics use only the real date union with explicit null gaps, never carry another date value', async () => {
  const result = await collector(value => { chart(value).body = chart(value).header[0] === PE ? [['2026-10-14', '10'], ['2026-10-15', '-2']] : [['2026-10-15', '1.2'], ['2026-10-16', '0']]; return value; })
    .collect({ ...range, allowPartialMetrics: true });
  assert.deepEqual(result.rows.map(row => [row.trade_date, row.pe_ttm, row.pb]), [['20261014', '10', null], ['20261015', '-2', '1.2'], ['20261016', null, '0']]);
  assert.equal(result.coverage.kind, 'partial_metrics'); assert.deepEqual(result.coverage.metricStatus, { pe_ttm: 'available', pb: 'available' });
  assert.deepEqual(result.coverage.missingDateCount, { pe_ttm: 1, pb: 1 });
});

test('Baidu all-market mode audits a real per-metric releaseDate mismatch without discarding matching current dates', async () => {
  const transform = value => { chart(value).releaseDate = chart(value).header[0] === PE ? '2001-08-30 00:00:00' : '2002-03-18 00:00:00'; return value; };
  await assert.rejects(collector(transform).collect(range), { kind: 'invalid_response' });
  const result = await collector(transform).collect({ ...range, allowPartialMetrics: true, allowEmpty: true });
  assert.equal(result.rows.length, 5); assert.equal(result.coverage.kind, 'available'); assert.equal(result.coverage.metricReleaseDateMismatch, true);
  assert.equal(result.raw.metricDateCoverage.pe_ttm.releaseDate, '20010830'); assert.equal(result.raw.metricDateCoverage.pb.releaseDate, '20020318');
  assert.equal(result.rows[0].pe_ttm, '19.20'); assert.equal(result.rows[0].pb, '19.20');
  await assert.rejects(collector(value => { chart(value).releaseDate = '2026-10-16 00:00:00'; return value; }).collect({ ...range, allowPartialMetrics: true }), { kind: 'invalid_response' });
});

test('Baidu partial mode never turns a network or invalid metric request into a missing-value success', async () => {
  for (const failure of ['network', 'invalid_response']) {
    const client = createBaiduHkValuationClient({ intervalMs: 0, maxRetries: 0, fetchImpl: async url => {
      const tag = new URL(url).searchParams.get('tag');
      if (tag === PB) { if (failure === 'network') throw new Error('private-network-message'); return response({ ResultCode: 1 }); }
      return response(body(tag));
    } });
    await assert.rejects(client.collect({ ...range, allowPartialMetrics: true, allowEmpty: true }), error => error.kind === failure && !/private/.test(error.message));
  }
});

test('Baidu allows an inclusive leap-year range up to 366 days and rejects bad requests without fetching', async () => {
  let calls = 0; const c = createBaiduHkValuationClient({ intervalMs: 0, maxRetries: 0, fetchImpl: async url => {
    calls++; return response(body(new URL(url).searchParams.get('tag'), { body: [['2024-02-29', '1']] }));
  } });
  assert.equal((await c.collect({ ...range, startDate: '20230301', endDate: '20240229' })).rows.length, 1);
  for (const changes of [{ ticker: '700.HK' }, { ticker: '00700.SH' }, { startDate: '20230228', endDate: '20240229' },
    { startDate: '20261019' }, { startDate: '20260230' }]) await assert.rejects(c.collect({ ...range, ...changes }), { kind: 'configuration' });
  assert.equal(calls, 2);
});

test('Baidu serializes collectors and each metric with bounded HTTP retries on the fixed host', async () => {
  let clock = 0, calls = 0; const starts = [], hosts = [];
  const c = createBaiduHkValuationClient({ intervalMs: 1000, maxRetries: 1, retryBaseMs: 500, now: () => clock,
    sleep: async ms => { clock += ms; }, fetchImpl: async url => { starts.push(clock); hosts.push(new URL(url).host);
      if (++calls === 1) return { status: 503 }; return response(body(new URL(url).searchParams.get('tag'))); } });
  await Promise.all([c.collect(range), c.collect(range)]);
  assert.deepEqual(starts, [0, 1000, 2000, 3000, 4000]); assert.deepEqual(hosts, Array(5).fill('finance.baidu.com'));
  let failures = 0; const failed = createBaiduHkValuationClient({ intervalMs: 0, retryBaseMs: 0, maxRetries: 1,
    fetchImpl: async () => { failures++; return { status: 503 }; } });
  await assert.rejects(failed.collect(range), { kind: 'upstream' }); assert.equal(failures, 2);
});

test('Baidu bounded concurrency shares one global 1s gate across all PE, PB and retry requests', async () => {
  let clock = 0, active = 0, peak = 0; const starts = [], release = [];
  const client = createBaiduHkValuationClient({ concurrency: 3, intervalMs: 0, maxRetries: 0, now: () => clock,
    sleep: async ms => { clock += ms; }, fetchImpl: async url => {
      starts.push(clock); active++; peak = Math.max(peak, active);
      await new Promise(resolve => release.push(resolve)); active--; return response(body(new URL(url).searchParams.get('tag')));
    } });
  const pending = Promise.all(Array.from({ length: 4 }, () => client.collect(range)));
  for (let i = 0; i < 30 && release.length < 3; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(release.length, 3); assert.equal(peak, 3); assert.deepEqual(starts, [0, 1000, 2000]);
  for (let i = 0; i < 30 && release.length < 8; i++) { for (const resolve of release) resolve(); await new Promise(resolve => setImmediate(resolve)); }
  for (const resolve of release) resolve(); await pending;
  assert.equal(starts.length, 8); assert.equal(peak, 3); assert.ok(starts.slice(1).every((start, i) => start - starts[i] >= 1000));
  let calls = 0; const retryStarts = [];
  const retry = createBaiduHkValuationClient({ concurrency: 3, intervalMs: 0, maxRetries: 1, retryBaseMs: 0, now: () => clock,
    sleep: async ms => { clock += ms; }, fetchImpl: async url => { retryStarts.push(clock); return ++calls === 1 ? { status: 503 } : response(body(new URL(url).searchParams.get('tag'))); } });
  await Promise.all([retry.collect(range), retry.collect(range)]);
  assert.equal(retryStarts.length, 5); assert.ok(retryStarts.slice(1).every((start, i) => start - retryStarts[i] >= 1000));
});

test('Baidu 429 and 403 stop all queued work without retrying, while invalid concurrency/options fail before fetching', async () => {
  for (const [status, kind] of [[429, 'rate_limit'], [403, 'permission']]) {
    let calls = 0, clock = 0;
    const client = createBaiduHkValuationClient({ concurrency: 3, maxRetries: 2, now: () => clock,
      sleep: async ms => { clock += ms; }, fetchImpl: async () => { calls++; return { status }; } });
    const result = await Promise.allSettled(Array.from({ length: 4 }, () => client.collect(range)));
    assert.ok(result.every(row => row.status === 'rejected' && row.reason.kind === kind)); assert.equal(calls, 1);
    await assert.rejects(client.collect(range), { kind }); assert.equal(calls, 1);
  }
  for (const concurrency of [0, 4, 1.1, '3']) assert.throws(() => createBaiduHkValuationClient({ concurrency }), { kind: 'configuration' });
  for (const option of [{ allowPartialMetrics: 'true' }, { allowEmpty: null }]) await assert.rejects(collector().collect({ ...range, ...option }), { kind: 'configuration' });
});

test('Baidu aborts timeouts, redacts upstream failures and never retries invalid payloads', async () => {
  const c = createBaiduHkValuationClient({ intervalMs: 0, timeoutMs: 5, maxRetries: 0, fetchImpl: async (_, { signal }) =>
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('raw secret')))) });
  await assert.rejects(c.collect(range), error => { assert.equal(error.kind, 'timeout'); assert.doesNotMatch(error.message, /secret/); return true; });
  let calls = 0; const invalid = createBaiduHkValuationClient({ intervalMs: 0, maxRetries: 1, fetchImpl: async () => { calls++; return response({ ResultCode: 1 }); } });
  await assert.rejects(invalid.collect(range), { kind: 'invalid_response' }); assert.equal(calls, 1);
});
