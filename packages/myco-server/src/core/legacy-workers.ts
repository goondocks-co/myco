import type { RelationalStore } from './adapters.js';
import { CONTACT_RECENT_MS } from './worker-contacts.js';
import { LIVE_RUNNER_ADMIN } from '../auth/runners.js';
import { writeGuardBatch } from './write-guard-store.js';

/** Forget only an offline contact, with a live admin and no authoritative assignment at the commit. */
export async function forgetLegacyWorker(db: RelationalStore, actorId: string, credentialId: string, now: number): Promise<boolean> {
  const marker = '$[myco_legacy_worker_forget_refused]';
  const assertion = () => db.prepare(`SELECT CASE WHEN ${LIVE_RUNNER_ADMIN}
    AND EXISTS (SELECT 1 FROM worker_contacts WHERE credential_id = ? AND last_seen_at < ?)
    AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE leased_by = ? AND status = 'running' AND lease_expires_at > ?)
    THEN 1 ELSE json_extract('[]', ?) END AS admitted`).bind(actorId, credentialId, now - CONTACT_RECENT_MS, credentialId, now, marker);
  try {
    await writeGuardBatch(db, assertion, error => { throw error; }, [
      db.prepare(`INSERT INTO legacy_worker_audit(id,credential_id,actor_member,action,last_seen_at,at)
        SELECT ?,credential_id,?,'forgotten',last_seen_at,? FROM worker_contacts WHERE credential_id = ?`)
        .bind(crypto.randomUUID(), actorId, now, credentialId),
      db.prepare('DELETE FROM worker_contacts WHERE credential_id = ?').bind(credentialId),
    ]);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('myco_legacy_worker_forget_refused')) return false;
    throw error;
  }
}
