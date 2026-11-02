import type { ServerEnv } from '../core/adapters.js';
import { recordDocumentPublishFailure } from '../core/attention-state.js';
import { emit } from '../telemetry.js';

const DOCUMENT_READ_BACKOFF_MS = 60_000;

/** A failed document waits while other documents and publisher jobs retain their share. */
export async function deferDocumentReadFailure(db: ServerEnv['db'], doc: { project_id: string; session_id: string; turnKey?: string }, error: unknown, now: number): Promise<void> {
  const failure = error instanceof Error && /^[a-z][a-z0-9_]{0,63}$/.test(error.message) ? error.message : 'unknown';
  emit({ kind: 'document_read_failed', projectId: doc.project_id, sessionId: doc.session_id, error: failure });
  await db.prepare(`UPDATE session_documents SET rollup_due=?,rollup_failure=?,rollup_checked=MAX(rollup_checked+1,?)
    WHERE project_id=? AND session_id=?`).bind(now + DOCUMENT_READ_BACKOFF_MS, failure.slice(0, 240), now, doc.project_id, doc.session_id).run();
  if (doc.turnKey !== undefined) await db.prepare(`UPDATE turn_cards SET settle_at=?
    WHERE project_id=? AND session_id=? AND turn_key=? AND state='pending'`)
    .bind(now + DOCUMENT_READ_BACKOFF_MS, doc.project_id, doc.session_id, doc.turnKey).run();
  await recordDocumentPublishFailure(db, { projectId: doc.project_id, sessionId: doc.session_id, failure: failure.slice(0, 240) }, now);
}
