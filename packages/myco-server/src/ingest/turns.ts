/**
 * A session's open turn: when it started, and what ends it.
 *
 * A turn starts when the member's prompt hook asks the Deployment for context (`POST /context/prompt`), which it does
 * for every prompt it takes, and ends when the turn's end reaches the Deployment: the transcript the session's own
 * turn-end hook ships (sent with `TURN_END_HEADER`; a transcript any other pass ships, a backlog, a drain, an import,
 * ends nothing), a response, or the session's end. Both instants are the member's own clock, the prompt's from its
 * UUIDv7 id and the end's from the event's `createdAt`:
 *
 * - an end older than the turn's start leaves the turn open, so a turn end drained late from the spool never closes
 *   the next turn;
 * - every end moves the session's `last_turn_end_at`, and a stamp not newer than it opens nothing, so a prompt's stamp
 *   landing after its own turn's end never reopens that turn;
 * - a prompt id whose instant is more than `MAX_CLOCK_SKEW_MS` from the Deployment's clock, either way, opens nothing:
 *   the session reads as Live through its receipts alone, and no instant of the Deployment's clock is ever set against
 *   ends in the member's.
 *
 * A session with an open turn reads as working (`read/sessions.ts`, `WORKING_CAP_MS`).
 */
import type { PreparedStatement, RelationalStore } from '../core/adapters.js';
import { MAX_CLOCK_SKEW_MS } from '../constants.js';
import { TURN_END_HEADER } from '@goondocks/myco-shared/member-protocol';

/** The event kinds that end a turn: a response, and the session's end. A transcript segment ends one only when sent with `TURN_END_HEADER`. */
export const TURN_END_KINDS: ReadonlySet<string> = new Set(['response', 'session.end']);
/** The kind that ends a turn only when its session's own turn-end hook sends it. */
export const TURN_END_SEGMENT_KIND = 'transcript.segment';
export { TURN_END_HEADER };

/** Whether an event ends its session's turn: a response or an end, or the transcript its own turn-end hook sends. Nothing an import carries does. */
export function endsTurn(e: { kind: string; channel: string }, turnEndHeader: boolean): boolean {
  if (e.channel === 'import') return false;
  return TURN_END_KINDS.has(e.kind) || (e.kind === TURN_END_SEGMENT_KIND && turnEndHeader);
}

/**
 * When the turn a prompt id opens started, in the member's clock: the millisecond timestamp of a UUIDv7, which is how
 * the member mints a prompt id. Null for an id that is not a v7, or whose instant is more than `MAX_CLOCK_SKEW_MS` from
 * the Deployment's clock either way: no turn is opened on an instant the member's own ends cannot be weighed against.
 */
export function turnStartedAt(promptId: string, nowMs: number): number | null {
  const hex = promptId.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex) || hex[12] !== '7') return null;
  const at = Number.parseInt(hex.slice(0, 12), 16);
  return Math.abs(at - nowMs) <= MAX_CLOCK_SKEW_MS ? at : null;
}

/**
 * Open a session's turn at `at`, on the machine that holds the session, when no turn end at or after `at` has reached
 * the Deployment: a stamp arriving after its own turn's end opens nothing. The session's recorded end is weighed where
 * the turn is read (`read/sessions.ts`): a turn older than it is no turn, and a session resumed after it is working
 * again, with its end left as it stands. A session the Deployment does not hold yet is left alone: its first turn opens
 * nothing.
 */
export function startTurnStatement(db: RelationalStore, s: { projectId: string; sessionId: string; machineId: string; at: number }): PreparedStatement {
  return db.prepare(
    `UPDATE sessions SET working_since = ?
      WHERE project_id = ? AND session_id = ? AND machine_id = ? AND (last_turn_end_at IS NULL OR last_turn_end_at < ?)`,
  ).bind(s.at, s.projectId, s.sessionId, s.machineId, s.at);
}

/**
 * Record a turn end that happened at `endedAt`, when this request stored the event (`nonce`): it moves the session's
 * `last_turn_end_at`, and closes the open turn unless that turn started after it.
 */
export function endTurnStatement(db: RelationalStore, e: { projectId: string; sessionId: string; eventId: string; endedAt: number; nonce: string }): PreparedStatement {
  return db.prepare(
    `UPDATE sessions SET last_turn_end_at = MAX(COALESCE(last_turn_end_at, 0), ?),
         working_since = CASE WHEN working_since IS NOT NULL AND working_since <= ? THEN NULL ELSE working_since END
      WHERE project_id = ? AND session_id = ?
        AND EXISTS (SELECT 1 FROM events WHERE project_id = ? AND event_id = ? AND ingest_nonce = ?)`,
  ).bind(e.endedAt, e.endedAt, e.projectId, e.sessionId, e.projectId, e.eventId, e.nonce);
}
