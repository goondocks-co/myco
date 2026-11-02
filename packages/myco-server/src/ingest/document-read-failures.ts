import type { ServerEnv } from '../core/adapters.js';
import { recordDocumentPublishFailure } from '../core/attention-state.js';
import { emit, failureTelemetry } from '../telemetry.js';

const DOCUMENT_READ_BACKOFF_MIN_MS = 60_000;
const DOCUMENT_READ_BACKOFF_MAX_MS = 30 * 60_000;
const DOCUMENT_READ_FAILURE_CHARS = 240;

/** A failed document waits while other documents and publisher jobs retain their share. */
export async function deferDocumentReadFailure(db: ServerEnv['db'], doc: { project_id: string; session_id: string; turnKey?: string }, error: unknown, now: number): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : null;
  const detail = (cause === null ? message : `${cause}: ${message}`).slice(0, DOCUMENT_READ_FAILURE_CHARS);
  const failure = /^[a-z][a-z0-9_]{0,63}$/.test(message) ? message : 'document_read_failed';
  emit({ kind: 'document_read_failed', projectId: doc.project_id, sessionId: doc.session_id, error: failure, ...failureTelemetry(error) });
  const deferred = await db.prepare(`UPDATE session_documents SET
      rollup_due=?1+CASE WHEN rollup_failure IS NULL THEN ?2 ELSE MIN(MAX(rollup_due-rollup_checked,?2)*2,?3) END,
      rollup_failure=?4,rollup_checked=MAX(rollup_checked+1,?1)
    WHERE project_id=?5 AND session_id=?6 RETURNING rollup_due`)
    .bind(now, DOCUMENT_READ_BACKOFF_MIN_MS, DOCUMENT_READ_BACKOFF_MAX_MS, detail, doc.project_id, doc.session_id)
    .first<{ rollup_due: number }>();
  if (doc.turnKey !== undefined && deferred !== null) await db.prepare(`UPDATE turn_cards SET settle_at=?
    WHERE project_id=? AND session_id=? AND turn_key=? AND state='pending'`)
    .bind(deferred.rollup_due, doc.project_id, doc.session_id, doc.turnKey).run();
  await recordDocumentPublishFailure(db, { projectId: doc.project_id, sessionId: doc.session_id, failure }, now);
}
