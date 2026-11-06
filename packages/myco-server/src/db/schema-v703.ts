/** Session denominators use the receipt-time window. */
export const V703_STATEMENTS: readonly string[] = [
  "CREATE INDEX IF NOT EXISTS idx_sessions_received ON sessions(project_id,first_received_at)",
];
