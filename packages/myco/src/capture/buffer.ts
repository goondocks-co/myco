import fs from 'node:fs';
import path from 'node:path';
import { withFileLockSync } from '../utils/lifecycle-lock.js';

/**
 * Subdirectory of a buffer dir holding quarantined (hard-retention-capped
 * diverging) buffer files. Excluded from every buffer enumeration — the
 * listing/locating helpers below only look at `*.jsonl` entries directly
 * inside the buffer dir and never descend.
 */
export const BUFFER_QUARANTINE_DIRNAME = 'quarantine';

export class EventBuffer {
  private filePath: string;
  private lockPath: string;

  constructor(
    private bufferDir: string,
    private sessionId: string,
  ) {
    this.filePath = path.join(bufferDir, `${sessionId}.jsonl`);
    this.lockPath = path.join(bufferDir, `.${sessionId}.lock`);

    // Ensure the buffer dir exists once at construction so the per-append
    // hot path doesn't repeat mkdirSync for every event.
    fs.mkdirSync(this.bufferDir, { recursive: true });
  }

  /**
   * Append one event to the session's buffer journal.
   *
   * Two processes can reach this method for the same session: the
   * daemon's event dispatcher and the hook subprocess (fallback when
   * its HTTP POST fails). The flock around the write serializes those
   * callers so event lines never interleave at the byte level, even
   * for events that exceed PIPE_BUF.
   */
  append(event: Record<string, unknown>): void {
    const line = JSON.stringify({
      ...event,
      timestamp: event.timestamp ?? new Date().toISOString(),
    });

    withFileLockSync(this.lockPath, () => {
      fs.appendFileSync(this.filePath, line + '\n');
    });
  }

  readAll(): Array<Record<string, unknown>> {
    if (!fs.existsSync(this.filePath)) return [];
    const content = fs.readFileSync(this.filePath, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').map((line) => JSON.parse(line));
  }

  exists(): boolean {
    return fs.existsSync(this.filePath);
  }

  /**
   * UNLOCKED delete — safe ONLY for CONDEMNED buffers, where the caller has
   * already decided the content is disposable regardless of what any
   * concurrent writer might still append (stale-swept, tombstoned,
   * quarantined, or cascade-deleted buffers). It takes no flock, so it can
   * race `append()`'s locked write: a line landing between the caller's last
   * read and this unlink is destroyed. Any caller deleting a LIVE buffer
   * conditioned on its content — "remove iff every record is acked" — must
   * use {@link deleteIfSync} instead.
   */
  delete(): void {
    if (fs.existsSync(this.filePath)) {
      fs.unlinkSync(this.filePath);
    }
    removeBufferLockCompanion(this.bufferDir, this.sessionId);
  }

  /**
   * LOCKED conditional delete — the content-gated counterpart of
   * {@link delete}. `append()` serializes every writer (daemon dispatcher AND
   * the hook-fallback subprocess — a real cross-process appender) through an
   * exclusive flock on the lock companion, so an unlocked check-then-delete
   * has a window where a straggler append lands between the caller's read
   * and the unlink and is silently destroyed. This variant closes that
   * window: it holds the SAME flock the appender takes, RE-READS the buffer
   * inside the lock, and unlinks only when `shouldDelete(records)` approves
   * the exact state the unlink will act on. A concurrent appender therefore
   * either lands before the lock is acquired (the re-read sees its line and
   * the caller can refuse) or blocks until the delete decision is made — a
   * write can never fall between check and delete.
   *
   * Conservative refusals: a missing file returns false without invoking the
   * callback; a buffer containing any unparseable line refuses outright (its
   * bytes cannot be proven disposable).
   *
   * Returns true when the file was deleted (the lock companion is reaped
   * with it, matching {@link delete}'s contract).
   */
  deleteIfSync(shouldDelete: (records: Array<Record<string, unknown>>) => boolean): boolean {
    const deleted = withFileLockSync(this.lockPath, () => {
      let raw: string;
      try {
        raw = fs.readFileSync(this.filePath, 'utf-8');
      } catch {
        return false; // already gone — nothing to delete
      }
      const records: Array<Record<string, unknown>> = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          records.push(JSON.parse(trimmed) as Record<string, unknown>);
        } catch {
          return false; // unparseable line — content not provably disposable; refuse
        }
      }
      if (!shouldDelete(records)) return false;
      fs.unlinkSync(this.filePath);
      return true;
    });
    if (deleted) removeBufferLockCompanion(this.bufferDir, this.sessionId);
    return deleted;
  }

  getFilePath(): string {
    return this.filePath;
  }
}

/**
 * Best-effort removal of the `.{sessionId}.lock` companion that
 * `EventBuffer.append`'s flock leaves beside the buffer file. Every site
 * that unlinks or quarantines a buffer must also call this — the lock is
 * meaningless without its buffer and otherwise accumulates forever.
 *
 * Unlinking a lock another process currently flocks lets a subsequent
 * appender create a fresh inode at the same path and acquire instantly
 * (flock binds to the inode, not the path). Accepted: every caller is
 * removing a buffer that is condemned (stale, tombstoned, quarantined,
 * or cascade-deleted), and the reconciler tolerates a torn trailing
 * line by excluding it with a WARN.
 */
export function removeBufferLockCompanion(bufferDir: string, sessionId: string): void {
  try {
    fs.unlinkSync(path.join(bufferDir, `.${sessionId}.lock`));
  } catch { /* already gone or never created */ }
}

/**
 * List all session IDs that have buffer files in the given directory.
 * Returns an empty array if the directory doesn't exist.
 */
export function listBufferSessionIds(bufferDir: string): string[] {
  try {
    return fs.readdirSync(bufferDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.replace('.jsonl', ''));
  } catch {
    return [];
  }
}

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
export function quarantineBufferFile(bufferDir: string, file: string): string {
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
  // files are never appended to again) — drop it with the move.
  removeBufferLockCompanion(bufferDir, base);
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

/**
 * Find the most recently active session by buffer file mtime.
 * The UserPromptSubmit hook appends to the session's buffer on every prompt,
 * so the most recently modified buffer is the calling session.
 */
export function resolveSessionFromBuffer(bufferDir: string): string | undefined {
  try {
    let bestSession: string | undefined;
    let bestMtime = 0;
    for (const file of fs.readdirSync(bufferDir)) {
      if (!file.endsWith('.jsonl')) continue;
      const mtime = fs.statSync(path.join(bufferDir, file)).mtimeMs;
      if (mtime > bestMtime) {
        bestMtime = mtime;
        bestSession = file.replace('.jsonl', '');
      }
    }
    return bestSession;
  } catch {
    return undefined;
  }
}
