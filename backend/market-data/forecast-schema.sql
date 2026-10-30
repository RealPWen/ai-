CREATE SCHEMA IF NOT EXISTS market_data;

CREATE TABLE IF NOT EXISTS market_data.sell_side_forecasts (
  forecast_id text PRIMARY KEY CHECK (forecast_id ~ '^[a-f0-9]{64}$'),
  ts_code text NOT NULL CHECK (ts_code ~ '^[0-9]{6}\.(SH|SZ|BJ)$'),
  name text,
  report_date date NOT NULL,
  report_title text,
  report_type text,
  classify text,
  org_name text,
  author_name text,
  quarter text,
  eps numeric,
  np numeric,
  pe numeric,
  rating text,
  max_price numeric,
  min_price numeric,
  source_create_time text,
  source text NOT NULL DEFAULT 'tushare' CHECK (source = 'tushare'),
  source_api text NOT NULL DEFAULT 'report_rc' CHECK (source_api = 'report_rc'),
  raw_data jsonb NOT NULL CHECK (jsonb_typeof(raw_data) = 'object'),
  source_duplicate_count integer NOT NULL DEFAULT 1 CHECK (source_duplicate_count >= 1),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  identity_version integer NOT NULL DEFAULT 2 CHECK (identity_version IN (1, 2))
);
-- Existing v1 identities omitted source create_time. Migration rekeys their IDs in Node without deleting observations.
ALTER TABLE market_data.sell_side_forecasts ADD COLUMN IF NOT EXISTS identity_version integer NOT NULL DEFAULT 1;
ALTER TABLE market_data.sell_side_forecasts ALTER COLUMN identity_version SET DEFAULT 2;

COMMENT ON TABLE market_data.sell_side_forecasts IS 'Tushare report_rc raw sell-side report observations, including each forecast period. No currency or EPS basis is inferred; original fields remain in raw_data. A stable report/period/source-create-time identity preserves distinct provider observations and supports idempotent retries.';
COMMENT ON COLUMN market_data.sell_side_forecasts.quarter IS 'Unmodified source forecast period, not report publication quarter.';
COMMENT ON COLUMN market_data.sell_side_forecasts.eps IS 'Unmodified source EPS; NULL remains NULL. Currency/basic/diluted/adjusted basis is not supplied by this endpoint.';
COMMENT ON COLUMN market_data.sell_side_forecasts.source_create_time IS 'Unmodified source create_time text; timezone is not inferred. Included in identity v2 to preserve distinct provider-created versions.';
COMMENT ON COLUMN market_data.sell_side_forecasts.identity_version IS 'v1 omitted source create_time; v2 includes it. Existing IDs are rekeyed atomically without changing raw rows or sync counts.';
COMMENT ON COLUMN market_data.sell_side_forecasts.source_duplicate_count IS 'Number of fully identical source rows within the downloaded partition; conflicting observations sharing an identity reject the partition.';
CREATE INDEX IF NOT EXISTS sell_side_forecasts_stock_date_idx ON market_data.sell_side_forecasts (ts_code, report_date DESC);
CREATE INDEX IF NOT EXISTS sell_side_forecasts_stock_quarter_org_idx ON market_data.sell_side_forecasts (ts_code, quarter, org_name, report_date DESC);
CREATE INDEX IF NOT EXISTS sell_side_forecasts_report_date_idx ON market_data.sell_side_forecasts (report_date);

CREATE TABLE IF NOT EXISTS market_data.forecast_sync_ranges (
  market text NOT NULL DEFAULT 'A' CHECK (market = 'A'),
  source_api text NOT NULL DEFAULT 'report_rc' CHECK (source_api = 'report_rc'),
  start_date date NOT NULL,
  end_date date NOT NULL CHECK (end_date >= start_date),
  status text NOT NULL CHECK (status IN ('completed', 'failed')),
  rows_count integer NOT NULL DEFAULT 0 CHECK (rows_count >= 0),
  raw_rows_count integer NOT NULL DEFAULT 0 CHECK (raw_rows_count >= rows_count),
  run_id text,
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (market, source_api, start_date, end_date),
  CHECK (status <> 'completed' OR error_code IS NULL)
);
COMMENT ON TABLE market_data.forecast_sync_ranges IS 'Calendar-date report_rc partitions; completed zero-row ranges are valid. This ledger is independent of trading-day price and valuation ingestion.';
