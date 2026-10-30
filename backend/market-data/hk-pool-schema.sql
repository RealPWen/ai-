CREATE SCHEMA IF NOT EXISTS market_data;

-- A workbook pool never reuses the success marker of a full-market download,
-- another ticker membership, or another data provider.
CREATE TABLE IF NOT EXISTS market_data.hk_pool_update_runs (
  run_date date NOT NULL,
  universe_hash text NOT NULL CHECK (universe_hash ~ '^[a-f0-9]{64}$'),
  source text NOT NULL,
  source_api text NOT NULL,
  tickers text[] NOT NULL CHECK (cardinality(tickers) > 0),
  window_start date NOT NULL,
  window_end date NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object'),
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_date, universe_hash, source, source_api),
  CONSTRAINT hk_pool_update_runs_window_check CHECK (window_start <= window_end AND window_end < run_date AND window_end - window_start < 400),
  CHECK (
    (status = 'running' AND finished_at IS NULL AND error_code IS NULL)
    OR (status = 'succeeded' AND finished_at IS NOT NULL AND error_code IS NULL)
    OR (status IN ('partial', 'failed') AND finished_at IS NOT NULL AND error_code IS NOT NULL)
  )
);

-- These are complete per-security query ranges, including genuine suspension
-- or closed-day gaps. They do not certify an entire HK market trading day.
CREATE TABLE IF NOT EXISTS market_data.hk_pool_symbol_ranges (
  universe_hash text NOT NULL CHECK (universe_hash ~ '^[a-f0-9]{64}$'),
  ts_code text NOT NULL CHECK (ts_code ~ '^[0-9]{5}\.HK$'),
  source text NOT NULL,
  source_api text NOT NULL,
  range_start date NOT NULL,
  range_end date NOT NULL,
  rows_count integer NOT NULL CONSTRAINT hk_pool_symbol_ranges_rows_check CHECK (rows_count >= 0 AND rows_count <= 400),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (universe_hash, ts_code, source, source_api, range_start, range_end),
  CONSTRAINT hk_pool_symbol_ranges_window_check CHECK (range_start <= range_end AND range_end - range_start < 400)
);

-- A lookup proves that the annual window's preceding real quote was checked.
-- Only that single quote is stored; lookup_start/end never certify retention.
CREATE TABLE IF NOT EXISTS market_data.hk_pool_symbol_baselines (
  universe_hash text NOT NULL CHECK (universe_hash ~ '^[a-f0-9]{64}$'),
  ts_code text NOT NULL CHECK (ts_code ~ '^[0-9]{5}\.HK$'),
  source text NOT NULL,
  source_api text NOT NULL,
  annual_start date NOT NULL,
  lookup_start date NOT NULL,
  lookup_end date NOT NULL,
  baseline_date date,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (universe_hash, ts_code, source, source_api, annual_start),
  CHECK (lookup_start <= lookup_end AND lookup_end < annual_start AND lookup_end - lookup_start < 30),
  CHECK (baseline_date IS NULL OR baseline_date < annual_start)
);

-- Upgrade existing annual-only checks without removing rows or coverage. The
-- previous schema used generated constraint names, so identify only its exact
-- 366-day bounds on these two pool tables, then install named buffered bounds.
DO $migration$
DECLARE old_check record;
BEGIN
  FOR old_check IN
    SELECT conrelid::regclass AS table_name, conname
    FROM pg_constraint
    WHERE contype = 'c'
      AND conrelid IN ('market_data.hk_pool_update_runs'::regclass, 'market_data.hk_pool_symbol_ranges'::regclass)
      AND pg_get_constraintdef(oid) ~ '\m366\M'
      AND (position('window_start' in pg_get_constraintdef(oid)) > 0
        OR position('range_start' in pg_get_constraintdef(oid)) > 0
        OR position('rows_count' in pg_get_constraintdef(oid)) > 0)
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', old_check.table_name, old_check.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'market_data.hk_pool_update_runs'::regclass AND conname = 'hk_pool_update_runs_window_check') THEN
    ALTER TABLE market_data.hk_pool_update_runs ADD CONSTRAINT hk_pool_update_runs_window_check
      CHECK (window_start <= window_end AND window_end < run_date AND window_end - window_start < 400);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'market_data.hk_pool_symbol_ranges'::regclass AND conname = 'hk_pool_symbol_ranges_window_check') THEN
    ALTER TABLE market_data.hk_pool_symbol_ranges ADD CONSTRAINT hk_pool_symbol_ranges_window_check
      CHECK (range_start <= range_end AND range_end - range_start < 400);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'market_data.hk_pool_symbol_ranges'::regclass AND conname = 'hk_pool_symbol_ranges_rows_check') THEN
    ALTER TABLE market_data.hk_pool_symbol_ranges ADD CONSTRAINT hk_pool_symbol_ranges_rows_check
      CHECK (rows_count >= 0 AND rows_count <= 400);
  END IF;
END
$migration$;

COMMENT ON TABLE market_data.hk_pool_update_runs IS 'Workbook-scoped Hong Kong annual rolling updates plus one preceding real quote; provider and sorted ticker membership identify independent resumable runs. No credentials or raw provider exceptions.';
COMMENT ON TABLE market_data.hk_pool_symbol_ranges IS 'Atomic per-ticker complete query coverage; never creates full-market sync_days completion.';
