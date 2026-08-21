/**
 * Spool retention: an un-acknowledged spool is never age-deleted. A session
 * spool with no acknowledgement for `MEMBER_SPOOL_QUARANTINE_MS` is moved into
 * the spool's `quarantine/` subdir (`quarantineBufferFile`), and quarantined
 * files older than `MEMBER_SPOOL_QUARANTINE_PRUNE_MS` are pruned
 * (`pruneQuarantinedBuffers`). "No acknowledgement" is measured on the later
 * of the file's last append and the session-state's last write — a session
 * that is still being drained is never quarantined.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BUFFER_QUARANTINE_DIRNAME, pruneQuarantinedBuffers, quarantineBufferFile } from '../capture/buffer.js';
import { MEMBER_DIR_MODE, MEMBER_SPOOL_QUARANTINE_MS, MEMBER_SPOOL_QUARANTINE_PRUNE_MS } from './constants.js';
import { readSessionState, removeSessionState, sessionStatePath } from './session-state.js';
import type { MemberSpool } from './spool.js';

export interface RetentionResult {
  quarantined: string[];
  pruned: number;
}

/** The instant a session's spool was last touched by an append or an acknowledgement. */
export function lastActivityAt(spool: MemberSpool, sessionId: string): number {
  let last = 0;
  try { last = Math.max(last, fs.statSync(path.join(spool.dir, `${sessionId}.jsonl`)).mtimeMs); } catch { /* no file */ }
  try { last = Math.max(last, fs.statSync(sessionStatePath(spool.dir, sessionId)).mtimeMs); } catch { /* no state */ }
  last = Math.max(last, readSessionState(spool.dir, sessionId).updatedAt);
  return last;
}

/** Quarantine every session spool idle past the cap, then prune quarantined files past the prune cap. Never deletes an un-acknowledged spool. */
export function applySpoolRetention(spool: MemberSpool, now: number = Date.now()): RetentionResult {
  const result: RetentionResult = { quarantined: [], pruned: 0 };
  for (const sessionId of spool.sessionIds()) {
    if (spool.depth(sessionId) === 0) continue;
    if (now - lastActivityAt(spool, sessionId) < MEMBER_SPOOL_QUARANTINE_MS) continue;
    const quarantineDir = path.join(spool.dir, BUFFER_QUARANTINE_DIRNAME);
    if (!fs.existsSync(quarantineDir)) fs.mkdirSync(quarantineDir, { mode: MEMBER_DIR_MODE });
    const target = quarantineBufferFile(spool.dir, `${sessionId}.jsonl`);
    removeSessionState(spool.dir, sessionId);
    result.quarantined.push(target);
    process.stderr.write(`[myco] member: spool for session ${sessionId} had no acknowledgement for ${Math.round(MEMBER_SPOOL_QUARANTINE_MS / 86_400_000)} days — quarantined at ${target}\n`);
  }
  result.pruned = pruneQuarantinedBuffers(spool.dir, MEMBER_SPOOL_QUARANTINE_PRUNE_MS);
  return result;
}
