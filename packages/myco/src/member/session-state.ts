/**
 * Per-session member state under the spool dir: the spool high-water, the
 * current prompt, the prompts already captured, the transcript pointer, and
 * the derived-id bookkeeping the Stop/SessionEnd transcript work needs. Read
 * and modified under the session's buffer lock — hooks run concurrently.
 */
import { removeSessionContext, type ContextAsk } from './context-cache.js';
import fs from 'node:fs';
import path from 'node:path';
import { withFileLockSync } from '../utils/lifecycle-lock.js';
import { REFUSAL_RETRY_INITIAL_MS, REFUSAL_RETRY_MAX_MS } from './constants.js';
import { ensurePrivateFile, readPrivateJson, reportSkippedPrivateFile, writePrivateFileAtomic } from './store.js';
import { CaptureLossLedger, type CaptureLoss } from './capture-loss.js';

export const SESSION_STATE_VERSION = 1;
/** Captured-prompt and attachment bookkeeping is kept to this many entries, oldest dropped first. */
const MAX_TRACKED = 500;

export interface TranscriptPointer {
  path: string;
  transcriptId: string;
  inode: number;
  /** The digest of the file's first bytes, once it has enough of them; sent on every segment as the Deployment's integrity gate. */
  headHash?: string;
  /** The next byte offset to ship; the server's held size after an ack. */
  nextOffset: number;
  /** Bytes of the transcript the member has already read for its own derivations: plan-file writes, and for an agent whose hooks write its turn rows, prompts, plans and images. */
  parsedSize: number;
  /** The code the Deployment refused this transcript with for good, when it has; nothing ships under this identity again. */
  refused?: string;
}

/**
 * When a backlog walk may send a session's records again after a transient
 * refusal, and the wait that set it. A pass that moves past the held records
 * clears it, so a wait always belongs to the records it held.
 */
export interface RefusalRetry {
  at: number;
  backoffMs: number;
  /** Local bytes retry per record; later capture can still be delivered. */
  localPayload?: true;
  /**
   * The run of consecutive holds whose refusal named no cause: when the first
   * of them arrived, and the wait the run alone has grown to. A hold for any
   * other cause ends the run.
   */
  unclassified?: { since: number; backoffMs: number };
}

/** The wait after `previous`: `REFUSAL_RETRY_INITIAL_MS` for the first, then double the last, to `REFUSAL_RETRY_MAX_MS`. */
const nextBackoff = (previous: { backoffMs: number } | undefined): number =>
  previous === undefined ? REFUSAL_RETRY_INITIAL_MS : Math.min(previous.backoffMs * 2, REFUSAL_RETRY_MAX_MS);

/** The state fields that hold a wait after a transient refusal: one for the session's spooled events, one for its transcripts. */
export type RetryField = 'eventRetry' | 'transcriptRetry';

