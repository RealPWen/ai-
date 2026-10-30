CREATE SCHEMA IF NOT EXISTS market_data;

CREATE TABLE IF NOT EXISTS market_data.hk_listed_universe (
  ts_code text PRIMARY KEY CHECK (ts_code ~ '^[0-9]{5}\.HK$'),
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  currency text NOT NULL,
  list_date date,
  board text,
  isin text,
  source text NOT NULL,
  source_api text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hk_listed_universe_active_idx ON market_data.hk_listed_universe (active, ts_code);

CREATE TABLE IF NOT EXISTS market_data.hk_market_update_runs (
  run_date date NOT NULL,
  universe_hash text NOT NULL CHECK (universe_hash ~ '^[a-f0-9]{64}$'),
  tickers text[] NOT NULL CHECK (cardinality(tickers) BETWEEN 1 AND 10000),
  window_start date NOT NULL,
  window_end date NOT NULL,
  status text NOT NULL CHECK (status IN ('running','succeeded','partial','failed')),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object'),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_date, universe_hash),
  CHECK (window_start <= window_end AND window_end < run_date AND window_end-window_start < 400),
  CHECK ((status='running' AND finished_at IS NULL) OR (status<>'running' AND finished_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS market_data.hk_market_symbol_ranges (
  ts_code text NOT NULL CHECK (ts_code ~ '^[0-9]{5}\.HK$'),
  source text NOT NULL CHECK (source='tencent'),
  source_api text NOT NULL CHECK (source_api='tencent_hk_daily'),
  range_start date NOT NULL,
  range_end date NOT NULL,
  rows_count integer NOT NULL CHECK (rows_count BETWEEN 0 AND 400),
  empty_proof text CONSTRAINT hk_market_symbol_ranges_empty_proof_check CHECK (empty_proof IS NULL OR empty_proof IN ('weekends','hk_tradecal')),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ts_code, source, source_api, range_start, range_end),
  CHECK (range_start<=range_end AND range_end-range_start<400),
  CONSTRAINT hk_market_symbol_ranges_nonempty_check CHECK (rows_count>0 OR (empty_proof IN ('weekends','hk_tradecal')) IS TRUE)
);

DO $migration$
DECLARE old_check record;
BEGIN
  FOR old_check IN SELECT conname FROM pg_constraint WHERE contype='c'
    AND conrelid='market_data.hk_market_symbol_ranges'::regclass
    AND position('empty_proof' in pg_get_constraintdef(oid))>0
    AND position('hk_tradecal' in pg_get_constraintdef(oid))=0
  LOOP
    EXECUTE format('ALTER TABLE market_data.hk_market_symbol_ranges DROP CONSTRAINT %I',old_check.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='market_data.hk_market_symbol_ranges'::regclass AND conname='hk_market_symbol_ranges_empty_proof_check') THEN
    ALTER TABLE market_data.hk_market_symbol_ranges ADD CONSTRAINT hk_market_symbol_ranges_empty_proof_check
      CHECK (empty_proof IS NULL OR empty_proof IN ('weekends','hk_tradecal'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='market_data.hk_market_symbol_ranges'::regclass AND conname='hk_market_symbol_ranges_nonempty_check') THEN
    ALTER TABLE market_data.hk_market_symbol_ranges ADD CONSTRAINT hk_market_symbol_ranges_nonempty_check
      CHECK (rows_count>0 OR (empty_proof IN ('weekends','hk_tradecal')) IS TRUE);
  END IF;
END
$migration$;

CREATE TABLE IF NOT EXISTS market_data.hk_market_symbol_attempts (
  run_date date NOT NULL,
  ts_code text NOT NULL CHECK (ts_code ~ '^[0-9]{5}\.HK$'),
  universe_hash text NOT NULL CHECK (universe_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('completed','no_data','failed')),
  rows_count integer NOT NULL DEFAULT 0 CHECK (rows_count>=0),
  error_code text,
  last_quote_date date,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_date,ts_code),
  CHECK ((status='completed' AND error_code IS NULL) OR (status<>'completed' AND error_code IS NOT NULL))
);

COMMENT ON TABLE market_data.hk_listed_universe IS 'Complete current listed-company catalog; inactive membership changes only after a verified complete source refresh.';
COMMENT ON TABLE market_data.hk_market_symbol_ranges IS 'Verified Tencent per-symbol query ranges independent of universe membership; no-data responses never certify market-day completion.';
