/**
 * The instants and state a session is presented with, as SQL.
 *
 * Every surface that shows, orders, filters or indexes a session's dates
 * renders them from here. `prefix` is the table's alias where a statement gives
 * it one, and empty where the columns stand alone.
 */

/** The instant a session is shown as having started. */
export const presentedStartedAt = (prefix = ''): string => `COALESCE(${prefix}occurred_started_at, ${prefix}started_at)`;

/** The instant a session is shown as having ended; NULL while it is open. */
export const presentedEndedAt = (prefix = ''): string => `COALESCE(${prefix}occurred_ended_at, ${prefix}ended_at)`;

/** What a session is ordered by. Spelled flat so `idx_sessions_occurred` covers it: a nested COALESCE plans as a sort. */
export const occurredAt = (prefix = ''): string => `COALESCE(${prefix}occurred_started_at, ${prefix}started_at, ${prefix}first_received_at)`;

/** Whether a session reads as running or finished, from the end it is shown with. */
export const presentedStatus = (prefix = ''): string => `CASE WHEN ${presentedEndedAt(prefix)} IS NULL THEN 'active' ELSE 'completed' END`;
