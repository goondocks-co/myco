/** Imported prompt provenance seeks one entry per offered session. */
export const V87_STATEMENTS: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_events_imported_prompt ON events (project_id, session_id, producer_adapter) WHERE kind = 'prompt' AND channel = 'import'`,
];
