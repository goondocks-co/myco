import fs from 'node:fs';
import path from 'node:path';
import { BUFFER_QUARANTINE_DIRNAME, removeBufferLockCompanion } from '@myco/member/buffer.js';
export * from '@myco/member/buffer.js';

/**
 * Per-session retention decision for `cleanStaleBuffers`:
 *
 *   - 'delete'    — remove immediately, regardless of age (tombstoned
 *                   sessions: the DB row was deliberately deleted).
 *   - 'age-gated' — remove only when older than `maxAgeMs` (sessions whose
 *                   buffer is fully converged into a closed DB row).
 *   - 'retain'    — keep (diverging buffers; convergence has not absorbed
 *                   every event yet). Subject ONLY to the hard retention
 *                   cap, which quarantines rather than deletes.
 */
export type BufferCleanupDecision = 'delete' | 'age-gated' | 'retain';

export interface CleanStaleBuffersOptions {
  /** Age gate (ms) for 'age-gated' files. */
  maxAgeMs: number;
  /** Skip this session (e.g., the currently active one). */
  excludeSessionId?: string;
  /**
   * Per-session retention decision; absent → every file is age-gated.
   * Receives the file's CURRENT (size, mtimeMs) identity so the caller
   * can require its converged mark to match — a file that changed since
   * the converged pass holds unreplayed events and must classify as
   * diverging ('retain'), never 'age-gated'.
   */
  classify?: (sessionId: string, identity: { size: number; mtimeMs: number }) => BufferCleanupDecision;
  /**
   * Hard retention cap for 'retain' files: a retained (diverging) buffer
   * idle past `maxAgeMs` is MOVED into the dir's `quarantine/` subdir —
   * never deleted, it may be the only durable copy of unreplayed events.
   */
  quarantine?: {
    maxAgeMs: number;
    /** Fires after a successful move with the file's new path. */
    onQuarantined?: (sessionId: string, quarantinedPath: string) => void;
  };
  /** Fires after each successful delete (cache eviction hook). */
  onRemoved?: (sessionId: string) => void;
}

/**
 * Move one buffer file into the dir's quarantine subdirectory, preserving
 * the filename (a name collision gains a `.N` suffix before the extension).
 * Returns the quarantined path.
 */
export function quarantineBufferFile(bufferDir: string, file: string, opts: { keepLockCompanion?: boolean } = {}): string {
  const quarantineDir = path.join(bufferDir, BUFFER_QUARANTINE_DIRNAME);
  fs.mkdirSync(quarantineDir, { recursive: true });
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  let target = path.join(quarantineDir, file);
  for (let n = 1; fs.existsSync(target); n++) {
    target = path.join(quarantineDir, `${base}.${n}${ext}`);
  }
  fs.renameSync(path.join(bufferDir, file), target);
  // The lock companion stays in the buffer dir on purpose (quarantined
  // files are never appended to again) — drop it with the move, unless the
  // session it locks lives on beside the quarantined journal.
  if (!opts.keepLockCompanion) removeBufferLockCompanion(bufferDir, base);
  return target;
}

/**
 * Delete quarantined buffer files idle past `maxAgeMs`. Callers pass
 * TOMBSTONE_RETENTION_MS so a quarantined copy never outlives the
 * tombstone window that prevents its session's resurrection.
 *
 * @returns count of files pruned
 */
export function pruneQuarantinedBuffers(bufferDir: string, maxAgeMs: number): number {
  const quarantineDir = path.join(bufferDir, BUFFER_QUARANTINE_DIRNAME);
  let pruned = 0;
  try {
    const cutoff = Date.now() - maxAgeMs;
    for (const file of fs.readdirSync(quarantineDir)) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = path.join(quarantineDir, file);
      try {
        if (fs.statSync(filePath).mtimeMs >= cutoff) continue;
        fs.unlinkSync(filePath);
        pruned++;
      } catch { /* concurrent removal — skip */ }
    }
  } catch { /* quarantine dir may not exist */ }
  return pruned;
}

/**
 * Remove buffer files per the retention policy.
 *
 * Without `classify`, every file is age-gated (the original mtime-only
 * behavior). Daemon callers pass the reconciler's convergence-aware
 * classifier so a diverging buffer — the only durable copy of unreplayed
 * events — is never deleted on age alone; the `quarantine` option completes
 * retention for those files by moving (not deleting) them once they pass
 * the hard cap.
 *
 * @returns count of files removed (deletes only; quarantine moves are
 *   reported through `onQuarantined`, not the return value)
 */
export function cleanStaleBuffers(
  bufferDir: string,
  options: CleanStaleBuffersOptions,
): number {
  const { maxAgeMs, excludeSessionId, classify, quarantine, onRemoved } = options;
  let removed = 0;
  try {
    const now = Date.now();
    const cutoff = now - maxAgeMs;
    for (const file of fs.readdirSync(bufferDir)) {
      if (!file.endsWith('.jsonl')) continue;
      if (excludeSessionId && file === `${excludeSessionId}.jsonl`) continue;
      const sessionId = file.replace('.jsonl', '');
      const filePath = path.join(bufferDir, file);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue; // concurrent removal
      }
      const identity = { size: stat.size, mtimeMs: stat.mtimeMs };
      const decision = classify ? classify(sessionId, identity) : 'age-gated';
      if (decision === 'retain') {
        if (!quarantine) continue;
        if (identity.mtimeMs >= now - quarantine.maxAgeMs) continue;
        try {
          const target = quarantineBufferFile(bufferDir, file);
          quarantine.onQuarantined?.(sessionId, target);
        } catch { /* move failed — retry next pass */ }
        continue;
      }
      if (decision === 'age-gated' && identity.mtimeMs >= cutoff) continue;
      fs.unlinkSync(filePath);
      removeBufferLockCompanion(bufferDir, sessionId);
      removed++;
      onRemoved?.(sessionId);
    }
    reapOrphanedBufferLocks(bufferDir, cutoff);
  } catch { /* buffer dir may not exist */ }
  return removed;
}

/**
 * Remove `.{sessionId}.lock` files whose buffer no longer exists. Covers
 * locks stranded by historical deletion sites (before lock cleanup was
 * paired with buffer removal) and by crashes between unlink and lock
 * cleanup. Age-gated by the same cutoff as buffer deletion: a freshly
 * created lock can precede its buffer's first append, so a young orphan
 * is left for the next pass.
 */
function reapOrphanedBufferLocks(bufferDir: string, cutoff: number): void {
  for (const file of fs.readdirSync(bufferDir)) {
    if (!file.startsWith('.') || !file.endsWith('.lock')) continue;
    const sessionId = file.slice(1, -'.lock'.length);
    if (!sessionId) continue;
    if (fs.existsSync(path.join(bufferDir, `${sessionId}.jsonl`))) continue;
    try {
      if (fs.statSync(path.join(bufferDir, file)).mtimeMs >= cutoff) continue;
      fs.unlinkSync(path.join(bufferDir, file));
    } catch { /* concurrent removal — skip */ }
  }
}
