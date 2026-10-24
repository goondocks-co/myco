import { TITLING_TASK } from '../core/task-catalogue.js';
import { READ_ORIGINS } from '../read/extraction-origins.js';
/** The ordered extraction candidates, including every material and visibility guard. */
export const EXTRACTION_CANDIDATE_SQL = 'has_session = 1 AND tombstoned = 0 AND ended_at IS NOT NULL AND eligible_prompts > 0 AND pending_transcripts = 0';

/** Explicit active reads retain the same visibility, material and unread guards. */
export const ACTIVE_EXTRACTION_CANDIDATE_SQL = 'has_session = 1 AND tombstoned = 0 AND eligible_prompts > 0 AND pending_transcripts = 0';

/** A transcript whose declared bytes are unread or whose parser recorded a failure. */
export const transcriptPendingSql = (alias: string): string => `(${alias}.parsed_offset < ${alias}.size OR ${alias}.parse_error IS NOT NULL)`;



/** The fact/legacy unread predicate, including the historical acknowledgement flag. */
export function unreadPromptSql(row: string, options: { beforeLedger?: boolean; exceptAck?: string } = {}): string {
  const historical = `${row}.processed = 0 AND ${row}.origin IN (${READ_ORIGINS.map(origin => `'${origin}'`).join(',')})`;
  if (options.beforeLedger === true) return `(${historical})`;
  return `(${historical} AND NOT EXISTS (SELECT 1 FROM extraction_acks a
    WHERE a.project_id = ${row}.project_id AND a.record_id = ${row}.prompt_id AND a.kind = 'record'${options.exceptAck === undefined ? '' : ` AND a.ack_id <> ${options.exceptAck}`}))`;
}



/**
 * A run in flight, queued included: what single-flight and the queue's own
 * refusals read. A `queued` row is still the task's one run — it is waiting to
 * be launched or claimed, not finished — so admitting a second dispatch beside
 * it would double the work rather than replace it.
 *
 * This is the other half of `LIVE_RUN_STATUSES`, and both exist so no statement
 * spells either set by hand. A lease is deliberately absent from both: expiry is
 * interpreted in exactly one place, `expireLeases`, which returns the row to the
 * queue. Reading a lapsed lease as "not in flight" here would admit a duplicate
 * of a run that is merely waiting for another worker to take it.
 */
export const IN_FLIGHT_RUN_STATUSES = "status IN ('pending', 'running', 'queued')";


/** A `title-summary` run naming the session is queued or running. */
export const titleRunInFlightSql = (session: string): string => `EXISTS (SELECT 1 FROM agent_runs r WHERE r.project_id = ${session}.project_id AND r.task = '${TITLING_TASK}'
    AND r.${IN_FLIGHT_RUN_STATUSES}
    AND json_extract(CASE WHEN json_valid(r.run_context) THEN r.run_context END, '$.session_id') = ${session}.session_id)`;
