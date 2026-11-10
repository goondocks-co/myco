import { reaching, type Reach } from './schema-step.js';
/** The failed calls a run made, so a failed run's own refusal is one seek however many calls succeeded before it. */
export const FAILED_CALL_INDEX = 'idx_agent_run_events_failed';
/** The rows the index holds; a read names this exact predicate so the planner can use it. */
export const FAILED_CALL_SQL = "event_type = 'run_tool' AND outcome = 'failed'";

export const V701_STATEMENTS: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS ${FAILED_CALL_INDEX} ON agent_run_events(project_id, run_id, recorded_at) WHERE ${FAILED_CALL_SQL}`,
];

/** Why the step reaches tables earlier steps created. */
export const V701_REACHES: readonly Reach[] = reaching(['agent_run_events'], 'A failed run\'s own refusal is one seek, however many of its calls succeeded.');
