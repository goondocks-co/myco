import type { ServerEnv } from '../core/adapters.js';
import { recordDocumentPublishFailure } from '../core/attention-state.js';
import { emit, failureTelemetry } from '../telemetry.js';

import { deferObservedDocumentRead, type DocumentReadObservation } from '../db/documents/failures.js';
const DOCUMENT_READ_FAILURE_CHARS = 240;

/** A failed document waits while other documents and publisher jobs retain their share. */
export async function deferDocumentReadFailure(db: ServerEnv['db'], doc: DocumentReadObservation, error: unknown, now: number): Promise<boolean> {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : null;
  const detail = (cause === null ? message : `${cause}: ${message}`).slice(0, DOCUMENT_READ_FAILURE_CHARS);
  const failure = /^[a-z][a-z0-9_]{0,63}$/.test(message) ? message : 'document_read_failed';
  const applied = await deferObservedDocumentRead(db, doc, detail, now);
  emit({ kind: applied ? 'document_read_failed' : 'document_read_failure_stale', projectId: doc.project_id, sessionId: doc.session_id, error: failure, ...failureTelemetry(error) });
  if (applied) await recordDocumentPublishFailure(db, { projectId: doc.project_id, sessionId: doc.session_id, failure }, now);
  return applied;
}
