import pg from 'pg';
import { ResearchError } from '../src/errors.mjs';
import { todayShanghai, validDate } from '../src/input.mjs';
import { MANUAL_RELATION_FIELDS, MANUAL_RELATION_JOINS, manualRelationRevision, mergeManualRelations } from './relations-manual-store.mjs';

const SUBJECT_TICKER = /^(?:\d{6}\.(?:SH|SZ|BJ)|\d{5}\.HK)$/;
const TYPES = ['upstream', 'peer', 'downstream'];
const MAX_VISIBLE_RELATIONS = 10;
const PERIODS = ['w1', 'm1', 'm6', 'y1', 'y3'];
const RETURN_BASIS = '前复权价格回报（不含息），百分比；1周为5个交易日，其他区间取请求日期减相应日历月份当天或之前最近收盘。';
const HK_RETURN_BASIS = '港股未复权收盘价区间涨跌幅，百分比；非投资总回报，未调整分红、拆股等公司行动。1周为5个交易日，其他区间取请求日期减相应日历月份当天或之前最近收盘。';

function unavailable() {
  // Driver errors can contain SQL or connection credentials.
  return new ResearchError('RELATIONS_DATABASE_UNAVAILABLE', '公司关系数据库暂不可用，请稍后重试。', 503);
}

function parseInput(params, now) {
  if (!params || typeof params !== 'object' || Array.isArray(params)
    || Object.keys(params).some(key => !['ticker', 'asOf'].includes(key))) {
    throw new ResearchError('INVALID_PARAMETERS', '公司关系请求含有不支持的参数。', 400);
  }
  const { ticker: value, asOf: date } = params;
  const ticker = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!SUBJECT_TICKER.test(ticker)) throw new ResearchError('INVALID_TICKER', '请输入有效的 A 股或五位港股代码，例如 002920.SZ、00700.HK。', 400);
  const today = todayShanghai(typeof now === 'function' ? now() : now);
  const asOf = date ?? today;
  if (!validDate(asOf) || asOf > today) {
    throw new ResearchError('INVALID_DATE', '关系日期应为有效的 YYYY-MM-DD，且不能晚于上海时区今日。', 400);
  }
  return { ticker, asOf };
}

function subtractMonths(asOf, months) {
  const date = new Date(`${asOf}T00:00:00Z`), day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);
  date.setUTCDate(Math.min(day, new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()));
  return date.toISOString().slice(0, 10);
}

