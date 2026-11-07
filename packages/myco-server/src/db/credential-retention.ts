import type { RelationalStore } from '../core/adapters.js';
import { commit, write } from './index.js';

const remove = write<[string, number, number], { id: string }>({
  name: 'credential.pruneRevoked', sql: `DELETE FROM member_credentials
  WHERE id IN (
    SELECT c.id FROM member_credentials c
     WHERE c.member_id = ? AND c.revoked_at IS NOT NULL AND c.revoked_at < ?
       AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.dispatched_by = c.id)
     ORDER BY c.revoked_at ASC LIMIT ?) RETURNING id`,
});

/** Remove revoked credentials of one member older than the cutoff, up to limit. */
export async function pruneRevokedCredentials(db: RelationalStore, memberId: string, cutoffMs: number, limit: number): Promise<number> {
  const [result] = await commit(db, remove.bind(memberId, cutoffMs, limit));
  return result.results.length;
}
