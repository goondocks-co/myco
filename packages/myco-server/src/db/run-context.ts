/**
 * A run's context, as SQL.
 *
 * `agent_runs.run_context` is the dispatch's JSON; every statement that reads one key off it, and the index that
 * serves reading `session_id`, renders the key from here, so an index and the statements it serves share one
 * expression. A key is a value a WHERE clause can compare, and null where the context holds no such key; a context
 * the store did not write is not read as JSON at all, so a caller's own string cannot fail the query.
 */
/** The key under which a failed run's context holds its worker's words on why it failed, for the run's page (`ProfileRefusal.reason`). */
export const FAILURE_REASON_KEY = 'failureReason';

export const contextValue = (key: string): string => `CASE WHEN json_valid(run_context) THEN json_extract(run_context, '$.${key}') END`;

/**
 * The member or process a run's dispatch names as its actor: the text `actor` of `dispatch_spec`, null where the spec
 * holds none or an empty one. The statements that count an actor's entries and the index that serves them
 * (`idx_agent_runs_actor_entry`) render it from here, so they read one expression.
 */
export const DISPATCH_ACTOR_SQL = `CASE WHEN json_valid(dispatch_spec) THEN CASE WHEN json_type(dispatch_spec, '$.actor') = 'text' THEN NULLIF(json_extract(dispatch_spec, '$.actor'), '') END END`;
