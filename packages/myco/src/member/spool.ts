/**
 * The member spool: a write-ahead `EventBuffer` per session under
 * `<MYCO_HOME>/member/spool/<projectId>/`, one drain implementation with a
 * per-session lease and a high-water mark, the per-project offline latch, and
 * the refusal diagnostic log.
 *
 * A hook appends its envelope(s) first and drains second; the live send is the
 * drain's first iteration, so a hook the harness kills leaves a durable copy.
 * Spool records are the wire envelope plus member-private sidecars
 * (`_memberProtocol`, `_blobSource`) that never reach the wire; blob bytes are
 * never spooled — the drain re-reads them from the staged source.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventBuffer, listBufferSessionIds } from '../capture/buffer.js';
import { resolveMycoHome } from '../paths/home.js';
import { LifecycleLock, withFileLockSync } from '../utils/lifecycle-lock.js';
import { canStartRequest, clippedRequestBudget, longestDeclaredHookTimeoutMs, type HookBudget } from './budget.js';
import {
  isProjectId, MEMBER_FILE_MODE, MEMBER_PROTOCOL, OFFLINE_BACKOFF_INITIAL_MS, OFFLINE_BACKOFF_MAX_MS, REFUSAL_RETRY_MAX_MS, REFUSAL_SUBJECT, refusalPermanent,
  REFUSED_LOG_MAX_BYTES, UNCLASSIFIED_REFUSAL_HOLD_HOURS, UNCLASSIFIED_REFUSAL_HOLD_MS, type MemberCode,
} from './constants.js';
import type { BlobSource, BlobStager, MemberEnvelope, OutboundEvent } from './envelope.js';
import { REJOIN_HINT } from './delivery-notice.js';
import {
  bufferLockPath, deferAfterRefusal, readSessionState, readSessionStateResult, readSessionStateUnlocked, retryWaiting, sessionStatePath, updateSessionState,
  writeSessionStateUnlocked, type SessionState, type SessionStateRead,
} from './session-state.js';
import { assertMemberPathContained, ensureMemberDir, ensurePrivateFile, memberRoot, pathIsAbsent, readPrivateJson, reportSkippedPrivateFile, writePrivateFileAtomic } from './store.js';
import type { ClientRecord, Outcome, ServerClient } from './transport.js';

export const SPOOL_DIRNAME = 'spool';
export const BLOBS_DIRNAME = 'blobs';
export const OFFLINE_LATCH_FILE = 'offline.json';
export const REFUSED_LOG_FILE = 'refused.jsonl';
const DRAIN_LEASE_SUFFIX = '.drain.lock';
/** Suffix of the marker naming a session whose transcripts may hold bytes the Deployment has not acknowledged. */
const TRANSCRIPT_BACKLOG_SUFFIX = '.transcript-backlog';
/** Suffix of a session's state file, the sibling of its spool file. */
const STATE_FILE_SUFFIX = '.state.json';
/** The code the Deployment answers an event whose blob it does not hold. */
const BLOB_ABSENT_CODE: MemberCode = 'blob_absent';

/** The seven envelope fields; nothing else leaves the spool. */
export const WIRE_FIELDS = ['eventId', 'sessionId', 'kind', 'createdAt', 'channel', 'producer', 'payload'] as const;

/** A spool line: the envelope plus the member-private sidecars. */
export interface SpoolRecord extends MemberEnvelope {
  _memberProtocol: number;
  _blobSource?: BlobSource;
}

export interface OfflineLatch {
  since: number;
  nextProbeAt: number;
  backoffMs: number;
}

export interface RefusedEntry {
  eventId: string;
  sessionId: string;
  kind: string;
  code: MemberCode;
  reason: string;
  at: number;
  /** Set when the record stays spooled for a later pass rather than being dropped, with when a backlog walk may send it again. Logged once per held record. */
  held?: { retryAt: number };
}

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
  if (row.held !== undefined) {
    const held = row.held as Record<string, unknown> | null;
    if (held === null || typeof held !== 'object' || typeof held.retryAt !== 'number' || !Number.isFinite(held.retryAt)) return false;
  }
  return typeof row.at === 'number' && Number.isFinite(row.at);
}

/** The records a spool's bytes hold; a torn line reads as null. */
function parseSpoolLines(raw: string): Array<SpoolRecord | null> {
  const records: Array<SpoolRecord | null> = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as SpoolRecord);
    } catch {
      records.push(null);
    }
  }
  return records;
}

