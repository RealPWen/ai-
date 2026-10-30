CREATE SCHEMA IF NOT EXISTS research_data;

CREATE TABLE IF NOT EXISTS research_data.ima_libraries (
  library_id text PRIMARY KEY,
  name text NOT NULL,
  reported_count integer,
  catalog_status text NOT NULL DEFAULT 'pending',
  sync_status text NOT NULL DEFAULT 'pending',
  started_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_error text
);

CREATE TABLE IF NOT EXISTS research_data.ima_folders (
  library_id text NOT NULL REFERENCES research_data.ima_libraries(library_id),
  folder_id text NOT NULL,
  parent_id text,
  title text NOT NULL,
  path text[] NOT NULL DEFAULT '{}',
  cursor_value text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  page_count integer NOT NULL DEFAULT 0,
  item_count integer NOT NULL DEFAULT 0,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (library_id, folder_id)
);

CREATE TABLE IF NOT EXISTS research_data.ima_documents (
  library_id text NOT NULL REFERENCES research_data.ima_libraries(library_id),
  media_id text NOT NULL,
  folder_id text NOT NULL,
  title text NOT NULL,
  media_type integer NOT NULL,
  download_status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  source_host text,
  content_type text,
  local_path text,
  bytes bigint,
  sha256 text,
  text_status text NOT NULL DEFAULT 'pending',
  discovered_at timestamptz NOT NULL DEFAULT now(),
  downloaded_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (library_id, media_id)
);
CREATE INDEX IF NOT EXISTS ima_download_queue_idx ON research_data.ima_documents(library_id, download_status, attempts);
CREATE INDEX IF NOT EXISTS ima_documents_hash_idx ON research_data.ima_documents(sha256);
CREATE INDEX IF NOT EXISTS ima_folder_queue_idx ON research_data.ima_folders(library_id, status);

CREATE TABLE IF NOT EXISTS research_data.ima_document_pages (
  library_id text NOT NULL,
  media_id text NOT NULL,
  page_number integer NOT NULL,
  content text NOT NULL,
  extraction_method text NOT NULL,
  PRIMARY KEY (library_id, media_id, page_number),
  FOREIGN KEY (library_id, media_id) REFERENCES research_data.ima_documents(library_id, media_id)
);

CREATE TABLE IF NOT EXISTS research_data.ima_sync_runs (
  run_id text PRIMARY KEY,
  library_id text NOT NULL REFERENCES research_data.ima_libraries(library_id),
  status text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  last_error text
);
