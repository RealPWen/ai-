CREATE SCHEMA IF NOT EXISTS market_data;

-- On-demand A/HK research is deliberately independent of the existing frozen
-- researcher runs and their A-share-only publication foreign keys.
CREATE TABLE IF NOT EXISTS market_data.company_relation_ai_jobs (
  job_id uuid PRIMARY KEY,
  subject_ticker text NOT NULL CHECK (subject_ticker ~ '^([0-9]{6}\.(SH|SZ|BJ)|[0-9]{5}\.HK)$'),
  subject_name text NOT NULL,
  as_of date NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  stage text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  method_version text NOT NULL,
  candidate_hash text NOT NULL CHECK (candidate_hash ~ '^[a-f0-9]{64}$'),
  candidate_count integer NOT NULL CHECK (candidate_count BETWEEN 0 AND 20000),
  candidate_securities jsonb NOT NULL CHECK (jsonb_typeof(candidate_securities) = 'array'),
  relations jsonb NOT NULL DEFAULT '[]'::jsonb CONSTRAINT company_relation_ai_jobs_relations_check CHECK (jsonb_typeof(relations) = 'array' AND jsonb_array_length(relations) <= 30),
  result_count integer NOT NULL DEFAULT 0 CHECK (result_count BETWEEN 0 AND 10),
  gaps jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(gaps) = 'array'),
  audit jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(audit) = 'object'),
  researched_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK ((status = 'running' AND finished_at IS NULL AND error_code IS NULL)
    OR (status = 'succeeded' AND finished_at IS NOT NULL AND researched_at IS NOT NULL AND error_code IS NULL)
    OR (status = 'failed' AND finished_at IS NOT NULL AND error_code IS NOT NULL))
);

-- Legacy result arrays are migrated into the unique current row before being
-- cleared. New jobs retain progress/count metadata, never another report copy.
ALTER TABLE market_data.company_relation_ai_jobs ADD COLUMN IF NOT EXISTS result_count integer NOT NULL DEFAULT 0 CHECK (result_count BETWEEN 0 AND 10);

CREATE UNIQUE INDEX IF NOT EXISTS company_relation_ai_jobs_running_idx
  ON market_data.company_relation_ai_jobs (subject_ticker, as_of) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS company_relation_ai_jobs_subject_date_idx
  ON market_data.company_relation_ai_jobs (subject_ticker, as_of DESC, created_at DESC);

COMMENT ON TABLE market_data.company_relation_ai_jobs IS 'Durable AI task progress and result counts. Relationship contents live only in company_relation_current after migration; failed or empty tasks preserve the current row.';
