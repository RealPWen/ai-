export const VALUATION_BANDS_MIN_SAMPLES = 20;
const QUANTILES = [['p10', 0.1], ['p25', 0.25], ['p50', 0.5], ['p75', 0.75], ['p90', 0.9]];

function finiteObservation(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Type 7: linear interpolation over the complete sorted positive sample. */
function quantile(sorted, probability) {
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position), weight = position - lower;
  return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * weight;
}

/** Missing and non-positive observations remain explicit gaps, never zero-valued samples. */
export function summarizeValuationMetric(metric, rows, { availableFrom = null, databaseThrough = null } = {}) {
  const observations = rows.filter(row => typeof row.trade_date === 'string').map(row => ({
    date: row.trade_date, rawValue: finiteObservation(row[metric]),
  })).sort((left, right) => left.date.localeCompare(right.date));
  const points = observations.map(row => ({ date: row.date, value: row.rawValue !== null && row.rawValue > 0 ? row.rawValue : null }));
  const values = points.map(point => point.value).filter(value => value !== null).sort((left, right) => left - right);
  const validCount = values.length;
  const enoughSamples = validCount >= VALUATION_BANDS_MIN_SAMPLES;
  const last = observations.at(-1), latestValue = points.at(-1)?.value ?? null;
  const percentile = enoughSamples && latestValue !== null
    ? 100 * (values.filter(value => value < latestValue).length + 0.5 * values.filter(value => value === latestValue).length) / validCount
    : null;
  return {
    metric,
    status: validCount === 0 ? 'no_data' : enoughSamples ? 'available' : 'insufficient_samples',
    points,
    quantiles: Object.fromEntries(QUANTILES.map(([key, probability]) => [key, enoughSamples ? quantile(values, probability) : null])),
    latest: { date: last?.date ?? null, rawValue: last?.rawValue ?? null, value: latestValue, percentile },
    meta: {
      validCount, totalCount: observations.length,
      missingCount: observations.filter(row => row.rawValue === null).length,
      nonPositiveCount: observations.filter(row => row.rawValue !== null && row.rawValue <= 0).length,
      firstDate: observations[0]?.date ?? null, lastDate: last?.date ?? null,
      availableFrom, databaseThrough, minSamples: VALUATION_BANDS_MIN_SAMPLES,
    },
  };
}

export function summarizeValuationBands({ ticker, asOf, period, windowStart, rows }) {
  const bounds = { availableFrom: rows[0]?.available_from ?? null, databaseThrough: rows[0]?.database_through ?? null };
  return {
    ticker, asOf, period, windowStart, source: 'Tushare daily_basic',
    peTtm: summarizeValuationMetric('pe_ttm', rows, bounds),
    pb: summarizeValuationMetric('pb', rows, bounds),
  };
}
