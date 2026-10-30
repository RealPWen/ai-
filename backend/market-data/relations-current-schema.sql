CREATE SCHEMA IF NOT EXISTS market_data;

CREATE TABLE IF NOT EXISTS market_data.company_relation_current (
  subject_ticker text PRIMARY KEY CHECK (subject_ticker ~ '^([0-9]{6}\.(SH|SZ|BJ)|[0-9]{5}\.HK)$'),
  subject_name text NOT NULL,
  as_of date NOT NULL,
  relations jsonb NOT NULL CHECK (jsonb_typeof(relations)='array' AND jsonb_array_length(relations) BETWEEN 1 AND 10),
  gaps jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(gaps)='array'),
  researched_at timestamptz NOT NULL,
  method_version text NOT NULL,
  source text NOT NULL,
  run_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE market_data.company_relation_current ADD COLUMN IF NOT EXISTS refresh_summary jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON TABLE market_data.company_relation_current IS 'One current relationship report per stock, at most ten companies. AI retains existing members unless evidence supports a change; current contents and latest change reasons are saved atomically in one row.';
