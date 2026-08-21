/**
 * Spool retention: an un-acknowledged spool is never age-deleted. A session
 * spool the server has not acknowledged for `MEMBER_SPOOL_QUARANTINE_MS` is
 * moved into the spool's `quarantine/` subdir (`quarantineBufferFile`), and
 * quarantined files older than `MEMBER_SPOOL_QUARANTINE_PRUNE_MS` are pruned
 * (`pruneQuarantinedBuffers`).
 *
 * "No acknowledgement" is measured on the acknowledgement itself — the drain
 * stamps `lastAckAt` on every ack — falling back to the session's first append
 * until one arrives. File mtimes are not the clock: an append bumps them, so a
 * session that keeps writing while permanently offline would never age out,
 * which is exactly the session retention exists for.
 *
 * Staged blob bytes are swept here too: the drain releases a record's bytes
 * when its high-water advances, and this sweep collects whatever a drain that
 * never finished left behind.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BUFFER_QUARANTINE_DIRNAME, pruneQuarantinedBuffers, quarantineBufferFile } from '../capture/buffer.js';
import { MEMBER_DIR_MODE, MEMBER_SPOOL_QUARANTINE_MS, MEMBER_SPOOL_QUARANTINE_PRUNE_MS } from './constants.js';
import { readSessionState, removeSessionState } from './session-state.js';
import type { MemberSpool } from './spool.js';

export interface RetentionResult {
  quarantined: string[];
  pruned: number;
  /** Staged blob files deleted because no live spool record references them. */
  releasedBlobs: number;
}

/** When the server last acknowledged one of this session's records; 0 when it never has. */
export function lastAckAt(spool: MemberSpool, sessionId: string): number {
  return readSessionState(spool.dir, sessionId).lastAckAt ?? 0;
}

/**
 * The instant retention counts from: the last acknowledgement, or the
 * session's first append while there has been none. A spool file with neither
 * (written by an older build) falls back to its own mtime.
 */
export function unacknowledgedSince(spool: MemberSpool, sessionId: string): number {
  const state = readSessionState(spool.dir, sessionId);
  if (state.lastAckAt !== undefined) return state.lastAckAt;
  if (state.startedAt !== undefined) return state.startedAt;
  try {
    return fs.statSync(path.join(spool.dir, `${sessionId}.jsonl`)).mtimeMs;
  } catch {
    return 0;
  }
}

/** Delete staged blob bytes no record of that session still references, and the staging dir of a session whose spool is gone. */
export function sweepStagedBlobs(spool: MemberSpool, sessionIds: readonly string[]): number {
  let released = 0;
  let staged: string[];
  try {
    staged = fs.readdirSync(spool.blobsDir);
  } catch {
    return 0;
  }
  const live = new Set(sessionIds);
  for (const sessionId of staged) {
    const dir = spool.blobsDirFor(sessionId);
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const referenced = new Set<string>();
    if (live.has(sessionId)) {
      for (const record of spool.readRecords(sessionId)) {
        if (record?._blobSource) referenced.add(record._blobSource.sha256);
      }
    }
    for (const file of files) {
      if (referenced.has(file)) continue;
      try { fs.unlinkSync(path.join(dir, file)); released += 1; } catch { /* already gone */ }
    }
    if (referenced.size === 0) {
      try { fs.rmdirSync(dir); } catch { /* not empty, or in use */ }
    }
  }
  return released;
}

/** Quarantine every session spool unacknowledged past the cap, prune quarantined files past the prune cap, and release staged bytes nothing references. */
export function applySpoolRetention(spool: MemberSpool, now: number = Date.now()): RetentionResult {
  const result: RetentionResult = { quarantined: [], pruned: 0, releasedBlobs: 0 };
  for (const sessionId of spool.sessionIds()) {
    if (spool.depth(sessionId) === 0) continue;
    if (now - unacknowledgedSince(spool, sessionId) < MEMBER_SPOOL_QUARANTINE_MS) continue;
    const quarantineDir = path.join(spool.dir, BUFFER_QUARANTINE_DIRNAME);
    if (!fs.existsSync(quarantineDir)) fs.mkdirSync(quarantineDir, { mode: MEMBER_DIR_MODE });
    const target = quarantineBufferFile(spool.dir, `${sessionId}.jsonl`);
    removeSessionState(spool.dir, sessionId);
    result.quarantined.push(target);
    process.stderr.write(`[myco] member: spool for session ${sessionId} had no acknowledgement for ${Math.round(MEMBER_SPOOL_QUARANTINE_MS / 86_400_000)} days — quarantined at ${target}\n`);
  }
  result.pruned = pruneQuarantinedBuffers(spool.dir, MEMBER_SPOOL_QUARANTINE_PRUNE_MS);
  result.releasedBlobs = sweepStagedBlobs(spool, spool.sessionIds());
  return result;
}