function numberOrNull(value) {
  if (!['string', 'number'].includes(typeof value) || (typeof value === 'string' && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestampOrNull(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !validDate(value.slice(0, 10)) || Number(value.slice(11, 13)) > 23
    || !Number.isFinite(new Date(value).getTime())) return null;
  return new Date(value).toISOString();
}

function visibleRelations(rows, ticker, asOf, allowHongKong = false) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  const rank = relation => Number.isInteger(Number(relation.rank)) && Number(relation.rank) > 0
    ? Number(relation.rank) : rows.indexOf(relation) + 1;
  return rows.filter(relation => {
    const verifiedAt = timestampOrNull(relation?.verifiedAt);
    if (!relation || !SUBJECT_TICKER.test(relation.relatedTicker) || (!allowHongKong && relation.relatedTicker.endsWith('.HK')) || relation.relatedTicker === ticker
      || !TYPES.includes(relation.relationType) || seen.has(relation.relatedTicker)
      || !verifiedAt || todayShanghai(new Date(verifiedAt)) > asOf
      || !Array.isArray(relation.sources) || !relation.sources.length
      || relation.sources.some(source => source?.publishedAt != null && (!validDate(source.publishedAt) || source.publishedAt > asOf))) return false;
    seen.add(relation.relatedTicker);
    return true;
  }).sort((a, b) => rank(a) - rank(b) || a.relatedTicker.localeCompare(b.relatedTicker))
    .slice(0, MAX_VISIBLE_RELATIONS).map(relation => ({
      relatedTicker: relation.relatedTicker, relatedName: relation.relatedName,
      relationType: relation.relationType, evidenceType: relation.evidenceType,
      rank: rank(relation), rationale: relation.rationale,
      actualEntity: relation.actualEntity, listedMappingBasis: relation.listedMappingBasis,
      notes: relation.notes ?? '', verifiedAt: timestampOrNull(relation.verifiedAt),
      sources: Array.isArray(relation.sources) ? relation.sources : [],
    }));
}

function relationSnapshot(row, ticker, asOf) {
  for (const [source, field] of [['draft', 'draft_relations'], ['published', 'published_relations'], ['archive', 'archived_relations']]) {
    const relations = visibleRelations(row?.[field], ticker, asOf);
    if (relations.length) return { source, relations };
  }
  return { source: 'none', relations: [] };
}

const snapshotOrder = (a, b) => b.row.relation_as_of.localeCompare(a.row.relation_as_of)
  || (Date.parse(b.row.research_created_at ?? '') || 0) - (Date.parse(a.row.research_created_at ?? '') || 0);

function limitManualRelations(relations) {
  if (relations.length > MAX_VISIBLE_RELATIONS) {
    throw new ResearchError('RELATIONS_LIMIT_EXCEEDED', '每只股票最多保存10家关联公司，请先移除部分人工关系后重新读取。', 409);
  }
  return relations.map((row, index) => ({ ...row, rank: index + 1 }));
}

function emptyMarket(ticker) {
  const hongKong = ticker.endsWith('.HK');
  return {
    close: null, changePct: null, peTtm: null, pb: null, tradeDate: null, valuationAsOf: null,
    currency: hongKong ? 'HKD' : 'CNY', status: 'no_prices', valuationStatus: 'missing',
    source: null, sourceApi: null, valuationSource: null, valuationSourceApi: null,
    adjustment: 'none', returnAdjustment: hongKong ? 'none' : 'qfq',
    returns: Object.fromEntries(PERIODS.map(period => [period, null])),
    returnStatus: Object.fromEntries(PERIODS.map(period => [period, 'no_prices'])),
    returnBaseDates: Object.fromEntries(PERIODS.map(period => [period, null])),
    returnBasis: hongKong ? HK_RETURN_BASIS : RETURN_BASIS,
  };
}

function marketFromRows(rows, tickers, asOf) {
  const result = new Map(tickers.map(ticker => [ticker, emptyMarket(ticker)]));
  for (const row of rows) {
    const market = result.get(row.ts_code);
    const hongKong = typeof row.ts_code === 'string' && row.ts_code.endsWith('.HK');
    if (!market || !SUBJECT_TICKER.test(row.ts_code) || row.market !== (hongKong ? 'HK' : 'A')) continue;
    if ((hongKong && ['HKD', 'USD'].includes(row.currency)) || (!hongKong && row.currency === 'CNY')) market.currency = row.currency;
    if (!validDate(row.trade_date) || row.trade_date > asOf) continue;
    market.tradeDate = row.trade_date;
    market.close = numberOrNull(row.close);
    market.changePct = numberOrNull(row.pct_chg);
    market.source = typeof row.source === 'string' ? row.source : null;
    market.sourceApi = typeof row.source_api === 'string' ? row.source_api : null;
    // Both markets use the exact quoted trading date. Do not silently compare
    // a current price with a valuation observed on a different date.
    market.valuationAsOf = row.valuation_as_of === row.trade_date ? row.valuation_as_of : null;
    market.peTtm = market.valuationAsOf ? numberOrNull(row.pe_ttm) : null;
    market.pb = market.valuationAsOf ? numberOrNull(row.pb) : null;
    market.valuationSource = market.valuationAsOf && typeof row.valuation_source === 'string' ? row.valuation_source : null;
    market.valuationSourceApi = market.valuationAsOf && typeof row.valuation_source_api === 'string' ? row.valuation_source_api : null;
    market.status = market.close === null ? 'missing_close' : 'available';
    market.valuationStatus = market.valuationAsOf === null ? 'missing' : market.peTtm === null ? 'loss_or_unavailable' : 'available';
    if (!PERIODS.includes(row.period)) continue;
    const close = market.close, factor = numberOrNull(row.adj_factor);
    const baseClose = numberOrNull(row.base_close), baseFactor = numberOrNull(row.base_factor);
    const months = { m1: 1, m6: 6, y1: 12, y3: 36 }[row.period];
    const target = months ? subtractMonths(asOf, months) : null;
    const baseDate = validDate(row.base_date) && row.base_date < row.trade_date
      && (!target || (target < row.trade_date && row.base_date <= target)) ? row.base_date : null;
    market.returnBaseDates[row.period] = baseDate;
    let status = 'available';
    if (close === null || close <= 0) status = 'invalid_price';
    else if (!hongKong && (factor === null || factor <= 0)) status = 'missing_anchor_factor';
    else if (!baseDate) status = 'insufficient_history';
    else if (baseClose === null || baseClose <= 0) status = 'invalid_base_price';
    else if (!hongKong && (baseFactor === null || baseFactor <= 0)) status = 'missing_base_factor';
    const value = status === 'available'
      ? numberOrNull((hongKong ? close / baseClose - 1 : close * factor / (baseClose * baseFactor) - 1) * 100) : null;
    market.returns[row.period] = value;
    market.returnStatus[row.period] = status === 'available' && value === null ? 'invalid_price' : status;
  }
  return result;
}

const RESEARCH_SQL = `WITH current_state AS (
    SELECT * FROM market_data.company_relation_current WHERE subject_ticker = $1
  ), subject_jobs AS (
    SELECT j.run_id, j.ticker, j.name, j.is_subject, j.status, j.gaps, j.draft_relations, j.archived_relations,
      r.as_of, r.method_version, r.created_at
    FROM market_data.company_relation_jobs j
    JOIN market_data.company_relation_runs r ON r.run_id = j.run_id WHERE j.ticker = $1 AND j.is_subject
      AND NOT EXISTS (SELECT 1 FROM current_state)
  ), bounds AS (
    SELECT to_char(min(as_of), 'YYYY-MM-DD') AS available_from,
      to_char(max(as_of), 'YYYY-MM-DD') AS database_through FROM (
        SELECT as_of FROM current_state
        UNION ALL SELECT as_of FROM subject_jobs
        UNION ALL SELECT as_of FROM market_data.company_relation_ai_jobs WHERE subject_ticker = $1 AND status = 'succeeded'
          AND NOT EXISTS (SELECT 1 FROM current_state)
      ) research_dates
  ) SELECT b.available_from, b.database_through, s.ts_code AS known_ticker,
    coalesce(nullif(j.name, ''), nullif(s.name, ''), $1) AS subject_name,
    j.run_id, j.ticker AS subject_ticker, to_char(j.as_of, 'YYYY-MM-DD') AS relation_as_of,
    j.method_version, j.status AS job_status, j.gaps, j.draft_relations, j.archived_relations, j.created_at AS research_created_at,
    coalesce(p.relations, '[]'::jsonb) AS published_relations, ${MANUAL_RELATION_FIELDS},
    ai.job_id::text AS ai_job_id, ai.subject_name AS ai_subject_name, to_char(ai.as_of, 'YYYY-MM-DD') AS ai_as_of,
    ai.method_version AS ai_method_version, ai_current.relations AS ai_relations, ai.gaps AS ai_gaps,
    ai.researched_at AS ai_researched_at, ai.created_at AS ai_created_at,
    canonical.subject_ticker AS current_ticker, canonical.subject_name AS current_subject_name,
    to_char(canonical.as_of, 'YYYY-MM-DD') AS current_as_of, canonical_list.relations AS current_relations,
    canonical.gaps AS current_gaps, canonical.researched_at AS current_researched_at,
    canonical.method_version AS current_method_version, canonical.source AS current_source,
    canonical.run_id AS current_run_id, canonical.updated_at AS current_updated_at,
    coalesce(to_jsonb(canonical)->'refresh_summary','{}'::jsonb) AS current_refresh_summary,
    CASE WHEN latest_ai.job_id IS NULL THEN NULL ELSE jsonb_build_object(
      'jobId', latest_ai.job_id, 'asOf', to_char(latest_ai.as_of, 'YYYY-MM-DD'), 'status', latest_ai.status,
      'stage', latest_ai.stage, 'relationCount', coalesce((to_jsonb(latest_ai)->>'result_count')::integer,
        (to_jsonb(latest_ai)->>'relation_count')::integer, jsonb_array_length(latest_ai.relations), 0), 'gaps', latest_ai.gaps,
      'researchedAt', latest_ai.researched_at, 'errorCode', latest_ai.error_code, 'errorMessage', latest_ai.error_message,
      'createdAt', latest_ai.created_at, 'updatedAt', latest_ai.updated_at, 'finishedAt', latest_ai.finished_at
    ) END AS ai_latest_job
  FROM bounds b LEFT JOIN subject_jobs j ON j.as_of <= $2::date
  LEFT JOIN current_state canonical ON true
  LEFT JOIN LATERAL (
    SELECT coalesce(jsonb_agg(item.value ORDER BY item.ordinality), '[]'::jsonb) AS relations
    FROM jsonb_array_elements(canonical.relations) WITH ORDINALITY AS item(value, ordinality)
    WHERE EXISTS (SELECT 1 FROM market_data.securities current_a
      WHERE current_a.ts_code = item.value->>'relatedTicker' AND current_a.market = 'A' AND current_a.list_status = 'L'
        AND current_a.ts_code ~ '^[0-9]{6}\\.(SH|SZ|BJ)$'
        AND (current_a.list_date IS NULL OR current_a.list_date <= $2::date)
        AND (current_a.delist_date IS NULL OR current_a.delist_date > $2::date))
      OR EXISTS (SELECT 1 FROM market_data.hk_listed_universe current_hk
        WHERE current_hk.ts_code = item.value->>'relatedTicker' AND current_hk.active
          AND (current_hk.list_date IS NULL OR current_hk.list_date <= $2::date))
  ) canonical_list ON true
  LEFT JOIN market_data.securities s ON s.ts_code = $1 AND s.market = CASE WHEN $1 LIKE '%.HK' THEN 'HK' ELSE 'A' END
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
      'relatedTicker', r.related_ticker, 'relatedName', r.related_name,
      'relationType', r.relation_type, 'evidenceType', r.evidence_type, 'rank', r.rank,
      'rationale', r.rationale, 'actualEntity', r.actual_entity,
      'listedMappingBasis', r.listed_mapping_basis, 'notes', r.notes,
      'verifiedAt', r.verified_at, 'sources', r.sources) ORDER BY r.rank) AS relations
    FROM market_data.company_relations r
    WHERE r.subject_ticker = $1 AND r.run_id = j.run_id AND r.as_of <= $2::date
  ) p ON true ${MANUAL_RELATION_JOINS}
  LEFT JOIN LATERAL (
    SELECT * FROM market_data.company_relation_ai_jobs
    WHERE subject_ticker = $1 AND as_of <= $2::date AND status = 'succeeded'
      AND NOT EXISTS (SELECT 1 FROM current_state)
      AND jsonb_array_length(relations) > 0 AND (researched_at AT TIME ZONE 'Asia/Shanghai')::date <= $2::date
    ORDER BY as_of DESC, created_at DESC, job_id DESC LIMIT 1
  ) ai ON true
  LEFT JOIN LATERAL (
    SELECT coalesce(jsonb_agg(item.value ORDER BY item.ordinality), '[]'::jsonb) AS relations
    FROM jsonb_array_elements(ai.relations) WITH ORDINALITY AS item(value, ordinality)
    WHERE EXISTS (SELECT 1 FROM market_data.securities current_a
      WHERE current_a.ts_code = item.value->>'relatedTicker' AND current_a.market = 'A' AND current_a.list_status = 'L'
        AND current_a.ts_code ~ '^[0-9]{6}\\.(SH|SZ|BJ)$'
        AND (current_a.list_date IS NULL OR current_a.list_date <= $2::date)
        AND (current_a.delist_date IS NULL OR current_a.delist_date > $2::date))
      OR EXISTS (SELECT 1 FROM market_data.hk_listed_universe current_hk
        WHERE current_hk.ts_code = item.value->>'relatedTicker' AND current_hk.active
          AND (current_hk.list_date IS NULL OR current_hk.list_date <= $2::date))
  ) ai_current ON true
  LEFT JOIN LATERAL (
    SELECT * FROM market_data.company_relation_ai_jobs WHERE subject_ticker = $1 AND as_of <= $2::date
    ORDER BY as_of DESC, created_at DESC, job_id DESC LIMIT 1
  ) latest_ai ON true
  ORDER BY j.as_of DESC, j.created_at DESC, j.run_id DESC`;

const MARKET_SQL = `WITH requested AS (
    SELECT codes.ts_code, CASE WHEN codes.ts_code LIKE '%.HK' THEN 'HK' ELSE 'A' END AS market,
      coalesce(c.currency, CASE WHEN codes.ts_code LIKE '%.HK' THEN 'HKD' ELSE 'CNY' END) AS currency
    FROM unnest($1::text[]) AS codes(ts_code)
    LEFT JOIN market_data.hk_listed_universe c ON c.ts_code=codes.ts_code AND c.active
  ), anchors AS (
    SELECT r.ts_code, r.market, coalesce(p.currency,r.currency) AS currency, p.trade_date, p.close, p.pct_chg, p.source, p.source_api, f.adj_factor,
      CASE WHEN r.market = 'HK' THEN hv.pe_ttm ELSE v.pe_ttm END AS pe_ttm,
      CASE WHEN r.market = 'HK' THEN hv.pb ELSE v.pb END AS pb,
      CASE WHEN r.market = 'HK' THEN hv.trade_date ELSE v.trade_date END AS valuation_as_of,
      CASE WHEN r.market = 'HK' THEN hv.source ELSE v.source END AS valuation_source,
      CASE WHEN r.market = 'HK' THEN hv.source_api ELSE v.source_api END AS valuation_source_api
    FROM requested r LEFT JOIN LATERAL (
      SELECT trade_date, close, pct_chg, source, source_api, currency FROM market_data.daily_prices
      WHERE ts_code = r.ts_code AND market = r.market AND trade_date <= $2::date
      ORDER BY trade_date DESC LIMIT 1
    ) p ON true
    LEFT JOIN market_data.daily_valuations v ON r.market = 'A' AND v.ts_code = r.ts_code AND v.market = 'A' AND v.trade_date = p.trade_date
    LEFT JOIN market_data.hk_daily_valuations hv ON r.market = 'HK' AND hv.ts_code = r.ts_code AND hv.trade_date = p.trade_date
    LEFT JOIN market_data.stock_adj_factors f ON r.market = 'A' AND f.ts_code = r.ts_code AND f.trade_date = p.trade_date AND f.adj_factor > 0
  ), periods(period, target_date) AS (VALUES
    ('w1', $2::date), ('m1', $3::date), ('m6', $4::date), ('y1', $5::date), ('y3', $6::date)
  ) SELECT a.ts_code, a.market, to_char(a.trade_date, 'YYYY-MM-DD') AS trade_date,
    a.close, a.pct_chg, a.currency, a.source, a.source_api, a.adj_factor, a.pe_ttm, a.pb, a.valuation_source, a.valuation_source_api,
    to_char(a.valuation_as_of, 'YYYY-MM-DD') AS valuation_as_of, h.period,
    to_char(b.trade_date, 'YYYY-MM-DD') AS base_date, b.close AS base_close, f.adj_factor AS base_factor
  FROM anchors a CROSS JOIN periods h LEFT JOIN LATERAL (
    SELECT p.trade_date, p.close FROM market_data.daily_prices p
    WHERE p.ts_code = a.ts_code AND p.market = a.market AND p.close > 0
      AND p.trade_date <= CASE WHEN h.period = 'w1' THEN a.trade_date ELSE h.target_date END
      AND (h.period = 'w1' OR h.target_date < a.trade_date)
    ORDER BY p.trade_date DESC OFFSET CASE WHEN h.period = 'w1' THEN 5 ELSE 0 END LIMIT 1
  ) b ON true
  LEFT JOIN market_data.stock_adj_factors f ON a.market = 'A' AND f.ts_code = a.ts_code AND f.trade_date = b.trade_date AND f.adj_factor > 0
  ORDER BY a.ts_code, h.period`;

/** Read-only local research and market snapshots. Never calls a provider, GPT, or a collector. */
export function createRelationsReadService({ connectionString, pool: injectedPool, now = () => new Date() } = {}) {
  let pool;
  try {
    if (!injectedPool && (typeof connectionString !== 'string' || !connectionString.trim())) throw unavailable();
    pool = injectedPool ?? new pg.Pool({ connectionString, max: 3, connectionTimeoutMillis: 10_000, query_timeout: 20_000 });
    if (!injectedPool) pool.on('error', () => {});
  } catch { throw unavailable(); }
  async function query(sql, params) { try { return await pool.query(sql, params); } catch { throw unavailable(); } }

  return {
    async get(params = {}) {
      const input = parseInput(params, now);
      const research = await query(RESEARCH_SQL, [input.ticker, input.asOf]);
      // Recheck the cutoff in JS too: injected pools and future schema changes
      // cannot cause a newer frozen run to become a historical relationship.
      const subjectRows = research.rows.filter(row => row.is_subject !== false && (!row.subject_ticker || row.subject_ticker === input.ticker));
      const eligible = subjectRows.filter(row => validDate(row.relation_as_of) && row.relation_as_of <= input.asOf);
      const metadataRow = subjectRows[0] ?? {};
      const hasCurrent = metadataRow.current_ticker === input.ticker;
      const currentVisible = hasCurrent && validDate(metadataRow.current_as_of) && metadataRow.current_as_of <= input.asOf;
      let snapshot;
      if (hasCurrent) {
        // A canonical row is the only current version. A historical cutoff never
        // causes the reader to replay or merge superseded research.
        if (currentVisible) snapshot = { source: metadataRow.current_source ?? 'current',
          relations: visibleRelations(metadataRow.current_relations, input.ticker, input.asOf, true),
          row: { ...metadataRow, subject_name: metadataRow.current_subject_name ?? metadataRow.subject_name,
            relation_as_of: metadataRow.current_as_of, run_id: metadataRow.current_run_id,
            method_version: metadataRow.current_method_version, job_status: 'succeeded',
            gaps: metadataRow.current_gaps, research_created_at: metadataRow.current_updated_at } };
      } else {
        // Compatibility only for an unmigrated stock: select one snapshot, never
        // accumulate earlier versions or fill a newer result from old research.
        const snapshots = eligible.map(row => ({ row, ...relationSnapshot(row, input.ticker, input.asOf) }));
        if (validDate(metadataRow.ai_as_of) && metadataRow.ai_as_of <= input.asOf) {
          const relations = visibleRelations(metadataRow.ai_relations, input.ticker, input.asOf, true);
          if (relations.length) snapshots.push({ source: 'ai', relations, row: { ...metadataRow,
            subject_name: metadataRow.ai_subject_name ?? metadataRow.subject_name,
            relation_as_of: metadataRow.ai_as_of, run_id: metadataRow.ai_job_id,
            method_version: metadataRow.ai_method_version, job_status: 'succeeded', gaps: metadataRow.ai_gaps,
            research_created_at: metadataRow.ai_created_at } });
        }
        snapshot = snapshots.filter(item => item.relations.length).sort(snapshotOrder)[0] ?? snapshots[0];
      }
      const selected = snapshot?.row;
      const metadata = selected ?? metadataRow;
      const latestAiJob = hasCurrent && metadata.ai_latest_job?.status === 'succeeded'
        && metadata.ai_latest_job?.relationCount > 0 && metadata.ai_latest_job?.jobId !== metadataRow.current_run_id
        ? null : metadata.ai_latest_job ?? null;
      const manual = mergeManualRelations(snapshot?.relations ?? [], hasCurrent && !currentVisible ? [] : metadata.manual_events, input);
      const relations = limitManualRelations(manual.relations);
      const counts = Object.fromEntries([...TYPES.map(type => [type, relations.filter(row => row.relationType === type).length]), ['total', relations.length]]);
      const status = manual.hasManualChanges ? 'customized' : relations.length ? 'complete'
        : (hasCurrent && !currentVisible) || (!eligible.length && validDate(metadata.available_from) && metadata.available_from > input.asOf) ? 'not_available_as_of' : 'not_researched';
      const tickers = [input.ticker, ...relations.map(row => row.relatedTicker)];
      const prices = await query(MARKET_SQL, [tickers, input.asOf, ...[1, 6, 12, 36].map(months => subtractMonths(input.asOf, months))]);
      const markets = marketFromRows(prices.rows, tickers, input.asOf);
      return {
        ...input, relationAsOf: selected?.relation_as_of ?? null,
        runId: selected?.run_id ?? null, methodVersion: selected?.method_version ?? null,
        status, counts, missing: 0,
        subject: { ticker: input.ticker, name: metadata.subject_name || input.ticker, market: markets.get(input.ticker) },
        relations: relations.map(row => ({ ...row, market: markets.get(row.relatedTicker) })),
        gaps: Array.isArray(selected?.gaps) ? selected.gaps.filter(value => typeof value === 'string') : [],
        meta: {
          targetCount: null, knownTicker: Boolean(metadata.known_ticker || metadata.available_from || manualRelationRevision(metadata.manual_revision) !== '0'),
          manualRevision: manualRelationRevision(metadata.manual_revision), hasManualChanges: manual.hasManualChanges,
          manualCounts: manual.manualCounts, removedRelations: manual.removedRelations,
          availableFrom: hasCurrent ? metadataRow.current_as_of : metadata.available_from ?? null,
          databaseThrough: hasCurrent ? metadataRow.current_as_of : metadata.database_through ?? null,
          researchJobStatus: selected?.job_status ?? null,
          aiJob: latestAiJob,
          aiResultNote: latestAiJob?.status === 'succeeded' && latestAiJob?.relationCount === 0
            ? `最近一次 AI 识别未找到足够证据支持的关系。${relations.length ? '已保留此前关系及人工修正。' : '未填充未经证实的公司。'}`
            : latestAiJob?.status === 'failed' ? '最近一次 AI 识别失败，已保留此前关系及人工修正。' : null,
          relationSource: snapshot?.source ?? 'none',
          updatedAt: currentVisible ? metadataRow.current_updated_at ?? null : null,
          ...(currentVisible && metadataRow.current_refresh_summary?.retainedCount!==undefined
            ? {refreshSummary:metadataRow.current_refresh_summary} : {}),
          storageMode: 'single_current',
          replacementNote: '每只股票仅保存一份当前关系，最多10家；AI 优先保留已有公司，替换须有具体理由和来源，人工可直接修改；失败或空结果保留原内容。',
          marketSource: tickers.some(code => code.endsWith('.HK')) ? '本地 PostgreSQL（行情来源见各行）' : 'Tushare（本地 PostgreSQL）',
          currency: tickers.some(code => code.endsWith('.HK')) ? 'mixed' : 'CNY', returnUnit: 'percent',
          returnBasis: tickers.some(code => code.endsWith('.HK')) ? `A股：${RETURN_BASIS}港股：${HK_RETURN_BASIS}` : RETURN_BASIS,
          pointInTimeNote: `${manual.hasManualChanges ? '人工修正按生效日期叠加，不附加研究来源；人工修改时间为实际写入时间，可晚于生效日。' : ''}仅展示当前保存的一份关系，不合并或回放旧版本；研究截止日、核验日期及已知来源发布日期均不晚于请求日期。估值仅匹配实际收盘交易日。`,
          coverageNote: '最多保存10家，不要求凑满；已保存可用不表示已识别全部关系。行情或复权因子未覆盖时保留关系并返回空值。',
        },
      };
    },
    async close() { try { await pool.end(); } catch { throw unavailable(); } },
  };
}
