CREATE TABLE IF NOT EXISTS schema_meta (
     key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS projects (
     project_id TEXT PRIMARY KEY,
     name       TEXT NOT NULL,
     created_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS member_tokens (
     id            TEXT PRIMARY KEY,
     project_id    TEXT NOT NULL REFERENCES projects(project_id),
     machine_id    TEXT,
     token_hash    TEXT NOT NULL,
     expires_at    INTEGER NOT NULL,
     revoked_at    INTEGER,
     bytes_written INTEGER NOT NULL DEFAULT 0,
     CONSTRAINT member_tokens_quota CHECK (bytes_written <= 1073741824));

CREATE UNIQUE INDEX IF NOT EXISTS idx_member_tokens_hash ON member_tokens (token_hash);

CREATE TABLE IF NOT EXISTS sessions (
     project_id          TEXT NOT NULL,
     session_id          TEXT NOT NULL,
     machine_id          TEXT,
     created_by_token_id TEXT NOT NULL,
     transport           TEXT NOT NULL DEFAULT 'cli',
     injection_delivered INTEGER,
     started_at          INTEGER NOT NULL,
     updated_at          INTEGER NOT NULL,
     PRIMARY KEY (project_id, session_id));

CREATE TABLE IF NOT EXISTS events (
     project_id   TEXT NOT NULL,
     event_id     TEXT NOT NULL,
     session_id   TEXT NOT NULL,
     token_id     TEXT NOT NULL,
     kind         TEXT NOT NULL,
     payload      TEXT NOT NULL,
     payload_hash TEXT NOT NULL,
     created_at   INTEGER NOT NULL,
     received_at  INTEGER NOT NULL,
     PRIMARY KEY (project_id, event_id));

CREATE INDEX IF NOT EXISTS idx_events_session ON events (project_id, session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_events_token ON events (project_id, token_id, created_at);

INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', '1');
