/**
 * The member spool: a write-ahead `EventBuffer` per session under
 * `<MYCO_HOME>/member/spool/<deploymentKey>/<projectId>/`, one drain implementation with a
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
export { BUFFER_QUARANTINE_DIRNAME } from '../capture/buffer.js';
import { resolveMycoHome } from '../paths/home.js';
import { LifecycleLock, withFileLockSync } from '../utils/lifecycle-lock.js';
import { canStartRequest, clippedRequestBudget, longestDeclaredHookTimeoutMs, type HookBudget } from './budget.js';
import {
  MEMBER_FILE_MODE, MEMBER_PROTOCOL, OFFLINE_BACKOFF_INITIAL_MS, OFFLINE_BACKOFF_MAX_MS, REFUSAL_RETRY_MAX_MS, REFUSAL_SUBJECT, refusalPermanent,
  REFUSED_LOG_MAX_BYTES, UNCLASSIFIED_REFUSAL_HOLD_HOURS, UNCLASSIFIED_REFUSAL_HOLD_MS, type MemberCode,
} from './constants.js';
import type { BlobSource, BlobStager, MemberEnvelope, OutboundEvent } from './envelope.js';
import { REJOIN_HINT } from './delivery-notice.js';
import {
  bufferLockPath, deferAfterRefusal, readSessionState, readSessionStateResult, readSessionStateUnlocked, retryWaiting, sessionStatePath, turnsFileOf, updateSessionState,
  writeSessionStateUnlocked, type SessionState, type SessionStateRead,
} from './session-state.js';
import { assertMemberPathContained, ensureMemberDir, ensurePrivateFile, memberRoot, pathIsAbsent, readPrivateJson, reportSkippedPrivateFile, writePrivateFileAtomic } from './store.js';
import { memberRoutingIdentity, pinSpoolDestination, LEGACY_MIGRATION_FILE, ROUTING_FILE, routedSpoolDir, sameRoutingIdentity, type MemberRoutingIdentity } from './routing.js';
import type { ClientRecord, Outcome, ServerClient } from './transport.js';
import { publishStagedBlob } from './staged-blobs.js';
import { payloadDisposition, type PayloadRetry } from './payload-disposition.js';
import { recordSessionLoss } from './capture-loss.js';

export const SPOOL_DIRNAME = 'spool';
export const BLOBS_DIRNAME = 'blobs';
export const OFFLINE_LATCH_FILE = 'offline.json';
export const REFUSED_LOG_FILE = 'refused.jsonl';
const DRAIN_LEASE_SUFFIX = '.drain.lock';
/** Suffix of the marker naming a session whose transcripts may hold bytes the Deployment has not acknowledged. */
const TRANSCRIPT_BACKLOG_SUFFIX = '.transcript-backlog';
/** Suffix of a session's state file, the sibling of its spool file. */
const STATE_FILE_SUFFIX = '.state.json';

/** The seven envelope fields; nothing else leaves the spool. */
export const WIRE_FIELDS = ['eventId', 'sessionId', 'kind', 'createdAt', 'channel', 'producer', 'payload'] as const;

/**
 * The journal format this build writes, stamped on every line it appends as `_journal`. It is the format of the
 * journal file and never travels: the wire's own number is `MEMBER_PROTOCOL`. A line written before the stamp is an
 * event of the first format.
 */
export const JOURNAL_VERSION = 2;

/** A spool line: the envelope plus the member-private sidecars. */
export interface SpoolRecord extends MemberEnvelope {
  _memberProtocol: number;
  _blobSource?: BlobSource;
  _journal?: number;
  _payloadRetry?: PayloadRetry;
}

/**
 * A turn-end mark: the session's turn ended at `at`, the member's clock, when the transcript in `slot` held `atSize`
 * bytes. It is never a record the Deployment is sent: the pass that reads it acts on it (the next turn's context is
 * fetched; a Deployment that does not take `turn` events is told by the transcript segment that reaches `atSize`),
 * and the transcript's own bytes are shipped from its pointer as always.
 *
 * Marks live in the session's own marks file (`.<session>.turns`), never in its journal (#1561 D8). A build that
 * predates marks deletes a journal once its event pass reaches the end; it never lists or opens the marks file, so a
 * rollback cannot take an unconsumed mark with it. `markWater` in session state counts the marks file's consumed lines.
 */
