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
 * could still commit a record naming them, and never the bytes a quarantined
 * spool references, which move into quarantine with it and are pruned with
 * it.
 *
 * Plugin-written transcripts age here too. They are the member's own store —
 * written by a native plugin for an agent whose runtime keeps no append-only
 * transcript of its own — so nothing else would ever delete them. A store any
 * manifest declares `retention: harness` is the agent's, holds the user's own
 * history, and is never touched by this pass.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BUFFER_QUARANTINE_DIRNAME, pruneQuarantinedBuffers, quarantineBufferFile } from '../capture/buffer.js';
import { longestDeclaredHookTimeoutMs } from './budget.js';
import { MEMBER_DIR_MODE, MEMBER_SPOOL_QUARANTINE_MS, MEMBER_SPOOL_QUARANTINE_PRUNE_MS, MEMBER_TRANSCRIPT_RETENTION_MS } from './constants.js';
import { resolveMycoHome } from '../paths/home.js';
import { BUNDLED_MANIFESTS } from '../symbionts/manifests.generated.js';
import { expandRoot } from '../symbionts/transcript-discovery.js';
import { readSessionState, removeSessionState } from './session-state.js';
import { BLOBS_DIRNAME, type MemberSpool } from './spool.js';

export interface RetentionResult {
  quarantined: string[];
  pruned: number;
  /** Staged blob files deleted because no live spool record references them. */
  releasedBlobs: number;
  /** Plugin-written transcripts deleted because they aged past the member window. */
  prunedTranscripts: number;
}

/**
 * The transcript roots the member owns, from the manifests that declare it.
 *
 * A store is pruned here only when its manifest says `retention: member` —
 * the agent whose plugin wrote it. Every other store belongs to its harness
 * and holds the user's own history, which this pass must never delete; the
 * declaration is what makes that a checkable boundary rather than a property
 * of where the loop happens to look.
 */
export function memberOwnedTranscriptRoots(env: NodeJS.ProcessEnv = process.env, mycoHome?: string): string[] {
  const roots: string[] = [];
  for (const manifest of BUNDLED_MANIFESTS) {
    const discovery = manifest.capture?.transcriptDiscovery;
    if (!discovery || discovery.retention !== 'member') continue;
    for (const root of discovery.roots) roots.push(expandRoot(root, env, mycoHome));
  }
  return roots;
}

/**
 * Delete plugin-written transcripts past the member's window.
 *
 * Age is the file's mtime: these files are append-only for the life of a
 * session, so a still-running session keeps bumping it and cannot be pruned
 * out from under itself.
 */
export function prunePluginTranscripts(
  now: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
  mycoHome?: string,
): number {
  let pruned = 0;
  // A claim names the instance that speaks for a session. It outlives nothing:
  // once past the window no runtime holds it and no transcript needs it.
  const claims = path.join(mycoHome ?? resolveMycoHome({ env }), 'member', 'claims');
  try {
    for (const entry of fs.readdirSync(claims, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.lock')) continue;
      const file = path.join(claims, entry.name);
      try {
        if (now - fs.statSync(file).mtimeMs < MEMBER_TRANSCRIPT_RETENTION_MS) continue;
        fs.unlinkSync(file);
      } catch { /* already gone */ }
    }
  } catch { /* no claims taken on this machine */ }
  for (const root of memberOwnedTranscriptRoots(env, mycoHome)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // no transcripts written for this agent yet
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const file = path.join(root, entry.name);
      try {
        if (now - fs.statSync(file).mtimeMs < MEMBER_TRANSCRIPT_RETENTION_MS) continue;
        fs.unlinkSync(file);
        pruned += 1;
      } catch { /* already gone, or not ours to remove */ }
    }
  }
  return pruned;
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

/**
 * Move a session's staged bytes with the spool that names them, under
 * `quarantine/blobs/<quarantined file's base name>`.
 *
 * A quarantined spool is RETAINED — it is the only durable copy of events
 * nothing acknowledged — so destroying the payloads it references would empty
 * it of exactly what it was kept for. The name follows the quarantined file
 * (which `quarantineBufferFile` may suffix on collision), so the two stay
 * paired and the prune can tie their lifetimes together.
 */
function quarantineStagedBlobs(spool: MemberSpool, sessionId: string, quarantinedFile: string): void {
  const from = spool.blobsDirFor(sessionId);
  if (!fs.existsSync(from)) return;
  const dir = path.join(spool.dir, BUFFER_QUARANTINE_DIRNAME, BLOBS_DIRNAME);
  fs.mkdirSync(dir, { recursive: true, mode: MEMBER_DIR_MODE });
  try {
    fs.renameSync(from, path.join(dir, path.basename(quarantinedFile, '.jsonl')));
  } catch { /* nothing staged, or already moved */ }
}

/** Delete quarantined staged bytes whose spool the prune has taken: the bytes live exactly as long as the events that name them. */
function pruneQuarantinedStagedBlobs(spool: MemberSpool): number {
  const quarantineDir = path.join(spool.dir, BUFFER_QUARANTINE_DIRNAME);
  const blobsDir = path.join(quarantineDir, BLOBS_DIRNAME);
  let pruned = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(blobsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (fs.existsSync(path.join(quarantineDir, `${entry.name}.jsonl`))) continue;
    try { fs.rmSync(path.join(blobsDir, entry.name), { recursive: true, force: true }); pruned += 1; } catch { /* concurrent removal */ }
  }
  return pruned;
}

/** Quarantine every session spool unacknowledged past the cap, prune quarantined files past the prune cap, and release staged bytes nothing references. */
export function applySpoolRetention(spool: MemberSpool, now: number = Date.now()): RetentionResult {
  const result: RetentionResult = { quarantined: [], pruned: 0, releasedBlobs: 0, prunedTranscripts: 0 };
  for (const sessionId of spool.sessionIds()) {
    if (spool.depth(sessionId) === 0) continue;
    if (now - unacknowledgedSince(spool, sessionId) < MEMBER_SPOOL_QUARANTINE_MS) continue;
    const quarantineDir = path.join(spool.dir, BUFFER_QUARANTINE_DIRNAME);
    if (!fs.existsSync(quarantineDir)) fs.mkdirSync(quarantineDir, { mode: MEMBER_DIR_MODE });
    const target = quarantineBufferFile(spool.dir, `${sessionId}.jsonl`);
    quarantineStagedBlobs(spool, sessionId, target);
    removeSessionState(spool.dir, sessionId);
    result.quarantined.push(target);
    process.stderr.write(`[myco] member: spool for session ${sessionId} had no acknowledgement for ${Math.round(MEMBER_SPOOL_QUARANTINE_MS / 86_400_000)} days — quarantined at ${target}\n`);
  }
  result.pruned = pruneQuarantinedBuffers(spool.dir, MEMBER_SPOOL_QUARANTINE_PRUNE_MS);
  // After the prune, whatever no quarantined spool still names goes with it.
  pruneQuarantinedStagedBlobs(spool);
  result.releasedBlobs = sweepStagedBlobs(spool, spool.sessionIds(), now);
  // The spool's OWN home: a hook resolving a project pin must not age the
  // claims and transcripts of whatever home the process's environment names.
  result.prunedTranscripts = prunePluginTranscripts(now, process.env, spool.mycoHome);
  return result;
}
