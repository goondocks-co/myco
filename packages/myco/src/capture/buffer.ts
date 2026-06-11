import fs from 'node:fs';
import path from 'node:path';
import { withFileLockSync } from '../utils/lifecycle-lock.js';

interface BufferOptions {
  maxEvents?: number;
}

export class EventBuffer {
  private filePath: string;
  private lockPath: string;
  private maxEvents: number;
  private eventCount = 0;

  constructor(
    private bufferDir: string,
    private sessionId: string,
    options: BufferOptions = {},
  ) {
    this.filePath = path.join(bufferDir, `${sessionId}.jsonl`);
    this.lockPath = path.join(bufferDir, `.${sessionId}.lock`);
    this.maxEvents = options.maxEvents ?? 500;

    // Ensure the buffer dir exists once at construction so the per-append
    // hot path doesn't repeat mkdirSync for every event.
    fs.mkdirSync(this.bufferDir, { recursive: true });

    if (fs.existsSync(this.filePath)) {
      const content = fs.readFileSync(this.filePath, 'utf-8').trim();
      this.eventCount = content ? content.split('\n').length : 0;
    }
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
    this.eventCount++;
  }

  readAll(): Array<Record<string, unknown>> {
    if (!fs.existsSync(this.filePath)) return [];
    const content = fs.readFileSync(this.filePath, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').map((line) => JSON.parse(line));
  }

  count(): number {
    return this.eventCount;
  }

  exists(): boolean {
    return fs.existsSync(this.filePath);
  }

  delete(): void {
    if (fs.existsSync(this.filePath)) {
      fs.unlinkSync(this.filePath);
    }
    this.eventCount = 0;
  }

  isOverflow(): boolean {
    return this.eventCount > this.maxEvents;
  }

  getFilePath(): string {
    return this.filePath;
  }
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
 *   - 'retain'    — never remove (diverging buffers; convergence has not
 *                   absorbed every event yet).
 */
export type BufferCleanupDecision = 'delete' | 'age-gated' | 'retain';

/**
 * Remove buffer files per the retention policy.
 *
 * Without `classify`, every file is age-gated (the original mtime-only
 * behavior). Daemon callers pass the reconciler's convergence-aware
 * classifier so a diverging buffer — the only durable copy of unreplayed
 * events — is never deleted on age alone.
 *
 * @param excludeSessionId - skip this session (e.g., the currently active one)
 * @returns count of files removed
 */
export function cleanStaleBuffers(
  bufferDir: string,
  maxAgeMs: number,
  excludeSessionId?: string,
  classify?: (sessionId: string) => BufferCleanupDecision,
): number {
  let removed = 0;
  try {
    const cutoff = Date.now() - maxAgeMs;
    for (const file of fs.readdirSync(bufferDir)) {
      if (!file.endsWith('.jsonl')) continue;
      if (excludeSessionId && file === `${excludeSessionId}.jsonl`) continue;
      const filePath = path.join(bufferDir, file);
      const decision = classify ? classify(file.replace('.jsonl', '')) : 'age-gated';
      if (decision === 'retain') continue;
      if (decision === 'age-gated') {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs >= cutoff) continue;
      }
      fs.unlinkSync(filePath);
      removed++;
    }
  } catch { /* buffer dir may not exist */ }
  return removed;
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
