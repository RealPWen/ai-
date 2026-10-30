import pg from 'pg';
import { ResearchError } from '../src/errors.mjs';
import { todayShanghai, validDate } from '../src/input.mjs';
import { readIndustryBenchmark } from './industry-read.mjs';
import { readHkIndexBenchmark } from './hk-index-read.mjs';
import { summarizeValuationBands } from './valuation-bands.mjs';

const PERIOD_MONTHS = { '1m': 1, '6m': 6, '1y': 12 };

function unavailable() {
  // Never return the original driver error: it may contain credentials or SQL.
  return new ResearchError('MARKET_DATABASE_UNAVAILABLE', '行情数据库暂不可用，请稍后重试。', 503);
}

function parseTicker(value) {
  if (typeof value !== 'string' || !/^(?:\d{6}\.(?:SH|SZ|BJ)|\d{5}\.HK)$/i.test(value.trim())) {
    throw new ResearchError('INVALID_TICKER', '请输入有效的 A 股或港股代码，例如 002920.SZ、600000.SH 或 00700.HK。', 400);
  }
  return value.trim().toUpperCase();
}

function parseAsOf(value, now) {
  const today = todayShanghai(typeof now === 'function' ? now() : now);
  const asOf = value ?? today;
  if (!validDate(asOf) || asOf > today) {
    throw new ResearchError('INVALID_DATE', '行情日期应为有效的 YYYY-MM-DD，且不能晚于上海时区今日。', 400);
  }
  return asOf;
}

function subtractMonths(asOf, months) {
  const date = new Date(`${asOf}T00:00:00Z`);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString().slice(0, 10);
}

function numberOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function profileFromRow(row) {
  if (!row) return null;
  const industry = typeof row.industry === 'string' ? row.industry.trim() : '';
  return {
    ticker: row.ts_code,
    name: row.name || row.ts_code,
    description: industry ? `行业分类：${industry}。公司业务简介待补充。` : '公司业务简介待补充。',
    businesses: industry ? [industry] : [],
    sourceUrl: 'https://tushare.pro',
    market: 'A',
  };
}

const SOURCE_LABELS = { tushare: 'Tushare', tencent: 'Tencent', eastmoney: 'Eastmoney', yahoo: 'Yahoo', baidu: '百度股市通', hkex: '香港交易所' };
function hkSource(row) {
  return { source: SOURCE_LABELS[row?.source] ?? row?.source ?? null, sourceId: row?.source ?? null, sourceApi: row?.source_api ?? null };
}
function hkValuationSource(row) {
  const metadata = hkSource(row);
  // Keep the public provider label readable, while retaining the precise API
  // separately. An unrecognized provider remains explicit rather than becoming
  // a Tushare valuation by default.
  return { ...metadata, source: metadata.source === null ? null : row.source === 'baidu' ? metadata.source
    : [metadata.source, metadata.sourceApi].filter(Boolean).join(' ') };
}
function hkValuationSources(rows) {
  return [...new Map(rows.filter(row => typeof row.trade_date === 'string').map(row => {
    const metadata = hkValuationSource(row);
    return [`${metadata.sourceId}\u0000${metadata.sourceApi}`, metadata];
  })).values()].filter(metadata => metadata.source !== null);
}
function hkUnits(row) {
  const currency = row?.currency ?? 'HKD';
  return { market: 'HK', currency: row?.currency ?? 'HKD', volumeUnit: row?.volume_unit === 'share' || !row?.volume_unit ? '股' : row.volume_unit,
    amountUnit: ({ hkd: '港元', usd: '美元' })[row?.amount_unit ?? currency.toLowerCase()] ?? row.amount_unit };
}
function hkSourceUrl(row, ticker) {
  return { tencent: `https://gu.qq.com/hk${ticker.slice(0, 5)}`, eastmoney: `https://quote.eastmoney.com/hk/${ticker.slice(0, 5)}.html`,
    yahoo: `https://finance.yahoo.com/quote/${String(Number(ticker.slice(0, 5))).padStart(4, '0')}.HK/`, tushare: 'https://tushare.pro' }[row?.source] ?? null;
}

