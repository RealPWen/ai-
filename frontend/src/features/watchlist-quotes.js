const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function previousCalendarDay(value) {
  if (!validDate(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

const unavailable = reason => ({ status: 'unavailable', reason });

function quoteState(quote, ticker, cutoff) {
  if (quote == null) return unavailable('暂无上一交易日行情');
  if (quote.ticker !== ticker || !validDate(quote.asOf) || quote.asOf > cutoff
    || (quote.requestedAsOf != null && quote.requestedAsOf !== cutoff)) return unavailable('上一交易日行情数据不匹配');
  if (typeof quote.pctChange !== 'number' || !Number.isFinite(quote.pctChange)) {
    return { ...unavailable('该交易日暂无涨跌幅数据'), tradeDate: quote.asOf };
  }
  return { status: 'ready', tradeDate: quote.asOf, pctChange: quote.pctChange };
}

// Cache belongs to the current research date only; no quote is written to storage.
export function createWatchlistQuotes({ loadQuote, onChange = () => {}, concurrency = 3 } = {}) {
  const limit = Math.max(1, Math.min(4, Math.floor(concurrency) || 3));
  let cutoff = null, revision = 0, disposed = false;
  let tickers = new Set(), queue = [];
  const entries = new Map(), active = new Set();
  const current = job => !disposed && !job.cancelled && job.revision === revision
    && tickers.has(job.ticker) && entries.get(job.ticker) === job.entry;
  const cancel = job => { job.cancelled = true; job.controller?.abort(); };

  function pump() {
    while (!disposed && active.size < limit && queue.length) {
      const job = queue.shift();
      if (!current(job)) continue;
      job.controller = new AbortController();
      active.add(job);
      Promise.resolve().then(() => {
        if (!current(job)) return null;
        return loadQuote({ ticker: job.ticker, asOf: job.cutoff }, { signal: job.controller.signal });
      }).then(quote => {
        if (!current(job)) return;
        job.entry.state = quoteState(quote, job.ticker, job.cutoff);
        onChange();
      }).catch(() => {
        if (!current(job)) return;
        job.entry.state = unavailable('上一交易日行情读取失败');
        onChange();
      }).finally(() => { active.delete(job); pump(); });
    }
  }

  function setContext({ asOf, tickers: nextTickers = [] } = {}) {
    if (disposed) return;
    const nextCutoff = previousCalendarDay(asOf);
    const next = new Set(nextTickers);
    if (nextCutoff !== cutoff) {
      revision += 1;
      for (const job of [...queue, ...active]) cancel(job);
      queue = [];
      entries.clear();
      cutoff = nextCutoff;
    }
    tickers = next;
    for (const [ticker] of entries) {
      if (tickers.has(ticker)) continue;
      for (const job of [...queue, ...active]) if (job.ticker === ticker) cancel(job);
      entries.delete(ticker);
    }
    queue = queue.filter(current);
    for (const ticker of tickers) {
      if (entries.has(ticker)) continue;
      const entry = { state: unavailable(cutoff ? '暂无上一交易日行情' : '研究日期无效，暂无涨跌幅') };
      entries.set(ticker, entry);
      if (!cutoff || typeof loadQuote !== 'function') continue;
      entry.state = { status: 'loading', reason: '正在读取上一交易日涨跌幅' };
      queue.push({ ticker, cutoff, revision, entry });
    }
    onChange();
    pump();
  }

  return {
    setContext,
    get: ticker => entries.get(ticker)?.state || unavailable('暂无上一交易日行情'),
    destroy() {
      disposed = true;
      for (const job of [...queue, ...active]) cancel(job);
      queue = [];
      entries.clear();
    },
  };
}
