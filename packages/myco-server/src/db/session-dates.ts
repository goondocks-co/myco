/**
 * The instants a session is presented at, as SQL.
 *
 * A session carries two pairs: the raw lifecycle instants the projections
 * decide admission, reopen and titling against, and the instants the parse
 * derived, which an import's dates are presented through. Every surface that
 * shows, orders, filters or indexes a session's dates spells them from here, so
 * a reader cannot disagree with another about when a session happened.
 *
 * `prefix` is the table's alias where the statement gives it one, and empty
 * where the columns stand alone.
 */

/** The instant a session is shown as having started. */
export const presentedStartedAt = (prefix = ''): string => `COALESCE(${prefix}occurred_started_at, ${prefix}started_at)`;

/** The instant a session is shown as having ended, and NULL while it is open. */
export const presentedEndedAt = (prefix = ''): string => `COALESCE(${prefix}occurred_ended_at, ${prefix}ended_at)`;

/** What a session is ordered by, spelled flat so `idx_sessions_occurred` covers it: a nested COALESCE plans as a sort. */
export const occurredAt = (prefix = ''): string => `COALESCE(${prefix}occurred_started_at, ${prefix}started_at, ${prefix}first_received_at)`;

/** Whether a session reads as running or finished, from the end it is shown with. */
export const presentedStatus = (prefix = ''): string => `CASE WHEN ${presentedEndedAt(prefix)} IS NULL THEN 'active' ELSE 'completed' END`;
