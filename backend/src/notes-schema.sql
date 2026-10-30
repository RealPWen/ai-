CREATE SCHEMA IF NOT EXISTS research_data;

CREATE TABLE IF NOT EXISTS research_data.user_notes (
  owner_name text NOT NULL CHECK (length(btrim(owner_name)) BETWEEN 1 AND 40),
  ticker text NOT NULL CHECK (ticker ~ '^([0-9]{6}\.(SH|SZ|BJ)|[0-9]{5}\.HK)$'),
  company_name text NOT NULL CHECK (length(btrim(company_name)) BETWEEN 1 AND 120),
  content text NOT NULL CHECK (length(content) <= 50000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (owner_name, ticker)
);
COMMENT ON TABLE research_data.user_notes IS 'Latest research note per author and ticker. Names follow the shared watchlist identity; they are not authenticated accounts.';
COMMENT ON COLUMN research_data.user_notes.created_at IS 'First database save time; legacy browser notes have no reliable original timestamp.';
COMMENT ON COLUMN research_data.user_notes.version IS 'Optimistic concurrency revision preventing stale pages from overwriting newer notes.';
