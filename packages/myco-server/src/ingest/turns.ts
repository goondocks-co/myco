/**
 * A session's open turn: when it started, and what ends it.
 *
 * A turn starts when the member's prompt hook asks the Deployment for context (`POST /context/prompt`), which it does
 * for every prompt it takes, and ends when the turn's end reaches the Deployment: the transcript the turn-end hook
 * ships, a response, or the session's end. Both instants are the member's own clock, the prompt's from its UUIDv7 id
 * and the end's from the event's `createdAt`, so a turn end drained late from the spool, older than the prompt that
 * started the next turn, leaves that turn open. A session with an open turn reads as working
 * (`read/sessions.ts`, `WORKING_CAP_MS`).
 */
import type { PreparedStatement, RelationalStore } from '../core/adapters.js';

/** The event kinds that end a turn: the transcript the turn-end hook ships, a response, and the session's end. */
export const TURN_END_KINDS: ReadonlySet<string> = new Set(['transcript.segment', 'response', 'session.end']);

/** How far a prompt id's own instant may stand from the Deployment's clock before it is not taken as the turn's start. */
const PROMPT_CLOCK_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/**
 * When the turn a prompt id opens started, in the member's clock: the millisecond timestamp of a UUIDv7, which is
 * how the member mints a prompt id. `nowMs` stands in for an id that is not a v7, or whose instant is a day or more
 * from the Deployment's clock.
 */
export function turnStartedAt(promptId: string, nowMs: number): number {
  const hex = promptId.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex) || hex[12] !== '7') return nowMs;
  const at = Number.parseInt(hex.slice(0, 12), 16);
  return Math.abs(at - nowMs) < PROMPT_CLOCK_TOLERANCE_MS ? at : nowMs;
}

/**
 * Open a session's turn at `at`, on the machine that holds the session, when no end is recorded or the recorded end is
 * older than the turn: a session resumed after its end is working again, and its recorded end stands. A session the
 * Deployment does not hold yet is left alone: its first turn opens nothing.
 */
export function startTurnStatement(db: RelationalStore, s: { projectId: string; sessionId: string; machineId: string; at: number }): PreparedStatement {
  return db.prepare(
    `UPDATE sessions SET working_since = ?
      WHERE project_id = ? AND session_id = ? AND machine_id = ? AND (ended_at IS NULL OR ended_at < ?)`,
  ).bind(s.at, s.projectId, s.sessionId, s.machineId, s.at);
}

/**
 * Close a session's turn by an end that happened at `endedAt`, when this request stored the event (`nonce`). A turn
 * that started after the end is left open: the end belongs to an earlier turn.
 */
export function endTurnStatement(db: RelationalStore, e: { projectId: string; sessionId: string; eventId: string; endedAt: number; nonce: string }): PreparedStatement {
  return db.prepare(
    `UPDATE sessions SET working_since = NULL
      WHERE project_id = ? AND session_id = ? AND working_since IS NOT NULL AND working_since <= ?
        AND EXISTS (SELECT 1 FROM events WHERE project_id = ? AND event_id = ? AND ingest_nonce = ?)`,
  ).bind(e.projectId, e.sessionId, e.endedAt, e.projectId, e.eventId, e.nonce);
}