/** `refused` and `unreadable` end a pass that holds a record of the session's own: a refusal of it for now, or staged bytes that could not be read. */
export type DrainEnd = Outcome['class'] | 'budget' | 'protocol_mismatch' | 'drained' | 'unreadable';
/** Pass endings that hold a record of the session's own and say nothing about any other session. */
export const HOLD_ENDS: readonly DrainEnd[] = ['refused', 'unreadable'];

export interface DrainResult {
  sessionId: string;
  /** `deferred`: the session's events wait out a transient refusal, and the caller asked that the wait be honoured. */
  skipped?: 'lease' | 'latched' | 'never-drains' | 'deferred';
  sent: number;
  acked: number;
  refused: number;
  /** Records still un-acknowledged after the pass. */
  remaining: number;
  endedBy: DrainEnd;
}

export interface DrainOptions {
  /** Dial even while the offline latch is set (Stop/SessionEnd probe; `myco member drain`). */
  force?: boolean;
  now?: () => number;
  /** Called once per pass on a 401 without the protocol header; a new client record retries the record once. */
  onUnauthorized?: () => Promise<ClientRecord | null>;
  /** Builds a client from a record; used after `onUnauthorized` supplies a new one. */
  clientFor?: (record: ClientRecord) => ServerClient;
  /** Pass over a session whose events wait out a transient refusal. A backlog walk honours the wait; a session's own hooks and an explicit drain send regardless. */
  honourRetry?: boolean;
}

/**
 * The directory a project's spool lives in.
 *
 * The id names one directory under the spool root and never a path: it must be
 * a project id, and the joined path must resolve to a direct child of that root.
 * Both hold before any directory is made, so a caller that only reads is bound
 * by the same containment as one that writes.
 */
export function spoolDirFor(projectId: string, mycoHome: string = resolveMycoHome()): string {
  const spoolRoot = path.join(memberRoot(mycoHome), SPOOL_DIRNAME);
  const dir = path.join(spoolRoot, projectId);
  const rel = path.relative(spoolRoot, path.resolve(dir));
  if (!isProjectId(projectId) || rel === '' || path.isAbsolute(rel) || rel.split(path.sep).length !== 1) {
    throw new Error(`spoolDirFor: ${projectId} does not name a project's spool under ${spoolRoot}`);
  }
  return dir;
}

/** The wire envelope of a spool record: the seven fields, nothing member-private, no buffer timestamp. */
export function toWire(record: SpoolRecord): MemberEnvelope {
  const out: Record<string, unknown> = {};
  for (const field of WIRE_FIELDS) out[field] = record[field];
  return out as unknown as MemberEnvelope;
}

/** What a report says of a path it could not hold to the member root: the check refuses a link out, a component it could not read, and one that is not a directory alike. */
const UNAVAILABLE_PATH = 'path unavailable';

const stderr = (line: string): void => { process.stderr.write(`[myco] member: ${line}\n`); };

export class MemberSpool {
  readonly dir: string;
  readonly blobsDir: string;
  /** The home this spool lives under; retention ages that home and no other. */
  readonly mycoHome: string;

  /**
   * `initialize` false skips creating the spool's directories, so a caller that
   * only reads can be built against a layout that is broken — a file where the
   * directory belongs — and report it. It is not a read-only spool: the writing
   * methods write and create their required directories.
   */
  constructor(readonly projectId: string, opts: { mycoHome?: string; initialize?: boolean } = {}) {
    this.mycoHome = opts.mycoHome ?? resolveMycoHome();
    this.dir = spoolDirFor(projectId, this.mycoHome);
    this.blobsDir = path.join(this.dir, BLOBS_DIRNAME);
    if (opts.initialize === false) return;
    ensureMemberDir(this.dir, this.mycoHome);
    ensureMemberDir(this.blobsDir, this.mycoHome);
  }

  /** The blob staging dir of one session: staged bytes belong to the session that staged them. */
  blobsDirFor(sessionId: string): string {
    return path.join(this.blobsDir, sessionId);
  }

