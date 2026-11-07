/** Unnamed-head classification seeks only its machine's unnamed sessions; named delete/rename paths require the same treatment. */
export const V708_STATEMENTS: readonly string[] = [
  "CREATE INDEX IF NOT EXISTS idx_sessions_unnamed_machine ON sessions(machine_id) WHERE agent IS NULL",
];
