import pg from 'pg';
import { ResearchError } from '../src/errors.mjs';
import { todayShanghai, validDate } from '../src/input.mjs';

const SOURCE = 'Tushare report_rc';
const BASIS = '接口未提供基本/稀释及调整口径，待原文核验';

// Reviewed, exact provider-name aliases only. Do not strip "证券", fold
// international affiliates, or join a predecessor and successor after mergers.
// 中信建投: https://www.csc108.com/doc/report2023.pdf (A/H short names).
// 中金公司: https://www.cicc.com/upload/file/2023/05/27/51673169-d41b-46d3-b27c-e8cfe419c87e.pdf
// 申万宏源研究: https://www.swsresearch.com/ (research institution of 申万宏源证券).
// 国泰海通: https://www.gtht.com/about-us
const BROKER_ALIASES = new Map([
  ['中信建投', '中信建投证券'],
  ['中金', '中金公司'],
  ['中国国际金融', '中金公司'],
  ['中国国际金融股份有限公司', '中金公司'],
  ['申万宏源', '申万宏源证券'],
  ['申万宏源研究', '申万宏源证券'],
  ['国泰海通', '国泰海通证券'],
]);

function unavailable() {
  // Driver errors may contain SQL or connection credentials.
  return new ResearchError('FORECAST_DATABASE_UNAVAILABLE', '卖方预测数据库暂不可用，请稍后重试。', 503);
}

