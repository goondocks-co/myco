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
  /** The next byte offset to ship; the server's held size after an ack. */
  nextOffset: number;
  /** Bytes of the transcript already parsed for transcript-derived capture. */
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
  /** sha256(content) → planKey for every plan this session has emitted. */
  planHashes: Record<string, string>;
  planTagCount: number;
  /** Blob keys of attachments already emitted. */
  attachmentKeys: string[];
  updatedAt: number;
}

export function emptySessionState(now: number = Date.now()): SessionState {
  return { version: SESSION_STATE_VERSION, highWater: 0, prompts: {}, planHashes: {}, planTagCount: 0, attachmentKeys: [], updatedAt: now };
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

/** The state as last written; a missing, loose-moded, or malformed file reads as empty (the latter two with one stderr line). */
export function readSessionStateUnlocked(spoolDir: string, sessionId: string): SessionState {
  const file = sessionStatePath(spoolDir, sessionId);
  const read = readPrivateJson<SessionState>(file);
  if (!read.ok) {
    if (read.reason !== 'missing') reportSkippedPrivateFile('session state', file, read);
    return emptySessionState();
  }
  if (!isState(read.value)) {
    reportSkippedPrivateFile('session state', file, { reason: 'malformed', detail: 'not a session state' });
    return emptySessionState();
  }
  return { ...emptySessionState(), ...read.value };
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
  if (state.attachmentKeys.length > MAX_TRACKED) state.attachmentKeys = state.attachmentKeys.slice(-MAX_TRACKED);
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
