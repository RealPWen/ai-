import { readFile } from 'node:fs/promises';
import pg from 'pg';

const APIS = new Set(['news', 'major_news', 'anns_d', 'cls_web']);
const STATUS = new Set(['available', 'permission_denied', 'failed']);
const MATCHES = new Set(['name', 'fullname', 'ticker', 'alias', 'source_tag']);
const CONTENT_KINDS = new Set(['fulltext', 'summary', 'none']);
const ERRORS = new Set(['provider_error', 'network_error', 'database_error', 'validation_error', 'unknown_error', 'permission_denied', 'rate_limited', 'authentication_error', 'truncated', 'incomplete_window']);
export function newsValidationError(message) { const error = new Error(message); error.code = 'VALIDATION_ERROR'; error.kind = 'validation'; return error; }
function databaseError(original) {
  const error = new Error('PostgreSQL 资讯数据操作失败。'); error.code = 'DATABASE_ERROR'; error.kind = 'database';
  if (typeof original?.code === 'string' && /^[0-9A-Z]{5}$/.test(original.code)) error.sqlState = original.code;
  return error;
}
export function newsInstant(value) {
  if (value instanceof Date) { if (!Number.isFinite(value.getTime())) throw newsValidationError('资讯时间无效。'); value = value.toISOString(); }
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
    || !Number.isFinite(Date.parse(value))) throw newsValidationError('资讯时间须为含时区的有效 ISO 时间。');
  const date = new Date(value);
  // Date.parse normalizes impossible calendar days; reject those before writing.
  const calendar = value.slice(0, 10), check = new Date(`${calendar}T00:00:00Z`);
  if (check.toISOString().slice(0, 10) !== calendar || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) throw newsValidationError('资讯时间无效。');
  return date.toISOString();
}
function source(sourceApi, sourceName = '') {
  if (!APIS.has(sourceApi) || typeof sourceName !== 'string' || sourceName.length > 200) throw newsValidationError('资讯来源参数无效。');
  return { sourceApi, sourceName: sourceName.trim() };
}
function bounds(from, to) {
  const start = newsInstant(from), end = newsInstant(to);
  if (start >= end) throw newsValidationError('资讯时间窗口起点须早于终点。');
  return { start, end };
}
export function safeNewsUrl(value) {
  if (value == null || value === '') return null;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
function errorCode(value) { return ERRORS.has(value) ? value : 'unknown_error'; }

export function createNewsStore({ connectionString, pool: injectedPool } = {}) {
  if (!injectedPool && (typeof connectionString !== 'string' || !connectionString.trim())) throw newsValidationError('请提供 PostgreSQL 连接配置。');
  const pool = injectedPool ?? new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 10_000 });
  if (!injectedPool) pool.on('error', () => {});
  async function query(sql, values) { try { return await pool.query(sql, values); } catch (error) { throw databaseError(error); } }
  async function transaction(operation) {
    let client, began = false;
    try { client = await pool.connect(); await client.query('BEGIN'); began = true; const result = await operation(client); await client.query('COMMIT'); return result; }
    catch (error) { if (began) { try { await client.query('ROLLBACK'); } catch {} } throw error?.kind === 'validation' ? error : databaseError(error); }
    finally { client?.release(); }
  }
  function prepareArticles({ sourceApi, sourceName = '', articles, links, fetchedAt = new Date().toISOString() }, window = null) {
    const sourceInput = source(sourceApi, sourceName), fetched = newsInstant(fetchedAt);
    if (!Array.isArray(articles) || !Array.isArray(links)) throw newsValidationError('资讯和股票关联须为数组。');
    const unique = new Map();
    for (const article of articles) {
      if (!article || !/^[a-f0-9]{64}$/.test(article.id) || article.sourceApi !== sourceApi || typeof article.title !== 'string' || !article.title.trim()
        || typeof article.content !== 'string') throw newsValidationError('资讯记录缺少有效的 ID、标题、正文或来源。');
      const contentKind = article.contentKind ?? (article.content ? 'fulltext' : 'none');
      if (!CONTENT_KINDS.has(contentKind) || (contentKind === 'none') !== (article.content === '')) throw newsValidationError('资讯内容类型与内容不符。');
      const articleSource = source(article.sourceApi, article.sourceName), publishedAt = newsInstant(article.publishedAt);
      if (window && (publishedAt < window.start || publishedAt >= window.end)) throw newsValidationError('资讯发布时间超出采集窗口。');
      const value = [article.id, articleSource.sourceApi, articleSource.sourceName, article.title, article.content, publishedAt, safeNewsUrl(article.url), article.fetchedAt ? newsInstant(article.fetchedAt) : fetched, contentKind];
      const previous = unique.get(article.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(value)) throw newsValidationError('同一资讯 ID 出现冲突内容。');
      unique.set(article.id, value);
    }
    const associations = new Map();
    for (const link of links) {
      if (!link || typeof link.ticker !== 'string' || !/^\d{6}\.(?:SH|SZ|BJ)$/.test(link.ticker) || !unique.has(link.articleId)
        || !MATCHES.has(link.matchType) || !Array.isArray(link.matchedTerms) || link.matchedTerms.some(term => typeof term !== 'string' || !term.trim() || term.length > 200)) throw newsValidationError('资讯股票关联无效或引用了窗口外文章。');
      const key = `${link.ticker}|${link.articleId}`, prior = associations.get(key);
      const terms = [...new Set([...(prior ? JSON.parse(prior[3]) : []), ...link.matchedTerms])].sort();
      associations.set(key, [link.ticker, link.articleId, prior?.[2] === 'source_tag' || link.matchType === 'source_tag' ? 'source_tag' : prior?.[2] ?? link.matchType, JSON.stringify(terms)]);
    }
    return { sourceInput, unique, associations };
  }
  async function writeArticles(client, { sourceInput, unique, associations }) {
    const write = async (table, columns, rows, conflict) => {
      for (let offset = 0; offset < rows.length; offset += 250) {
        const batch = rows.slice(offset, offset + 250), placeholders = batch.map((_, index) => `(${columns.map((__, column) => `$${index * columns.length + column + 1}`).join(', ')})`).join(', ');
        await client.query(`INSERT INTO market_data.${table} (${columns.join(', ')}) VALUES ${placeholders} ${conflict}`, batch.flat());
      }
    };
    // Website list pages carry metadata or a brief. Neither can replace an
    // existing full article; later detail downloads may upgrade/correct it.
    const preserveContent = `EXCLUDED.source_api = 'cls_web' AND (EXCLUDED.content_kind = 'none'
      OR (market_data.news_articles.content_kind = 'fulltext' AND EXCLUDED.content_kind <> 'fulltext'))`;
    await write('news_articles', ['article_id', 'source_api', 'source_name', 'title', 'content', 'published_at', 'url', 'fetched_at', 'content_kind'], [...unique.values()], `ON CONFLICT (article_id) DO UPDATE SET source_name = EXCLUDED.source_name, title = EXCLUDED.title,
      content = CASE WHEN ${preserveContent} THEN market_data.news_articles.content ELSE EXCLUDED.content END,
      content_kind = CASE WHEN ${preserveContent} THEN market_data.news_articles.content_kind ELSE EXCLUDED.content_kind END,
      published_at = EXCLUDED.published_at, url = EXCLUDED.url, fetched_at = EXCLUDED.fetched_at`);
    // A metadata-only website reimport must not downgrade an explicit stock tag
    // to a lexical match. Keep the original replacement semantics for Tushare.
    const linkConflict = sourceInput.sourceApi === 'cls_web'
      ? `ON CONFLICT (ts_code, article_id) DO UPDATE SET
          match_type = CASE WHEN market_data.stock_news_links.match_type = 'source_tag' THEN 'source_tag' ELSE EXCLUDED.match_type END,
          matched_terms = (SELECT coalesce(jsonb_agg(merged.term ORDER BY merged.term), '[]'::jsonb)
            FROM (SELECT DISTINCT term FROM jsonb_array_elements_text(market_data.stock_news_links.matched_terms || EXCLUDED.matched_terms) AS terms(term)) merged)`
      : 'ON CONFLICT (ts_code, article_id) DO UPDATE SET match_type = EXCLUDED.match_type, matched_terms = EXCLUDED.matched_terms';
    await write('stock_news_links', ['ts_code', 'article_id', 'match_type', 'matched_terms'], [...associations.values()], linkConflict);
  }
  return {
    async migrate() { const schema = await readFile(new URL('./news-schema.sql', import.meta.url), 'utf8'); await transaction(client => client.query(schema)); },
    async getSecurities() {
      const result = await query(`SELECT s.ts_code AS ticker, s.name, NULL::text AS fullname FROM market_data.securities s
        WHERE s.market = 'A' AND EXISTS (SELECT 1 FROM market_data.daily_prices p WHERE p.ts_code = s.ts_code AND p.market = 'A') ORDER BY s.ts_code`);
      return result.rows;
    },
    async getCompletedWindows({ sourceApi, sourceName = '', from, to }) {
      const sourceInput = source(sourceApi, sourceName), { start, end } = bounds(from, to);
      const result = await query(`SELECT window_start, window_end FROM market_data.news_sync_windows
        WHERE source_api = $1 AND source_name = $2 AND status = 'completed' AND window_start >= $3 AND window_end <= $4 ORDER BY window_start`, [sourceInput.sourceApi, sourceInput.sourceName, start, end]);
      return new Set(result.rows.map(row => `${newsInstant(row.window_start)}|${newsInstant(row.window_end)}`));
    },
    // Article discovery is not proof that a time range was exhaustively collected.
    // In particular, public website indexes must never create completed windows.
    async saveArticles(input) {
      const prepared = prepareArticles(input);
      await transaction(client => writeArticles(client, prepared));
      return { rowsCount: prepared.unique.size, matchedCount: prepared.associations.size };
    },
    async saveWindow({ sourceApi, sourceName = '', start, end, articles, links, fetchedAt = new Date().toISOString() }) {
      const window = bounds(start, end), prepared = prepareArticles({ sourceApi, sourceName, articles, links, fetchedAt }, window);
      const { sourceInput, unique, associations } = prepared;
      await transaction(async client => {
        await writeArticles(client, prepared);
        await client.query(`INSERT INTO market_data.news_sync_windows (source_api, source_name, window_start, window_end, status, rows_count, matched_count, error_code)
          VALUES ($1, $2, $3, $4, 'completed', $5, $6, NULL) ON CONFLICT (source_api, source_name, window_start, window_end)
          DO UPDATE SET status = 'completed', rows_count = EXCLUDED.rows_count, matched_count = EXCLUDED.matched_count, error_code = NULL, updated_at = now()`,
        [sourceInput.sourceApi, sourceInput.sourceName, window.start, window.end, unique.size, associations.size]);
      });
      return { rowsCount: unique.size, matchedCount: associations.size, start: window.start, end: window.end };
    },
    async setSourceStatus({ sourceApi, status, errorCode: value = null }) {
      source(sourceApi);
      if (!STATUS.has(status)) throw newsValidationError('资讯来源状态无效。');
      await query(`INSERT INTO market_data.news_source_status (source_api, status, error_code) VALUES ($1, $2, $3)
        ON CONFLICT (source_api) DO UPDATE SET status = EXCLUDED.status, error_code = EXCLUDED.error_code, updated_at = now()`, [sourceApi, status, status === 'available' ? null : errorCode(value)]);
    },
    async markFailedWindow({ sourceApi, sourceName = '', start, end, errorCode: value }) {
      const sourceInput = source(sourceApi, sourceName), window = bounds(start, end);
      await query(`INSERT INTO market_data.news_sync_windows (source_api, source_name, window_start, window_end, status, error_code)
        VALUES ($1, $2, $3, $4, 'failed', $5) ON CONFLICT (source_api, source_name, window_start, window_end)
        DO UPDATE SET status = 'failed', error_code = EXCLUDED.error_code, updated_at = now() WHERE market_data.news_sync_windows.status <> 'completed'`, [sourceInput.sourceApi, sourceInput.sourceName, window.start, window.end, errorCode(value)]);
    },
    async summary({ from, to } = {}) {
      const range = from != null || to != null ? bounds(from, to) : null;
      const result = await query(`SELECT count(DISTINCT a.article_id) AS article_count, count(DISTINCT l.ts_code) AS ticker_count,
        count(l.ts_code) AS link_count, count(DISTINCT a.article_id) FILTER (WHERE l.ts_code IS NOT NULL) AS linked_articles,
        min(a.published_at) AS min_published_at, max(a.published_at) AS max_published_at
        FROM market_data.news_articles a LEFT JOIN market_data.stock_news_links l USING (article_id)
        WHERE ($1::timestamptz IS NULL OR a.published_at >= $1) AND ($2::timestamptz IS NULL OR a.published_at < $2)`, [range?.start ?? null, range?.end ?? null]);
      const windows = await query(`SELECT status, count(*) AS count FROM market_data.news_sync_windows
        WHERE ($1::timestamptz IS NULL OR window_start >= $1) AND ($2::timestamptz IS NULL OR window_end <= $2) GROUP BY status`, [range?.start ?? null, range?.end ?? null]);
      const row = result.rows[0] ?? {};
      return { from: range?.start ?? null, to: range?.end ?? null, articleCount: Number(row.article_count ?? 0), linkCount: Number(row.link_count ?? 0), tickerCount: Number(row.ticker_count ?? 0), linkedArticles: Number(row.linked_articles ?? 0), minPublishedAt: row.min_published_at ? newsInstant(row.min_published_at) : null, maxPublishedAt: row.max_published_at ? newsInstant(row.max_published_at) : null, completedWindows: Number(windows.rows.find(item => item.status === 'completed')?.count ?? 0), failedWindows: Number(windows.rows.find(item => item.status === 'failed')?.count ?? 0) };
    },
    async close() { try { await pool.end(); } catch (error) { throw databaseError(error); } },
  };
}
