import { createHash } from 'node:crypto';
import { summarizeMarketComparison } from '../../frontend/src/features/market-comparison.js';
import { todayShanghai, validDate } from './input.mjs';
import { ResearchError } from './errors.mjs';

export const ATTRIBUTION_PERIODS = ['1m', '6m', '1y'];
const MONTHS = { '1m': 1, '6m': 6, '1y': 12 };
export const ATTRIBUTION_METHOD = 'news-summary-relative-return-v2';
const invalid = message => new ResearchError('INVALID_ATTRIBUTION_INPUT', message, 400);
export function attributionInput(raw, { now = new Date(), generate = false } = {}) {
  const allowed = generate ? ['ticker', 'periods'] : ['ticker', 'asOf'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !allowed.includes(key))) throw invalid('涨跌归因请求参数无效。');
  const ticker = typeof raw.ticker === 'string' ? raw.ticker.trim().toUpperCase() : '';
  if (!/^(?:\d{6}\.(?:SH|SZ|BJ)|\d{5}\.HK)$/.test(ticker)) throw invalid('涨跌归因仅支持 A 股及五位港股公司代码。');
  const today = todayShanghai(now), asOf = generate ? today : raw.asOf ?? today;
  if (!validDate(asOf) || asOf > today) throw invalid('数据日期无效或晚于今日。');
  const periods = generate ? raw.periods ?? ATTRIBUTION_PERIODS : ATTRIBUTION_PERIODS;
  if (!Array.isArray(periods) || !periods.length || periods.length > 3 || new Set(periods).size !== periods.length || periods.some(period => !ATTRIBUTION_PERIODS.includes(period))) throw invalid('归因周期仅支持 1m、6m、1y，且不能重复。');
  return { ticker, asOf, periods: ATTRIBUTION_PERIODS.filter(period => periods.includes(period)) };
}
export function attributionWindow(asOf, period) {
  if (!validDate(asOf) || !ATTRIBUTION_PERIODS.includes(period)) throw invalid('归因周期或数据日期无效。');
  const date = new Date(`${asOf}T00:00:00Z`), day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() - MONTHS[period]);
  date.setUTCDate(Math.min(day, new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()));
  return date.toISOString().slice(0, 10);
}
export function buildAttributionSnapshot({ ticker, period, asOf, profile, prices, sector: resolvedSector }) {
  if (typeof ticker !== 'string' || !/^(?:\d{6}\.(?:SH|SZ|BJ)|\d{5}\.HK)$/.test(ticker) || !ATTRIBUTION_PERIODS.includes(period) || !validDate(asOf)) throw invalid('归因股票、周期或数据日期无效。');
  const hk = ticker.endsWith('.HK'), adjustment = hk ? 'none' : 'qfq';
  if (prices?.ticker !== ticker || prices.meta?.requestedAsOf !== asOf || prices.meta?.period !== period || prices.meta?.adjustment !== adjustment) throw new ResearchError('ATTRIBUTION_DATA_MISMATCH', '行情返回的证券、日期或价格口径不一致。', 503);
  const benchmark = prices.benchmark;
  if (!benchmark || benchmark.status !== 'available' || (hk ? benchmark.system !== 'HSI' || benchmark.indexCode !== 'HSI' : benchmark.system !== 'SW2021')) throw new ResearchError('ATTRIBUTION_BENCHMARK_MISSING', hk ? '恒生指数数据尚未就绪，请稍后重试。' : '当前股票缺少可用的行业指数对照。', 409);
  if (!Array.isArray(prices.points) || !Array.isArray(benchmark.points)) throw new ResearchError('ATTRIBUTION_DATA_MISMATCH', '行情或比较基准序列无效。', 503);
  const requestedFrom = attributionWindow(asOf, period);
  const normalize = points => [...new Map(points.filter(point => validDate(point?.date) && point.date >= requestedFrom && point.date <= asOf && Number.isFinite(point.close) && point.close > 0)
    .map(point => [point.date, { date: point.date, close: point.close }])).values()].sort((a, b) => a.date.localeCompare(b.date));
  const stockPoints = normalize(prices.points), indexPoints = normalize(benchmark.points);
  const { performance } = summarizeMarketComparison(stockPoints, { ...benchmark, points: indexPoints });
  if (!performance) throw new ResearchError('ATTRIBUTION_NO_COMMON_DATA', '股票与指数至少需要两个共同交易日才能生成归因。', 409);
  const indices = new Map(indexPoints.map(point => [point.date, point.close]));
  const series = stockPoints.filter(point => point.date >= performance.from && point.date <= performance.to && indices.has(point.date))
    .map(point => ({ date: point.date, stockClose: point.close, indexClose: indices.get(point.date) }));
  if (series.length < 2 || series[0].date !== performance.from || series.at(-1).date !== performance.to) throw new ResearchError('ATTRIBUTION_DATA_MISMATCH', '股票与指数的比较窗口不一致。', 503);
  const partial = Date.parse(performance.from) - Date.parse(requestedFrom) > 10 * 86400000 || Date.parse(asOf) - Date.parse(performance.to) > 10 * 86400000 || prices.meta.adjustmentStatus === 'partial';
  const basis = { ticker, period, method: ATTRIBUTION_METHOD, adjustment, benchmark: { indexCode: benchmark.indexCode, industryName: benchmark.industryName, system: benchmark.system, level: benchmark.level ?? null }, series };
  const sectorName = !hk ? benchmark.industryName || profile?.industry || profile?.businesses?.[0] : profile?.industry;
  const sector = resolvedSector?.known === false ? { ...resolvedSector, name: '' }
    : resolvedSector ?? (typeof sectorName === 'string' && sectorName.trim()
      ? { name:sectorName.trim(),source:hk?'company_profile':'sw2021',known:true } : { name:'',source:'unknown',known:false });
  return { ticker, period, companyName: profile?.name || ticker, requestedAsOf: asOf, ...performance, benchmark: basis.benchmark, adjustment, currency: prices.meta.currency || (hk ? 'HKD' : 'CNY'),
    coverage: { requestedFrom, actualFrom: performance.from, actualTo: performance.to, pointCount: series.length, partial }, sector,newsFrom:requestedFrom,newsTo:performance.to,series,
    inputHash: createHash('sha256').update(JSON.stringify(basis)).digest('hex') };
}
export function publicAttributionMetrics(snapshot) {
  if (!snapshot) return null;
  const { series, inputHash, ...metrics } = snapshot;
  return metrics;
}
