import { PROJECT_ID_GRAMMAR } from './project-id.js';

export const V715 = 715;

export const V715_STATEMENTS: readonly string[] = [
  'CREATE INDEX IF NOT EXISTS idx_backups_key ON backups(key)',
  'ALTER TABLE object_releases ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE object_releases ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0',
  'CREATE INDEX IF NOT EXISTS idx_object_releases_retry ON object_releases(retry_at,created_at,physical)',
  `CREATE TABLE IF NOT EXISTS object_settlement_intents (
    physical TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('upload','backup')),
    project_id TEXT CHECK (${PROJECT_ID_GRAMMAR}), key TEXT, generation TEXT,
    expires_at INTEGER NOT NULL,
    CHECK(kind='backup' OR (project_id IS NOT NULL AND key IS NOT NULL AND generation IS NOT NULL)))`,
  `CREATE TABLE IF NOT EXISTS object_reconciliation_cursor (
    slot INTEGER PRIMARY KEY CHECK(slot=1), physical TEXT NOT NULL)`,
  "INSERT OR IGNORE INTO object_reconciliation_cursor(slot,physical) VALUES(1,'')",
];
