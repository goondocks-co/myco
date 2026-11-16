import { observeSpool } from './spool-observations.js';
import fs from 'node:fs';
import path from 'node:path';
import { MemberSpool as DeliverySpool, REFUSED_LOG_FILE, STATE_FILE_SUFFIX, type RefusedEntry } from './spool.js';
import { CaptureLossLedger as DeliveryLossLedger, CAPTURE_LOSS_DAY_MS, CAPTURE_LOSS_DAYS } from './capture-loss.js';
import { assertMemberPathContained, pathIsAbsent, reportSkippedPrivateFile } from './store.js';
import { bufferLockPath, readSessionStateResult, sessionStatePath, type SessionStateRead } from './session-state.js';

/**
 * Whether a line of the refusal log is one `appendRefused` wrote.
 *
 * `eventId` and `kind` are empty for a refusal the drain raises against an
 * unparsable spool line, which names no event; a report carries those as null.
 * Every other field must be there for the line to say anything at all.
 */
function isRefusedEntry(value: unknown): value is RefusedEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  for (const field of ['sessionId', 'code'] as const) {
    if (typeof row[field] !== 'string' || row[field] === '') return false;
  }
  for (const field of ['eventId', 'kind', 'reason'] as const) {
    if (typeof row[field] !== 'string') return false;
  }
  if (row.serverCode !== undefined && typeof row.serverCode !== 'string') return false;
  if (row.held !== undefined) {
    const held = row.held as Record<string, unknown> | null;
    if (held === null || typeof held !== 'object' || typeof held.retryAt !== 'number' || !Number.isFinite(held.retryAt)) return false;
  }
  return typeof row.at === 'number' && Number.isFinite(row.at);
}

/** Read-only observations share the delivery spool's path and lock admission. */
export class MemberSpool extends DeliverySpool {
  readSpool() { return observeSpool(this, { createReadLocks: this.createReadLocks }); }

  /** Strict identity evidence includes fully delivered sessions and refuses incomplete reads. */
  readSessionRoutes(): Array<{ sessionId: string; agent: string }> {
    assertMemberPathContained(this.dir, this.mycoHome);
    if (pathIsAbsent(this.dir)) return [];
    this.assertDestination();
    const ids = fs.readdirSync(this.dir).filter(file => file.endsWith(STATE_FILE_SUFFIX)).map(file => file.slice(0, -STATE_FILE_SUFFIX.length));
    return ids.flatMap(sessionId => {
      const file = sessionStatePath(this.dir, sessionId);
      assertMemberPathContained(file, this.mycoHome);
      assertMemberPathContained(bufferLockPath(this.dir, sessionId), this.mycoHome);
      const read = readSessionStateResult(this.dir, sessionId, { createLock: false });
      if (!read.ok && read.reason === 'missing') return [];
      if (!read.ok) throw new Error(`Session route evidence is ${read.reason}: ${file}`);
      if (read.state.agent === undefined) return [];
      if (typeof read.state.agent !== 'string' || !/^[A-Za-z0-9._-]+$/.test(read.state.agent)) throw new Error(`Session route agent is invalid: ${file}`);
      return [{ sessionId, agent: read.state.agent }];
    });
  }

  /** When this session was first marked as waiting for transcript delivery. */
  transcriptBacklogSince(sessionId: string): number | null {
    const file = this.transcriptBacklogPath(sessionId);
    if (!this.reachable(file)) throw new Error('Transcript waiting mark could not be read');
    try { return fs.statSync(file).mtimeMs; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && pathIsAbsent(file)) return null;
      throw error;
    }
  }

  /**
   * A session's acknowledgement, or the fact that its state could not be read.
   *
   * State is read under the same append lock the records are, so a lock path
   * that is a directory fails here too — before any record is counted. A state
   * file that is not there is a session with no acknowledgement yet.
   */
  readAck(sessionId: string): { readable: true; lastDeliveryAt: number | null } | { readable: false } {
    if (!this.reachable(sessionStatePath(this.dir, sessionId)) || !this.reachable(bufferLockPath(this.dir, sessionId))) return { readable: false };
    let read: SessionStateRead;
    try {
      read = readSessionStateResult(this.dir, sessionId, { createLock: this.createReadLocks });
    } catch {
      return { readable: false };
    }
    if (read.ok) {
      const at = Math.max(read.state.lastAckAt ?? 0, read.state.lastDeliveryAt ?? 0);
      return { readable: true, lastDeliveryAt: at > 0 ? at : null };
    }
    // A state a session has not written yet is one with no acknowledgement.
    return read.reason === 'missing' ? { readable: true, lastDeliveryAt: null } : { readable: false };
  }

  /**
   * The refusal log: what it holds, what it could not hold, and whether it could
   * be read at all.
   *
   * An absent file is `readable` with no refusals — no log is no refusals, and
   * absence is the entry's own, so a link to nothing is a log that could not be
   * read. Any other read failure is `readable: false`, so a log behind a
   * permission or an I/O error never reads as an empty one. Per line, a line that is not JSON or
   * not a JSON object is counted rather than carried: one such line costs that
   * line, and the count says the log is damaged.
   */
  readRefused(): { entries: RefusedEntry[]; unreadableLines: number; readable: boolean } {
    const file = path.join(this.dir, REFUSED_LOG_FILE);
    if (!this.reachable(file)) {
      reportSkippedPrivateFile('refusal log', file, { reason: 'unreadable', detail: 'path unavailable' });
      return { entries: [], unreadableLines: 0, readable: false };
    }
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch (err) {
      // Absence is the entry's own and the read's errno together: a removal a
      // read lost to, or any other failure, is a log that could not be read.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && pathIsAbsent(file)) return { entries: [], unreadableLines: 0, readable: true };
      reportSkippedPrivateFile('refusal log', file, { reason: 'unreadable', detail: (err as Error).message });
      return { entries: [], unreadableLines: 0, readable: false };
    }
    const entries: RefusedEntry[] = [];
    let unreadableLines = 0;
    for (const line of raw.split('\n')) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        unreadableLines += 1;
        continue;
      }
      if (!isRefusedEntry(parsed)) {
        unreadableLines += 1;
        continue;
      }
      entries.push(parsed);
    }
    return { entries, unreadableLines, readable: true };
  }

}

/** Dated reporting is kept off the hook's delivery path. */
export class CaptureLossLedger extends DeliveryLossLedger {
  /** Seven UTC calendar days including today; older ledgers retain their undated totals. */
  recent(now: number) {
    const counts = this.read();
    const today = Math.floor(now / CAPTURE_LOSS_DAY_MS);
    const days = (counts.days ?? []).filter(entry => entry.day > today - CAPTURE_LOSS_DAYS && entry.day <= today);
    return {
      payloads: days.reduce((sum, entry) => sum + entry.payloads, 0),
      plans: days.reduce((sum, entry) => sum + entry.plans, 0),
      records: days.reduce((sum, entry) => sum + entry.records, 0),
      transcripts: days.reduce((sum, entry) => sum + entry.transcripts, 0),
      lastAt: days.length ? Math.max(...days.map(entry => entry.lastAt)) : undefined,
      undated: counts.undated ?? (counts.days === undefined ? counts : { payloads: 0, plans: 0, records: 0, transcripts: 0 }),
    };
  }

}
