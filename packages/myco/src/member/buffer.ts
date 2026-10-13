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
    /**
     * Keep the lock companion when the journal is deleted. A session whose state outlives its journal (the member
     * spool) keeps locking the same file, and unlinking it would let a writer already waiting on the old file and one
     * opening the path now hold the lock together; that store retires the lock itself once nothing names the session.
     */
    private readonly opts: { keepLockCompanion?: boolean } = {},
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
    if (!this.opts.keepLockCompanion) removeBufferLockCompanion(this.bufferDir, this.sessionId);
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
   * callback; a buffer containing an unparseable line refuses outright (its
   * bytes cannot be proven disposable), unless `tolerate` accepts that line by
   * its position — a reader that has already logged the line as unreadable says
   * so, and the line then reads as `null` in `records`.
   *
   * Returns true when the file was deleted (the lock companion is reaped
   * with it, matching {@link delete}'s contract, unless the buffer keeps it).
   */
  deleteIfSync(shouldDelete: (records: Array<Record<string, unknown>>) => boolean): boolean;
  deleteIfSync(shouldDelete: (records: Array<Record<string, unknown> | null>) => boolean, opts: { tolerate: (lineIndex: number) => boolean }): boolean;
  deleteIfSync(
    shouldDelete: ((records: Array<Record<string, unknown>>) => boolean) | ((records: Array<Record<string, unknown> | null>) => boolean),
    opts: { tolerate?: (lineIndex: number) => boolean } = {},
  ): boolean {
    const deleted = withFileLockSync(this.lockPath, () => {
      let raw: string;
      try {
        raw = fs.readFileSync(this.filePath, 'utf-8');
      } catch {
        return false; // already gone — nothing to delete
      }
      const records: Array<Record<string, unknown> | null> = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          records.push(JSON.parse(trimmed) as Record<string, unknown>);
        } catch {
          // unparseable line — content not provably disposable unless the caller has accounted for it
          if (!opts.tolerate?.(records.length)) return false;
          records.push(null);
        }
      }
      // Without `tolerate` no line reads as null, so the narrower signature sees only records.
      if (!(shouldDelete as (records: Array<Record<string, unknown> | null>) => boolean)(records)) return false;
      fs.unlinkSync(this.filePath);
      return true;
    });
    if (deleted && !this.opts.keepLockCompanion) removeBufferLockCompanion(this.bufferDir, this.sessionId);
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
      .map((f) => path.basename(f, '.jsonl'));
  } catch {
    return [];
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
