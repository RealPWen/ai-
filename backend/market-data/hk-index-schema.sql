CREATE SCHEMA IF NOT EXISTS market_data;
CREATE TABLE IF NOT EXISTS market_data.hk_index_daily (
  index_code text NOT NULL CHECK (index_code = 'HSI'),
  trade_date date NOT NULL,
  open numeric NOT NULL CHECK (open > 0), high numeric NOT NULL CHECK (high > 0),
  low numeric NOT NULL CHECK (low > 0), close numeric NOT NULL CHECK (close > 0),
  vol numeric NOT NULL CHECK (vol >= 0),
  source text NOT NULL DEFAULT 'tencent' CHECK (source = 'tencent'),
  source_api text NOT NULL DEFAULT 'tencent_hsi_daily' CHECK (source_api = 'tencent_hsi_daily'),
  fetched_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (index_code, trade_date),
  CHECK (low <= high AND open BETWEEN low AND high AND close BETWEEN low AND high)
);
CREATE TABLE IF NOT EXISTS market_data.hk_index_update_runs (
  run_date date PRIMARY KEY,
  window_start date NOT NULL, window_end date NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  summary jsonb NOT NULL DEFAULT '{}', error_code text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (window_start <= window_end AND window_end < run_date)
);
