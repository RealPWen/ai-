CREATE SCHEMA IF NOT EXISTS market_data;

CREATE TABLE IF NOT EXISTS market_data.daily_valuations (
  ts_code text NOT NULL CHECK (ts_code ~ '^[0-9]{6}\.(SH|SZ|BJ)$'),
  trade_date date NOT NULL,
  market text NOT NULL DEFAULT 'A' CHECK (market = 'A'),
  close numeric CHECK (close >= 0),
  pe numeric,
  pe_ttm numeric,
  pb numeric,
  total_mv numeric CHECK (total_mv >= 0),
  circ_mv numeric CHECK (circ_mv >= 0),
  turnover_rate numeric CHECK (turnover_rate >= 0),
  total_share numeric CHECK (total_share >= 0),
  float_share numeric CHECK (float_share >= 0),
  source text NOT NULL DEFAULT 'tushare' CHECK (source = 'tushare'),
  source_api text NOT NULL DEFAULT 'daily_basic' CHECK (source_api = 'daily_basic'),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ts_code, trade_date)
);

COMMENT ON TABLE market_data.daily_valuations IS 'Tushare daily_basic A-share raw observations. Missing values remain NULL; PE/PB are source multiples, never filled from another date.';
COMMENT ON COLUMN market_data.daily_valuations.close IS 'Unadjusted close price, CNY per share.';
COMMENT ON COLUMN market_data.daily_valuations.pe IS 'Source PE (total market value / net profit); multiple, x. Loss-making company values may be NULL.';
COMMENT ON COLUMN market_data.daily_valuations.pe_ttm IS 'Source trailing-twelve-month PE; multiple, x. Loss-making company values may be NULL.';
COMMENT ON COLUMN market_data.daily_valuations.pb IS 'Source price/book multiple, x.';
COMMENT ON COLUMN market_data.daily_valuations.total_mv IS 'Source unit: ten thousand CNY (万元), not CNY.';
COMMENT ON COLUMN market_data.daily_valuations.circ_mv IS 'Source unit: ten thousand CNY (万元), not CNY.';
COMMENT ON COLUMN market_data.daily_valuations.turnover_rate IS 'Source unit: percent (%), not fractional rate.';
COMMENT ON COLUMN market_data.daily_valuations.total_share IS 'Source unit: ten thousand shares (万股).';
COMMENT ON COLUMN market_data.daily_valuations.float_share IS 'Source unit: ten thousand shares (万股).';

CREATE INDEX IF NOT EXISTS daily_valuations_market_date_idx
  ON market_data.daily_valuations (market, trade_date);

-- Shared completion ledger; source_api keeps daily and daily_basic progress separate.
CREATE TABLE IF NOT EXISTS market_data.sync_days (
  market text NOT NULL CHECK (market IN ('A', 'HK')),
  source_api text NOT NULL,
  trade_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('completed', 'failed')),
  rows_count integer NOT NULL DEFAULT 0 CHECK (rows_count >= 0),
  run_id text,
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (market, source_api, trade_date),
  CHECK (status <> 'completed' OR error_code IS NULL)
);
