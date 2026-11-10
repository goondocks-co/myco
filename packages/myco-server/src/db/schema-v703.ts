import { reaching, type Reach } from './schema-step.js';
/** KPI session denominators use receipt time; session lists use occurrence time. */
export const V703_STATEMENTS: readonly string[] = [
  "CREATE INDEX IF NOT EXISTS idx_sessions_received ON sessions(project_id,first_received_at)",
];

/** Why the step reaches tables earlier steps created. */
export const V703_REACHES: readonly Reach[] = reaching(['sessions'], 'KPI denominators seek session receipts in the selected time window.');