function parseInput({ ticker: value, asOf: date, windowDays: days = 90 } = {}, now) {
  if (typeof value !== 'string' || !/^(?:\d{6}\.(?:SH|SZ|BJ)|\d{5}\.HK)$/i.test(value.trim())) {
    throw new ResearchError('INVALID_TICKER', '请输入有效的 A 股或港股代码，例如 002920.SZ 或 00700.HK。', 400);
  }
  const today = todayShanghai(typeof now === 'function' ? now() : now);
  const asOf = date ?? today;
  if (!validDate(asOf) || asOf > today) {
    throw new ResearchError('INVALID_DATE', '预测日期应为有效的 YYYY-MM-DD，且不能晚于上海时区今日。', 400);
  }
  if (!['number', 'string'].includes(typeof days) || !/^\d+$/.test(String(days)) || Number(days) < 30 || Number(days) > 365) {
    throw new ResearchError('INVALID_WINDOW', '预测样本窗口应为 30 至 365 天的整数。', 400);
  }
  const windowDays = Number(days);
  const start = new Date(`${asOf}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - windowDays + 1);
  return { ticker: value.trim().toUpperCase(), asOf, windowDays, windowStart: start.toISOString().slice(0, 10) };
}

function numberOrNull(value) {
  if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function textOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sampleFromRow(row) {
  return {
    id: row.forecast_id, broker: row.org_name.trim(), brokerOriginal: row.broker_original,
    author: textOrNull(row.author_name),
    reportDate: row.report_date, title: textOrNull(row.report_title), eps: numberOrNull(row.eps),
    pe: numberOrNull(row.pe), netProfit: numberOrNull(row.np), rating: textOrNull(row.rating),
    period: row.quarter, sourceUrl: null,
  };
}

function compareRepresentative(a, b) {
  return `${a.report_title ?? ''}\u0000${a.forecast_id ?? ''}`.localeCompare(`${b.report_title ?? ''}\u0000${b.forecast_id ?? ''}`);
}

function summarize(input, records) {
  const groups = new Map();
  const year = Number(input.asOf.slice(0, 4));
  // SQL applies the same bounds. These checks also prevent malformed records
  // from becoming estimates and keep the aggregation independently testable.
  const windowRows = records.filter(row => validDate(row.report_date) && row.report_date >= input.windowStart && row.report_date <= input.asOf);
  const reportCount = new Set(windowRows.map(row => JSON.stringify([row.org_name, row.report_date, row.report_title]))).size;
  let excludedCount = 0;
  for (const row of windowRows) {
    const period = typeof row.quarter === 'string' ? row.quarter.trim() : '';
    const annual = /^(\d{4})Q4$/.exec(period);
    if (!annual || Number(annual[1]) < year) continue;
    const sourceBroker = textOrNull(row.org_name);
    if (!sourceBroker) { excludedCount += 1; continue; }
    const broker = BROKER_ALIASES.get(sourceBroker) ?? sourceBroker;
    const key = JSON.stringify([period, broker]);
    const previous = groups.get(key);
    const normalized = { ...row, quarter: period, org_name: broker, broker_original: row.org_name };
    if (!previous || previous[0].report_date < row.report_date) groups.set(key, [normalized]);
    else if (previous[0].report_date === row.report_date) previous.push(normalized);
  }

  const years = new Map();
  const effectiveBrokers = new Set();
  for (const latest of groups.values()) {
    const values = new Set(latest.map(row => numberOrNull(row.eps)));
    // A null EPS in a newer report must never revive an older forecast. Without
    // publication times, conflicting values on the newest date are ambiguous.
    if (values.has(null) || values.size !== 1) { excludedCount += 1; continue; }
    latest.sort(compareRepresentative);
    const sample = sampleFromRow(latest[0]);
    if (!years.has(sample.period)) years.set(sample.period, []);
    years.get(sample.period).push(sample);
    effectiveBrokers.add(sample.broker);
  }

  const rows = [...years].sort(([a], [b]) => a.localeCompare(b)).map(([period, samples]) => {
    samples.sort((a, b) => a.eps - b.eps || a.broker.localeCompare(b.broker));
    const values = samples.map(sample => sample.eps);
    const minimum = values[0], maximum = values.at(-1);
    const extreme = value => {
      const brokers = samples.filter(sample => sample.eps === value).map(sample => sample.broker).sort();
      return { value, broker: brokers.join('、'), brokers };
    };
    const middle = Math.floor(values.length / 2);
    return {
      fiscalYear: `${period.slice(0, 4)}E`, period, sampleSize: samples.length,
      low: extreme(minimum), high: extreme(maximum),
      consensus: { value: values.reduce((sum, value) => sum + value, 0) / values.length, method: 'mean' },
      median: values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2,
      source: SOURCE, asOf: samples.map(sample => sample.reportDate).sort().at(-1),
      unit: '元/股', currency: null, basis: BASIS, samples,
    };
  });

  const metadata = records[0] ?? {};
  return {
    ...input, source: SOURCE, unit: '元/股', currency: null, basis: BASIS,
    meta: {
      availableFrom: metadata.available_from ?? null, databaseThrough: metadata.database_through ?? null,
      fetchedAt: metadata.fetched_at_max ?? null, coverageScope: 'stock',
      rawRowCount: windowRows.length, reportCount, brokerCount: effectiveBrokers.size, excludedCount,
      brokerAliasNote: '券商按已核对的名称别名及研究机构归属去重；保留原始机构名。未自动合并历史更名前身、合并前机构或境内外关联公司。',
      exclusionNote: '排除最新日期 EPS 缺失或冲突的券商/年度样本及无券商名的年度记录；旧报告去重、非年度及已结束年度不计为有效样本。',
      pointInTimeNote: '按研报发布日期截取；同一券商同一预测年度只取窗口内最新报告。数据库覆盖不代表完整市场覆盖，接口未提供币种和 EPS 口径，历史记录可能修订，样本均值不是全市场一致预期。',
    }, rows,
  };
}

const HK_SOURCE_LABELS = { etnet: '经济通', eastmoney: '东方财富', baidu: '百度股市通', tushare: 'Tushare' };
const HK_BASIS = '来源未明确基本/稀释或会计调整口径';
function hkSource(row) {
  const source = textOrNull(row.source);
  const api = textOrNull(row.source_api);
  if (source === 'etnet') return '经济通';
  return [HK_SOURCE_LABELS[source] ?? source, api].filter(Boolean).join(' ') || null;
}
function hkBasis(row) {
  const basis = textOrNull(row.eps_basis);
  return row.source === 'etnet' && basis ? `${basis}；${HK_BASIS}` : basis ?? HK_BASIS;
}
function hkUnit(currency) {
  return { CNY: '人民币元/股', RMB: '人民币元/股', HKD: '港元/股', USD: '美元/股' }[currency]
    ?? (currency ? `${currency}/股` : '币种未提供/股');
}

function summarizeHongKong(input, records) {
  const groups = new Map(), year = Number(input.asOf.slice(0, 4));
  const selectedDate = records[0]?.snapshot_date;
  const snapshotDate = validDate(selectedDate) && selectedDate <= input.asOf ? selectedDate : null;
  const snapshotHash = textOrNull(records[0]?.snapshot_universe_hash);
  const windowRows = snapshotDate ? records.filter(row => row.snapshot_date === snapshotDate
    && (!snapshotHash || row.forecast_universe_hash === snapshotHash)
    && validDate(row.report_date) && row.report_date >= input.windowStart && row.report_date <= input.asOf) : [];
  const reportCount = new Set(windowRows.map(row => JSON.stringify([row.org_name, row.report_date, row.report_title]))).size;
  let excludedCount = 0;
  for (const row of windowRows) {
    const fiscalYear = numberOrNull(row.fiscal_year), broker = textOrNull(row.org_name);
    if (!Number.isSafeInteger(fiscalYear) || fiscalYear < year) continue;
    const fiscalPeriod = textOrNull(row.fiscal_period) ?? String(fiscalYear);
    if (!new RegExp(`^${fiscalYear}(?:-(?:0[1-9]|1[0-2]))?$`).test(fiscalPeriod)) { excludedCount += 1; continue; }
    if (!broker) { excludedCount += 1; continue; }
    // HK research provider names are retained exactly. The A-share alias list
    // must not silently join a mainland broker with its international affiliate.
    const key = JSON.stringify([fiscalPeriod, broker]);
    const normalized = { ...row, fiscal_year: fiscalYear, fiscal_period: fiscalPeriod, org_name: broker, broker_original: row.org_name };
    const previous = groups.get(key);
    if (!previous || previous[0].report_date < row.report_date) groups.set(key, [normalized]);
    else if (previous[0].report_date === row.report_date) previous.push(normalized);
  }

  const buckets = new Map(), effectiveBrokers = new Set();
  for (const latest of groups.values()) {
    const values = new Set(latest.map(row => JSON.stringify([numberOrNull(row.eps), textOrNull(row.currency), textOrNull(row.eps_basis)])));
    // Select the newest report before checking EPS and units, so a missing or
    // ambiguous newest report cannot revive a stale, more convenient forecast.
    if (latest.some(row => numberOrNull(row.eps) === null) || values.size !== 1) { excludedCount += 1; continue; }
    latest.sort(compareRepresentative);
    const row = latest[0], currency = textOrNull(row.currency), basis = textOrNull(row.eps_basis);
    const sample = {
      id: row.forecast_id, broker: row.org_name, brokerOriginal: row.broker_original,
      author: textOrNull(row.author_name), reportDate: row.report_date, title: textOrNull(row.report_title),
      eps: numberOrNull(row.eps), pe: numberOrNull(row.pe), netProfit: numberOrNull(row.np), rating: textOrNull(row.rating),
      period: row.fiscal_period, fiscalPeriod: row.fiscal_period, source: hkSource(row), sourceId: textOrNull(row.source),
      sourceApi: textOrNull(row.source_api), sourceUrl: textOrNull(row.source_url),
      currency, unit: hkUnit(currency), basis: hkBasis(row),
    };
    // Unknown currencies cannot safely be averaged across brokers: each such
    // observation remains visible as a separate one-broker group.
    const key = JSON.stringify([row.fiscal_period, currency, basis, currency ? null : row.org_name]);
    if (!buckets.has(key)) buckets.set(key, { fiscalYear: row.fiscal_year, fiscalPeriod: row.fiscal_period, currency, basis, samples: [] });
    buckets.get(key).samples.push(sample);
    effectiveBrokers.add(sample.broker);
  }

  const rows = [...buckets.values()].sort((a, b) => a.fiscalPeriod.localeCompare(b.fiscalPeriod)
    || String(a.currency).localeCompare(String(b.currency)) || String(a.basis).localeCompare(String(b.basis))
    || a.samples[0].broker.localeCompare(b.samples[0].broker)).map(({ fiscalYear, fiscalPeriod, currency, basis, samples }) => {
    samples.sort((a, b) => a.eps - b.eps || a.broker.localeCompare(b.broker));
    const values = samples.map(sample => sample.eps), middle = Math.floor(values.length / 2);
    const extreme = value => {
      const brokers = samples.filter(sample => sample.eps === value).map(sample => sample.broker).sort();
      return { value, broker: brokers.join('、'), brokers };
    };
    return {
      fiscalYear: `${fiscalYear}E`, fiscalPeriod, period: fiscalPeriod, sampleSize: samples.length,
      low: extreme(values[0]), high: extreme(values.at(-1)),
      consensus: { value: values.reduce((sum, value) => sum + value, 0) / values.length, method: 'mean' },
      median: values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2,
      source: [...new Set(samples.map(sample => sample.source).filter(Boolean))].join('、') || null,
      sourceUrl: new Set(samples.map(sample => sample.sourceUrl)).size === 1 ? samples[0].sourceUrl : null,
      asOf: samples.map(sample => sample.reportDate).sort().at(-1),
      currency, unit: hkUnit(currency), basis: samples[0].basis, samples,
    };
  });
  const metadata = records[0] ?? {};
  const currencies = new Set(rows.map(row => row.currency)), bases = new Set(rows.map(row => row.basis));
  const sources = [...new Set(windowRows.map(hkSource).filter(Boolean))];
  const currency = currencies.size === 1 ? rows[0].currency : null;
  const lastAttemptDate = validDate(metadata.last_attempt_date) && metadata.last_attempt_date <= input.asOf ? metadata.last_attempt_date : null;
  const attemptedStatus = lastAttemptDate && ['running', 'succeeded', 'partial', 'failed'].includes(metadata.last_attempt_status) ? metadata.last_attempt_status : null;
  const timestamp = value => value instanceof Date ? value.getTime() : Date.parse(value);
  const snapshotTime = timestamp(metadata.fetched_at_max), attemptedTime = timestamp(metadata.last_attempt_at);
  const newerAttempt = !!lastAttemptDate && (!snapshotDate || lastAttemptDate > snapshotDate
    || lastAttemptDate === snapshotDate && Number.isFinite(snapshotTime) && Number.isFinite(attemptedTime) && attemptedTime > snapshotTime);
  const updateStatus = attemptedStatus && newerAttempt ? attemptedStatus : snapshotDate ? 'succeeded' : attemptedStatus;
  const snapshotRows = Number.isSafeInteger(Number(metadata.snapshot_rows_count)) && metadata.snapshot_rows_count != null ? Number(metadata.snapshot_rows_count) : null;
  const status = rows.length ? 'available' : windowRows.length ? 'no_valid_samples' : snapshotDate ? snapshotRows === 0 ? 'no_coverage' : 'empty_window'
    : updateStatus === 'failed' || updateStatus === 'partial' ? 'collection_failed' : updateStatus === 'running' ? 'collecting' : 'not_downloaded';
  const coverageNote = status === 'no_coverage' ? '已查询经济通，该公司当前暂无公开卖方 EPS 预测覆盖。'
    : status === 'collection_failed' ? '该公司卖方 EPS 预测采集失败，暂无可用快照。'
      : status === 'collecting' ? '正在采集该公司的卖方 EPS 预测，请稍后查看。'
        : status === 'not_downloaded' ? '该截止日尚未完成该公司的卖方 EPS 预测采集。' : null;
  return {
    ...input, market: 'HK', source: sources.join('、') || null,
    sourceUrl: rows.length && new Set(rows.map(row => row.sourceUrl)).size === 1 ? rows[0].sourceUrl : null,
    currency, unit: rows.length && currencies.size === 1 ? hkUnit(currency) : '按各预测行标注',
    basis: bases.size === 1 ? rows[0].basis : '按财年、币种及 EPS 口径分别统计，未跨币种或口径混算',
    meta: {
      availableFrom: metadata.available_from ?? null, databaseThrough: metadata.database_through ?? null,
      fetchedAt: metadata.fetched_at_max ?? null, coverageScope: 'stock',
      snapshotDate, snapshotUniverseHash: snapshotHash, snapshotRowCount: snapshotRows,
      coverageKind: 'current_snapshot', dateMeaning: 'broker_update_date', eligibleUniverse: 'hk_listed_universe', coverageNote,
      historicalArchiveAvailable: false,
      lastAttemptDate, updateStatus, stale: !!snapshotDate && newerAttempt && updateStatus !== 'succeeded', status,
      rawRowCount: windowRows.length, reportCount, brokerCount: effectiveBrokers.size, excludedCount,
      brokerAliasNote: '港股券商按来源机构原名精确去重；不自动合并境内外关联机构或历史前身。',
      exclusionNote: '排除最新日期 EPS 缺失、数值或口径冲突及无券商名的样本；不回退旧预测。币种不明的预测保留为各券商独立分组。',
      pointInTimeNote: '经济通提供当前券商预测快照，日期指券商更新日期；预测档案从首次实际采集日起逐日积累。仅使用研究截止日之前已采集的最近一次成功快照，每家券商每个财政期只取窗口内最新更新，按币种和 EPS 口径分别统计。来源不提供历史修订档案，样本均值不是全市场一致预期。',
    }, rows,
  };
}

/** Read-only local sell-side estimates. Does not call Tushare or GPT. */
export function createForecastReadService({ connectionString, pool: injectedPool, now = () => new Date() } = {}) {
  let pool;
  try {
    if (!injectedPool && (typeof connectionString !== 'string' || !connectionString.trim())) throw unavailable();
    pool = injectedPool ?? new pg.Pool({ connectionString, max: 3, connectionTimeoutMillis: 10_000, query_timeout: 20_000 });
    if (!injectedPool) pool.on('error', () => {});
  } catch { throw unavailable(); }

  return {
    async get(params = {}) {
      const input = parseInput(params, now);
      if (input.ticker.endsWith('.HK')) {
        // Membership changes after listing refreshes; never retain a process cache.
        let listing;
        try {
          listing = await pool.query(`SELECT ts_code, name FROM market_data.hk_listed_universe WHERE ts_code = $1 AND active = true`, [input.ticker]);
        } catch { throw unavailable(); }
        if (!listing.rows.some(row => row.ts_code === input.ticker)) {
          throw new ResearchError('MARKET_NOT_IN_UNIVERSE', '该代码不在当前上市港股公司名单中。', 404);
        }
        let result;
        try {
          result = await pool.query(`WITH selected_snapshot AS (
            SELECT run_date, universe_hash, fetched_at, rows_count FROM market_data.hk_forecast_symbol_runs
            WHERE ts_code = $1 AND status = 'succeeded' AND run_date <= $3::date
            ORDER BY run_date DESC, fetched_at DESC, universe_hash ASC LIMIT 1
          ), availability AS (
            SELECT to_char(min(run_date), 'YYYY-MM-DD') AS available_from
            FROM market_data.hk_forecast_symbol_runs WHERE ts_code = $1 AND status = 'succeeded'
          ), latest_attempt AS (
            SELECT to_char(run_date, 'YYYY-MM-DD') AS last_attempt_date, status AS last_attempt_status, fetched_at AS last_attempt_at
            FROM (
              SELECT run_date, universe_hash, CASE WHEN status = 'no_data' THEN 'succeeded' ELSE status END AS status, updated_at AS fetched_at
              FROM market_data.hk_forecast_symbol_attempts WHERE ts_code = $1 AND run_date <= $3::date
              UNION ALL
              SELECT run_date, universe_hash, status, fetched_at FROM market_data.hk_forecast_symbol_runs WHERE ts_code = $1 AND run_date <= $3::date
            ) attempts ORDER BY run_date DESC, fetched_at DESC, universe_hash ASC LIMIT 1
          ), bounds AS (
            SELECT to_char(s.run_date, 'YYYY-MM-DD') AS snapshot_date,
              s.universe_hash AS snapshot_universe_hash, s.rows_count AS snapshot_rows_count,
              to_char(max(f.report_date), 'YYYY-MM-DD') AS database_through, s.fetched_at AS fetched_at_max
            FROM selected_snapshot s LEFT JOIN market_data.hk_sell_side_forecasts f
              ON f.ts_code = $1 AND f.universe_hash = s.universe_hash AND f.snapshot_date = s.run_date
            GROUP BY s.run_date, s.universe_hash, s.rows_count, s.fetched_at
          ), forecasts AS (
            SELECT forecast_id, report_date, report_title, org_name, author_name, fiscal_year,
              fiscal_period, eps, np, pe, rating, currency, eps_basis, source, source_api, source_url, f.universe_hash
            FROM market_data.hk_sell_side_forecasts f JOIN selected_snapshot s
              ON f.universe_hash = s.universe_hash AND f.snapshot_date = s.run_date
            WHERE ts_code = $1 AND report_date BETWEEN $2::date AND $3::date
          ) SELECT f.forecast_id, to_char(f.report_date, 'YYYY-MM-DD') AS report_date,
            f.report_title, f.org_name, f.author_name, f.fiscal_year, f.fiscal_period, f.eps, f.np, f.pe, f.rating,
            f.currency, f.eps_basis, f.source, f.source_api, f.source_url,
            f.universe_hash AS forecast_universe_hash, b.snapshot_universe_hash, b.snapshot_rows_count,
            a.available_from, b.snapshot_date, b.database_through, b.fetched_at_max,
            u.last_attempt_date, u.last_attempt_status, u.last_attempt_at
          FROM availability a LEFT JOIN bounds b ON true LEFT JOIN forecasts f ON true LEFT JOIN latest_attempt u ON true
          ORDER BY f.report_date DESC, f.forecast_id ASC`, [input.ticker, input.windowStart, input.asOf]);
        } catch { throw unavailable(); }
        return summarizeHongKong(input, result.rows);
      }
      let result;
      try {
        result = await pool.query(`WITH bounds AS (
          SELECT to_char(min(report_date), 'YYYY-MM-DD') AS available_from,
            to_char(max(report_date), 'YYYY-MM-DD') AS database_through,
            max(fetched_at) AS fetched_at_max
          FROM market_data.sell_side_forecasts WHERE ts_code = $1 AND source_api = 'report_rc'
        ), forecasts AS (
          SELECT forecast_id, report_date, report_title, org_name, author_name, quarter, eps, np, pe, rating
          FROM market_data.sell_side_forecasts
          WHERE ts_code = $1 AND source_api = 'report_rc' AND report_date BETWEEN $2::date AND $3::date
        ) SELECT f.forecast_id, to_char(f.report_date, 'YYYY-MM-DD') AS report_date,
          f.report_title, f.org_name, f.author_name, f.quarter, f.eps, f.np, f.pe, f.rating,
          b.available_from, b.database_through, b.fetched_at_max
        FROM bounds b LEFT JOIN forecasts f ON true
        ORDER BY f.report_date DESC, f.forecast_id ASC`, [input.ticker, input.windowStart, input.asOf]);
      } catch { throw unavailable(); }
      return summarize(input, result.rows);
    },
    async close() { try { await pool.end(); } catch { throw unavailable(); } },
  };
}
