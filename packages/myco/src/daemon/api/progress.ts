import { randomUUID } from 'node:crypto';
import type { RouteResponse } from '../router.js';

/** Maximum number of concurrently tracked operations. */
const MAX_CONCURRENT_OPERATIONS = 10;

/** Time-to-live for completed/failed entries before cleanup (ms). */
const PROGRESS_TTL_MS = 5 * 60 * 1000;

export type ProgressStatus = 'running' | 'completed' | 'failed';

export interface ProgressEntry {
  token: string;
  type: string;
  status: ProgressStatus;
  percent?: number;
  message?: string;
  created: number;
  updated: number;
}

export class ProgressTracker {
  private entries = new Map<string, ProgressEntry>();

  /**
   * Create a new tracked operation. Returns the existing token if an
   * operation of the same type is already running (duplicate prevention).
   * Throws if the maximum concurrent operations limit is reached.
   */
  /**
   * Create a new tracked operation or return existing one.
   * Returns `{ token, isNew }` — if `isNew` is false, the operation
   * was already running and the caller should NOT launch it again.
   * Throws if the maximum concurrent operations limit is reached.
   */
  create(type: string): { token: string; isNew: boolean } {
    // Lazy cleanup of stale completed/failed entries before checking limits
    this.cleanup();

    // Duplicate prevention: if an operation of the same type is already running, return its token
    for (const entry of this.entries.values()) {
      if (entry.type === type && entry.status === 'running') {
        return { token: entry.token, isNew: false };
      }
    }

    // Enforce concurrency limit (count only running entries)
    const runningCount = [...this.entries.values()].filter((e) => e.status === 'running').length;
    if (runningCount >= MAX_CONCURRENT_OPERATIONS) {
      throw new Error(`Maximum concurrent operations reached (${MAX_CONCURRENT_OPERATIONS})`);
    }

    const token = randomUUID();
    const now = Date.now();
    this.entries.set(token, {
      token,
      type,
      status: 'running',
      created: now,
      updated: now,
    });
    return { token, isNew: true };
  }

  /**
   * Update progress for a tracked operation.
   */
  update(token: string, data: { percent?: number; message?: string; status?: ProgressStatus }): void {
    const entry = this.entries.get(token);
    if (!entry) return;

    if (data.percent !== undefined) entry.percent = data.percent;
    if (data.message !== undefined) entry.message = data.message;
    if (data.status !== undefined) entry.status = data.status;
    entry.updated = Date.now();
  }

  /**
   * Get the current state of a tracked operation.
   */
  get(token: string): ProgressEntry | undefined {
    return this.entries.get(token);
  }

  /**
   * Check whether any operations are currently running.
   */
  hasActiveOperations(): boolean {
    for (const entry of this.entries.values()) {
      if (entry.status === 'running') return true;
    }
    return false;
  }

  /**
   * Remove completed/failed entries older than PROGRESS_TTL_MS.
   */
  cleanup(): void {
    const cutoff = Date.now() - PROGRESS_TTL_MS;
    for (const [token, entry] of this.entries) {
      if (entry.status !== 'running' && entry.updated < cutoff) {
        this.entries.delete(token);
      }
    }
  }
}

export async function handleGetProgress(
  tracker: ProgressTracker,
  token: string,
): Promise<RouteResponse> {
  const entry = tracker.get(token);
  if (!entry) {
    return { status: 404, body: { error: 'not_found', message: 'Progress token not found' } };
  }
  return { body: entry };
}
