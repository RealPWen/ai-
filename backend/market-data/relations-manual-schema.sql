CREATE SCHEMA IF NOT EXISTS market_data;

-- Human corrections have their own revision head and append-only audit log.
-- Automated relation publications never update these tables.
CREATE TABLE IF NOT EXISTS market_data.company_relation_manual_subjects (
  subject_ticker text PRIMARY KEY REFERENCES market_data.securities (ts_code),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (subject_ticker ~ '^([0-9]{6}\.(SH|SZ|BJ)|[0-9]{5}\.HK)$')
);

CREATE TABLE IF NOT EXISTS market_data.company_relation_manual_events (
  event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_ticker text NOT NULL REFERENCES market_data.company_relation_manual_subjects (subject_ticker),
  related_ticker text NOT NULL REFERENCES market_data.securities (ts_code),
  related_name text NOT NULL CHECK (length(btrim(related_name)) > 0),
  revision bigint NOT NULL CHECK (revision > 0),
  effective_date date NOT NULL,
  action text NOT NULL CHECK (action IN ('upsert', 'remove', 'restore')),
  relation_type text CHECK (relation_type IN ('upstream', 'peer', 'downstream')),
  rationale text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (subject_ticker, revision, related_ticker),
  CHECK (subject_ticker <> related_ticker),
  CHECK (related_ticker ~ '^([0-9]{6}\.(SH|SZ|BJ)|[0-9]{5}\.HK)$'),
  CHECK ((action = 'upsert' AND relation_type IS NOT NULL) OR (action <> 'upsert' AND relation_type IS NULL))
);
CREATE INDEX IF NOT EXISTS company_relation_manual_events_as_of_idx
  ON market_data.company_relation_manual_events (subject_ticker, related_ticker, effective_date DESC, revision DESC);

COMMENT ON TABLE market_data.company_relation_manual_subjects IS 'Global per-subject concurrency token for human relation changes, independent of automated research runs.';
COMMENT ON TABLE market_data.company_relation_manual_events IS 'Append-only human relation audit events. Read the latest effective date not after the requested cutoff, then the latest revision for each pair. Restore removes the human override and follows automated research.';
