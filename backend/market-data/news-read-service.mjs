import pg from 'pg';
import { ResearchError } from '../src/errors.mjs';
import { todayShanghai, validDate } from '../src/input.mjs';
import { safeNewsUrl } from './news-store.mjs';
import { MANUAL_RELATION_FIELDS, MANUAL_RELATION_JOINS, manualRelationRevision, mergeManualRelations } from './relations-manual-store.mjs';

const APIS = ['major_news', 'news', 'anns_d', 'cls_web'];
const CATEGORIES = ['全部', '公司', '同行', '上游', '下游', '政策'];
const TYPE_CATEGORY = { peer: '同行', upstream: '上游', downstream: '下游' };
const PRIORITY = { company: 0, peer: 1, upstream: 2, downstream: 3 };
const TICKER = /^\d{6}\.(?:SH|SZ|BJ)$/;
function unavailable() { return new ResearchError('NEWS_DATABASE_UNAVAILABLE', '资讯数据库暂不可用，请稍后重试。', 503); }
function subtractMonths(asOf, months) {
  const date = new Date(`${asOf}T00:00:00Z`), day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() - months);
  date.setUTCDate(Math.min(day, new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()));
  return date.toISOString().slice(0, 10);
}
function parseInput(params, now) {
  if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !['ticker', 'asOf', 'category', 'limit', 'offset'].includes(key))) throw new ResearchError('INVALID_PARAMETERS', '资讯请求含有不支持的参数。', 400);
  const ticker = typeof params.ticker === 'string' ? params.ticker.trim().toUpperCase() : '';
  if (/\.HK$/.test(ticker)) throw new ResearchError('MARKET_NOT_SUPPORTED', '目前仅接入 A 股资讯，港股资讯暂未入库。', 400);
  if (!TICKER.test(ticker)) throw new ResearchError('INVALID_TICKER', '请输入有效的 A 股代码，例如 002920.SZ。', 400);
  const current = typeof now === 'function' ? now() : now;
  const currentTime = current instanceof Date ? current.getTime() : new Date(current).getTime();
  const today = todayShanghai(new Date(currentTime)), asOf = params.asOf ?? today;
  if (!validDate(asOf) || asOf > today) throw new ResearchError('INVALID_DATE', '资讯截止日期须为有效 YYYY-MM-DD，且不能晚于上海时区今日。', 400);
  const category = params.category ?? '全部';
  if (!CATEGORIES.includes(category)) throw new ResearchError('INVALID_CATEGORY', '资讯分类无效。', 400);
  const integer = (value, fallback, min, max) => {
    if (value === undefined) return fallback;
    if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) throw new ResearchError('INVALID_PAGINATION', '资讯分页参数无效。', 400);
    return Number(value);
  };
  const limit = integer(params.limit, 20, 1, 50), offset = integer(params.offset, 0, 0, 100_000), from = subtractMonths(asOf, 3);
  const end = new Date(`${asOf}T00:00:00+08:00`); end.setUTCDate(end.getUTCDate() + 1);
  // A current-day request cannot expect windows that have not happened yet.
  const through = asOf === today ? Math.min(end.getTime(), Math.floor(currentTime / 1000) * 1000) : end.getTime();
  return { ticker, asOf, category, from, start: new Date(`${from}T00:00:00+08:00`).toISOString(), end: new Date(through).toISOString(), limit, offset };
}
function timestamp(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
function relationVisible(row, input) {
  const verifiedAt = timestamp(row?.verifiedAt);
  return row && TICKER.test(row.relatedTicker) && row.relatedTicker !== input.ticker && TYPE_CATEGORY[row.relationType]
    && verifiedAt && verifiedAt < input.end && Array.isArray(row.sources) && row.sources.length > 0
    && row.sources.every(source => source?.publishedAt == null || (validDate(source.publishedAt) && source.publishedAt <= input.asOf));
}

/** Union complete collection windows at second precision; article dates are not coverage evidence. */
export function newsWindowCoverage(rows, requestedFrom, requestedThrough) {
  const from = Math.floor(new Date(requestedFrom).getTime() / 1000), through = Math.floor(new Date(requestedThrough).getTime() / 1000);
  const windows = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row.status != null && row.status !== 'completed') continue;
    const start = timestamp(row.window_start), end = timestamp(row.window_end);
    if (!start || !end) continue;
    const left = Math.max(from, Math.floor(new Date(start).getTime() / 1000)), right = Math.min(through, Math.floor(new Date(end).getTime() / 1000));
    if (left < right) windows.push({ start: left, end: right, sourceApi: row.source_api });
  }
  windows.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const window of windows) {
    const previous = merged.at(-1);
    if (previous && window.start <= previous.end) previous.end = Math.max(previous.end, window.end);
    else merged.push({ start: window.start, end: window.end });
  }
  const coveredSeconds = merged.reduce((sum, window) => sum + window.end - window.start, 0), totalSeconds = Math.max(0, through - from);
  const complete = totalSeconds > 0 && coveredSeconds === totalSeconds;
  const iso = seconds => new Date(seconds * 1000).toISOString();
  return {
    requestedFrom: iso(from), requestedThrough: iso(through), endExclusive: true,
    coveredSeconds, totalSeconds, complete,
    status: complete ? 'complete' : coveredSeconds ? 'partial' : 'not_synced',
    coveredFrom: merged.length ? iso(merged[0].start) : null,
    // This field only advances when coverage is continuous from the requested start.
    coveredThrough: merged[0]?.start === from ? iso(merged[0].end) : null,
    latestCoveredAt: merged.length ? iso(merged.at(-1).end) : null,
    mergedWindowCount: merged.length,
    sourceApis: [...new Set(windows.map(row => row.sourceApi).filter(api => APIS.includes(api)))].sort(),
    basis: '已完成采集窗口的并集；仅表示接入渠道在这些时段已采集，不保证所有平台或每家公司均有资讯。',
  };
}

