import { DISPATCH_ACTOR_SQL } from './run-context.js';

/**
 * Schema v60: a session working now, and an actor's entries counted by seek.
 *
 * - `sessions.working_since` is the instant a session's current turn started, stamped when its prompt asks the
 *   Deployment for context and cleared by the turn's end, in the member's own clock on both sides. A session whose
 *   turn is open reads as working however long the turn runs without sending anything.
 * - `sessions.last_turn_end_at` is the latest turn end that reached the Deployment, in the member's clock: a turn stamp
 *   not newer than it opens nothing, so a stamp arriving after its own turn's end never reopens that turn.
 * - `idx_sessions_working` holds the sessions with an open turn, a handful of rows, so the sessions working across
 *   every Project are one range read.
 * - `idx_agent_runs_actor_entry` finds one actor's entries of a task from an instant on, across the Deployment: the
 *   count an actor's daily ceiling is checked against, inside the write that records a run, and the window its reset
 *   is read from, on the same actor expression those statements render.
 */
export const V60_STATEMENTS: readonly string[] = [
  `ALTER TABLE sessions ADD COLUMN working_since INTEGER`,
  `ALTER TABLE sessions ADD COLUMN last_turn_end_at INTEGER`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_working ON sessions (working_since) WHERE working_since IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_agent_runs_actor_entry ON agent_runs (task, ${DISPATCH_ACTOR_SQL}, COALESCE(queued_at, started_at))`,
];
