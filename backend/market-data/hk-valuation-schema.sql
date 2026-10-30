CREATE SCHEMA IF NOT EXISTS market_data;

CREATE TABLE IF NOT EXISTS market_data.hk_daily_valuations (
  ts_code text NOT NULL CHECK (ts_code ~ '^[0-9]{5}\.HK$'),
  trade_date date NOT NULL,
  pe_ttm numeric,
  pb numeric,
  source text NOT NULL CHECK (source = 'baidu'),
  source_api text NOT NULL CHECK (source_api = 'baidu_hk_valuation'),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ts_code, trade_date)
);
COMMENT ON TABLE market_data.hk_daily_valuations IS 'Baidu historical PE-TTM and PB source multiples, intersected with actual stored HK daily price dates. Negative values and explicit missing values are retained. No current fundamentals are used to reconstruct historical values.';
CREATE INDEX IF NOT EXISTS hk_daily_valuations_date_idx ON market_data.hk_daily_valuations (trade_date);

CREATE TABLE IF NOT EXISTS market_data.hk_valuation_update_runs (
  run_date date NOT NULL,
  universe_hash text NOT NULL CHECK (universe_hash ~ '^[a-f0-9]{64}$'),
  tickers text[] NOT NULL,
  window_start date NOT NULL,
  window_end date NOT NULL,
  status text NOT NULL CHECK (status IN ('running','succeeded','partial','failed')),
  summary jsonb NOT NULL DEFAULT '{}',
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_date, universe_hash),
  CHECK (window_start <= window_end AND window_end < run_date)
);
CREATE TABLE IF NOT EXISTS market_data.hk_valuation_symbol_runs (
  run_date date NOT NULL,
  universe_hash text NOT NULL,
  ts_code text NOT NULL CHECK (ts_code ~ '^[0-9]{5}\.HK$'),
  rows_count integer NOT NULL CHECK (rows_count > 0),
  source_through date NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_date, universe_hash, ts_code),
  FOREIGN KEY (run_date, universe_hash) REFERENCES market_data.hk_valuation_update_runs(run_date, universe_hash)
);
CREATE INDEX IF NOT EXISTS hk_valuation_symbol_stock_date_idx ON market_data.hk_valuation_symbol_runs(ts_code,run_date DESC,updated_at DESC,universe_hash);

CREATE TABLE IF NOT EXISTS market_data.hk_valuation_symbol_attempts (
  run_date date NOT NULL,
  ts_code text NOT NULL CHECK (ts_code ~ '^[0-9]{5}\.HK$'),
  universe_hash text NOT NULL CHECK (universe_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('running','succeeded','no_data','no_price_data','failed')),
  rows_count integer NOT NULL DEFAULT 0 CHECK (rows_count>=0),
  expected_count integer NOT NULL DEFAULT 0 CHECK (expected_count>=0),
  error_code text,
  coverage jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(coverage)='object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(run_date,ts_code),
  CHECK ((status IN ('running','succeeded') AND error_code IS NULL)
    OR (status IN ('no_data','no_price_data','failed') AND error_code IS NOT NULL)),
  CHECK ((status='succeeded' AND rows_count>0 AND rows_count=expected_count)
    OR (status<>'succeeded' AND rows_count=0)),
  CHECK (status<>'no_price_data' OR expected_count=0)
);
CREATE INDEX IF NOT EXISTS hk_valuation_attempts_stock_date_idx ON market_data.hk_valuation_symbol_attempts(ts_code,run_date DESC);
