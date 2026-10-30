const finite = value => typeof value === 'number' && Number.isFinite(value);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

/** Latest observations retain their own dates; returns always share both endpoints. */
export function summarizeMarketComparison(points = [], benchmark = null) {
  const stocks = [...new Map(points.filter(point => validDate(point?.date) && finite(point.close) && point.close >= 0)
    .map(point => [point.date, { date: point.date, close: point.close }])).values()].sort((a, b) => a.date.localeCompare(b.date));
  const stock = stocks.at(-1) ?? null;
  if (!benchmark || !['available', 'no_common_date'].includes(benchmark.status)) return { stock, index: null, performance: null };
  const indices = (benchmark.points || []).filter(point => validDate(point?.date) && finite(point.close) && point.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  const latest = Object.hasOwn(benchmark, 'latest') ? benchmark.latest : indices.at(-1);
  const index = validDate(latest?.date) && finite(latest.close) && latest.close > 0 ? { date: latest.date, close: latest.close } : null;
  const byDate = new Map(indices.map(point => [point.date, point.close]));
  const common = stocks.filter(point => point.close > 0 && byDate.has(point.date));
  if (benchmark.status !== 'available' || common.length < 2) return { stock, index, performance: null };
  const first = common[0], last = common.at(-1);
  const stockReturn = first.close > 0 ? last.close / first.close - 1 : NaN;
  const indexReturn = byDate.get(last.date) / byDate.get(first.date) - 1;
  const excessPercentagePoints = (stockReturn - indexReturn) * 100;
  const performance = [stockReturn, indexReturn, excessPercentagePoints].every(finite)
    ? { from: first.date, to: last.date, stockReturn, indexReturn, excessPercentagePoints } : null;
  return { stock, index, performance };
}