  /**
   * Whether a report may touch `target`: it must resolve under the member
   * root with its links read, so neither the read nor the lock the read takes
   * reaches a file outside it. A link out, a component that could not be read
   * and one that is not a directory all answer false here, before anything is
   * opened or created.
   */
  private reachable(target: string): boolean {
    try {
      assertMemberPathContained(target, this.mycoHome);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A stager for one session: bytes land in `blobs/<sessionId>/<sha256>`
   * (0600) for the drain to upload. Staging is per session, not per project,
   * so the drain can delete a record's bytes the moment the record is
   * acknowledged — with one project-wide dir, two sessions staging identical
   * bytes would share a file and the first drain would delete it under the
   * second, whose upload would then answer `blob_absent`.
   */
  stagerFor(sessionId: string): BlobStager {
    const dir = this.blobsDirFor(sessionId);
    return (bytes, mediaType) => {
      ensureMemberDir(dir, this.mycoHome);
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const file = path.join(dir, sha256);
      if (fs.existsSync(file)) {
        // Content-addressed, so the bytes are already right — but the mtime is
        // what says "a hook may still name this", and reclaiming reads it. A
        // second staging of the same sha restarts that clock, or the grace
        // could expire while the hook that just staged it is still running.
        const now = new Date();
        try { fs.utimesSync(file, now, now); } catch { /* vanished under us; the write below is not worth racing */ }
      } else {
        fs.writeFileSync(file, bytes, { mode: MEMBER_FILE_MODE });
      }
      return { path: file, sha256, mediaType, size: bytes.byteLength };
    };
  }

  private spoolFile(sessionId: string): string {
    return path.join(this.dir, `${sessionId}.jsonl`);
  }

  private leasePath(sessionId: string): string {
    return path.join(this.dir, `.${sessionId}${DRAIN_LEASE_SUFFIX}`);
  }

  /** The session's buffer with its lock companion and file pre-created 0600. */
  private buffer(sessionId: string): EventBuffer {
    ensurePrivateFile(bufferLockPath(this.dir, sessionId));
    ensurePrivateFile(this.spoolFile(sessionId));
    return new EventBuffer(this.dir, sessionId);
  }

  /** Write-ahead: append one record before anything is sent. */
  append(sessionId: string, out: OutboundEvent): void {
    this.appendAndRecord(sessionId, [out]);
  }

  /**
   * The commit point. The events and the state that records them having been
   * captured land together, under ONE hold of the session's buffer lock.
   *
   * A handler that derives an event also writes its receipt — the prompt hash,
   * the plan hash, the attachment key, the transcript's parsed size — and
   * nothing re-derives an event whose receipt is already on disk. Writing the
   * receipt before the append therefore makes a crash between the two a
   * permanent loss, not a retry: the rerun reads the receipt, derives nothing,
   * and the event exists nowhere. Appending first and recording in the same
   * locked section makes the durable copy the thing that cannot be missing.
   */
  appendAndRecord(sessionId: string, events: readonly OutboundEvent[], record?: (state: SessionState) => void, now: number = Date.now()): void {
    if (events.length === 0 && !record) return;
    const lock = bufferLockPath(this.dir, sessionId);
    const file = this.spoolFile(sessionId);
    ensurePrivateFile(lock);
    // A receipt with nothing to append leaves no spool file behind: an empty file would read as a session with records to drain.
    if (events.length > 0) ensurePrivateFile(file);
    withFileLockSync(lock, () => {
      for (const out of events) {
        const line: SpoolRecord & { timestamp: string } = {
          ...out.envelope,
          _memberProtocol: MEMBER_PROTOCOL,
          ...(out.blobSource ? { _blobSource: out.blobSource } : {}),
          timestamp: new Date(now).toISOString(),
        };
        fs.appendFileSync(file, JSON.stringify(line) + '\n', { mode: MEMBER_FILE_MODE });
      }
      const state = readSessionStateUnlocked(this.dir, sessionId);
      if (state.startedAt === undefined) state.startedAt = now;
      record?.(state);
      writeSessionStateUnlocked(this.dir, sessionId, state, now);
      // Write-ahead, with the pointer that names the bytes: a hook killed
      // before its transcript pass still leaves the session in the backlog.
      if (state.transcript !== undefined || Object.keys(state.siblings).length > 0) this.markTranscriptBacklog(sessionId);
    });
  }

  // ---------------------------------------------------------------------------
  // Transcript backlog
  // ---------------------------------------------------------------------------

  private transcriptBacklogPath(sessionId: string): string {
    return path.join(this.dir, `.${sessionId}${TRANSCRIPT_BACKLOG_SUFFIX}`);
  }

  /** Name the session as one whose transcripts may hold bytes not yet acknowledged. The session state's pointers say which bytes. */
  markTranscriptBacklog(sessionId: string): void {
    ensurePrivateFile(this.transcriptBacklogPath(sessionId));
  }

  /** The session's transcripts are acknowledged to their end, or their files are gone. */
  clearTranscriptBacklog(sessionId: string): void {
    try { fs.unlinkSync(this.transcriptBacklogPath(sessionId)); } catch { /* not marked */ }
  }

  hasTranscriptBacklog(sessionId: string): boolean {
    return fs.existsSync(this.transcriptBacklogPath(sessionId));
  }

  /** Every session marked as holding transcript bytes not yet acknowledged. */
  transcriptBacklogIds(): string[] {
    if (!this.reachable(this.dir)) return [];
    try {
      return fs.readdirSync(this.dir)
        .filter((file) => file.startsWith('.') && file.endsWith(TRANSCRIPT_BACKLOG_SUFFIX))
        .map((file) => file.slice(1, -TRANSCRIPT_BACKLOG_SUFFIX.length));
    } catch {
      return [];
    }
  }

  /** Run `fn` holding the session's drain lease; null, without running it, when another process holds the lease. */
  async withSessionLease<T>(sessionId: string, fn: () => Promise<T>): Promise<T | null> {
    ensurePrivateFile(this.leasePath(sessionId));
    const lease = LifecycleLock.acquire(this.leasePath(sessionId), { command: 'myco member drain' });
    if (!lease.acquired) return null;
    try {
      return await fn();
    } finally {
      lease.lock.release();
    }
  }

  /** Session ids with a spool file. */
  sessionIds(): string[] {
    return listBufferSessionIds(this.dir).filter((id) => id !== path.basename(REFUSED_LOG_FILE, '.jsonl'));
  }

  /**
   * Session ids with a state file. A fully delivered session keeps its state
   * after the drain deletes its spool file, so the acknowledgement it records
   * is only reachable through this set.
   */
  stateSessionIds(): string[] {
    if (!this.reachable(this.dir)) return [];
    try {
      return fs.readdirSync(this.dir)
        .filter((file) => file.endsWith(STATE_FILE_SUFFIX))
        .map((file) => file.slice(0, -STATE_FILE_SUFFIX.length));
    } catch {
      return [];
    }
  }

  /** Every record of the session's spool, read under the append lock; a torn line reads as null. A spool that is not there is empty; a lock this process cannot take still throws, as every writer here does. */
  readRecords(sessionId: string): Array<SpoolRecord | null> {
    const file = this.spoolFile(sessionId);
    const lock = bufferLockPath(this.dir, sessionId);
    ensurePrivateFile(lock);
    return withFileLockSync(lock, () => {
      let raw: string;
      try {
        raw = fs.readFileSync(file, 'utf-8');
      } catch {
        return [];
      }
      return parseSpoolLines(raw);
    });
  }

  /**
   * Every record of the session's spool, or the fact that it could not be read.
   *
   * The whole read answers, the lock it is taken under included: a lock path
   * that is a directory, a spool that is one, a file or lock that leads outside
   * the member root, and a file that goes away between the listing and the read
   * all report rather than throw. The caller names a session the listing just
   * held a file for, so a file that is no longer there is one the read lost,
   * not an empty spool.
   */
  readRecordsOrNull(sessionId: string): { readable: true; records: Array<SpoolRecord | null> } | { readable: false } {
    try {
      const file = this.spoolFile(sessionId);
      const lock = bufferLockPath(this.dir, sessionId);
      if (!this.reachable(file) || !this.reachable(lock)) return { readable: false };
      ensurePrivateFile(lock);
      return withFileLockSync(lock, () => {
        let raw: string;
        try {
          raw = fs.readFileSync(file, 'utf-8');
        } catch {
          return { readable: false as const };
        }
        return { readable: true as const, records: parseSpoolLines(raw) };
      });
    } catch {
      return { readable: false };
    }
  }

  /**
   * A session's acknowledgement, or the fact that its state could not be read.
   *
   * State is read under the same append lock the records are, so a lock path
   * that is a directory fails here too — before any record is counted. A state
   * file that is not there is a session with no acknowledgement yet.
   */
  readAck(sessionId: string): { readable: true; lastAckAt: number | null } | { readable: false } {
    if (!this.reachable(sessionStatePath(this.dir, sessionId)) || !this.reachable(bufferLockPath(this.dir, sessionId))) return { readable: false };
    let read: SessionStateRead;
    try {
      read = readSessionStateResult(this.dir, sessionId);
    } catch {
      return { readable: false };
    }
    if (read.ok) return { readable: true, lastAckAt: read.state.lastAckAt ?? null };
    // A state a session has not written yet is one with no acknowledgement.
    return read.reason === 'missing' ? { readable: true, lastAckAt: null } : { readable: false };
  }

  /** The spool as a report reads it: a directory nothing could read carries `readable: false`, and a session whose own file could not be read carries a null depth. */
  readSpool(): { readable: boolean; sessions: Array<{ sessionId: string; unacknowledged: number | null }> } {
    if (!this.reachable(this.dir)) return { readable: false, sessions: [] };
    let names: string[];
    try {
      names = fs.readdirSync(this.dir).filter((name) => name.endsWith('.jsonl'));
    } catch (err) {
      // A spool a member has not written yet is empty, not unreadable — and
      // absence is the directory's own, so a link to nothing, or a directory
      // the listing lost, is a spool that could not be read.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && pathIsAbsent(this.dir)) return { readable: true, sessions: [] };
      return { readable: false, sessions: [] };
    }
    const refusedLog = path.basename(REFUSED_LOG_FILE, '.jsonl');
    const sessions = names
      .map((name) => path.basename(name, '.jsonl'))
      .filter((sessionId) => sessionId !== refusedLog)
      .map((sessionId) => {
        const read = this.readRecordsOrNull(sessionId);
        if (!read.readable) return { sessionId, unacknowledged: null };
        // The count is records against the acknowledged mark, so a state the
        // report cannot use leaves it unknown rather than counting from zero.
        let state: SessionStateRead;
        try {
          state = readSessionStateResult(this.dir, sessionId);
        } catch {
          return { sessionId, unacknowledged: null };
        }
        if (!state.ok) return { sessionId, unacknowledged: state.reason === 'missing' ? read.records.length : null };
        return { sessionId, unacknowledged: Math.max(0, read.records.length - state.state.highWater) };
      });
    return { readable: true, sessions };
  }

  /** Un-acknowledged records in the session's spool. */
  depth(sessionId: string): number {
    const records = this.readRecords(sessionId);
    const state = readSessionState(this.dir, sessionId);
    return Math.max(0, records.length - state.highWater);
  }

  // ---------------------------------------------------------------------------
  // Offline latch
  // ---------------------------------------------------------------------------

  private latchPath(): string {
    return path.join(this.dir, OFFLINE_LATCH_FILE);
  }

  /**
   * The latch, or the fact that its file could not be used.
   *
   * A latch that is not there is no latch: readable, with none held. A mode
   * refusal, an unparsable file or one that is not a latch is unreadable. The
   * one parse and shape check; `readLatch` derives from it.
   */
  readLatchResult(): { readable: true; latch: OfflineLatch | null } | { readable: false; reason: 'unreadable' | 'loose-mode' | 'malformed' | 'invalid'; detail?: string } {
    if (!this.reachable(this.latchPath())) return { readable: false, reason: 'unreadable', detail: UNAVAILABLE_PATH };
    const read = readPrivateJson<OfflineLatch>(this.latchPath());
    if (!read.ok) {
      return read.reason === 'missing' ? { readable: true, latch: null } : { readable: false, reason: read.reason, detail: read.detail };
    }
    // Runtime latches accept numeric fields; reports check renderability separately.
    const l = read.value as unknown;
    const shaped = l !== null && typeof l === 'object' && !Array.isArray(l)
      && ['since', 'nextProbeAt', 'backoffMs'].every((field) => typeof (l as Record<string, unknown>)[field] === 'number');
    return shaped ? { readable: true, latch: l as OfflineLatch } : { readable: false, reason: 'invalid', detail: 'not an offline latch' };
  }

  /** The latch held, or null where none is: a file that could not be used reads as none, a mode or parse refusal with one stderr line. */
  readLatch(): OfflineLatch | null {
    const read = this.readLatchResult();
    if (read.readable) return read.latch;
    if (read.reason !== 'invalid') reportSkippedPrivateFile('offline latch', this.latchPath(), read);
    return null;
  }

  /** True when a hook may dial: no latch, the probe time has come, or the caller forces a probe. */
  shouldDial(now: number, force = false): boolean {
    if (force) return true;
    const latch = this.readLatch();
    return latch === null || now >= latch.nextProbeAt;
  }

  /** Set or extend the latch: 30 s, doubling to 10 min; a server `retry-after` stretches the probe at least that far. */
  markOffline(now: number, retryAfterMs?: number): OfflineLatch {
    const existing = this.readLatch();
    const backoffMs = existing === null ? OFFLINE_BACKOFF_INITIAL_MS : Math.min(existing.backoffMs * 2, OFFLINE_BACKOFF_MAX_MS);
    const latch: OfflineLatch = { since: existing?.since ?? now, nextProbeAt: now + Math.max(backoffMs, retryAfterMs ?? 0), backoffMs };
    writePrivateFileAtomic(this.latchPath(), JSON.stringify(latch));
    return latch;
  }

  clearLatch(): void {
    try { fs.unlinkSync(this.latchPath()); } catch { /* not latched */ }
  }

  // ---------------------------------------------------------------------------
  // Refusal log
  // ---------------------------------------------------------------------------

  private refusedPath(): string {
    return path.join(this.dir, REFUSED_LOG_FILE);
  }

  /** Append one refusal; the log is truncated when it would grow past its cap. Never a payload. */
  appendRefused(entry: RefusedEntry): void {
    const file = this.refusedPath();
    ensurePrivateFile(file);
    const line = JSON.stringify({
      eventId: entry.eventId, sessionId: entry.sessionId, kind: entry.kind, code: entry.code, reason: entry.reason, at: entry.at,
      ...(entry.held === undefined ? {} : { held: { retryAt: entry.held.retryAt } }),
    }) + '\n';
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* created above */ }
    if (size + Buffer.byteLength(line) > REFUSED_LOG_MAX_BYTES) fs.writeFileSync(file, '', { mode: MEMBER_FILE_MODE });
    fs.appendFileSync(file, line, { mode: MEMBER_FILE_MODE });
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
    const file = this.refusedPath();
    if (!this.reachable(file)) {
      reportSkippedPrivateFile('refusal log', file, { reason: 'unreadable', detail: UNAVAILABLE_PATH });
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

  // ---------------------------------------------------------------------------
  // Drain
  // ---------------------------------------------------------------------------

  /**
   * Upload a staged blob. `gone` when nothing is at the source any more (the
   * event is sent without it, and the Deployment answers `blob_absent` unless
   * it already holds the bytes); `unreadable` when the bytes may be there but
   * could not be read.
   */
  private async uploadBlob(client: ServerClient, source: BlobSource, budget: HookBudget, now: () => number, uploaded: Set<string>): Promise<Outcome | 'gone' | 'unreadable'> {
    if (uploaded.has(source.sha256)) return { class: 'acked', body: {} };
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(source.path);
    } catch {
      return pathIsAbsent(source.path) ? 'gone' : 'unreadable';
    }
    const outcome = await client.postBlob(bytes, source.sha256, source.mediaType, clippedRequestBudget(budget, now()));
    if (outcome.class === 'acked') uploaded.add(source.sha256);
    return outcome;
  }

  /**
   * One drain pass over a session's spool under the session lease, in spool
   * order. The high-water advances on `acked` and on a refusal final for the
   * record. Any other refusal holds the record, and every record after it, for
   * a later pass: the pass ends `refused`, and the session's wait starts or
   * lengthens.
   */
  async drainSession(sessionId: string, client: ServerClient, budget: HookBudget, opts: DrainOptions = {}): Promise<DrainResult> {
    const now = opts.now ?? Date.now;
    const result: DrainResult = { sessionId, sent: 0, acked: 0, refused: 0, remaining: 0, endedBy: 'drained' };
    if (!budget.drains) return { ...result, skipped: 'never-drains', remaining: this.depth(sessionId) };
    if (!this.shouldDial(now(), opts.force)) return { ...result, skipped: 'latched', remaining: this.depth(sessionId) };
    if (opts.honourRetry === true && retryWaiting(readSessionState(this.dir, sessionId).eventRetry, now())) return { ...result, skipped: 'deferred', remaining: this.depth(sessionId) };
    ensurePrivateFile(this.leasePath(sessionId));
    const lease = LifecycleLock.acquire(this.leasePath(sessionId), { command: 'myco member drain' });
    if (!lease.acquired) return { ...result, skipped: 'lease', remaining: this.depth(sessionId) };

    try {
      const records = this.readRecords(sessionId);
      let i = readSessionState(this.dir, sessionId).highWater;
      const uploaded = new Set<string>();
      let sawUnauthorized = false;
      let retriedAfterUnauthorized = false;
      let activeClient = client;
      // How many records still reference each staged blob; the last one to be
      // drained releases the bytes. Without the count a repeat sha would be
      // unlinked under a record that has not been sent yet.
      const staged = new Map<string, number>();
      for (const record of records) {
        if (record?._blobSource) staged.set(record._blobSource.sha256, (staged.get(record._blobSource.sha256) ?? 0) + 1);
      }
      const settled = now() - longestDeclaredHookTimeoutMs();
      const release = (record: SpoolRecord | null) => {
        const source = record?._blobSource;
        if (!source) return;
        const remaining = (staged.get(source.sha256) ?? 1) - 1;
        staged.set(source.sha256, remaining);
        // `staged` counts the records this pass read. A hook still running can
        // append another record naming the same bytes, so the count is a
        // floor, not the truth — bytes younger than the longest hook timeout
        // are left for the retention sweep, which runs once nobody can.
        if (remaining > 0) return;
        // Only bytes this spool staged: a source outside the session's staging dir belongs to someone else.
        if (path.dirname(path.resolve(source.path)) !== path.resolve(this.blobsDirFor(sessionId))) return;
        try {
          if (fs.statSync(source.path).mtimeMs > settled) return;
          fs.unlinkSync(source.path);
        } catch { /* already gone */ }
      };
      // A high-water past the held record ends the wait it set.
      const persist = (highWater: number, acked?: boolean) => updateSessionState(this.dir, sessionId, (s) => {
        s.highWater = highWater;
        if (acked) s.lastAckAt = now();
        delete s.eventRetry;
      }, now());
      /**
       * Whether a refusal is final for `record`: its code is permanent; the
       * Deployment lacks bytes this member no longer holds; or no code names
       * the cause and the holds before it were an unbroken run of such
       * refusals, begun at least `UNCLASSIFIED_REFUSAL_HOLD_MS` ago, whose own
       * wait has reached `REFUSAL_RETRY_MAX_MS`.
       */
      const verdictOn = (record: SpoolRecord, code: MemberCode, sourceGone: boolean): 'final' | 'held-too-long' | 'held' => {
        if (refusalPermanent(code) || (code === BLOB_ABSENT_CODE && sourceGone)) return 'final';
        if (REFUSAL_SUBJECT[code] !== 'unclassified') return 'held';
        const run = readSessionState(this.dir, sessionId).eventRetry?.unclassified;
        const heldTooLong = run !== undefined && run.backoffMs >= REFUSAL_RETRY_MAX_MS && now() - run.since >= UNCLASSIFIED_REFUSAL_HOLD_MS;
        return heldTooLong ? 'held-too-long' : 'held';
      };
      /** Keep the record at the high-water, and every record after it, for a later pass: the session's wait starts or lengthens. */
      const hold = (unclassified: boolean) => deferAfterRefusal(this.dir, sessionId, 'eventRetry', now(), { unclassified });
      /** Log a refusal of `record` and apply it: true when the pass moves past the record, false when the record is held. */
      const refuse = (record: SpoolRecord, code: MemberCode, reason: string, sourceGone: boolean): boolean => {
        const verdict = verdictOn(record, code, sourceGone);
        if (verdict === 'held') {
          const alreadyHeld = readSessionState(this.dir, sessionId).eventRetry !== undefined;
          const wait = hold(REFUSAL_SUBJECT[code] === 'unclassified');
          if (!alreadyHeld) this.appendRefused({ eventId: record.eventId, sessionId, kind: record.kind, code, reason, at: now(), held: { retryAt: wait.at } });
          stderr(`${record.kind} ${record.eventId} refused by the server (${code}): ${reason} — kept spooled with the session's later events, sent again later`);
          return false;
        }
        const logged = verdict === 'held-too-long' ? `refused for ${UNCLASSIFIED_REFUSAL_HOLD_HOURS} h: ${reason}` : reason;
        this.appendRefused({ eventId: record.eventId, sessionId, kind: record.kind, code, reason: logged, at: now() });
        stderr(`${record.kind} ${record.eventId} refused by the server (${code}): ${logged} — dropped`);
        result.refused += 1;
        i += 1;
        release(record);
        persist(i);
        return true;
      };

      pass: while (i < records.length) {
        if (!canStartRequest(budget, now())) { result.endedBy = 'budget'; break; }
        const record = records[i];
        if (record === null) {
          this.appendRefused({ eventId: '', sessionId, kind: '', code: 'refused', reason: 'unparsable spool line', at: now() });
          result.refused += 1;
          i += 1;
          persist(i);
          continue;
        }
        if (record._memberProtocol !== MEMBER_PROTOCOL) {
          stderr(`spool record ${record.eventId} was produced by member protocol ${record._memberProtocol}; this build speaks ${MEMBER_PROTOCOL} — not drained`);
          result.endedBy = 'protocol_mismatch';
          break;
        }
        let sourceGone = false;
        if (record._blobSource) {
          const blobOutcome = await this.uploadBlob(activeClient, record._blobSource, budget, now, uploaded);
          if (blobOutcome === 'gone') {
            sourceGone = true;
          } else if (blobOutcome === 'unreadable') {
            hold(false);
            stderr(`${record.kind} ${record.eventId}: its staged bytes at ${record._blobSource.path} could not be read — kept spooled with the session's later events, sent again later`);
            result.endedBy = 'unreadable';
            break;
          } else if (blobOutcome.class === 'refused') {
            // The record's bytes were refused: the refusal of the bytes is the record's.
            if (refuse(record, blobOutcome.code, blobOutcome.reason, false)) continue;
            result.endedBy = 'refused';
            break;
          } else if (blobOutcome.class !== 'acked') {
            result.endedBy = this.endPass(blobOutcome, now());
            break;
          }
        }
        const outcome = await activeClient.postEvent(toWire(record), clippedRequestBudget(budget, now()));
        result.sent += 1;
        switch (outcome.class) {
          case 'acked':
            this.clearLatch();
            result.acked += 1;
            i += 1;
            release(record);
            persist(i, true);
            continue;
          case 'refused':
            if (refuse(record, outcome.code, outcome.reason, sourceGone)) continue;
            result.endedBy = 'refused';
            break pass;
          case 'reslice':
            stderr(`${record.kind} ${record.eventId} answered ${outcome.code} on the event spool — left spooled`);
            result.endedBy = outcome.class;
            break pass;
          case 'retry':
            if (outcome.anonymousLimited && sawUnauthorized) {
              result.endedBy = 'unauthorized';
              break pass;
            }
            result.endedBy = this.endPass(outcome, now());
            break pass;
          case 'unauthorized': {
            sawUnauthorized = true;
            if (!retriedAfterUnauthorized && opts.onUnauthorized && opts.clientFor) {
              retriedAfterUnauthorized = true;
              const fresh = await opts.onUnauthorized();
              if (fresh !== null) {
                activeClient = opts.clientFor(fresh);
                continue;
              }
            }
            result.endedBy = this.endPass(outcome, now());
            break pass;
          }
          default:
            result.endedBy = this.endPass(outcome, now());
            break pass;
        }
      }

      if (i >= records.length && records.length > 0) {
        const deleted = this.buffer(sessionId).deleteIfSync((fresh) => {
          if (fresh.length > i) return false;
          const state = readSessionStateUnlocked(this.dir, sessionId);
          state.highWater = 0;
          writeSessionStateUnlocked(this.dir, sessionId, state, now());
          return true;
        });
        if (!deleted) persist(i);
        result.remaining = Math.max(0, this.readRecords(sessionId).length - (deleted ? 0 : i));
      } else {
        result.remaining = records.length - i;
      }
      return result;
    } finally {
      lease.lock.release();
    }
  }

  /**
   * Side effects and the end class for an outcome that stops a pass — the one
   * place that decides what each outcome does (latch, diagnostic, neither).
   * Public because the transcript-segment path ends its own passes and must
   * not carry a second copy of the policy.
   *
   * Refusals are not here and belong to the caller: what a refusal does to a
   * pass depends on whether it is final for the record, and only the caller
   * holds the record whose id, kind and code `refused.jsonl` records. Every
   * caller that can be refused logs it.
   */
  endPass(outcome: Outcome, now: number): DrainEnd {
    switch (outcome.class) {
      case 'parked':
        stderr('write quota exceeded — capture parked');
        return outcome.class;
      case 'retry':
        this.markOffline(now, outcome.retryAfterMs);
        return outcome.class;
      case 'route_missing':
        stderr('server answered 401 with the protocol header on a capture route — contract bug; events stay spooled');
        this.markOffline(now);
        return outcome.class;
      case 'unauthorized':
        stderr(`member token refused — events stay spooled; ${REJOIN_HINT}`);
        return outcome.class;
      case 'protocol':
        stderr(`server refuses member protocol ${MEMBER_PROTOCOL} (server_protocol=${outcome.serverProtocol ?? '?'}, min_compat_member_protocol=${outcome.minCompatMemberProtocol ?? '?'}) — upgrade myco; events stay spooled`);
        this.markOffline(now);
        return outcome.class;
      default:
        return outcome.class;
    }
  }
}
