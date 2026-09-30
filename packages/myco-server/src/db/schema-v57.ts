import { occurredAt } from './session-dates.js';

/**
 * Schema v57: the reads the dashboard's Today page makes across every Project.
 *
 * - `idx_sessions_occurred_deployment`, `idx_spores_created_deployment` and `idx_plans_updated_deployment` order each
 *   list newest first across the Deployment, on the expression and tie-break its per-Project read orders by, so a page
 *   across Projects walks the index and stops at its page instead of sorting every row held.
 * - `idx_spores_author` finds the spores a run wrote: `spores.author` holds the writing run's id, and what a run
 *   produced is counted by it.
 * - `idx_sessions_capture` reads the latest receipt per machine and agent over a recent window. It leads with the
 *   receipt so the window is a range, and carries the machine, the agent and the Project so the read never visits a
 *   session row.
 */
export const V57_STATEMENTS: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_sessions_occurred_deployment ON sessions (${occurredAt()}, session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_spores_created_deployment ON spores (created_at, id)`,
  `CREATE INDEX IF NOT EXISTS idx_plans_updated_deployment ON plans (updated_at, plan_key)`,
  `CREATE INDEX IF NOT EXISTS idx_spores_author ON spores (project_id, author)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_capture ON sessions (last_received_at, machine_id, agent, project_id)`,
];
