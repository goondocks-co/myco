import fs from 'node:fs';
import { recordSessionLoss } from './capture-loss.js';
import { pointersOf, updateSessionState } from './session-state.js';
import type { MemberSpool as ObservedSpool } from './capture-observations.js';
import type { MemberSpool } from './spool.js';

/** Undelivered sessions, counted once even when both delivery lanes have work. */
export function captureQueue(spool: ObservedSpool) {
  const listing = spool.readSpool();
  let readable = listing.readable;
  const events = new Set<string>();
  const transcripts = new Set<string>();
  const dates: number[] = [];
  for (const session of listing.sessions) {
    if (session.unacknowledged === null) { readable = false; continue; }
    if (session.unacknowledged === 0) continue;
    events.add(session.sessionId);
    const state = spool.peekSessionState(session.sessionId);
    const records = spool.readRecordsOrNull(session.sessionId);
    if (!records.readable || (!state.ok && state.reason !== 'missing')) { readable = false; continue; }
    for (const record of records.records.slice(state.ok ? state.state.highWater : 0)) {
      if (record !== null && Number.isFinite(record.createdAt)) dates.push(record.createdAt);
    }
  }
  for (const sessionId of spool.stateSessionIds()) {
    const read = spool.peekSessionState(sessionId);
    if (!read.ok) { readable = false; continue; }
    for (const pointer of pointersOf(read.state)) {
      if (pointer.refused !== undefined) continue;
      try {
        const stat = fs.statSync(pointer.path);
        if (stat.size <= pointer.nextOffset) continue;
        transcripts.add(sessionId);
        dates.push(spool.transcriptBacklogSince(sessionId) ?? stat.mtimeMs);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') readable = false;
      }
    }
  }
  return { readable, sessions: new Set([...events, ...transcripts]).size, events: events.size, transcripts: transcripts.size,
    oldestAt: dates.length ? dates.reduce((oldest, at) => Math.min(oldest, at), Infinity) : undefined };
}

/** The pointer's receipt makes repeated delivery passes count one degraded transcript. */
export function recordTranscriptUnavailable(spool: MemberSpool, sessionId: string, transcriptId: string, now: number): void {
  updateSessionState(spool.dir, sessionId, state => {
    const pointer = pointersOf(state).find(pointer => pointer.transcriptId === transcriptId);
    if (pointer === undefined || pointer.unavailableAt !== undefined) return;
    recordSessionLoss(state, transcriptId, 'transcript', now);
    pointer.unavailableAt = now;
  }, now);
}
