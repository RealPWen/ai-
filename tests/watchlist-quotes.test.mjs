import test from 'node:test';
import assert from 'node:assert/strict';
import { createWatchlistQuotes, previousCalendarDay } from '../frontend/src/features/watchlist-quotes.js';

const tickers = ['002920.SZ', '000338.SZ', '600519.SH', '000001.SZ', '300750.SZ', '02313.HK'];
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferredQuotes() {
  const calls = [];
  return {
    calls,
    loadQuote(params, { signal }) {
      return new Promise((resolve, reject) => calls.push({ ...params, signal, resolve, reject }));
    },
  };
}
const response = (call, pctChange = 1.23, date = call.asOf) => ({ ticker: call.ticker, requestedAsOf: call.asOf, asOf: date, pctChange });

test('上一交易日请求严格先减一个日历日，跨年、闰日及无效日期均正确处理', () => {
  assert.equal(previousCalendarDay('2026-10-12'), '2026-10-11');
  assert.equal(previousCalendarDay('2026-01-01'), '2025-12-31');
  assert.equal(previousCalendarDay('2024-03-01'), '2024-02-29');
  for (const value of ['2026-02-29', '2026-13-01', '2026-1-1', '', null]) assert.equal(previousCalendarDay(value), null);
});

test('同研究日请求去重且最多三项并发，周末返回周五实际日期并保留负值与零', async t => {
  const loader = deferredQuotes(), quotes = createWatchlistQuotes(loader);
  t.after(() => quotes.destroy());
  const context = { asOf: '2026-10-12', tickers };
  quotes.setContext(context); quotes.setContext(context);
  await flush();
  assert.equal(loader.calls.length, 3);
  assert.ok(loader.calls.every(call => call.asOf === '2026-10-11'));
  loader.calls[0].resolve(response(loader.calls[0], -1.23, '2026-10-09'));
  await flush();
  assert.equal(loader.calls.length, 4);
  assert.deepEqual(quotes.get(tickers[0]), { status: 'ready', tradeDate: '2026-10-09', pctChange: -1.23 });
  loader.calls[1].resolve(response(loader.calls[1], 0, '2026-10-09'));
  loader.calls[2].resolve(response(loader.calls[2], 2.34, '2026-10-09'));
  await flush();
  assert.equal(loader.calls.length, 6);
  assert.equal(quotes.get(tickers[1]).pctChange, 0);
  for (const call of loader.calls.slice(3)) call.resolve(null);
  await flush(); quotes.setContext(context); await flush();
  assert.equal(loader.calls.length, 6, '成功与无数据结果均按当前研究日缓存');
});

test('切换日期立即清除旧涨跌并取消请求，忽略不遵守取消信号的晚响应', async t => {
  const loader = deferredQuotes(), quotes = createWatchlistQuotes(loader);
  t.after(() => quotes.destroy());
  quotes.setContext({ asOf: '2026-10-15', tickers: tickers.slice(0, 2) }); await flush();
  const [oldReady, oldPending] = loader.calls;
  oldReady.resolve(response(oldReady, 3)); await flush();
  assert.equal(quotes.get(tickers[0]).pctChange, 3);
  quotes.setContext({ asOf: '2026-10-12', tickers: tickers.slice(0, 2) });
  assert.equal(oldPending.signal.aborted, true);
  assert.equal(quotes.get(tickers[0]).status, 'loading');
  await flush();
  oldPending.resolve(response(oldPending, 99)); await flush();
  assert.notEqual(quotes.get(tickers[1]).pctChange, 99);
  const recent = loader.calls.filter(call => call.asOf === '2026-10-11');
  assert.equal(recent.length, 2);
  for (const call of recent) call.resolve(response(call, -2, '2026-10-09'));
  await flush();
  assert.equal(quotes.get(tickers[1]).pctChange, -2);
  assert.equal(quotes.get(tickers[1]).tradeDate, '2026-10-09');
});

test('移除标的取消其请求，晚响应不会恢复已移除行，再加入产生新任务', async t => {
  const loader = deferredQuotes(), quotes = createWatchlistQuotes(loader);
  t.after(() => quotes.destroy());
  quotes.setContext({ asOf: '2026-10-15', tickers: tickers.slice(0, 4) }); await flush();
  const removed = loader.calls[0];
  quotes.setContext({ asOf: '2026-10-15', tickers: tickers.slice(1, 4) });
  assert.equal(removed.signal.aborted, true);
  removed.resolve(response(removed, 88)); await flush();
  assert.equal(quotes.get(tickers[0]).status, 'unavailable');
  assert.equal(loader.calls.length, 4, '取消任务结束后继续队列');
  quotes.setContext({ asOf: '2026-10-15', tickers: tickers.slice(0, 4) });
  loader.calls[1].resolve(null); await flush();
  const replacement = loader.calls.at(-1);
  assert.equal(replacement.ticker, tickers[0]);
  replacement.resolve(response(replacement, 1)); await flush();
  assert.equal(quotes.get(tickers[0]).pctChange, 1);
});

test('无数据、失败和不匹配数据保留中性原因，未来行情不能成为上一交易日', async t => {
  const cases = [
    [null, /暂无上一交易日行情/],
    [{ ticker: tickers[0], asOf: '2026-10-14', pctChange: null }, /暂无涨跌幅数据/],
    [{ ticker: tickers[1], asOf: '2026-10-14', pctChange: 1 }, /数据不匹配/],
    [{ ticker: tickers[0], asOf: '2026-10-15', pctChange: 1 }, /数据不匹配/],
    [{ ticker: tickers[0], asOf: '2026-10-14', requestedAsOf: '2026-10-15', pctChange: 1 }, /数据不匹配/],
    [new Error('network failed'), /读取失败/],
  ];
  for (const [result, reason] of cases) {
    const quotes = createWatchlistQuotes({ loadQuote: async () => { if (result instanceof Error) throw result; return result; } });
    t.after(() => quotes.destroy());
    quotes.setContext({ asOf: '2026-10-15', tickers: [tickers[0]] }); await flush();
    assert.equal(quotes.get(tickers[0]).status, 'unavailable');
    assert.match(quotes.get(tickers[0]).reason, reason);
  }
});