export interface TurnEndMark {
  t: typeof TURN_END_MARK;
  _journal: number;
  slot: 'primary' | { subagent: string };
  transcriptId: string;
  atSize: number;
  at: number;
}

export const TURN_END_MARK = 'te';

/** A turn-end mark not yet consumed, with where it stands: the generation of its marks file and its line there. */
export interface PendingTurnEnd {
  generation: string;
  line: number;
  mark: TurnEndMark;
}

/** What names one turn's end: the transcript, its slot, and the size it had reached. */
export const turnEndIdentity = (mark: Pick<TurnEndMark, 'slot' | 'transcriptId' | 'atSize'>): string =>
  `${mark.slot === 'primary' ? 'primary' : `subagent:${mark.slot.subagent}`}\u0000${mark.transcriptId}\u0000${mark.atSize}`;

/** Whether a parsed marks-file line is a turn-end mark: a line this build cannot read is skipped, never acted on. */
export const isTurnEndMark = (line: unknown): line is TurnEndMark =>
  line !== null && typeof line === 'object' && (line as { t?: unknown }).t === TURN_END_MARK;

/**
 * Whether a turn-end mark has nothing left to wait for: the transcript it names reached `atSize` on the Deployment,
 * or never will. That is the case when the slot's pointer now names another transcript (the file was replaced and
 * re-minted), the Deployment refused the transcript for good, the file is gone, or it holds fewer bytes than the mark
 * names (cut short or rotated under its name).
 */
export function turnEndSatisfied(mark: TurnEndMark, state: SessionState): boolean {
  const pointer = mark.slot === 'primary' ? state.transcript : state.siblings[mark.slot.subagent];
  if (pointer === undefined || pointer.transcriptId !== mark.transcriptId) return true;
  if (pointer.refused !== undefined) return true;
  if (pointer.nextOffset >= mark.atSize) return true;
  try {
    return fs.statSync(pointer.path).size < mark.atSize;
  } catch {
    return true;
  }
}

/** The staged bytes a journal line names, when it names any. */
export const blobSourceOf = (line: SpoolRecord | null): BlobSource | undefined => line?._blobSource;

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

/** The lines a spool's bytes hold; a torn line reads as null. */
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

/** The parsed lines of a marks file; a cut-off line reads as null. A file that is not there holds none. */
function readTurnLines(file: string): Array<unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];
  }
  return raw.split('\n').filter((line) => line.trim() !== '').map((line) => {
    try { return JSON.parse(line) as unknown; } catch { return null; }
  });
}

/** The first line of every marks file: the generation that names this file among every one the session has had. */
interface TurnsHeader {
  t: 'gen';
  _journal: number;
  generation: string;
}

/** A new marks file's header: a fresh generation, so a consumer holding line numbers of a file already deleted can never consume this one's marks. */
const newTurnsHeader = (): TurnsHeader => ({ t: 'gen', _journal: JOURNAL_VERSION, generation: crypto.randomBytes(8).toString('hex') });

/** The generation a marks file's lines name, or null where its first line is not a header (no file, or one cut off). */
function generationOf(lines: readonly unknown[]): string | null {
  const head = lines[0] as Partial<TurnsHeader> | null | undefined;
  return head !== null && typeof head === 'object' && head.t === 'gen' && typeof head.generation === 'string' ? head.generation : null;
}

/**
 * Whether a journal or marks file ends part-way through a line: the last write into it was cut off (a crash, a full disk).
 * The next append starts a fresh line, so the cut line is lost alone and never fuses with the record after it.
 */
