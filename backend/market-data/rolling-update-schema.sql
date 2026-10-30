CREATE SCHEMA IF NOT EXISTS market_data;

-- One durable outcome per China-local scheduled date. Failed or interrupted
-- executions may retry that date; succeeded executions are not overwritten.
CREATE TABLE IF NOT EXISTS market_data.daily_update_runs (
  run_date date PRIMARY KEY,
  window_start date NOT NULL,
  window_end date NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object'),
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (window_start <= window_end AND window_end < run_date),
  CHECK (
    (status = 'running' AND finished_at IS NULL AND error_code IS NULL)
    OR (status = 'succeeded' AND finished_at IS NOT NULL AND error_code IS NULL)
    OR (status = 'failed' AND finished_at IS NOT NULL AND error_code IS NOT NULL)
  )
);

COMMENT ON TABLE market_data.daily_update_runs IS 'A-share rolling one-calendar-year updater outcomes by Asia/Shanghai scheduled date. Success is committed atomically with retention after every expected API/day is complete. No credentials or raw exception messages.';

-- Hong Kong has its own calendar, provider entitlement, outcome and lock. An
-- A-share success on the same local date must never suppress the HK update.
CREATE TABLE IF NOT EXISTS market_data.hk_daily_update_runs (
  run_date date PRIMARY KEY,
  window_start date NOT NULL,
  window_end date NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object'),
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (window_start <= window_end AND window_end < run_date),
  CHECK (
    (status = 'running' AND finished_at IS NULL AND error_code IS NULL)
    OR (status = 'succeeded' AND finished_at IS NOT NULL AND error_code IS NULL)
    OR (status = 'failed' AND finished_at IS NOT NULL AND error_code IS NOT NULL)
  )
);

COMMENT ON TABLE market_data.hk_daily_update_runs IS 'Hong Kong rolling one-calendar-year updater outcomes by Asia/Shanghai scheduled date. Success is committed atomically with HK-only retention after every expected hk_daily trading day is complete. No credentials or raw exception messages.';