export interface SessionState {
  version: typeof SESSION_STATE_VERSION;
  /** Spool records (from the start of the current file) acknowledged: acked or refused. */
  highWater: number;
  /**
   * Lines of the session's marks file (`turnsFileOf`) consumed: every mark at a line below it has been read by the
   * pass that acts on it. Absent reads as 0. The marks file is deleted, and this starts again at 0, only once it
   * reaches the file's end, so no mark is deleted before it is read.
   */
  markWater?: number;
  /** The generation of the marks file `markWater` counts in; a file of another generation is read from its start. */
  markGeneration?: string;
  /**
   * Set once the event lane is past one of the session's `session.start` records, delivered or dropped for good. A
   * transcript waits for the session's start only until then: a start a later resume, compaction or clear writes is
   * the same session again, and the Deployment already holds it. Kept when the journal is deleted.
   */
  startSettled?: true;
  /** The current prompt, minted by UserPromptSubmit. */
  promptId?: string;
  /** sha256(text) → promptId for every prompt this session has captured. */
  prompts: Record<string, string>;
  transcript?: TranscriptPointer;
  /** The subagent transcripts found beside the session's own, keyed by path; each ships under its own pointer with role `subagent`. */
  siblings: Record<string, TranscriptPointer>;
  /** sha256(content) → planKey for every plan this session has emitted. */
  planHashes: Record<string, string>;
  planTagCount: number;
  /** Normalized path → the key, captured content hash and any outstanding read for each tracked plan; Stop re-reads them. */
  planPaths: Record<string, {
    planKey: string;
    hash: string;
    /** A file read still owed, even when no version of the plan has shipped. */
    pendingRead?: 'absent' | 'unreadable' | 'not-file';
    pendingSince?: number;
    pendingChecks?: number;
    /** The producing prompt, retained until a first successful read. */
    promptId?: string;
  }>;
  /** Blob keys of attachments already emitted. */
  attachmentKeys: string[];
  /**
   * The recall kinds this session has already been served — `cortex` for its
   * start, `cortex:<agentType>` for a subagent's. A hook that finds its kind
   * here asks the Deployment for nothing, so a symbiont running session-start
   * on every invocation spends the budget once.
   */
  delivered: string[];
  /** Compactions this session has been through, advanced by the hook that observes one before it asks for the block served after it. */
  compactionOrdinal: number;
  /** The manifest name of the symbiont whose hooks captured this session; a transcript shipped from another session's hook is labelled with it. */
  agent?: string;
  /** Set when no one symbiont's declared transcript layout names this session's transcript, so a hook's backlog walk passes it over rather than search again. */
  agentUnknown?: true;
  /** When a backlog walk may send this session's transcripts again after a transient refusal, and the wait that set it. */
  transcriptRetry?: RefusalRetry;
  /** When a backlog walk may send this session's spooled events again after a transient refusal held them, and the wait that set it. */
  eventRetry?: RefusalRetry;
  /** When this session first appended to the spool; the clock retention measures from until an acknowledgement arrives. */
  startedAt?: number;
  /**
   * When the server last acknowledged one of this session's spooled events: retention's clock for quarantining a
   * journal nothing is taking. Transcript segments and blobs do not move it (`lastDeliveryAt` does).
   */
  lastAckAt?: number;
  /** When an event was last acknowledged or given an explicit terminal loss/refusal disposition. */
  lastAccountedAt?: number;
  /**
   * When the Deployment last took a record of this session's: an event acknowledged, or a transcript segment
   * acknowledged or resliced. A blob alone is not a delivery: the record it belongs to may yet be refused. What a
   * report shows as the session's last delivery.
   */
  lastDeliveryAt?: number;
  /**
   * What the session's hooks asked the member helper to fetch from the Deployment (`member/context-cache.ts`): kept
   * here, written with the hook's own records, until the helper has asked.
   */
  contextAsks?: ContextAsk[];
  /** A transcript the member helper is to read prompts from (`member/transcript-prompts.ts`), and when it was asked. */
  promptBackfill?: { transcriptPath: string; at: number };
  /** When a hook last appended for this session: how a pass tells a live session from one its harness left. */
  hookAt?: number;
  /** When the session's end hook ran: nothing of its transcript waits on a turn's end after it. */
  endedAt?: number;
  /** The prompt whose served context a prompt of this session has rendered: each answer is rendered once. */
  renderedPrompt?: string;
  updatedAt: number;
  /** Loss dispositions queued by the current receipt mutation, flushed before that receipt is committed. */
  pendingLosses?: CaptureLoss[];
}

/** Every transcript pointer a session holds: its own, then the subagent transcripts beside it. */
export const pointersOf = (state: SessionState): TranscriptPointer[] =>
  [...(state.transcript ? [state.transcript] : []), ...Object.values(state.siblings)];

/** Whether a transcript holds bytes on disk past what the Deployment acknowledged, and may still be sent them. */
export function pointerBehind(pointer: TranscriptPointer): boolean {
  if (pointer.refused !== undefined) return false;
  try {
    return fs.statSync(pointer.path).size > pointer.nextOffset;
  } catch {
    return false;
  }
}

export function emptySessionState(now: number = Date.now()): SessionState {
  return { version: SESSION_STATE_VERSION, highWater: 0, prompts: {}, siblings: {}, planHashes: {}, planTagCount: 0, planPaths: {}, attachmentKeys: [], delivered: [], compactionOrdinal: 0, updatedAt: now };
}

export function sessionStatePath(spoolDir: string, sessionId: string): string {
  return path.join(spoolDir, `${sessionId}.state.json`);
}

/**
 * A session's turn-end marks file (`TurnEndMark`), `.<session>.turns`: apart from its journal, and not a `*.jsonl`,
 * so no build lists it as a session's journal (#1561 D8).
 */
export function turnsFileOf(spoolDir: string, sessionId: string): string {
  return path.join(spoolDir, `.${sessionId}.turns`);
}

/** The buffer lock companion `EventBuffer` serializes appends on; session-state shares it. */
export function bufferLockPath(spoolDir: string, sessionId: string): string {
  return path.join(spoolDir, `.${sessionId}.lock`);
}

