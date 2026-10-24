import { IN_FLIGHT_RUN_STATUSES } from './run-statuses.js';
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

/** A `title-summary` run naming the session is queued or running. */
export const titleRunInFlightSql = (session: string): string => `EXISTS (SELECT 1 FROM agent_runs r WHERE r.project_id = ${session}.project_id AND r.task = '${TITLING_TASK}'
    AND r.${IN_FLIGHT_RUN_STATUSES}
    AND json_extract(CASE WHEN json_valid(r.run_context) THEN r.run_context END, '$.session_id') = ${session}.session_id)`;
