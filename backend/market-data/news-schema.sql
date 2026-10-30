CREATE SCHEMA IF NOT EXISTS market_data;

-- Raw public news is stored once; a separate table records explicit company-name
-- matches. A match is a retrieval association, never a verified business claim.
CREATE TABLE IF NOT EXISTS market_data.news_articles (
  article_id text PRIMARY KEY CHECK (article_id ~ '^[a-f0-9]{64}$'),
  source_api text NOT NULL CHECK (source_api IN ('news', 'major_news', 'anns_d', 'cls_web')),
  source_name text NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  content text NOT NULL DEFAULT '',
  content_kind text NOT NULL DEFAULT 'none' CHECK (content_kind IN ('fulltext', 'summary', 'none')),
  published_at timestamptz NOT NULL,
  url text CHECK (url IS NULL OR url ~ '^https?://'),
  fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS news_articles_date_idx ON market_data.news_articles (published_at DESC, article_id);
CREATE TABLE IF NOT EXISTS market_data.stock_news_links (
  ts_code text NOT NULL CHECK (ts_code ~ '^[0-9]{6}\.(SH|SZ|BJ)$'),
  article_id text NOT NULL REFERENCES market_data.news_articles (article_id),
  match_type text NOT NULL CHECK (match_type IN ('name', 'fullname', 'ticker', 'alias', 'source_tag')),
  matched_terms jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(matched_terms) = 'array'),
  PRIMARY KEY (ts_code, article_id)
);
CREATE INDEX IF NOT EXISTS stock_news_links_article_idx ON market_data.stock_news_links (article_id, ts_code);
CREATE TABLE IF NOT EXISTS market_data.news_sync_windows (
  source_api text NOT NULL CHECK (source_api IN ('news', 'major_news', 'anns_d', 'cls_web')),
  source_name text NOT NULL DEFAULT '',
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('completed', 'failed')),
  rows_count integer NOT NULL DEFAULT 0 CHECK (rows_count >= 0),
  matched_count integer NOT NULL DEFAULT 0 CHECK (matched_count >= 0),
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_api, source_name, window_start, window_end),
  CHECK (window_start < window_end),
  CHECK (status <> 'completed' OR error_code IS NULL)
);
CREATE TABLE IF NOT EXISTS market_data.news_source_status (
  source_api text PRIMARY KEY CHECK (source_api IN ('news', 'major_news', 'anns_d', 'cls_web')),
  status text NOT NULL CHECK (status IN ('available', 'permission_denied', 'failed')),
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- NULL identifies rows from before content kinds existed. Backfill those once;
-- an explicitly saved summary/none must survive every subsequent migration.
ALTER TABLE market_data.news_articles ADD COLUMN IF NOT EXISTS content_kind text;
UPDATE market_data.news_articles SET content_kind = CASE WHEN content = '' THEN 'none' ELSE 'fulltext' END WHERE content_kind IS NULL;
ALTER TABLE market_data.news_articles ALTER COLUMN content_kind SET DEFAULT 'none';
ALTER TABLE market_data.news_articles ALTER COLUMN content_kind SET NOT NULL;
ALTER TABLE market_data.news_articles DROP CONSTRAINT IF EXISTS news_articles_content_kind_check;
ALTER TABLE market_data.news_articles ADD CONSTRAINT news_articles_content_kind_check CHECK (content_kind IN ('fulltext', 'summary', 'none'));
COMMENT ON TABLE market_data.news_sync_windows IS 'UTC instants; windows are left-closed/right-open. Completed empty windows are retained to support resumable calendar-day collection.';
COMMENT ON TABLE market_data.stock_news_links IS 'Explicit lexical company associations; no AI sentiment or causal attribution is inferred.';

-- Existing installations already have these named CHECK constraints. Widen them
-- without dropping tables or data; the transaction makes this repeatable.
ALTER TABLE market_data.news_articles DROP CONSTRAINT IF EXISTS news_articles_source_api_check;
ALTER TABLE market_data.news_articles ADD CONSTRAINT news_articles_source_api_check CHECK (source_api IN ('news', 'major_news', 'anns_d', 'cls_web'));
ALTER TABLE market_data.news_sync_windows DROP CONSTRAINT IF EXISTS news_sync_windows_source_api_check;
ALTER TABLE market_data.news_sync_windows ADD CONSTRAINT news_sync_windows_source_api_check CHECK (source_api IN ('news', 'major_news', 'anns_d', 'cls_web'));
ALTER TABLE market_data.news_source_status DROP CONSTRAINT IF EXISTS news_source_status_source_api_check;
ALTER TABLE market_data.news_source_status ADD CONSTRAINT news_source_status_source_api_check CHECK (source_api IN ('news', 'major_news', 'anns_d', 'cls_web'));
ALTER TABLE market_data.stock_news_links DROP CONSTRAINT IF EXISTS stock_news_links_match_type_check;
ALTER TABLE market_data.stock_news_links ADD CONSTRAINT stock_news_links_match_type_check CHECK (match_type IN ('name', 'fullname', 'ticker', 'alias', 'source_tag'));
COMMENT ON TABLE market_data.stock_news_links IS 'Explicit company associations by source stock tags or lexical matches; no AI sentiment or causal attribution is inferred.';
