/**
 * A person's end of a session: one server-origin `session.end` through the
 * ordinary ingest path, so the lifecycle projection, its ordering rule and the
 * titling request apply exactly as they do to an agent's end hook.
 *
 * Decided before anything is written: a session the Project does not hold, or
 * has deleted, is answered as absent rather than opened by the write, and a
 * session already ended is answered with the end that stands. What is answered
 * afterwards is the row as it then reads: a turn or a deletion landing between
 * the read and the write is reported, never papered over.
 */
import type { RelationalStore } from './adapters.js';
import { ingestEvent } from '../ingest/events.js';
import type { ReadScope } from '../read/scope.js';
import { sessionLifecycle } from '../read/sessions.js';
import { SERVER_PROTOCOL } from '../constants.js';

/** What a person's end says produced it. */
export const OWNER_END_PRODUCER = { adapter: 'deployment', version: String(SERVER_PROTOCOL) } as const;

/**
 * How the ask ended. `ended`: this call ended the session. `already_ended`:
 * ended before the call. `open`: the end did not apply, a human turn newer
 * than it having landed, and the session reads open.
 */
export type EndSessionOutcome =
  | { outcome: 'ended'; endedAt: number }
  | { outcome: 'already_ended'; endedAt: number }
  | { outcome: 'open'; endedAt: null };

/** End an open session as member `by`, or answer null for a session the Project does not hold or has deleted, before or during the write. Rejects with the ingest refusal when the write does not land for any other reason. */
export async function endSession(db: RelationalStore, scope: ReadScope, sessionId: string, now: number, by: string): Promise<EndSessionOutcome | null> {
  // The lifecycle columns, never the presented dates: a session shown as finished is still open to an end.
  const before = await sessionLifecycle(db, scope, sessionId);
  if (before === null) return null;
  if (before.endedAt !== null) return { outcome: 'already_ended', endedAt: before.endedAt };
  if (before.machineId === null) throw new Error('the session names no machine, so no end can be attributed to it');
  const result = await ingestEvent(db, { projectId: scope.projectId, machineId: before.machineId, tokenId: before.createdByTokenId, bodyBytes: 0, now, writeOrigin: 'server', actor: by }, {
    eventId: crypto.randomUUID(), sessionId, kind: 'session.end', createdAt: now, channel: 'http', producer: OWNER_END_PRODUCER, payload: { endedAt: now },
  });
  const after = await sessionLifecycle(db, scope, sessionId);
  if (after === null) return null;
  if (!result.persisted) throw new Error(`the session's end was refused: ${result.reason}`);
  return after.endedAt === null ? { outcome: 'open', endedAt: null } : { outcome: after.endedAt === now ? 'ended' : 'already_ended', endedAt: after.endedAt };
}
