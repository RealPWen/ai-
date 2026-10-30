CREATE SCHEMA IF NOT EXISTS market_data;
CREATE TABLE IF NOT EXISTS market_data.hk_sell_side_forecasts (
  forecast_id text PRIMARY KEY CHECK (forecast_id ~ '^[a-f0-9]{64}$'),
  snapshot_date date NOT NULL,
  universe_hash text NOT NULL CHECK (universe_hash ~ '^[a-f0-9]{64}$'),
  ts_code text NOT NULL CHECK (ts_code ~ '^[0-9]{5}\.HK$'),
  source_record_id text NOT NULL,
  report_date date NOT NULL,
  report_title text,
  org_name text NOT NULL,
  author_name text,
  fiscal_year integer NOT NULL CHECK (fiscal_year BETWEEN 1900 AND 2200),
  fiscal_period text NOT NULL,
  eps numeric,
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  eps_basis text,
  np numeric,
  pe numeric,
  rating text,
  source text NOT NULL CHECK (source = 'etnet'),
  source_api text NOT NULL CHECK (source_api = 'etnet_hk_profit_forecast'),
  source_url text NOT NULL,
  raw_data jsonb NOT NULL CHECK (jsonb_typeof(raw_data) = 'object'),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  CHECK (report_date <= snapshot_date)
);
COMMENT ON TABLE market_data.hk_sell_side_forecasts IS 'ETNet per-broker annual EPS current snapshots, not a historical report archive. Observation date is snapshot_date; report_date retains the source broker update date. Share-unit normalization and source currency are recorded in raw_data; unknown currency/basis is never inferred.';
COMMENT ON COLUMN market_data.hk_sell_side_forecasts.report_date IS 'Source broker forecast update date, not a report publication date.';
COMMENT ON COLUMN market_data.hk_sell_side_forecasts.eps IS 'Source EPS normalized from cents/fen to currency units per share. Negative, zero and explicit missing values are retained.';
CREATE INDEX IF NOT EXISTS hk_forecasts_snapshot_stock_idx ON market_data.hk_sell_side_forecasts(ts_code,snapshot_date DESC,report_date DESC);

CREATE TABLE IF NOT EXISTS market_data.hk_forecast_update_runs (
  run_date date NOT NULL,
  universe_hash text NOT NULL CHECK (universe_hash ~ '^[a-f0-9]{64}$'),
  tickers text[] NOT NULL,
  window_start date NOT NULL,
  window_end date NOT NULL,
  status text NOT NULL CHECK (status IN ('running','succeeded','partial','failed')),
  summary jsonb NOT NULL DEFAULT '{}',
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(run_date,universe_hash),
  CHECK (window_start <= window_end AND window_end = run_date)
);
CREATE TABLE IF NOT EXISTS market_data.hk_forecast_symbol_runs (
  run_date date NOT NULL,
  universe_hash text NOT NULL,
  ts_code text NOT NULL CHECK (ts_code ~ '^[0-9]{5}\.HK$'),
  status text NOT NULL DEFAULT 'succeeded' CHECK (status = 'succeeded'),
  rows_count integer NOT NULL CHECK (rows_count >= 0),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(run_date,universe_hash,ts_code),
  FOREIGN KEY(run_date,universe_hash) REFERENCES market_data.hk_forecast_update_runs(run_date,universe_hash)
);
CREATE INDEX IF NOT EXISTS hk_forecast_symbol_stock_date_idx ON market_data.hk_forecast_symbol_runs(ts_code,run_date DESC,fetched_at DESC,universe_hash);

-- Per-company attempts use the actual observation day independently of the
-- market membership hash. An explicit empty source is distinct from a failure.
CREATE TABLE IF NOT EXISTS market_data.hk_forecast_symbol_attempts (
  run_date date NOT NULL,
  ts_code text NOT NULL CHECK (ts_code ~ '^[0-9]{5}\.HK$'),
  universe_hash text NOT NULL CHECK (universe_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('running','succeeded','no_data','failed')),
  rows_count integer NOT NULL DEFAULT 0 CHECK (rows_count >= 0),
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(run_date,ts_code),
  CHECK ((status IN ('running','succeeded','no_data') AND error_code IS NULL)
    OR (status='failed' AND error_code IS NOT NULL)),
  CHECK ((status='succeeded' AND rows_count>0) OR (status<>'succeeded' AND rows_count=0))
);
CREATE INDEX IF NOT EXISTS hk_forecast_attempts_stock_date_idx ON market_data.hk_forecast_symbol_attempts(ts_code,run_date DESC);
