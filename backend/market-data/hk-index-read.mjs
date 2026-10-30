const positive = value => ['number', 'string'].includes(typeof value) && String(value).trim() && Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;

export async function readHkIndexBenchmark({ query, from, asOf, stockPoints }) {
  const benchmark = { status: 'missing_prices', system: 'HSI', level: null, membershipBasis: 'index', membershipFetchedAt: null,
    indexCode: 'HSI', industryName: '恒生指数', baseDate: null, baseStockClose: null, baseIndexClose: null, latest: null,
    points: stockPoints.map(point => ({ date: point.date, close: null, scaledClose: null })) };
  const result = await query(`SELECT to_char(trade_date,'YYYY-MM-DD') AS trade_date,close FROM market_data.hk_index_daily
    WHERE index_code=$1 AND trade_date BETWEEN $2::date AND $3::date ORDER BY trade_date`, ['HSI', from, asOf]);
  const byDate = new Map(result.rows.filter(row => typeof row.trade_date === 'string' && row.trade_date >= from && row.trade_date <= asOf)
    .map(row => [row.trade_date, positive(row.close)]));
  const latest = [...byDate.entries()].filter(([, close]) => close !== null).sort(([a], [b]) => a.localeCompare(b)).at(-1);
  if (!latest) return benchmark;
  benchmark.latest = { date: latest[0], close: latest[1] };
  const base = stockPoints.filter(point => positive(point.close) !== null && byDate.get(point.date) != null).sort((a, b) => a.date.localeCompare(b.date))[0];
  if (!base) return { ...benchmark, status: 'no_common_date' };
  const baseStockClose = positive(base.close), baseIndexClose = byDate.get(base.date);
  return { ...benchmark, status: 'available', baseDate: base.date, baseStockClose, baseIndexClose,
    points: stockPoints.map(point => { const close = byDate.get(point.date) ?? null, scaledClose = close === null ? null : close / baseIndexClose * baseStockClose;
      return { date: point.date, close, scaledClose: Number.isFinite(scaledClose) ? scaledClose : null }; }) };
}
