CREATE SCHEMA IF NOT EXISTS market_data;

CREATE TABLE IF NOT EXISTS market_data.sw_industries (
  index_code text PRIMARY KEY CHECK (index_code ~ '^[0-9]{6}\.SI$'),
  industry_name text NOT NULL,
  is_pub boolean NOT NULL,
  src text NOT NULL DEFAULT 'SW2021' CHECK (src = 'SW2021'),
  level text NOT NULL DEFAULT 'L3' CHECK (level = 'L3'),
  industry_code text,
  parent_code text,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS market_data.sw_industries_l2 (
  index_code text PRIMARY KEY CHECK (index_code ~ '^[0-9]{6}\.SI$'),
  industry_name text NOT NULL,
  is_pub boolean NOT NULL,
  src text NOT NULL DEFAULT 'SW2021' CHECK (src = 'SW2021'),
  level text NOT NULL DEFAULT 'L2' CHECK (level = 'L2'),
  industry_code text,
  parent_code text,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS market_data.sw_industry_members (
  ts_code text NOT NULL CHECK (ts_code ~ '^[0-9]{6}\.(SH|SZ|BJ)$'),
  l3_code text NOT NULL CHECK (l3_code ~ '^[0-9]{6}\.SI$'),
  l1_code text NOT NULL,
  l1_name text NOT NULL,
  l2_code text NOT NULL,
  l2_name text NOT NULL,
  l3_name text NOT NULL,
  name text,
  in_date date,
  out_date date,
  is_new text NOT NULL DEFAULT 'Y' CHECK (is_new = 'Y'),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ts_code, l3_code)
);
CREATE INDEX IF NOT EXISTS sw_industry_members_l3_idx ON market_data.sw_industry_members (l3_code);
CREATE INDEX IF NOT EXISTS sw_industry_members_l2_idx ON market_data.sw_industry_members (l2_code);

CREATE TABLE IF NOT EXISTS market_data.sw_industry_members_l2 (
  ts_code text NOT NULL CHECK (ts_code ~ '^[0-9]{6}\.(SH|SZ|BJ)$'),
  l3_code text NOT NULL CHECK (l3_code ~ '^[0-9]{6}\.SI$'),
  l1_code text NOT NULL,
  l1_name text NOT NULL,
  l2_code text NOT NULL CHECK (l2_code ~ '^[0-9]{6}\.SI$'),
  l2_name text NOT NULL,
  l3_name text NOT NULL,
  name text,
  in_date date,
  out_date date,
  is_new text NOT NULL DEFAULT 'Y' CHECK (is_new = 'Y'),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ts_code, l2_code, l3_code)
);
CREATE INDEX IF NOT EXISTS sw_industry_members_l2_parent_idx ON market_data.sw_industry_members_l2 (l2_code);

CREATE TABLE IF NOT EXISTS market_data.sw_index_daily (
  index_code text NOT NULL CHECK (index_code ~ '^[0-9]{6}\.SI$'),
  trade_date date NOT NULL,
  open numeric CHECK (open >= 0),
  high numeric CHECK (high >= 0),
  low numeric CHECK (low >= 0),
  close numeric NOT NULL CHECK (close > 0),
  pct_change numeric,
  vol numeric CHECK (vol >= 0),
  amount numeric CHECK (amount >= 0),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (index_code, trade_date)
);
CREATE INDEX IF NOT EXISTS sw_index_daily_date_idx ON market_data.sw_index_daily (trade_date);

CREATE TABLE IF NOT EXISTS market_data.stock_adj_factors (
  ts_code text NOT NULL CHECK (ts_code ~ '^[0-9]{6}\.(SH|SZ|BJ)$'),
  trade_date date NOT NULL,
  adj_factor numeric NOT NULL CHECK (adj_factor > 0),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ts_code, trade_date)
);
CREATE INDEX IF NOT EXISTS stock_adj_factors_date_idx ON market_data.stock_adj_factors (trade_date);

COMMENT ON TABLE market_data.sw_industries IS 'Latest complete Tushare SW2021 L3 directory snapshot, including unpublished indices.';
COMMENT ON TABLE market_data.sw_industries_l2 IS 'Latest complete Tushare SW2021 L2 directory snapshot, including unpublished indices.';
COMMENT ON TABLE market_data.sw_industry_members IS 'Latest SW2021 membership snapshot. Multiple L3 rows for a stock retain provider conflicts; this is not a historical classification table.';
COMMENT ON TABLE market_data.sw_industry_members_l2 IS 'Latest complete membership snapshot collected independently by L2. Source L3 codes are retained without requiring a matching L3 directory entry.';
COMMENT ON TABLE market_data.sw_index_daily IS 'Published SW2021 L2 and L3 index observations. Missing index dates remain absent; OHLC retains source index points.';
COMMENT ON COLUMN market_data.sw_index_daily.vol IS 'Source sw_daily volume unit: ten thousand shares (万股).';
COMMENT ON COLUMN market_data.sw_index_daily.amount IS 'Source sw_daily amount unit: ten thousand CNY (万元).';
COMMENT ON TABLE market_data.stock_adj_factors IS 'Positive source adj_factor observations; original daily_prices remain unadjusted.';

-- All day observations and their API-specific completion entry share a transaction.
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