/** Read-only local A shares and active HK company listings. No provider requests. */
export function createMarketReadService({ connectionString, pool: injectedPool, now = () => new Date() } = {}) {
  let pool;
  try {
    if (!injectedPool && (typeof connectionString !== 'string' || !connectionString.trim())) throw unavailable();
    pool = injectedPool ?? new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 10_000, query_timeout: 20_000 });
    // An idle connection failure must not crash the API process. Queries return
    // the same sanitized unavailable error and the Pool reconnects as needed.
    if (!injectedPool) pool.on('error', () => {});
  } catch {
    throw unavailable();
  }

  async function query(sql, params) {
    try { return await pool.query(sql, params); } catch { throw unavailable(); }
  }
  async function tickerFor(inputTicker) {
    const ticker = parseTicker(inputTicker);
    if (ticker.endsWith('.HK')) {
      // Do not cache the active catalog: a successful daily listing refresh may
      // add a new company or retire a delisted one while this process is alive.
      const listing = await query(`SELECT ts_code, name, currency FROM market_data.hk_listed_universe WHERE ts_code = $1 AND active = true`, [ticker]);
      if (!listing.rows.some(row => row.ts_code === ticker)) {
        throw new ResearchError('MARKET_NOT_IN_UNIVERSE', '该代码不在当前上市港股公司名单中。', 404);
      }
      return { ticker, listing: listing.rows.find(row => row.ts_code === ticker) };
    }
    return { ticker, listing: null };
  }

  return {
    async search({ q = '', limit = 20, market = 'all' } = {}) {
      if (typeof q !== 'string' || q.trim().length > 100) {
        throw new ResearchError('INVALID_SEARCH', '股票搜索词应为不超过 100 字的文本。', 400);
      }
      if (!(typeof limit === 'number' || typeof limit === 'string') || !/^\d+$/.test(String(limit)) || Number(limit) < 1 || Number(limit) > 50) {
        throw new ResearchError('INVALID_LIMIT', '股票搜索数量应为 1 至 50 的整数。', 400);
      }
      if (!['all', 'A', 'HK'].includes(market)) throw new ResearchError('INVALID_MARKET', '股票搜索市场仅支持 all、A 或 HK。', 400);
      const text = q.trim();
      // Use an explicit escape character so user %, _ and ! are literal text.
      const pattern = `%${text.replace(/[!%_]/g, character => `!${character}`)}%`;
      if (market !== 'A') {
        const hkOnly = market === 'HK';
        const result = await query(`WITH available AS (
            ${hkOnly ? '' : "SELECT DISTINCT ts_code, market, NULL::text AS listing_name FROM market_data.daily_prices WHERE market = 'A' UNION ALL"}
            SELECT ts_code, 'HK'::text AS market, name AS listing_name FROM market_data.hk_listed_universe WHERE active = true
          ), matches AS (
            SELECT a.ts_code, a.market, coalesce(nullif(a.listing_name, ''), nullif(s.name, ''), a.ts_code) AS name,
              CASE WHEN a.ts_code = $2 OR split_part(a.ts_code, '.', 1) = $2 OR coalesce(a.listing_name, s.name) = $3 THEN 0 ELSE 1 END AS exact_rank,
              CASE WHEN a.market = 'HK' OR s.list_status = 'L' THEN 0 ELSE 1 END AS status_rank
            FROM available a LEFT JOIN market_data.securities s ON s.ts_code = a.ts_code AND s.market = a.market
            WHERE a.ts_code ILIKE $1 ESCAPE '!' OR coalesce(a.listing_name, s.name) ILIKE $1 ESCAPE '!'
          ), ranked AS (
            SELECT *, row_number() OVER (PARTITION BY market ORDER BY exact_rank, status_rank, ts_code) AS market_rank FROM matches
          ) SELECT ts_code, name, market FROM ranked ORDER BY exact_rank, market_rank, market, ts_code LIMIT $4`,
        [pattern, text.toUpperCase(), text, Number(limit)]);
        return result.rows.filter(row => !hkOnly || row.ts_code.endsWith('.HK'))
          .map(row => ({ ticker: row.ts_code, name: row.name || row.ts_code,
            market: row.ts_code.endsWith('.HK') ? 'HK' : 'A' }));
      }
      const result = await query(`WITH available AS (
          SELECT DISTINCT ts_code FROM market_data.daily_prices WHERE market = 'A'
        ) SELECT a.ts_code, coalesce(nullif(s.name, ''), a.ts_code) AS name
        FROM available a
        LEFT JOIN market_data.securities s ON s.ts_code = a.ts_code AND s.market = 'A'
        WHERE a.ts_code ILIKE $1 ESCAPE '!' OR s.name ILIKE $1 ESCAPE '!'
        ORDER BY CASE WHEN s.list_status = 'L' THEN 0 ELSE 1 END,
          CASE WHEN a.ts_code = $2 OR split_part(a.ts_code, '.', 1) = $2 OR s.name = $3 THEN 0 ELSE 1 END,
          a.ts_code
        LIMIT $4`, [pattern, text.toUpperCase(), text, Number(limit)]);
      return result.rows.map(row => ({ ticker: row.ts_code, name: row.name || row.ts_code, market: 'A' }));
    },

    async profile({ ticker: inputTicker } = {}) {
      const { ticker } = await tickerFor(inputTicker);
      if (ticker.endsWith('.HK')) {
        const result = await query(`SELECT c.ts_code, coalesce(nullif(c.name, ''), nullif(s.name, ''), c.ts_code) AS name,
            coalesce(p.source, c.source) AS source, coalesce(p.source_api, c.source_api) AS source_api,
            coalesce(p.currency, c.currency) AS currency, p.volume_unit, p.amount_unit
          FROM market_data.hk_listed_universe c LEFT JOIN LATERAL (
            SELECT source, source_api, currency, volume_unit, amount_unit FROM market_data.daily_prices
            WHERE ts_code = c.ts_code AND market = 'HK' ORDER BY trade_date DESC LIMIT 1
          ) p ON true LEFT JOIN market_data.securities s ON s.ts_code = c.ts_code AND s.market = 'HK'
          WHERE c.ts_code = $1 AND c.active = true`, [ticker]);
        const row = result.rows[0]; if (!row) return null;
        return { ticker, name: row.name || ticker, description: '公司业务简介待补充。', businesses: [], scope: 'hk_listed_universe',
          sourceUrl: hkSourceUrl(row, ticker), ...hkUnits(row), ...hkSource(row) };
      }
      const result = await query(`SELECT p.ts_code, coalesce(nullif(s.name, ''), p.ts_code) AS name, s.industry
        FROM (SELECT ts_code FROM market_data.daily_prices WHERE ts_code = $1 AND market = 'A' LIMIT 1) p
        LEFT JOIN market_data.securities s ON s.ts_code = p.ts_code AND s.market = 'A'`, [ticker]);
      return profileFromRow(result.rows[0]);
    },

    async quote({ ticker: inputTicker, asOf: inputAsOf, adjustment, benchmark } = {}) {
      const { ticker } = await tickerFor(inputTicker);
      const asOf = parseAsOf(inputAsOf, now);
      if (ticker.endsWith('.HK')) {
        if (adjustment !== undefined && adjustment !== 'none') throw new ResearchError('ADJUSTMENT_NOT_SUPPORTED', '港股仅提供未复权日线，暂不支持前复权。', 400);
        if (benchmark !== undefined) throw new ResearchError('BENCHMARK_NOT_SUPPORTED', '港股暂不支持申万行业基准比较。', 400);
        const result = await query(`SELECT p.ts_code, to_char(p.trade_date, 'YYYY-MM-DD') AS trade_date,
            p.open, p.high, p.low, p.close, p.pre_close, p.change, p.pct_chg, p.vol, p.amount,
            p.source, p.source_api, p.currency, p.volume_unit, p.amount_unit,
            v.pe_ttm, v.pb, to_char(v.trade_date, 'YYYY-MM-DD') AS valuation_as_of,
            v.source AS valuation_source, v.source_api AS valuation_source_api,
            (SELECT to_char(max(d.trade_date), 'YYYY-MM-DD') FROM market_data.daily_prices d
              JOIN market_data.hk_listed_universe c ON c.ts_code = d.ts_code AND c.active = true WHERE d.market = 'HK') AS database_through
          FROM market_data.daily_prices p
          LEFT JOIN market_data.hk_daily_valuations v ON v.ts_code = p.ts_code AND v.trade_date = p.trade_date
          WHERE p.ts_code = $1 AND p.market = 'HK' AND p.trade_date <= $2::date
          ORDER BY p.trade_date DESC LIMIT 1`, [ticker, asOf]);
        const row = result.rows[0]; if (!row) return null;
        const valuationAsOf = row.valuation_as_of === row.trade_date ? row.valuation_as_of : null;
        const peTtm = valuationAsOf ? numberOrNull(row.pe_ttm) : null, pb = valuationAsOf ? numberOrNull(row.pb) : null;
        const valuationMeta = valuationAsOf === null ? null : hkValuationSource({ source: row.valuation_source, source_api: row.valuation_source_api });
        return { ticker, asOf: row.trade_date, requestedAsOf: asOf, price: numberOrNull(row.close), open: numberOrNull(row.open),
          high: numberOrNull(row.high), low: numberOrNull(row.low), previousClose: numberOrNull(row.pre_close), change: numberOrNull(row.change),
          pctChange: numberOrNull(row.pct_chg), volume: numberOrNull(row.vol), amount: numberOrNull(row.amount), ...hkUnits(row), ...hkSource(row),
          adjustment: 'none', peTtm, pb, valuationAsOf,
          valuationStatus: valuationAsOf === null ? 'missing' : peTtm === null ? 'loss_or_unavailable' : 'available',
          valuationSource: valuationMeta?.source ?? null, valuationMeta,
          databaseThrough: row.database_through ?? null };
      }
      const result = await query(`SELECT p.ts_code, to_char(p.trade_date, 'YYYY-MM-DD') AS trade_date,
          p.open, p.high, p.low, p.close, p.pre_close, p.change, p.pct_chg, p.vol, p.amount,
          v.pe_ttm, v.pb, to_char(v.trade_date, 'YYYY-MM-DD') AS valuation_as_of,
          (SELECT to_char(max(trade_date), 'YYYY-MM-DD') FROM market_data.daily_prices WHERE market = 'A') AS database_through
        FROM market_data.daily_prices p
        LEFT JOIN market_data.daily_valuations v
          ON v.ts_code = p.ts_code AND v.trade_date = p.trade_date AND v.market = p.market
        WHERE p.ts_code = $1 AND p.market = 'A' AND p.trade_date <= $2::date
        ORDER BY p.trade_date DESC LIMIT 1`, [ticker, asOf]);
      const row = result.rows[0];
      if (!row) return null;
      const valuationAsOf = row.valuation_as_of ?? null;
      const peTtm = numberOrNull(row.pe_ttm);
      return {
        ticker, asOf: row.trade_date, requestedAsOf: asOf,
        price: numberOrNull(row.close), open: numberOrNull(row.open), high: numberOrNull(row.high), low: numberOrNull(row.low),
        previousClose: numberOrNull(row.pre_close), change: numberOrNull(row.change), pctChange: numberOrNull(row.pct_chg),
        volume: numberOrNull(row.vol), volumeUnit: '手', amount: numberOrNull(row.amount), amountUnit: '千元',
        currency: 'CNY', source: 'Tushare', adjustment: 'none', peTtm, pb: numberOrNull(row.pb),
        valuationAsOf,
        valuationStatus: valuationAsOf === null ? 'missing' : peTtm === null ? 'loss_or_unavailable' : 'available',
        valuationSource: valuationAsOf === null ? null : 'Tushare daily_basic',
        databaseThrough: row.database_through,
      };
    },

    async prices(params = {}) {
      if (!params || typeof params !== 'object' || Array.isArray(params)
        || Object.keys(params).some(key => !['ticker', 'asOf', 'period', 'adjustment', 'benchmark'].includes(key))) {
        throw new ResearchError('INVALID_PARAMETERS', '行情请求含有不支持的参数。', 400);
      }
      const { ticker: inputTicker, asOf: inputAsOf, period = '1y', adjustment = 'none', benchmark } = params;
      const { ticker, listing } = await tickerFor(inputTicker);
      const asOf = parseAsOf(inputAsOf, now);
      if (typeof period !== 'string' || !Object.hasOwn(PERIOD_MONTHS, period)) {
        throw new ResearchError('INVALID_PERIOD', '行情区间仅支持 1m、6m 或 1y。', 400);
      }
      if (!['none', 'qfq'].includes(adjustment)) {
        throw new ResearchError('INVALID_ADJUSTMENT', '价格复权方式仅支持 none 或 qfq。', 400);
      }
      if (benchmark !== undefined && !['sw2021_l3', 'hsi'].includes(benchmark)) {
        throw new ResearchError('INVALID_BENCHMARK', '指数比较仅支持 sw2021_l3 或 hsi。', 400);
      }
      const from = subtractMonths(asOf, PERIOD_MONTHS[period]);
      if (ticker.endsWith('.HK')) {
        if (adjustment !== 'none') throw new ResearchError('ADJUSTMENT_NOT_SUPPORTED', '港股仅提供未复权日线，暂不支持前复权。', 400);
        if (benchmark !== undefined && benchmark !== 'hsi') throw new ResearchError('BENCHMARK_NOT_SUPPORTED', '港股仅支持恒生指数基准比较。', 400);
        const result = await query(`WITH bounds AS (
            SELECT to_char(min(d.trade_date), 'YYYY-MM-DD') AS available_from, to_char(max(d.trade_date), 'YYYY-MM-DD') AS database_through
            FROM market_data.daily_prices d JOIN market_data.hk_listed_universe c ON c.ts_code = d.ts_code AND c.active = true WHERE d.market = 'HK'
          ), points AS (
            SELECT trade_date, open, high, low, close, vol, amount, source, source_api, currency, volume_unit, amount_unit
            FROM market_data.daily_prices WHERE ts_code = $1 AND market = 'HK' AND trade_date BETWEEN $2::date AND $3::date
          ) SELECT to_char(p.trade_date, 'YYYY-MM-DD') AS trade_date, p.open, p.high, p.low, p.close, p.vol, p.amount,
            p.source, p.source_api, p.currency, p.volume_unit, p.amount_unit, b.available_from, b.database_through
          FROM bounds b LEFT JOIN points p ON true ORDER BY p.trade_date ASC`, [ticker, from, asOf]);
        const rows = result.rows.filter(row => row.trade_date);
        const points = rows.map(row => ({ date: row.trade_date, open: numberOrNull(row.open), high: numberOrNull(row.high), low: numberOrNull(row.low),
          close: numberOrNull(row.close), volume: numberOrNull(row.vol), amount: numberOrNull(row.amount), ...hkSource(row) }));
        const sources = [...new Map(rows.map(row => [`${row.source}/${row.source_api}`, hkSource(row)])).values()];
        const source = sources.length === 1 ? sources[0] : { source: sources.length ? '混合来源' : null, sourceId: null, sourceApi: null };
        const response = { ticker, points, meta: { ...hkUnits(rows[0] ?? listing), ...source, sources, adjustment: 'none', requestedAsOf: asOf, period,
          availableFrom: result.rows[0]?.available_from ?? null, databaseThrough: result.rows[0]?.database_through ?? null,
          startDate: points[0]?.date ?? null, endDate: points.at(-1)?.date ?? null, pointCount: points.length } };
        if (benchmark === 'hsi') response.benchmark = await readHkIndexBenchmark({ query, from, asOf, stockPoints: points });
        return response;
      }
      if (benchmark === 'hsi') throw new ResearchError('BENCHMARK_NOT_SUPPORTED', 'A 股仅支持申万行业基准比较。', 400);
      // A LEFT JOIN keeps the database coverage metadata even for an empty
      // ticker/date window. Missing sessions are omitted, never filled with zero.
      const sql = adjustment === 'none' ? `WITH bounds AS (
          SELECT to_char(min(trade_date), 'YYYY-MM-DD') AS available_from,
            to_char(max(trade_date), 'YYYY-MM-DD') AS database_through
          FROM market_data.daily_prices WHERE market = 'A'
        ), points AS (
          SELECT trade_date, open, high, low, close, vol, amount
          FROM market_data.daily_prices
          WHERE ts_code = $1 AND market = 'A' AND trade_date BETWEEN $2::date AND $3::date
        ) SELECT to_char(p.trade_date, 'YYYY-MM-DD') AS trade_date,
          p.open, p.high, p.low, p.close, p.vol, p.amount, b.available_from, b.database_through
        FROM bounds b LEFT JOIN points p ON true ORDER BY p.trade_date ASC` : `WITH bounds AS (
          SELECT to_char(min(trade_date), 'YYYY-MM-DD') AS available_from,
            to_char(max(trade_date), 'YYYY-MM-DD') AS database_through
          FROM market_data.daily_prices WHERE market = 'A'
        ), anchor_price AS (
          SELECT trade_date FROM market_data.daily_prices
          WHERE ts_code = $1 AND market = 'A' AND trade_date <= $3::date
          ORDER BY trade_date DESC LIMIT 1
        ), anchor AS (
          SELECT a.trade_date, f.adj_factor
          FROM anchor_price a LEFT JOIN market_data.stock_adj_factors f
            ON f.ts_code = $1 AND f.trade_date = a.trade_date AND f.adj_factor > 0
        ), points AS (
          SELECT p.trade_date, p.open, p.high, p.low, p.close, p.vol, p.amount, f.adj_factor
          FROM market_data.daily_prices p LEFT JOIN market_data.stock_adj_factors f
            ON f.ts_code = p.ts_code AND f.trade_date = p.trade_date AND f.adj_factor > 0
          WHERE p.ts_code = $1 AND p.market = 'A' AND p.trade_date BETWEEN $2::date AND $3::date
        ) SELECT to_char(p.trade_date, 'YYYY-MM-DD') AS trade_date,
          p.open, p.high, p.low, p.close, p.vol, p.amount, p.adj_factor,
          to_char(a.trade_date, 'YYYY-MM-DD') AS anchor_trade_date, a.adj_factor AS anchor_factor,
          b.available_from, b.database_through
        FROM bounds b LEFT JOIN anchor a ON true LEFT JOIN points p ON true ORDER BY p.trade_date ASC`;
      const result = await query(sql, [ticker, from, asOf]);
      const rawRows = result.rows.filter(row => row.trade_date);
      let points = rawRows.map(row => ({
        date: row.trade_date, open: numberOrNull(row.open), high: numberOrNull(row.high), low: numberOrNull(row.low),
        close: numberOrNull(row.close), volume: numberOrNull(row.vol), amount: numberOrNull(row.amount),
      }));
      const adjustmentMeta = {};
      if (adjustment === 'qfq') {
        const anchorDate = result.rows[0]?.anchor_trade_date ?? null;
        const anchorFactor = numberOrNull(result.rows[0]?.anchor_factor);
        const factors = rawRows.map(row => numberOrNull(row.adj_factor));
        adjustmentMeta.adjustmentAnchorDate = anchorDate;
        adjustmentMeta.adjustmentAnchorFactor = anchorFactor !== null && anchorFactor > 0 ? anchorFactor : null;
        adjustmentMeta.missingFactorCount = factors.filter(factor => factor === null || factor <= 0).length;
        if (anchorDate === null || !rawRows.length) {
          adjustmentMeta.adjustmentStatus = 'no_prices'; points = [];
        } else if (adjustmentMeta.adjustmentAnchorFactor === null) {
          adjustmentMeta.adjustmentStatus = 'missing_anchor_factor'; points = [];
        } else {
          adjustmentMeta.adjustmentStatus = adjustmentMeta.missingFactorCount ? 'partial' : 'available';
          points = points.flatMap((point, index) => {
            const factor = factors[index];
            if (factor === null || factor <= 0) return [];
            const adjusted = { ...point };
            const ratio = factor / anchorFactor;
            for (const field of ['open', 'high', 'low', 'close']) {
              adjusted[field] = point[field] === null ? null : numberOrNull(point[field] * ratio);
            }
            return [adjusted];
          });
        }
      }
      const response = {
        ticker, points,
        meta: {
          source: 'Tushare', currency: 'CNY', adjustment, requestedAsOf: asOf, period,
          availableFrom: result.rows[0]?.available_from ?? null,
          databaseThrough: result.rows[0]?.database_through ?? null,
          startDate: points[0]?.date ?? null, endDate: points.at(-1)?.date ?? null, pointCount: points.length,
          ...adjustmentMeta,
        },
      };
      if (benchmark === 'sw2021_l3') {
        response.benchmark = await readIndustryBenchmark({ query, ticker, from, asOf, stockPoints: points });
      }
      return response;
    },

    async bands(params = {}) {
      if (!params || typeof params !== 'object' || Array.isArray(params)
        || Object.keys(params).some(key => !['ticker', 'asOf', 'period'].includes(key))) {
        throw new ResearchError('INVALID_PARAMETERS', '估值分位请求含有不支持的参数。', 400);
      }
      const { ticker: inputTicker, asOf: inputAsOf, period = '1y' } = params;
      const { ticker, listing } = await tickerFor(inputTicker), asOf = parseAsOf(inputAsOf, now);
      if (!['6m', '1y'].includes(period)) {
        throw new ResearchError('INVALID_PERIOD', '估值分位区间仅支持 6m 或 1y。', 400);
      }
      const windowStart = subtractMonths(asOf, PERIOD_MONTHS[period]);
      if (ticker.endsWith('.HK')) {
        const result = await query(`WITH bounds AS (
            SELECT to_char(min(v.trade_date), 'YYYY-MM-DD') AS available_from,
              to_char(max(v.trade_date), 'YYYY-MM-DD') AS database_through
            FROM market_data.hk_daily_valuations v JOIN market_data.daily_prices p
              ON p.ts_code = v.ts_code AND p.trade_date = v.trade_date AND p.market = 'HK'
            WHERE v.ts_code = $1 AND v.trade_date <= $3::date
          ), latest_attempt AS (
            SELECT to_char(run_date, 'YYYY-MM-DD') AS last_attempt_date, status AS last_attempt_status, updated_at AS last_attempt_at, error_code, coverage AS source_coverage
            FROM (
              SELECT run_date, universe_hash, status, updated_at, error_code, coverage
              FROM market_data.hk_valuation_symbol_attempts WHERE ts_code = $1 AND run_date <= $3::date
              UNION ALL
              SELECT run_date, universe_hash, 'succeeded'::text AS status, updated_at, NULL::text AS error_code, '{}'::jsonb AS coverage
              FROM market_data.hk_valuation_symbol_runs WHERE ts_code = $1 AND run_date <= $3::date
            ) attempts ORDER BY run_date DESC, updated_at DESC, universe_hash ASC LIMIT 1
          ), observations AS (
            SELECT p.trade_date, v.pe_ttm, v.pb, v.source, v.source_api, v.ts_code AS valuation_ticker
            FROM market_data.daily_prices p LEFT JOIN market_data.hk_daily_valuations v
              ON v.ts_code = p.ts_code AND v.trade_date = p.trade_date
            WHERE p.ts_code = $1 AND p.market = 'HK' AND p.trade_date BETWEEN $2::date AND $3::date
          ), counts AS (
            SELECT count(*) AS price_count, count(valuation_ticker) AS valuation_count FROM observations
          ) SELECT to_char(o.trade_date, 'YYYY-MM-DD') AS trade_date, o.pe_ttm, o.pb, o.source, o.source_api,
            b.available_from, b.database_through, c.price_count, c.valuation_count,
            u.last_attempt_date, u.last_attempt_status, u.last_attempt_at, u.error_code, u.source_coverage
          FROM bounds b CROSS JOIN counts c LEFT JOIN observations o ON true LEFT JOIN latest_attempt u ON true
          ORDER BY o.trade_date ASC`, [ticker, windowStart, asOf]);
        const summary = summarizeValuationBands({ ticker, asOf, period, windowStart, rows: result.rows });
        const sources = hkValuationSources(result.rows);
        const metadata = sources.length === 1 ? sources[0] : { source: sources.length ? '混合来源' : null, sourceId: null, sourceApi: null };
        const detail = result.rows[0] ?? {};
        const observed = result.rows.filter(row => typeof row.trade_date === 'string');
        const priceCount = numberOrNull(detail.price_count) ?? observed.length;
        const valuationCount = numberOrNull(detail.valuation_count) ?? observed.filter(row => row.source != null || row.pe_ttm != null || row.pb != null).length;
        const lastAttemptDate = validDate(detail.last_attempt_date) && detail.last_attempt_date <= asOf ? detail.last_attempt_date : null;
        const updateStatus = lastAttemptDate && ['running', 'succeeded', 'no_data', 'no_price_data', 'failed'].includes(detail.last_attempt_status) ? detail.last_attempt_status : null;
        const coverageStatus = priceCount === 0 ? 'no_price_data' : updateStatus === 'failed' ? 'collection_failed'
          : updateStatus === 'running' ? 'collecting' : updateStatus === 'no_data' ? 'no_data'
            : valuationCount > 0 ? 'available' : updateStatus === 'succeeded' ? 'no_data' : 'not_downloaded';
        return { ...summary, market: 'HK', currency: listing.currency, ...metadata, sources,
          coverageScope: 'hk_listed_universe', coverageStatus,
          meta: { lastAttemptDate, updateStatus, fetchedAt: lastAttemptDate ? detail.last_attempt_at ?? null : null,
            errorCode: lastAttemptDate && typeof detail.error_code === 'string' ? detail.error_code : null,
            sourceCoverage: lastAttemptDate && detail.source_coverage && typeof detail.source_coverage === 'object' && !Array.isArray(detail.source_coverage) ? detail.source_coverage : {},
            priceCount, valuationCount, missingPriceCount: Math.max(0, priceCount - valuationCount),
            retainedHistory: valuationCount > 0 && ['collection_failed', 'collecting', 'no_data'].includes(coverageStatus) },
          status: [summary.peTtm, summary.pb].some(metric => metric.status === 'available') ? 'available'
            : [summary.peTtm, summary.pb].some(metric => metric.status === 'insufficient_samples') ? 'insufficient_samples' : 'no_data' };
      }
      const result = await query(`WITH bounds AS (
          SELECT to_char(min(trade_date), 'YYYY-MM-DD') AS available_from,
            to_char(max(trade_date), 'YYYY-MM-DD') AS database_through
          FROM market_data.daily_valuations WHERE market = 'A'
        ), observations AS (
          SELECT trade_date, pe_ttm, pb FROM market_data.daily_valuations
          WHERE ts_code = $1 AND market = 'A' AND trade_date BETWEEN $2::date AND $3::date
        ) SELECT to_char(o.trade_date, 'YYYY-MM-DD') AS trade_date, o.pe_ttm, o.pb,
          b.available_from, b.database_through
        FROM bounds b LEFT JOIN observations o ON true ORDER BY o.trade_date ASC`, [ticker, windowStart, asOf]);
      return summarizeValuationBands({ ticker, asOf, period, windowStart, rows: result.rows });
    },

    async close() {
      try { await pool.end(); } catch { throw unavailable(); }
    },
  };
}
