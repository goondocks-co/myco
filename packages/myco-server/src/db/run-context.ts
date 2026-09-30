/**
 * A run's context, as SQL.
 *
 * `agent_runs.run_context` is the dispatch's JSON; every statement that reads one key off it, and the index that
 * serves reading `session_id`, renders the key from here, so an index and the statements it serves share one
 * expression. A key is a value a WHERE clause can compare, and null where the context holds no such key; a context
 * the store did not write is not read as JSON at all, so a caller's own string cannot fail the query.
 */
export const contextValue = (key: string): string => `CASE WHEN json_valid(run_context) THEN json_extract(run_context, '$.${key}') END`;