// The same stored partial research used by the relations panel is eligible here.
// The source report date and verification cutoff are checked again in JS.
const RELATIONS_SQL = `WITH jobs AS (
    SELECT j.run_id, j.name, j.draft_relations, j.archived_relations, r.as_of, r.created_at
    FROM market_data.company_relation_jobs j JOIN market_data.company_relation_runs r USING (run_id)
    WHERE j.ticker = $1 AND j.is_subject AND r.as_of <= $2::date
  ) SELECT coalesce(j.name, s.name, $1) AS subject_name, j.run_id, to_char(j.as_of, 'YYYY-MM-DD') AS relation_as_of,
    j.draft_relations, j.archived_relations, coalesce(p.relations, '[]'::jsonb) AS published_relations, ${MANUAL_RELATION_FIELDS}
  FROM (SELECT name, ts_code FROM market_data.securities WHERE ts_code = $1 AND market = 'A') s FULL JOIN jobs j ON true
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object('relatedTicker', r.related_ticker, 'relatedName', r.related_name,
      'relationType', r.relation_type, 'rank', r.rank, 'verifiedAt', r.verified_at, 'sources', r.sources) ORDER BY r.rank) AS relations
    FROM market_data.company_relations r WHERE r.subject_ticker = $1 AND r.run_id = j.run_id AND r.as_of <= $2::date AND r.verified_at < $3
  ) p ON true ${MANUAL_RELATION_JOINS}
  WHERE s.ts_code = $1 OR s.ts_code IS NULL
  ORDER BY j.as_of DESC NULLS LAST, j.created_at DESC NULLS LAST, j.run_id DESC NULLS LAST`;

const RELEVANT_SQL = `WITH requested AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(ticker text, name text, relation_type text, category text, priority integer)
  ), relevant AS (
    SELECT a.article_id, a.title, a.content, a.content_kind, a.published_at, a.source_api, a.source_name, a.url,
      (array_agg(r.category ORDER BY r.priority, r.ticker))[1] AS category,
      jsonb_agg(jsonb_build_object('ticker', r.ticker, 'name', r.name, 'relationType', r.relation_type,
        'matchedTerms', l.matched_terms, 'matchType', l.match_type) ORDER BY r.priority, r.ticker) AS related_companies
    FROM market_data.news_articles a JOIN market_data.stock_news_links l USING (article_id)
    JOIN requested r ON r.ticker = l.ts_code
    WHERE a.published_at >= $2::timestamptz AND a.published_at < $3::timestamptz
    GROUP BY a.article_id
  ), selected AS (SELECT * FROM relevant WHERE $4::text = '全部' OR category = $4)`;
