/** KPI session denominators use receipt time; session lists use occurrence time. */
export const V703_STATEMENTS: readonly string[] = [
  "CREATE INDEX IF NOT EXISTS idx_sessions_received ON sessions(project_id,first_received_at)",
];
