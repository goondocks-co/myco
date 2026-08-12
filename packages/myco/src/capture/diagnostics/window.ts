import type { Database } from 'bun:sqlite';
import type { DiagnosticWindow } from './types.js';

export const WINDOW_PAD_SECONDS = 30 * 60;
/** Expansion never grows the window more than 24h past the initial padded span. */
export const MAX_EXPANSION_SECONDS = 24 * 60 * 60;

/** Thrown by `resolveWindow` when `{sessionId}` names a session that does not
 *  exist. A typed class (not a bare `Error`) so daemon callers can map it to a
 *  404 instead of leaking a raw 500 with the session id embedded in the message. */
export class SessionNotFoundError extends Error {
  constructor(public readonly sessionId: string) {
    super(`session not found: ${sessionId}`);
    this.name = 'SessionNotFoundError';
  }
}

/**
 * Resolve the export window. A session id becomes the session's own span
 * padded ±30min, then expanded ONCE to cover sessions that STARTED inside
 * that padded span — so a duplicate-session pair is always bundled together
 * without the user knowing both ids. Expansion keys on started_at (not
 * overlap) because an active session (ended_at NULL) spans to "now" and
 * would otherwise drag every window across days; growth is additionally
 * capped at MAX_EXPANSION_SECONDS per side. Single pass, not transitive
 * closure.
 */
export function resolveWindow(
  db: Database,
  input: { sessionId: string } | DiagnosticWindow,
): DiagnosticWindow {
  if (!('sessionId' in input)) return { since: input.since, until: input.until };

  const row = db
    .query(`SELECT started_at, ended_at FROM sessions WHERE id = $id`)
    .get({ $id: input.sessionId }) as { started_at: number; ended_at: number | null } | null;
  if (!row) throw new SessionNotFoundError(input.sessionId);

  const now = Math.floor(Date.now() / 1000);
  const since0 = row.started_at - WINDOW_PAD_SECONDS;
  const until0 = (row.ended_at ?? now) + WINDOW_PAD_SECONDS;
  let since = since0;
  let until = until0;

  const startedInside = db
    .query(
      `SELECT started_at, ended_at FROM sessions
       WHERE started_at BETWEEN $since AND $until`,
    )
    .all({ $since: since0, $until: until0 }) as Array<{
    started_at: number;
    ended_at: number | null;
  }>;
  for (const s of startedInside) {
    since = Math.min(since, s.started_at - WINDOW_PAD_SECONDS);
    // an active overlapper extends to "now" but never past the cap
    until = Math.max(until, (s.ended_at ?? now) + WINDOW_PAD_SECONDS);
  }
  return {
    since: Math.max(since, since0 - MAX_EXPANSION_SECONDS),
    until: Math.min(until, until0 + MAX_EXPANSION_SECONDS),
  };
}