function isState(value: unknown): value is SessionState {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return s.version === SESSION_STATE_VERSION && typeof s.highWater === 'number' && typeof s.prompts === 'object' && s.prompts !== null;
}

/** Why a state file yielded no state: absent, refused by its mode, unparsable, or parsed but not a state. */
export type SessionStateRefusal = 'missing' | 'unreadable' | 'loose-mode' | 'malformed' | 'invalid';

export type SessionStateRead =
  | { ok: true; state: SessionState }
  | { ok: false; reason: SessionStateRefusal; detail?: string };

/** The one parse, schema check and default merge over a state file; both readers below derive from it. */
function readStateFile(spoolDir: string, sessionId: string): SessionStateRead {
  const read = readPrivateJson<SessionState>(sessionStatePath(spoolDir, sessionId));
  if (!read.ok) return { ok: false, reason: read.reason, detail: read.detail };
  if (!isState(read.value)) return { ok: false, reason: 'invalid', detail: 'not a session state' };
  return { ok: true, state: { ...emptySessionState(), ...read.value } };
}

/** An instant a surface can render: finite, and a date. */
const rendersAsInstant = (value: unknown): boolean =>
  typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime());

/** Diagnostic state requires a non-negative whole high-water mark and a renderable acknowledgement timestamp. */
export function readSessionStateResultUnlocked(spoolDir: string, sessionId: string): SessionStateRead {
  const read = readStateFile(spoolDir, sessionId);
  if (!read.ok) return read;
  const { highWater, lastAckAt, lastDeliveryAt } = read.state;
  const reportable = Number.isSafeInteger(highWater) && highWater >= 0
    && (lastAckAt === undefined || rendersAsInstant(lastAckAt))
    && (lastDeliveryAt === undefined || rendersAsInstant(lastDeliveryAt));
  return reportable ? read : { ok: false, reason: 'invalid', detail: 'a reported field is not a number a report can use' };
}

/** The state as last written; a missing, loose-moded, malformed or invalid file reads as empty (all but missing with one stderr line). */
export function readSessionStateUnlocked(spoolDir: string, sessionId: string): SessionState {
  const read = readStateFile(spoolDir, sessionId);
  if (read.ok) return read.state;
  if (read.reason !== 'missing') {
    reportSkippedPrivateFile('session state', sessionStatePath(spoolDir, sessionId),
      { reason: read.reason === 'invalid' ? 'malformed' : read.reason, detail: read.detail });
  }
  return emptySessionState();
}

function trimTracked(state: SessionState): void {
  const promptKeys = Object.keys(state.prompts);
  if (promptKeys.length > MAX_TRACKED) {
    for (const key of promptKeys.slice(0, promptKeys.length - MAX_TRACKED)) delete state.prompts[key];
  }
  const planKeys = Object.keys(state.planHashes);
  if (planKeys.length > MAX_TRACKED) {
    for (const key of planKeys.slice(0, planKeys.length - MAX_TRACKED)) delete state.planHashes[key];
  }
  const pathKeys = Object.keys(state.planPaths).filter((key) => state.planPaths[key].pendingRead === undefined);
  if (pathKeys.length > MAX_TRACKED) {
    for (const key of pathKeys.slice(0, pathKeys.length - MAX_TRACKED)) delete state.planPaths[key];
  }
  const siblingKeys = Object.keys(state.siblings);
  if (siblingKeys.length > MAX_TRACKED) {
    for (const key of siblingKeys.slice(0, siblingKeys.length - MAX_TRACKED)) delete state.siblings[key];
  }
  if (state.attachmentKeys.length > MAX_TRACKED) state.attachmentKeys = state.attachmentKeys.slice(-MAX_TRACKED);
  if (state.delivered.length > MAX_TRACKED) state.delivered = state.delivered.slice(-MAX_TRACKED);
}

/** Write the state atomically (0600). Callers hold the buffer lock, or run inside a callback that already does. */
export function writeSessionStateUnlocked(spoolDir: string, sessionId: string, state: SessionState, now: number = Date.now()): void {
  if (state.pendingLosses !== undefined) {
    new CaptureLossLedger(spoolDir).record(state.pendingLosses);
    delete state.pendingLosses;
  }
  trimTracked(state);
  state.updatedAt = now;
  writePrivateFileAtomic(sessionStatePath(spoolDir, sessionId), JSON.stringify(state));
}