function endsMidLine(file: string): boolean {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return false;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    fs.closeSync(fd);
  }
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
export function spoolDirFor(route: MemberRoutingIdentity, mycoHome: string = resolveMycoHome()): string {
  return routedSpoolDir(route, mycoHome);
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
  readonly routing: MemberRoutingIdentity | null;
  readonly projectId: string;
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
  constructor(route: MemberRoutingIdentity | null, opts: { mycoHome?: string; initialize?: boolean; dir?: string } = {}) {
    this.mycoHome = opts.mycoHome ?? resolveMycoHome();
    // `dir` holds capture for a repository that has no project yet (`pending.ts`): a directory inside the member root.
    if (opts.dir !== undefined) assertMemberPathContained(opts.dir, this.mycoHome);
    this.routing = route === null ? null : memberRoutingIdentity(route);
    this.projectId = this.routing?.projectId ?? '';
    if (this.routing === null && opts.dir === undefined) throw new Error('An unbound spool requires an explicit pending directory');
    if (this.routing !== null && opts.dir !== undefined && path.resolve(opts.dir) !== spoolDirFor(this.routing, this.mycoHome)) throw new Error('A routed spool requires its own destination directory');
    this.dir = opts.dir ?? spoolDirFor(this.routing!, this.mycoHome);
    this.blobsDir = path.join(this.dir, BLOBS_DIRNAME);
    if (opts.initialize === false) return;
    ensureMemberDir(this.dir, this.mycoHome);
    if (this.routing !== null) pinSpoolDestination(this.dir, this.routing);
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
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const file = path.join(dir, sha256);
      const source = { path: file, sha256, mediaType, size: bytes.byteLength };
      const lock = bufferLockPath(this.dir, sessionId);
      ensurePrivateFile(lock);
      withFileLockSync(lock, () => {
        ensureMemberDir(dir, this.mycoHome);
        publishStagedBlob(source, bytes);
      });
      return source;
    };
  }

  private spoolFile(sessionId: string): string {
    return path.join(this.dir, `${sessionId}.jsonl`);
  }

  /** The session's turn-end marks file (`TurnEndMark`). */
  turnsFile(sessionId: string): string {
    return turnsFileOf(this.dir, sessionId);
  }

  private leasePath(sessionId: string): string {
    return path.join(this.dir, `.${sessionId}${DRAIN_LEASE_SUFFIX}`);
  }

  /**
   * The session's buffer with its lock companion and file pre-created 0600. Its lock companion outlives its journal:
   * the session's state is locked on the same file, and only retention retires it (`retireSessionFiles`).
   */
  private buffer(sessionId: string): EventBuffer {
    ensurePrivateFile(bufferLockPath(this.dir, sessionId));
    ensurePrivateFile(this.spoolFile(sessionId));
    return new EventBuffer(this.dir, sessionId, { keepLockCompanion: true });
  }

  /** Write-ahead: append one record before anything is sent. */
  append(sessionId: string, out: OutboundEvent): void {
    this.appendAndRecord(sessionId, [out]);
  }

  /** Reconcile a journal under its append lock; reset the checkpoint before replacing its rows. */
  private reconcileJournal(sessionId: string, reconcile: (lines: string[], state: SessionState) => string[], now: number): number {
    const lock = bufferLockPath(this.dir, sessionId);
    ensurePrivateFile(lock);
    return withFileLockSync(lock, () => {
      const file = this.spoolFile(sessionId);
      let raw: string;
      try { raw = fs.readFileSync(file, 'utf8'); }
      catch (err) { if (!pathIsAbsent(file)) throw err; raw = ''; }
      const state = readSessionStateUnlocked(this.dir, sessionId);
      const lines = reconcile(raw.split('\n').filter((line) => line.trim() !== ''), state);
      state.highWater = 0;
      writeSessionStateUnlocked(this.dir, sessionId, state, now);
      writePrivateFileAtomic(file, lines.length === 0 ? '' : `${lines.join('\n')}\n`);
      return lines.length;
    });
  }

  /** Replay older recovered records before current capture; a concurrent drain retains its journal generation. */
  prependRecovered(sessionId: string, events: readonly OutboundEvent[], now: number = Date.now()): boolean {
    ensurePrivateFile(this.leasePath(sessionId));
    const lease = LifecycleLock.acquire(this.leasePath(sessionId), { command: 'myco member recover' });
    if (!lease.acquired) return false;
    try {
      this.reconcileJournal(sessionId, (lines, state) => {
        const live = lines.slice(state.highWater);
        const ids = new Set(parseSpoolLines(live.join('\n')).flatMap((record) => record === null ? [] : [record.eventId]));
        const recovered = events.filter((event) => {
          if (ids.has(event.envelope.eventId)) return false;
          ids.add(event.envelope.eventId);
          return true;
        }).map((event) => JSON.stringify({ ...event.envelope, _memberProtocol: MEMBER_PROTOCOL, _journal: JOURNAL_VERSION,
          ...(event.blobSource === undefined ? {} : { _blobSource: event.blobSource }) }));
        return [...recovered, ...live];
      }, now);
      return true;
    } finally { lease.lock.release(); }
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
  appendAndRecord(sessionId: string, events: readonly OutboundEvent[], record?: (state: SessionState) => void, now: number = Date.now(), deduplicate = false): void {
    const stamp = new Date(now).toISOString();
    this.appendLines(sessionId, this.spoolFile(sessionId), events.map((out) => ({
      ...out.envelope,
      _memberProtocol: MEMBER_PROTOCOL,
      _journal: JOURNAL_VERSION,
      ...(out.blobSource ? { _blobSource: out.blobSource } : {}),
      timestamp: stamp,
    })), record, now, undefined, deduplicate ? (existing, moving) => {
      const ids = new Set(existing.flatMap((line) => typeof line === 'object' && line !== null && 'eventId' in line ? [line.eventId] : []));
      return moving.filter((line) => {
        const id = (line as SpoolRecord).eventId;
        if (ids.has(id)) return false;
        ids.add(id);
        return true;
      });
    } : undefined);
  }

  /**
   * Append a turn-end mark (`TurnEndMark`) to the session's marks file, with its receipts, under the same lock and
   * write rules as an event: the transcript in `slot` held `atSize` bytes when the session's turn ended, at `now`.
   */
  appendTurnEnd(sessionId: string, mark: { slot: TurnEndMark['slot']; transcriptId: string; atSize: number }, record?: (state: SessionState) => void, now: number = Date.now()): void {
    const line: TurnEndMark & { timestamp: string } = { t: TURN_END_MARK, _journal: JOURNAL_VERSION, ...mark, at: now, timestamp: new Date(now).toISOString() };
    this.appendLines(sessionId, this.turnsFile(sessionId), [line], record, now, newTurnsHeader);
  }

  /**
   * Append turn-end marks moved from another spool (capture held for a repository with no connection, `pending.ts`),
   * in their order and each with the time its turn ended, under the same lock and header rules as `appendTurnEnd`. A
   * mark whose slot, transcript and size the marks file already holds is skipped, so a move that runs again appends
   * none twice. How many were appended.
   */
  appendMovedTurnEnds(sessionId: string, marks: readonly TurnEndMark[], now: number = Date.now()): number {
    const lines = marks.map((mark): TurnEndMark & { timestamp: string } => ({
      t: TURN_END_MARK, _journal: JOURNAL_VERSION, slot: mark.slot, transcriptId: mark.transcriptId, atSize: mark.atSize, at: mark.at,
      timestamp: new Date(mark.at).toISOString(),
    }));
    let appended = 0;
    this.appendLines(sessionId, this.turnsFile(sessionId), lines, undefined, now, newTurnsHeader, (existing, moving) => {
      const held = new Set(existing.filter(isTurnEndMark).map(turnEndIdentity));
      const fresh = moving.filter((line) => {
        const identity = turnEndIdentity(line as TurnEndMark);
        if (held.has(identity)) return false;
        held.add(identity);
        return true;
      });
      appended = fresh.length;
      return fresh;
    });
    return appended;
  }

  /**
   * One hook's lines into `file` (the journal or the marks file) and its receipts, under one hold of the session's
   * lock and in ONE write: a hook that is killed, or meets a full disk, part-way leaves at most a cut final line,
   * which `endsMidLine` closes before the next append so it never costs the line after it.
   */
  private appendLines(
    sessionId: string, file: string, lines: readonly object[], record: ((state: SessionState) => void) | undefined, now: number, header?: () => object,
    fresh?: (existing: readonly unknown[], lines: readonly object[]) => readonly object[],
  ): void {
    if (lines.length === 0 && !record) return;
    const lock = bufferLockPath(this.dir, sessionId);
    ensurePrivateFile(lock);
    // A receipt with nothing to append leaves no spool file behind: an empty file would read as a session with records to drain.
    if (lines.length > 0) ensurePrivateFile(file);
    withFileLockSync(lock, () => {
      const existing = lines.length === 0 || (header === undefined && fresh === undefined) || fs.statSync(file).size === 0 ? null
        : header === undefined ? parseSpoolLines(fs.readFileSync(file, 'utf8')) : readTurnLines(file);
      // What the file already holds is read under the lock this append holds, so no other append slips between.
      const appending = fresh === undefined || lines.length === 0 ? lines : fresh(existing ?? [], lines);
      if (appending.length > 0) {
        const toText = (out: readonly unknown[]): string => out.map((line) => JSON.stringify(line) + '\n').join('');
        if (header !== undefined && existing !== null && generationOf(existing) === null) {
          // The file's first write was cut off before its header was whole: begin a fresh generation, keeping every
          // mark after it that reads whole, so no later mark is hidden behind a header nothing can read.
          writePrivateFileAtomic(file, toText([header(), ...existing.filter(isTurnEndMark), ...appending]));
        } else {
          const body = toText([...(header !== undefined && existing === null ? [header()] : []), ...appending]);
          fs.appendFileSync(file, (endsMidLine(file) ? '\n' : '') + body, { mode: MEMBER_FILE_MODE });
        }
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

  /**
   * The turn-end marks no pass has consumed yet, oldest first, each with its marks file's generation and its line in
   * that file: what `consumeTurnEnds` takes back. A line this build cannot read (cut off, or not a mark) is skipped.
   * A count kept for another generation of the file counts nothing in this one.
   */
  pendingTurnEnds(sessionId: string): PendingTurnEnd[] {
    const lock = bufferLockPath(this.dir, sessionId);
    ensurePrivateFile(lock);
    return withFileLockSync(lock, () => {
      const lines = readTurnLines(this.turnsFile(sessionId));
      const generation = generationOf(lines);
      if (generation === null) return [];
      const state = readSessionStateUnlocked(this.dir, sessionId);
      const from = state.markGeneration === generation ? Math.max(1, state.markWater ?? 0) : 1;
      const pending: PendingTurnEnd[] = [];
      for (let i = from; i < lines.length; i++) {
        const line = lines[i];
        if (isTurnEndMark(line)) pending.push({ generation, line: i, mark: line });
      }
      return pending;
    });
  }

  /**
   * Consume every turn-end mark at or before `through.line` of the marks file `through.generation` names: the pass
   * that read them has acted on them. A generation that is not the file's names a file already gone, whose marks
   * were consumed, and consumes nothing.
   *
   * Once every line is consumed the count is written back to zero first and the file deleted after, all under the
   * lock an append takes: a mark appended meanwhile is never deleted unread, and a consume cut off between the two
   * leaves its marks to be read again, never a count that skips the next file's.
   */
  consumeTurnEnds(sessionId: string, through: { generation: string; line: number }, now: number = Date.now()): void {
    const lock = bufferLockPath(this.dir, sessionId);
    ensurePrivateFile(lock);
    withFileLockSync(lock, () => {
      const file = this.turnsFile(sessionId);
      const lines = readTurnLines(file);
      if (generationOf(lines) !== through.generation) return;
      const state = readSessionStateUnlocked(this.dir, sessionId);
      const from = state.markGeneration === through.generation ? (state.markWater ?? 0) : 0;
      const markWater = Math.max(from, through.line + 1);
      if (markWater >= lines.length) {
        state.markWater = 0;
        delete state.markGeneration;
        writeSessionStateUnlocked(this.dir, sessionId, state, now);
        try { fs.unlinkSync(file); } catch { /* already gone */ }
        return;
      }
      state.markWater = markWater;
      state.markGeneration = through.generation;
      writeSessionStateUnlocked(this.dir, sessionId, state, now);
    });
  }

  /**
   * Whether the session's start is still waiting in its journal: no start of the session's is settled yet
   * (`startSettled`), and one lies at or past the acknowledged mark. A transcript ships only after its session's
   * start, so the Deployment always holds the session a transcript belongs to, whatever else of the session is held.
   * Once one start is settled, a later one (a resume, a compaction, a clear) holds no transcript back.
   */
  sessionStartPending(sessionId: string): boolean {
    const state = readSessionState(this.dir, sessionId);
    if (state.startSettled === true) return false;
    const lines = this.readRecords(sessionId);
    for (let i = state.highWater; i < lines.length; i++) {
      const line = lines[i];
      if (line !== null && line.kind === 'session.start') return true;
    }
    return false;
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
      return this.withSessionRecordsLock(sessionId, (read) => read.readable ? read : { readable: false });
    } catch {
      return { readable: false };
    }
  }

  /** Keep journal accounting and staged-byte reclamation under the append and publication lock. */
  withSessionRecordsLock<T>(sessionId: string, fn: (read: { readable: true; records: Array<SpoolRecord | null> } | { readable: false; absent?: true }) => T): T {
    const file = this.spoolFile(sessionId);
    const lock = bufferLockPath(this.dir, sessionId);
    if (!this.reachable(file) || !this.reachable(lock)) throw new Error(UNAVAILABLE_PATH);
    ensurePrivateFile(lock);
    return withFileLockSync(lock, () => {
      let raw: string;
      try { raw = fs.readFileSync(file, 'utf8'); }
      catch { return fn({ readable: false, ...(pathIsAbsent(file) ? { absent: true as const } : {}) }); }
      return fn({ readable: true, records: parseSpoolLines(raw) });
    });
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
      read = readSessionStateResult(this.dir, sessionId);
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

  /** Check the persisted spool identity and the client before any delivery. */
  assertClientDestination(client: Pick<ServerClient, 'serverUrl' | 'projectId'>): void {
    const destination = readPrivateJson<MemberRoutingIdentity>(path.join(this.dir, ROUTING_FILE));
    if (!destination.ok || this.routing === null || !sameRoutingIdentity(destination.value, this.routing)) throw new Error('Member spool destination is unavailable or mismatched');
    const migration = readPrivateJson<{ version: number; state: string; destination: MemberRoutingIdentity }>(path.join(this.dir, LEGACY_MIGRATION_FILE));
    if (migration.ok ? migration.value?.version !== 1 || migration.value.state !== 'validated' || !migration.value.destination || !sameRoutingIdentity(migration.value.destination, this.routing) : migration.reason !== 'missing') throw new Error('Member spool migration has not been validated');
    if (this.routing === null || client.projectId === undefined || !sameRoutingIdentity(this.routing, { serverUrl: client.serverUrl, projectId: client.projectId })) {
      throw new Error('Member capture client does not match its buffered destination');
    }
  }

  /** Upload verified or repaired bytes; unavailable records receive their own bounded retry disposition. */
  private async uploadBlob(client: ServerClient, record: SpoolRecord, budget: HookBudget, now: () => number, uploaded: Set<string>): Promise<Outcome | 'missing' | 'unreadable'> {
    const source = record._blobSource!;
    if (uploaded.has(source.sha256)) return { class: 'acked', body: {} };
    const read = payloadDisposition(source, record._payloadRetry, now(), (bytes) => {
      const repaired = this.stagerFor(record.sessionId)(bytes, source.mediaType);
      source.path = repaired.path;
    });
    if (read.status === 'retry') { record._payloadRetry = read.retry; return 'unreadable'; }
    delete record._payloadRetry;
    if (read.status === 'missing') return 'missing';
    const outcome = await client.postBlob(read.bytes, source.sha256, source.mediaType, clippedRequestBudget(budget, now()));
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
    this.assertClientDestination(client);
    const now = opts.now ?? Date.now;
    const result: DrainResult = { sessionId, sent: 0, acked: 0, refused: 0, remaining: 0, endedBy: 'drained' };
    if (!budget.drains) return { ...result, skipped: 'never-drains', remaining: this.depth(sessionId) };
    if (!this.shouldDial(now(), opts.force)) return { ...result, skipped: 'latched', remaining: this.depth(sessionId) };
    const wait = readSessionState(this.dir, sessionId).eventRetry;
    if (opts.honourRetry === true && wait?.localPayload !== true && retryWaiting(wait, now())) return { ...result, skipped: 'deferred', remaining: this.depth(sessionId) };
    ensurePrivateFile(this.leasePath(sessionId));
    const lease = LifecycleLock.acquire(this.leasePath(sessionId), { command: 'myco member drain' });
    if (!lease.acquired) return { ...result, skipped: 'lease', remaining: this.depth(sessionId) };

    try {
      const records = this.readRecords(sessionId);
      const rawLines = records.includes(null) ? fs.readFileSync(this.spoolFile(sessionId), 'utf8').split('\n').filter((line) => line.trim() !== '') : [];
      let i = readSessionState(this.dir, sessionId).highWater;
      const uploaded = new Set<string>();
      const retained: SpoolRecord[] = [];
      let contiguous = true;
      let sawUnauthorized = false;
      let retriedAfterUnauthorized = false;
      let activeClient = client;
      // How many records still reference each staged blob; the last one to be
      // drained releases the bytes. Without the count a repeat sha would be
      // unlinked under a record that has not been sent yet.
      const staged = new Map<string, number>();
      for (const record of records) {
        const source = blobSourceOf(record);
        if (source) staged.set(source.sha256, (staged.get(source.sha256) ?? 0) + 1);
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
        const owned = path.dirname(path.resolve(source.path)) === path.resolve(this.blobsDirFor(sessionId));
        const pending = path.relative(path.join(memberRoot(this.mycoHome), 'pending'), source.path).split(path.sep);
        const pendingOwned = pending.length === 4 && /^[0-9a-f]{16,64}$/.test(pending[0]) && pending[1] === BLOBS_DIRNAME && pending[2] === sessionId && pending[3] === source.sha256;
        if (!owned && !pendingOwned) return;
        assertMemberPathContained(source.path, this.mycoHome);
        withFileLockSync(bufferLockPath(this.dir, sessionId), () => {
          try {
            if (fs.statSync(source.path).mtimeMs > settled) return;
            fs.unlinkSync(source.path);
          } catch { /* already gone */ }
        });
      };
      // A high-water past the held record ends the wait it set; one past a start settles the session's start.
      const persist = (highWater: number, acked?: boolean, passed?: SpoolRecord) => updateSessionState(this.dir, sessionId, (s) => {
        if (contiguous) s.highWater = highWater;
        s.lastAccountedAt = now();
        if (acked) {
          s.lastAckAt = now();
          s.lastDeliveryAt = now();
        }
        if (passed?.kind === 'session.start') s.startSettled = true;
        delete s.eventRetry;
      }, now());
      /**
       * Whether a refusal is final for `record`: its code is permanent; or no code names
       * the cause and the holds before it were an unbroken run of such
       * refusals, begun at least `UNCLASSIFIED_REFUSAL_HOLD_MS` ago, whose own
       * wait has reached `REFUSAL_RETRY_MAX_MS`.
       */
      const verdictOn = (record: SpoolRecord, code: MemberCode, missing: boolean): 'final' | 'held-too-long' | 'held' => {
        if (refusalPermanent(code) || (missing && code === 'blob_absent')) return 'final';
        if (REFUSAL_SUBJECT[code] !== 'unclassified') return 'held';
        const run = readSessionState(this.dir, sessionId).eventRetry?.unclassified;
        const heldTooLong = run !== undefined && run.backoffMs >= REFUSAL_RETRY_MAX_MS && now() - run.since >= UNCLASSIFIED_REFUSAL_HOLD_MS;
        return heldTooLong ? 'held-too-long' : 'held';
      };
      /** Keep the record at the high-water, and every record after it, for a later pass: the session's wait starts or lengthens. */
      const hold = (unclassified: boolean) => deferAfterRefusal(this.dir, sessionId, 'eventRetry', now(), { unclassified });
      /** Log a refusal of `record` and apply it: true when the pass moves past the record, false when the record is held. */
      const refuse = (record: SpoolRecord, code: MemberCode, reason: string, missing = false): boolean => {
        const verdict = verdictOn(record, code, missing);
        if (verdict === 'held') {
          const alreadyHeld = readSessionState(this.dir, sessionId).eventRetry !== undefined;
          const wait = hold(REFUSAL_SUBJECT[code] === 'unclassified');
          if (!alreadyHeld) this.appendRefused({ eventId: record.eventId, sessionId, kind: record.kind, code, reason, at: now(), held: { retryAt: wait.at } });
          stderr(`${record.kind} ${record.eventId} refused by the server (${code}): ${reason} — kept spooled with the session's later events, sent again later`);
          return false;
        }
        if (missing && code === 'blob_absent') {
          updateSessionState(this.dir, sessionId, (state) => recordSessionLoss(state, record.eventId, 'payload', now()), now());
          stderr(`${record.kind} ${record.eventId}: confirmed payload loss — counted in member status`);
        }
        const logged = verdict === 'held-too-long' ? `refused for ${UNCLASSIFIED_REFUSAL_HOLD_HOURS} h: ${reason}` : reason;
        this.appendRefused({ eventId: record.eventId, sessionId, kind: record.kind, code, reason: logged, at: now() });
        stderr(`${record.kind} ${record.eventId} refused by the server (${code}): ${logged} — dropped`);
        result.refused += 1;
        i += 1;
        release(record);
        persist(i, false, record);
        return true;
      };

      pass: while (i < records.length) {
        if (!canStartRequest(budget, now())) { result.endedBy = 'budget'; break; }
        const record = records[i];
        if (record === null) {
          const key = crypto.createHash('sha256').update(rawLines[i] ?? '').digest('hex');
          updateSessionState(this.dir, sessionId, (state) => recordSessionLoss(state, `damaged:${sessionId}:${key}`, 'record', now()), now());
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
        let sourceMissing = false;
        if (record._blobSource) {
          const blobOutcome = await this.uploadBlob(activeClient, record, budget, now, uploaded);
          if (blobOutcome === 'unreadable') {
            retained.push(record);
            contiguous = false;
            i += 1;
            stderr(`${record.kind} ${record.eventId}: staged bytes unavailable — this record retries with backoff; later capture can deliver`);
            continue;
          } else if (blobOutcome === 'missing') {
            sourceMissing = true;
          } else if (blobOutcome.class === 'refused') {
            // The record's bytes were refused: the refusal of the bytes is the record's.
            if (refuse(record, blobOutcome.code, blobOutcome.reason)) continue;
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
            persist(i, true, record);
            continue;
          case 'refused':
            if (refuse(record, outcome.code, outcome.reason, sourceMissing)) continue;
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
                this.assertClientDestination(activeClient);
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

      if (retained.length > 0) {
        result.remaining = this.reconcileJournal(sessionId, (lines, state) => {
          const fresh = parseSpoolLines(lines.join('\n'));
          if (records.some((record, index) => record?.eventId !== fresh[index]?.eventId)) throw new Error('Journal changed during payload retry accounting');
          const retry = retained.map((record) => record._payloadRetry!).sort((a, b) => a.at - b.at)[0];
          if (result.endedBy !== 'refused') state.eventRetry = { at: retry.at, backoffMs: retry.backoffMs, localPayload: true };
          return [...retained.map((record) => JSON.stringify(record)), ...lines.slice(i)];
        }, now());
        if (result.endedBy === 'drained') result.endedBy = 'unreadable';
      } else if (i >= records.length && records.length > 0) {
        // Deleted once every record is acknowledged. Turn-end marks live in their own file and are no reason to keep
        // it. A line this pass could not parse is already logged (`refused.jsonl`) below the mark, and pins nothing.
        const deleted = this.buffer(sessionId).deleteIfSync((fresh) => {
          if (fresh.length > i) return false;
          const state = readSessionStateUnlocked(this.dir, sessionId);
          state.highWater = 0;
          writeSessionStateUnlocked(this.dir, sessionId, state, now());
          return true;
        }, { tolerate: (line) => line < i });
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
        stderr('the Deployment refused capture for its write quota — capture stays spooled and ships once the Deployment is updated');
        return outcome.class;
      case 'retry':
        this.markOffline(now, outcome.retryAfterMs);
        return outcome.class;
      case 'slow':
        // A capped share ran out before the answer did. The server answered nothing wrong and may simply be busy,
        // so nothing latches: the next hook asks again.
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
