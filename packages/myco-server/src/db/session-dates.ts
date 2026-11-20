/** The longest an open turn is considered current work. */
export const WORKING_CAP_MS = 3 * 60 * 60 * 1000;

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

/** Whether a session reads as running or finished, from the end it is shown with. Stored search metadata keeps this form; every read that shows a session's state uses `presentedLiveStatus`. */
export const presentedStatus = (prefix = ''): string => `CASE WHEN ${presentedEndedAt(prefix)} IS NULL THEN 'active' ELSE 'completed' END`;

/** Whether a session is open past its shown end: no end, or a turn opened after it (a session resumed after its end). */
export const presentedOpen = (prefix = ''): string =>
  `(${presentedEndedAt(prefix)} IS NULL OR COALESCE(${prefix}working_since > ${presentedEndedAt(prefix)}, 0))`;

/** Latest event activity, bounded by receipt; older rows retain receipt-based liveness. */
export const activityAt = (prefix = ''): string => `COALESCE(${prefix}latest_activity_at, ${prefix}last_received_at)`;

/**
 * Whether a session is live, as 0 or 1: open (`presentedOpen`) and heard from after `quiet`, the instant
 * `sessionQuietBefore` answers. A session quiet since then reads as ended, whether or not its harness sent an end. With
 * `quiet` null, no session reads as live.
 */
export const presentedLive = (quiet: string, prefix = ''): string =>
  `(${quiet} IS NOT NULL AND ${activityAt(prefix)} > ${quiet} AND ${presentedOpen(prefix)})`;

/** A session's state as browsing, its page, `myco_sessions` and search all show it: `active` while live, else `completed`. */
export const presentedLiveStatus = (quiet: string, prefix = ''): string => `CASE WHEN ${presentedLive(quiet, prefix)} THEN 'active' ELSE 'completed' END`;
