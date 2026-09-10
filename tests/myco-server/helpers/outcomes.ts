import type { IngestResult } from '@myco-server-worker/ingest/events.js';
import type { RefreshResult } from '@myco-server-worker/auth/tokens.js';

/**
 * The refusal an ingest answered with, narrowed through its own `persisted`
 * discriminant. A write that landed throws with the outcome, so a case that
 * expected a refusal names what it got instead of reading a field off a union.
 */
export function refused(result: IngestResult): Extract<IngestResult, { persisted: false }> {
  if (result.persisted) {
    throw new Error(`the ingest persisted: ${JSON.stringify(result)}`);
  }
  return result;
}

/** The successor a refresh minted, narrowed through its own `refreshed` discriminant. */
export function refreshed(result: RefreshResult): Extract<RefreshResult, { refreshed: true }> {
  if (!result.refreshed) {
    throw new Error(`the refresh was declined: ${JSON.stringify(result)}`);
  }
  return result;
}
