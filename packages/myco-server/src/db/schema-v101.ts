/** Dispatch boundary for revision-guarded spore resolution. */
export const GUARD_ENABLED_AT = 'guard_enabled_at';

/** Spore revisions are carried with the spore in backups; existing rows start at zero. */
export const V101_STATEMENTS: readonly string[] = [
  `ALTER TABLE spores ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`,
  `INSERT OR IGNORE INTO schema_meta (key, value)
     VALUES ('${GUARD_ENABLED_AT}', CAST(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS TEXT))`,
];
