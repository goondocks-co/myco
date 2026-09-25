/**
 * Per-session member state under the spool dir: the spool high-water, the
 * current prompt, the prompts already captured, the transcript pointer, and
 * the derived-id bookkeeping the Stop/SessionEnd transcript work needs. Read
 * and modified under the session's buffer lock — hooks run concurrently.
 */
import fs from 'node:fs';
import path from 'node:path';
import { withFileLockSync } from '../utils/lifecycle-lock.js';
import { ensurePrivateFile, readPrivateJson, reportSkippedPrivateFile, writePrivateFileAtomic } from './store.js';

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
}

export interface SessionState {
  version: typeof SESSION_STATE_VERSION;
  /** Spool records (from the start of the current file) acknowledged: acked or refused. */
  highWater: number;
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
  /** normalized path → the key and the content hash last shipped for every plan file this session has captured; Stop re-reads them. */
  planPaths: Record<string, { planKey: string; hash: string }>;
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
  /** When this session first appended to the spool; the clock retention measures from until an acknowledgement arrives. */
  startedAt?: number;
  /** When the server last acknowledged one of this session's records. */
  lastAckAt?: number;
  updatedAt: number;
}

export function emptySessionState(now: number = Date.now()): SessionState {
  return { version: SESSION_STATE_VERSION, highWater: 0, prompts: {}, siblings: {}, planHashes: {}, planTagCount: 0, planPaths: {}, attachmentKeys: [], delivered: [], compactionOrdinal: 0, updatedAt: now };
}

export function sessionStatePath(spoolDir: string, sessionId: string): string {
  return path.join(spoolDir, `${sessionId}.state.json`);
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
  const { highWater, lastAckAt } = read.state;
  const reportable = Number.isSafeInteger(highWater) && highWater >= 0 && (lastAckAt === undefined || rendersAsInstant(lastAckAt));
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
  const pathKeys = Object.keys(state.planPaths);
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

/** Remove a session's state file (after its spool is fully acknowledged and deleted, or on purge). */
export function removeSessionState(spoolDir: string, sessionId: string): void {
  try { fs.unlinkSync(sessionStatePath(spoolDir, sessionId)); } catch { /* absent */ }
}
