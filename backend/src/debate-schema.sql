CREATE SCHEMA IF NOT EXISTS market_data;

-- Exactly one active report per stock. Provider, model and research date are
-- provenance of that report rather than extra storage partitions.
CREATE TABLE IF NOT EXISTS market_data.core_market_debates (
  ticker text PRIMARY KEY CHECK (ticker ~ '^[A-Z0-9][A-Z0-9._-]{0,31}$'),
  report jsonb NOT NULL CHECK (jsonb_typeof(report)='object'),
  updated_at timestamptz NOT NULL,
  provider text NOT NULL CHECK (provider IN ('deepseek','chatgpt','openai')),
  model text NOT NULL,
  prompt_version text NOT NULL,
  saved_at timestamptz NOT NULL DEFAULT now(),
  CHECK (report ?& ARRAY['ticker','company','generatedAt','asOf','model','provider','promptVersion']),
  CHECK (jsonb_typeof(report->'company')='object' AND (report->'company') ? 'ticker'),
  CHECK (report->>'ticker'=ticker),
  CHECK (report->'company'->>'ticker'=ticker),
  CHECK (report->>'provider'=provider),
  CHECK (report->>'model'=model),
  CHECK (report->>'promptVersion'=prompt_version)
);
COMMENT ON TABLE market_data.core_market_debates IS 'One latest successfully audited core-market-debate report per ticker. Updated_at is the original generatedAt instant, including during legacy migration; no version history is stored here.';
