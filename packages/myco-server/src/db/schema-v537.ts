/** A backup upload retains release authority until index publication or expiry. */
export const V537_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS backup_publications (
    key TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS idx_backup_publications_expiry ON backup_publications(expires_at,key)',
];
