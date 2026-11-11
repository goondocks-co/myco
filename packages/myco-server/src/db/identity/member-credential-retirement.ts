import { write, type Bound } from '../index.js';

const RETIRE_OWNED = 'UPDATE member_credentials SET revoked_at = ?1, revoked_by = ?2 WHERE id = ?3 AND member_id = ?2 AND revoked_at IS NULL';

const retireOwned = write<[now: number, memberId: string, tokenId: string], { id: string }>({
  name: 'credential.retireOwned', sql: `${RETIRE_OWNED} RETURNING id`,
});
const retireEndedAttempt = write<[now: number, memberId: string, tokenId: string, projectId: string, runId: string], { id: string }>({
  name: 'credential.retireEndedAttempt',
  sql: `${RETIRE_OWNED} AND EXISTS (SELECT 1 FROM agent_runs WHERE project_id = ?4 AND id = ?5 AND dispatched_by = ?3 AND status IN ('completed','failed','skipped')) RETURNING id`,
});

/** Retires a live credential only when it belongs to `memberId`; its RETURNING row says whether it did. */
export const retireOwnedCredentialWrite = (now: number, memberId: string, tokenId: string): Bound<{ id: string }, 'write'> =>
  retireOwned.bind(now, memberId, tokenId);

/**
 * Retires a live credential of `memberId` only while the run it dispatched has ended under it, read at this point of
 * the batch: placed after the run's terminal update, it retires the credential exactly when that run is over.
 */
export function retireEndedAttemptCredentialWrite(
  now: number, memberId: string, attempt: { tokenId: string; projectId: string; runId: string },
): Bound<{ id: string }, 'write'> {
  return retireEndedAttempt.bind(now, memberId, attempt.tokenId, attempt.projectId, attempt.runId);
}