const SOURCES_SQL = `WITH inventory AS (
    SELECT source_api FROM market_data.news_source_status
    UNION SELECT source_api FROM market_data.news_articles
  ) SELECT i.source_api, coalesce(s.status, CASE WHEN a.article_count > 0 THEN 'available' END) AS status,
    s.error_code, coalesce(s.updated_at, a.last_fetched_at) AS updated_at,
    coalesce(w.completed_windows, 0) AS completed_windows, coalesce(w.failed_windows, 0) AS failed_windows,
    w.synced_from, w.synced_through, coalesce(a.article_count, 0) AS article_count,
    a.first_published_at, a.latest_published_at
  FROM inventory i LEFT JOIN market_data.news_source_status s USING (source_api)
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE status = 'completed') AS completed_windows,
      count(*) FILTER (WHERE status = 'failed') AS failed_windows,
      min(window_start) FILTER (WHERE status = 'completed') AS synced_from,
      max(window_end) FILTER (WHERE status = 'completed') AS synced_through
    FROM market_data.news_sync_windows w WHERE w.source_api = i.source_api AND window_start < $2 AND window_end > $1
  ) w ON true LEFT JOIN LATERAL (
    SELECT count(*) AS article_count, min(published_at) AS first_published_at,
      max(published_at) AS latest_published_at, max(fetched_at) AS last_fetched_at
    FROM market_data.news_articles a WHERE a.source_api = i.source_api AND published_at >= $1 AND published_at < $2
  ) a ON true ORDER BY i.source_api`;
const COVERAGE_SQL = `SELECT source_api, source_name, window_start, window_end, status
  FROM market_data.news_sync_windows WHERE status = 'completed'
    AND window_start < $2::timestamptz AND window_end > $1::timestamptz
  ORDER BY window_start, window_end`;

