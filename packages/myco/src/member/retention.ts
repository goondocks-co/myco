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
 * never finished left behind — but never bytes young enough that a live hook
 * could still commit a record naming them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BUFFER_QUARANTINE_DIRNAME, pruneQuarantinedBuffers, quarantineBufferFile } from '../capture/buffer.js';
import { longestDeclaredHookTimeoutMs } from './budget.js';
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

/**
 * Delete staged blob bytes nothing references, and the staging dir of a session
 * whose spool is gone.
 *
 * "Nothing references" is only knowable for bytes no live hook could still
 * name. A hook stages during its parse and commits the record — and the
 * receipt that stops it being derived again — later; retention runs from a
 * DIFFERENT session's probing hook and sees neither. Deleting a file staged
 * seconds ago therefore destroys what a hook in another session is about to
 * reference, and its receipt makes that permanent. Anything younger than the
 * longest timeout a hook can declare is left alone: past that the harness has
 * killed whoever staged it, so "unreferenced" is a fact rather than a race.
 */
export function sweepStagedBlobs(spool: MemberSpool, sessionIds: readonly string[], now: number = Date.now()): number {
  let released = 0;
  let staged: fs.Dirent[];
  try {
    staged = fs.readdirSync(spool.blobsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const settled = now - longestDeclaredHookTimeoutMs();
  const reclaim = (file: string): void => {
    try {
      if (fs.statSync(file).mtimeMs > settled) return;
      fs.unlinkSync(file);
      released += 1;
    } catch { /* already gone */ }
  };
  const live = new Set(sessionIds);
  for (const entry of staged) {
    // Bytes a project-wide-dir build staged sit directly under `blobs/`; no
    // record of this build names them by that path, so they are reclaimable.
    if (!entry.isDirectory()) {
      reclaim(path.join(spool.blobsDir, entry.name));
      continue;
    }
    const dir = spool.blobsDirFor(entry.name);
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const referenced = new Set<string>();
    if (live.has(entry.name)) {
      for (const record of spool.readRecords(entry.name)) {
        if (record?._blobSource) referenced.add(record._blobSource.sha256);
      }
    }
    for (const file of files) {
      if (referenced.has(file)) continue;
      reclaim(path.join(dir, file));
    }
    if (referenced.size === 0) {
      try { fs.rmdirSync(dir); } catch { /* not empty, or still in use */ }
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
  result.releasedBlobs = sweepStagedBlobs(spool, spool.sessionIds(), now);
  return result;
}
