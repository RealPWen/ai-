CREATE SCHEMA IF NOT EXISTS market_data;
CREATE TABLE IF NOT EXISTS market_data.stock_return_attributions (
  ticker text NOT NULL CHECK (ticker ~ '^([0-9]{6}\.(SH|SZ|BJ)|[0-9]{5}\.HK)$'),
  period text NOT NULL CHECK (period IN ('1m','6m','1y')),
  report jsonb NOT NULL CHECK (jsonb_typeof(report)='object'),
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  generated_at timestamptz NOT NULL,
  generation_started_at timestamptz NOT NULL,
  saved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(ticker,period),
  CHECK (report->>'ticker'=ticker AND report->>'period'=period AND report->>'inputHash'=input_hash)
);
CREATE TABLE IF NOT EXISTS market_data.stock_return_attribution_jobs (
  job_id uuid PRIMARY KEY,
  ticker text NOT NULL CHECK (ticker ~ '^([0-9]{6}\.(SH|SZ|BJ)|[0-9]{5}\.HK)$'),
  as_of date NOT NULL,
  status text NOT NULL CHECK (status IN ('running','succeeded','partial','failed')),
  stage text NOT NULL,
  periods jsonb NOT NULL CHECK (jsonb_typeof(periods)='object'),
  snapshots jsonb NOT NULL CHECK (jsonb_typeof(snapshots)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK ((status='running' AND finished_at IS NULL) OR (status<>'running' AND finished_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS stock_return_attribution_one_running ON market_data.stock_return_attribution_jobs ((true)) WHERE status='running';
CREATE INDEX IF NOT EXISTS stock_return_attribution_jobs_ticker ON market_data.stock_return_attribution_jobs(ticker,created_at DESC);
COMMENT ON TABLE market_data.stock_return_attributions IS 'Only the latest successful report per stock and period. Three periods per stock; report JSONB lives in PostgreSQL, never a JSON file.';
COMMENT ON TABLE market_data.stock_return_attribution_jobs IS 'Manual research progress and frozen numeric inputs. No historical copies of generated report text.';
