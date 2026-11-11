/** A session's open turn as its row records it: when it started, and when its last turn ended. The rules that decide these instants live with the capture rules (`ingest/turns.ts`). */
import { write, type Bound } from '../index.js';

const OPENS = `project_id = ?2 AND session_id = ?3 AND machine_id = ?4 AND (last_turn_end_at IS NULL OR last_turn_end_at < ?1)
        AND (working_since IS NULL OR working_since < ?1)`;
const stored = (project: string, event: string, nonce: string) => `EXISTS (SELECT 1 FROM events WHERE project_id = ${project} AND event_id = ${event} AND ingest_nonce = ${nonce})`;

const start = write<[at: number, project: string, session: string, machine: string]>({ name: 'sessions.startTurn', sql:
  `UPDATE sessions SET working_since = ?1 WHERE ${OPENS}` });
const startFromEvent = write<[at: number, project: string, session: string, machine: string, event: string, nonce: string]>({ name: 'sessions.startTurnFromEvent', sql:
  `UPDATE sessions SET working_since = ?1 WHERE ${OPENS} AND ${stored('?2', '?5', '?6')}` });
const end = write<[endedAt: number, project: string, session: string, event: string, nonce: string]>({ name: 'sessions.endTurn', sql:
  `UPDATE sessions SET last_turn_end_at = MAX(COALESCE(last_turn_end_at, 0), ?1),
       working_since = CASE WHEN working_since IS NOT NULL AND working_since <= ?1 THEN NULL ELSE working_since END
    WHERE project_id = ?2 AND session_id = ?3 AND ${stored('?2', '?4', '?5')}` });

/**
 * Open a session's turn at `at`, on the machine that holds the session, when no turn end at or after `at` has reached
 * the Deployment: a stamp arriving after its own turn's end opens nothing. The session's recorded end is weighed where
 * the turn is read (`read/catalog/sessions.ts`): a turn older than it is no turn, and a session resumed after it is working
 * again, with its end left as it stands. A session the Deployment does not hold yet is left alone: its first turn opens
 * nothing.
 */
export function startTurn(s: { projectId: string; sessionId: string; machineId: string; at: number }): Bound {
  return start.bind(s.at, s.projectId, s.sessionId, s.machineId);
}

/**
 * The same opening, from a `turn` start this request stored (`nonce`): a duplicate delivery of the event, which stores
 * nothing, opens nothing again.
 */
export function startTurnFromEvent(s: { projectId: string; sessionId: string; machineId: string; at: number; eventId: string; nonce: string }): Bound {
  return startFromEvent.bind(s.at, s.projectId, s.sessionId, s.machineId, s.eventId, s.nonce);
}

/**
 * Record a turn end that happened at `endedAt`, when this request stored the event (`nonce`): it moves the session's
 * `last_turn_end_at`, and closes the open turn unless that turn started after it.
 */
export function endTurn(e: { projectId: string; sessionId: string; eventId: string; endedAt: number; nonce: string }): Bound {
  return end.bind(e.endedAt, e.projectId, e.sessionId, e.eventId, e.nonce);
}