/** Only local stored news is read. Loading a panel never downloads or invokes GPT. */
export function createNewsReadService({ connectionString, pool: injectedPool, now = () => new Date() } = {}) {
  let pool;
  try {
    if (!injectedPool && (typeof connectionString !== 'string' || !connectionString.trim())) throw unavailable();
    pool = injectedPool ?? new pg.Pool({ connectionString, max: 3, connectionTimeoutMillis: 10_000, query_timeout: 20_000 });
    if (!injectedPool) pool.on('error', () => {});
  } catch { throw unavailable(); }
  async function query(sql, values) { try { return await pool.query(sql, values); } catch { throw unavailable(); } }
  return {
    async get(params = {}) {
      const input = parseInput(params, now);
      const [research, sourceResult, windows] = await Promise.all([
        query(RELATIONS_SQL, [input.ticker, input.asOf, input.end]), query(SOURCES_SQL, [input.start, input.end]),
        query(COVERAGE_SQL, [input.start, input.end]),
      ]);
      const eligible = research.rows.filter(row => validDate(row.relation_as_of) && row.relation_as_of <= input.asOf);
      let relations = [], relationAsOf = null;
      for (const row of eligible) {
        for (const key of ['draft_relations', 'published_relations', 'archived_relations']) {
          const current = Array.isArray(row[key]) ? row[key].filter(item => relationVisible(item, input)).slice(0, 10) : [];
          if (current.length) { relations = current; relationAsOf = row.relation_as_of; break; }
        }
        if (relations.length) break;
      }
      const manual = mergeManualRelations(relations, research.rows[0]?.manual_events, input);
      relations = manual.relations;
      const subjects = new Map([[input.ticker, { ticker: input.ticker, name: research.rows[0]?.subject_name || input.ticker, relation_type: 'company', category: '公司', priority: 0 }]]);
      for (const relation of relations) {
        if (!subjects.has(relation.relatedTicker)) subjects.set(relation.relatedTicker, { ticker: relation.relatedTicker, name: relation.relatedName || relation.relatedTicker, relation_type: relation.relationType, category: TYPE_CATEGORY[relation.relationType], priority: PRIORITY[relation.relationType] });
      }
      const values = [JSON.stringify([...subjects.values()]), input.start, input.end, input.category];
      const [count, results] = await Promise.all([
        query(`${RELEVANT_SQL} SELECT count(*) AS total FROM selected`, values),
        query(`${RELEVANT_SQL} SELECT * FROM selected ORDER BY published_at DESC, article_id DESC LIMIT $5 OFFSET $6`, [...values, input.limit, input.offset]),
      ]);
      const items = results.rows.flatMap(row => {
        const publishedAt = timestamp(row.published_at);
        if (!publishedAt || publishedAt < input.start || publishedAt >= input.end || !CATEGORIES.includes(row.category) || row.category === '全部' || row.category === '政策') return [];
        const relatedCompanies = (Array.isArray(row.related_companies) ? row.related_companies : []).filter(company => subjects.has(company.ticker)).map(company => {
          const subject = subjects.get(company.ticker);
          return { ticker: subject.ticker, name: subject.name, relationType: subject.relation_type,
            matchType: company.matchType ?? null, matchedTerms: Array.isArray(company.matchedTerms) ? company.matchedTerms.filter(term => typeof term === 'string') : [] };
        });
        if (!relatedCompanies.length || (input.category !== '全部' && row.category !== input.category)) return [];
        const content = row.content ?? '', contentKind = ['fulltext', 'summary', 'none'].includes(row.content_kind) ? row.content_kind : content ? 'fulltext' : 'none';
        return [{ id: row.article_id, title: row.title, content, contentKind, publishedAt, sourceName: row.source_api === 'cls_web' ? '财联社官网' : row.source_name, sourceApi: row.source_api, url: safeNewsUrl(row.url), category: row.category, relatedCompanies }];
      });
      const sources = APIS.map(sourceApi => {
        const row = sourceResult.rows.find(item => item.source_api === sourceApi), status = row?.status;
        return { sourceApi, sourceName: sourceApi === 'cls_web' ? '财联社官网' : 'Tushare', status: ['available', 'permission_denied', 'failed'].includes(status) ? status : 'not_synced', updatedAt: timestamp(row?.updated_at),
          errorCode: row?.error_code === 'permission_denied' ? 'permission_denied' : row?.error_code ? 'source_error' : null,
          completedWindows: Number(row?.completed_windows ?? 0), failedWindows: Number(row?.failed_windows ?? 0), syncedFrom: timestamp(row?.synced_from), syncedThrough: timestamp(row?.synced_through),
          articleCount: Number(row?.article_count ?? 0), firstPublishedAt: timestamp(row?.first_published_at), latestPublishedAt: timestamp(row?.latest_published_at),
          coverage: newsWindowCoverage(windows.rows.filter(window => window.source_api === sourceApi), input.start, input.end) };
      });
      const total = Number(count.rows[0]?.total ?? 0);
      return { ticker: input.ticker, asOf: input.asOf, from: input.from, category: input.category, items, total, limit: input.limit, offset: input.offset, hasMore: input.offset + items.length < total,
        meta: { sources, coverage: newsWindowCoverage(windows.rows, input.start, input.end), relationAsOf, relatedCompanyCount: subjects.size - 1,
          manualRevision: manualRelationRevision(research.rows[0]?.manual_revision), hasManualChanges: manual.hasManualChanges,
          matchingBasis: '来源股票标签或公司名称、证券代码显式匹配；相关公司新闻按已入库研究与人工修正关系归类，关联不代表事件影响或因果关系。',
          coverageNote: '仅展示已下载且匹配到公司的公开资讯；权限、渠道或历史覆盖不足时可能缺失。政策分类尚未人工标注，不自动推断。', database: 'PostgreSQL', source: [...new Set([...sources.filter(item => item.articleCount > 0 || item.status === 'available').map(item => item.sourceName), ...items.map(item => item.sourceApi === 'cls_web' ? '财联社官网' : 'Tushare')])].join('、') || '本地资讯库' } };
    },
    async close() { try { await pool.end(); } catch { throw unavailable(); } },
  };
}
