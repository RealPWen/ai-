CREATE SCHEMA IF NOT EXISTS market_data;

-- A run freezes both its research policy and the then-listed A-share candidates and its explicit A/HK research scope.
CREATE TABLE IF NOT EXISTS market_data.company_relation_runs (
  run_id text PRIMARY KEY,
  as_of date NOT NULL,
  method_version text NOT NULL,
  subject_scope jsonb CHECK (subject_scope IS NULL OR jsonb_typeof(subject_scope) = 'array'),
  securities_count integer NOT NULL DEFAULT 0 CHECK (securities_count >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS market_data.company_relation_jobs (
  run_id text NOT NULL REFERENCES market_data.company_relation_runs (run_id),
  ticker text NOT NULL CHECK (ticker ~ '^([0-9]{6}\.(SH|SZ|BJ)|[0-9]{5}\.HK)$'),
  is_subject boolean NOT NULL DEFAULT true,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  industry text,
  industry_classifications jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(industry_classifications) = 'array'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'partial', 'completed', 'failed')),
  gaps jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(gaps) = 'array'),
  draft_relations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(draft_relations) = 'array' AND jsonb_array_length(draft_relations) <= 10),
  archived_relations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(archived_relations) = 'array' AND jsonb_array_length(archived_relations) <= 10),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_owner text,
  lease_until timestamptz,
  lease_token uuid,
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, ticker),
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
  CHECK (status <> 'running' OR lease_owner IS NOT NULL)
);
ALTER TABLE market_data.company_relation_runs ADD COLUMN IF NOT EXISTS subject_scope jsonb CHECK (subject_scope IS NULL OR jsonb_typeof(subject_scope) = 'array');
ALTER TABLE market_data.company_relation_jobs ADD COLUMN IF NOT EXISTS is_subject boolean NOT NULL DEFAULT true;
-- Replace only the validation constraint; preserve every job and business row.
ALTER TABLE market_data.company_relation_jobs DROP CONSTRAINT IF EXISTS company_relation_jobs_ticker_check;
ALTER TABLE market_data.company_relation_jobs ADD CONSTRAINT company_relation_jobs_ticker_check CHECK (ticker ~ '^([0-9]{6}\.(SH|SZ|BJ)|[0-9]{5}\.HK)$');
ALTER TABLE market_data.company_relation_jobs ADD COLUMN IF NOT EXISTS draft_relations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(draft_relations) = 'array' AND jsonb_array_length(draft_relations) <= 10);
ALTER TABLE market_data.company_relation_jobs ADD COLUMN IF NOT EXISTS archived_relations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(archived_relations) = 'array' AND jsonb_array_length(archived_relations) <= 10);
ALTER TABLE market_data.company_relation_jobs ADD COLUMN IF NOT EXISTS lease_token uuid;
CREATE INDEX IF NOT EXISTS company_relation_jobs_claim_idx
  ON market_data.company_relation_jobs (run_id, status, ticker);

-- Current published relations: a newer run is published for a subject only when
-- its researched result is published. Any nonempty older result remains published
-- until a new run has 10 candidates; replaced rows remain in the old job archive.
CREATE TABLE IF NOT EXISTS market_data.company_relations (
  subject_ticker text NOT NULL,
  subject_name text NOT NULL,
  related_ticker text NOT NULL,
  related_name text NOT NULL,
  relation_type text NOT NULL CHECK (relation_type IN ('upstream', 'peer', 'downstream')),
  rank smallint NOT NULL CHECK (rank BETWEEN 1 AND 10),
  evidence_type text NOT NULL CHECK (evidence_type IN ('direct_business', 'technical_cooperation', 'industry_position', 'business_comparable')),
  rationale text NOT NULL CHECK (length(btrim(rationale)) > 0),
  actual_entity text NOT NULL CHECK (length(btrim(actual_entity)) > 0),
  listed_mapping_basis text NOT NULL CHECK (length(btrim(listed_mapping_basis)) > 0),
  notes text NOT NULL DEFAULT '',
  sources jsonb NOT NULL CHECK (jsonb_typeof(sources) = 'array' AND jsonb_array_length(sources) > 0),
  verified_at timestamptz NOT NULL DEFAULT now(),
  run_id text NOT NULL,
  as_of date NOT NULL,
  method_version text NOT NULL,
  PRIMARY KEY (subject_ticker, related_ticker),
  UNIQUE (subject_ticker, rank),
  FOREIGN KEY (run_id, subject_ticker) REFERENCES market_data.company_relation_jobs (run_id, ticker),
  FOREIGN KEY (run_id, related_ticker) REFERENCES market_data.company_relation_jobs (run_id, ticker),
  CHECK (subject_ticker <> related_ticker)
);
CREATE INDEX IF NOT EXISTS company_relations_run_idx ON market_data.company_relations (run_id, subject_ticker);
COMMENT ON TABLE market_data.company_relations IS 'Current researched A/HK subjects with A-share counterparties. URLs and excerpts are structurally validated; semantic evidence must be reviewed by a researcher. Any older nonempty publication stays until a new run has 10 candidates, then remains readable in its original job archive.';
COMMENT ON COLUMN market_data.company_relation_jobs.name IS 'Frozen listed security name at run initialization; used to validate researched counterparties.';
COMMENT ON COLUMN market_data.company_relation_jobs.industry_classifications IS 'Frozen SW classification candidates only; classification alone does not establish business relationships.';

COMMENT ON COLUMN market_data.company_relation_jobs.is_subject IS 'True for research tasks; false for frozen A-share counterparty candidates only. Existing runs default to all A-share subjects.';