/** Read under the buffer lock. */
export function readSessionState(spoolDir: string, sessionId: string): SessionState {
  const lock = bufferLockPath(spoolDir, sessionId);
  ensurePrivateFile(lock);
  return withFileLockSync(lock, () => readSessionStateUnlocked(spoolDir, sessionId));
}

/** The state, or why it could not be used, read under the buffer lock. A lock this process cannot take throws, as it does for every other reader here. */
export function readSessionStateResult(spoolDir: string, sessionId: string): SessionStateRead {
  const lock = bufferLockPath(spoolDir, sessionId);
  ensurePrivateFile(lock);
  return withFileLockSync(lock, () => readSessionStateResultUnlocked(spoolDir, sessionId));
}

/** Locked read-modify-write: `mutate` sees the current state and its edits are written back before the lock is released. */
export function updateSessionState(spoolDir: string, sessionId: string, mutate: (state: SessionState) => void, now: number = Date.now()): SessionState {
  const lock = bufferLockPath(spoolDir, sessionId);
  ensurePrivateFile(lock);
  return withFileLockSync(lock, () => {
    const state = readSessionStateUnlocked(spoolDir, sessionId);
    mutate(state);
    writeSessionStateUnlocked(spoolDir, sessionId, state, now);
    return state;
  });
}

/** Whether a wait after a transient refusal still runs at `now`. */
export const retryWaiting = (retry: RefusalRetry | undefined, now: number): boolean => retry !== undefined && retry.at > now;

/**
 * Start or lengthen a session's wait after a hold: `REFUSAL_RETRY_INITIAL_MS`,
 * then double the last wait, to `REFUSAL_RETRY_MAX_MS`. `unclassified` says
 * the hold's refusal named no cause, which extends the run of such holds; a
 * hold for any other cause ends it.
 */
export function deferAfterRefusal(spoolDir: string, sessionId: string, field: RetryField, now: number, cause: { unclassified: boolean } = { unclassified: false }): RefusalRetry {
  const state = updateSessionState(spoolDir, sessionId, (s) => {
    const previous = s[field];
    const backoffMs = nextBackoff(previous);
    const run = previous?.unclassified;
    s[field] = {
      at: now + backoffMs, backoffMs,
      ...(cause.unclassified ? { unclassified: { since: run?.since ?? now, backoffMs: nextBackoff(run) } } : {}),
    };
  }, now);
  return state[field]!;
}

/** End a session's wait: the records it held were delivered or let go. */
export function clearRefusalRetry(spoolDir: string, sessionId: string, field: RetryField, now: number): void {
  updateSessionState(spoolDir, sessionId, (s) => { delete s[field]; }, now);
}

/**
 * Retire a session the spool holds nothing more for: its state file and the lock companion that serialized it, removed
 * under that lock, and only when the session still has no journal and `stillRetired` still agrees, read under the
 * lock, with what the state says now. Whether anything was retired.
 *
 * The lock file goes last, and on POSIX while it is still held: a writer that was waiting on it wakes holding a lock on
 * a file no path names any more, sees that (`withFileLockSync` compares the file it holds with the one the path names),
 * and takes the lock again on a fresh file. It never shares the lock with one that opened the path after the unlink.
 * On Windows a lock file another process holds open cannot be deleted, so the unlink is attempted after the release
 * and fails, harmlessly, while anyone still has it open.
 */
export function retireSessionFiles(spoolDir: string, sessionId: string, stillRetired: (state: SessionState) => boolean): boolean {
  const lock = bufferLockPath(spoolDir, sessionId);
  const journal = path.join(spoolDir, `${sessionId}.jsonl`);
  if (!fs.existsSync(lock)) return false;
  const retired = withFileLockSync(lock, () => {
    if (fs.existsSync(journal)) return false;
    if (!stillRetired(readSessionStateUnlocked(spoolDir, sessionId))) return false;
    try { fs.unlinkSync(sessionStatePath(spoolDir, sessionId)); } catch { /* absent */ }
    // A mark is read against the state's transcript pointers: without them it has nothing left to wait for.
    try { fs.unlinkSync(turnsFileOf(spoolDir, sessionId)); } catch { /* absent */ }
    removeSessionContext(spoolDir, sessionId);
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(lock); } catch { /* absent */ }
    }
    return true;
  });
  if (retired && process.platform === 'win32') {
    try { fs.unlinkSync(lock); } catch { /* still open elsewhere: left for the next pass */ }
  }
  return retired;
}
