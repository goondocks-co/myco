import fs from 'node:fs';
import { attemptCaptureLossRecording, CaptureLossLedger } from './capture-loss.js';
import { withFileLockSync } from '../utils/lifecycle-lock.js';
import { ensurePrivateFile } from './store.js';
import { bufferLockPath, pointersOf, readSessionStateResultUnlocked, writeSessionStateUnlocked } from './session-state.js';
import type { MemberSpool as ObservedSpool } from './capture-observations.js';
import type { MemberSpool } from './spool.js';

interface WaitingCapture { events: boolean; transcripts: boolean; eventAt?: number; transcriptAt?: number; endedAt?: number }

/** Undelivered sessions, counted once even when both delivery lanes have work. */
export function captureQueue(spool: ObservedSpool) {
  const listing = spool.readSpool();
  let readable = listing.readable;
  const events = new Set<string>();
  const transcripts = new Set<string>();
  const dates: number[] = [];
  const waiting = new Map<string, WaitingCapture>();
  let lastDeliveryAt = 0;
  for (const session of listing.sessions) {
    if (session.unacknowledged === null) { readable = false; continue; }
    if (session.unacknowledged === 0) continue;
    events.add(session.sessionId);
    const state = spool.peekSessionState(session.sessionId);
    const records = spool.readRecordsOrNull(session.sessionId);
    const pending = { events: true, transcripts: false, eventAt: Infinity };
    waiting.set(session.sessionId, pending);
    if (!records.readable || (!state.ok && state.reason !== 'missing')) { readable = false; continue; }
    for (const record of records.records.slice(state.ok ? state.state.highWater : 0)) {
      if (record !== null && Number.isFinite(record.createdAt)) { dates.push(record.createdAt); pending.eventAt = Math.min(pending.eventAt, record.createdAt); }
    }
  }
  for (const sessionId of spool.stateSessionIds()) {
    const read = spool.peekSessionState(sessionId);
    if (!read.ok) { readable = false; continue; }
    lastDeliveryAt = Math.max(lastDeliveryAt, read.state.lastDeliveryAt ?? read.state.lastAckAt ?? 0);
    for (const pointer of pointersOf(read.state)) {
      if (pointer.refused !== undefined) continue;
      try {
        const stat = fs.statSync(pointer.path);
        if (stat.size <= pointer.nextOffset) continue;
        transcripts.add(sessionId);
        const pending: WaitingCapture = waiting.get(sessionId) ?? { events: false, transcripts: false };
        pending.transcripts = true;
        pending.transcriptAt = Math.max(pending.transcriptAt ?? 0, stat.mtimeMs, read.state.hookAt ?? 0);
        pending.endedAt = read.state.endedAt;
        waiting.set(sessionId, pending);
        dates.push(spool.transcriptBacklogSince(sessionId) ?? stat.mtimeMs);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') readable = false;
      }
    }
  }
  return { readable, waiting: [...waiting.values()], lastDeliveryAt: lastDeliveryAt || undefined, sessions: new Set([...events, ...transcripts]).size, events: events.size, transcripts: transcripts.size,
    oldestAt: dates.length ? dates.reduce((oldest, at) => Math.min(oldest, at), Infinity) : undefined };
}

/** Count an unavailable transcript once; false leaves accounting queued for another delivery pass. */
export function recordTranscriptUnavailable(spool: MemberSpool, loss: { sessionId: string; transcriptId: string; at: number; error: unknown }): boolean {
  const recorded = attemptCaptureLossRecording(spool.dir, () => {
    const lock = bufferLockPath(spool.dir, loss.sessionId);
    ensurePrivateFile(lock);
    return withFileLockSync(lock, () => {
      const read = readSessionStateResultUnlocked(spool.dir, loss.sessionId);
      if (!read.ok) throw new Error(`Transcript loss receipt unavailable (${read.reason})`);
      const pointer = pointersOf(read.state).find(pointer => pointer.transcriptId === loss.transcriptId);
      if (pointer === undefined || pointer.unavailableAt !== undefined) return;
      if ((loss.error as NodeJS.ErrnoException)?.code === 'ENOENT' && pointer.parsedSize <= pointer.nextOffset) return;
      if (!new CaptureLossLedger(spool.dir, () => loss.at).record([{ key: loss.transcriptId, kind: 'transcript', at: loss.at }])) return false;
      pointer.unavailableAt = loss.at;
      writeSessionStateUnlocked(spool.dir, loss.sessionId, read.state, loss.at);
    }, { wait: false });
  });
  if (!recorded) attemptCaptureLossRecording(spool.dir, () => spool.markTranscriptBacklog(loss.sessionId));
  return recorded;
}
