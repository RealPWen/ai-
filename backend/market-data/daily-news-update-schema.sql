CREATE SCHEMA IF NOT EXISTS market_data;

-- This ledger records a completed traversal of the specified public keyword,
-- not complete news coverage or point-in-time reconstruction of the provider.
CREATE TABLE IF NOT EXISTS market_data.daily_news_update_runs (
  run_date date PRIMARY KEY,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  source_api text NOT NULL DEFAULT 'cls_web' CHECK (source_api = 'cls_web'),
  search_type text NOT NULL DEFAULT 'depth' CHECK (search_type = 'depth'),
  search_keyword text NOT NULL DEFAULT '财联社' CHECK (search_keyword = '财联社'),
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object'),
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (window_end = (run_date::timestamp AT TIME ZONE 'Asia/Shanghai')),
  CHECK (window_start = window_end - interval '24 hours'),
  CHECK ((status = 'running' AND finished_at IS NULL AND error_code IS NULL)
    OR (status = 'succeeded' AND finished_at IS NOT NULL AND error_code IS NULL)
    OR (status = 'failed' AND finished_at IS NOT NULL AND error_code IS NOT NULL))
);

COMMENT ON TABLE market_data.daily_news_update_runs IS 'Asia/Shanghai 06:00 CLS public depth keyword update for the previous local calendar day. Independent lock and retryable ledger. No whole-site completeness claim; no retention deletion or credentials.';
