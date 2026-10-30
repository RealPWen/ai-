CREATE SCHEMA IF NOT EXISTS market_data;

-- Current reference names/classification, separate from historical prices.
CREATE TABLE IF NOT EXISTS market_data.securities (
  ts_code text PRIMARY KEY,
  name text NOT NULL,
  market text NOT NULL CHECK (market IN ('A', 'HK')),
  industry text,
  list_date date,
  delist_date date,
  list_status text,
  source text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

-- Provider prices are stored without adjustment. Volume and amount retain
-- the source API's units; A-share and Hong Kong rows must not be mixed blindly.
CREATE TABLE IF NOT EXISTS market_data.daily_prices (
  ts_code text NOT NULL,
  trade_date date NOT NULL,
  market text NOT NULL CHECK (market IN ('A', 'HK')),
  open numeric,
  high numeric,
  low numeric,
  close numeric,
  pre_close numeric,
  change numeric,
  pct_chg numeric,
  vol numeric,
  amount numeric,
  source text NOT NULL DEFAULT 'tushare',
  source_api text NOT NULL,
  adjustment text NOT NULL DEFAULT 'none' CHECK (adjustment = 'none'),
  volume_unit text NOT NULL,
  amount_unit text NOT NULL,
  currency text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ts_code, trade_date),
  CONSTRAINT daily_prices_market_units_check CHECK (
    (market = 'A' AND volume_unit = 'lot' AND amount_unit = 'thousand_cny' AND currency = 'CNY')
    OR (market = 'HK' AND volume_unit = 'share' AND amount_unit = 'hkd' AND currency = 'HKD')
    OR (market = 'HK' AND source = 'tencent' AND source_api = 'tencent_hk_daily'
      AND volume_unit = 'share' AND amount_unit = 'usd' AND currency = 'USD')
  )
);

-- A USD-denominated listed company counter keeps its original Tencent USD
-- prices. Other providers retain the original HKD-only unit contract.
DO $units_migration$
DECLARE old_check record;
BEGIN
  FOR old_check IN SELECT conname FROM pg_constraint WHERE contype='c'
    AND conrelid='market_data.daily_prices'::regclass
    AND position('volume_unit' in pg_get_constraintdef(oid))>0
    AND position('amount_unit' in pg_get_constraintdef(oid))>0
    AND position('currency' in pg_get_constraintdef(oid))>0
    AND position('USD' in pg_get_constraintdef(oid))=0
  LOOP
    EXECUTE format('ALTER TABLE market_data.daily_prices DROP CONSTRAINT %I',old_check.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='market_data.daily_prices'::regclass AND conname='daily_prices_market_units_check') THEN
    ALTER TABLE market_data.daily_prices ADD CONSTRAINT daily_prices_market_units_check CHECK (
      (market='A' AND volume_unit='lot' AND amount_unit='thousand_cny' AND currency='CNY')
      OR (market='HK' AND volume_unit='share' AND amount_unit='hkd' AND currency='HKD')
      OR (market='HK' AND source='tencent' AND source_api='tencent_hk_daily' AND volume_unit='share' AND amount_unit='usd' AND currency='USD')
    );
  END IF;
END
$units_migration$;

-- Upgrade the original Tushare-only check without changing existing records.
ALTER TABLE market_data.daily_prices DROP CONSTRAINT IF EXISTS daily_prices_source_check;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'market_data.daily_prices'::regclass AND conname = 'daily_prices_source_provider_check'
    AND (position('yahoo_hk_daily' in pg_get_constraintdef(oid)) = 0 OR position('tencent_hk_daily' in pg_get_constraintdef(oid)) = 0)) THEN
    ALTER TABLE market_data.daily_prices DROP CONSTRAINT daily_prices_source_provider_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'market_data.daily_prices'::regclass AND conname = 'daily_prices_source_provider_check') THEN
    ALTER TABLE market_data.daily_prices ADD CONSTRAINT daily_prices_source_provider_check CHECK (
      (source = 'tushare' AND source_api NOT IN ('eastmoney_hk_daily', 'yahoo_hk_daily', 'tencent_hk_daily'))
      OR (source = 'eastmoney' AND market = 'HK' AND source_api = 'eastmoney_hk_daily')
      OR (source = 'yahoo' AND market = 'HK' AND source_api = 'yahoo_hk_daily')
      OR (source = 'tencent' AND market = 'HK' AND source_api = 'tencent_hk_daily')
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS daily_prices_market_date_idx
  ON market_data.daily_prices (market, trade_date);

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
