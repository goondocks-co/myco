import { IN_FLIGHT_RUN_STATUSES } from '../core/runs.js';
import { TITLING_TASK } from '../core/task-catalogue.js';

/** A first attempt, or a failed automatic attempt followed by newly captured live bytes. */
export const titlingClaimAvailableSql = (alias: string): string => `(${alias}.titled_at IS NULL OR (
  ${alias}.title IS NULL
  AND EXISTS (SELECT 1 FROM transcripts t WHERE t.project_id = ${alias}.project_id AND t.session_id = ${alias}.session_id
    AND t.last_received_at > ${alias}.titled_at AND t.imported_at IS NULL)
  AND EXISTS (SELECT 1 FROM agent_runs r WHERE r.project_id = ${alias}.project_id AND r.task = '${TITLING_TASK}'
    AND r.status = 'failed' AND COALESCE(r.queued_at, r.started_at) = ${alias}.titled_at
    AND json_extract(CASE WHEN json_valid(r.run_context) THEN r.run_context END, '$.session_id') = ${alias}.session_id
    AND json_extract(CASE WHEN json_valid(r.run_context) THEN r.run_context END, '$.mode') = 'claim')
  AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.project_id = ${alias}.project_id AND r.task = '${TITLING_TASK}'
    AND r.${IN_FLIGHT_RUN_STATUSES}
    AND json_extract(CASE WHEN json_valid(r.run_context) THEN r.run_context END, '$.session_id') = ${alias}.session_id)
))`;
