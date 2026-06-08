/**
 * Restore job registry.
 *
 * A restore of a large backup takes minutes (it executes the whole dump),
 * so it can't be the body of a synchronous HTTP request. Instead the POST
 * starts a job — spawning the out-of-process restore (restore-runner) — and
 * returns a job id immediately; the UI polls for status until it finishes.
 *
 * State is in-memory: restore is rare and a daemon restart mid-restore is an
 * acceptable loss (the child is orphaned, the merge is idempotent). One
 * running job per Grove is allowed — concurrent restores into the same DB
 * would only contend.
 */

import type { RestoreResult } from './engine.js';

export type RestoreJobStatus = 'running' | 'done' | 'error';

export interface RestoreJob {
  id: string;
  grove_id: string;
  file_name: string;
  status: RestoreJobStatus;
  started_at: number;
  finished_at?: number;
  result?: RestoreResult;
  error?: string;
}

/** How the heavy restore is actually executed (default: out-of-process child). */
export type RestoreExec = (params: { dbPath: string; backupPath: string }) => Promise<RestoreResult>;

export interface StartRestoreParams {
  groveId: string;
  fileName: string;
  dbPath: string;
  backupPath: string;
}

/** Finished jobs are retained this long so the UI can poll the final result. */
const FINISHED_JOB_RETENTION_MS = 30 * 60_000;

export class RestoreJobRegistry {
  private readonly jobs = new Map<string, RestoreJob>();
  private seq = 0;

  constructor(
    private readonly exec: RestoreExec,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The in-flight restore for a Grove, if one is running. */
  runningForGrove(groveId: string): RestoreJob | undefined {
    for (const job of this.jobs.values()) {
      if (job.grove_id === groveId && job.status === 'running') return job;
    }
    return undefined;
  }

  /** Drop finished jobs past their retention window so the map stays bounded. */
  private evictFinished(): void {
    const cutoff = this.now() - FINISHED_JOB_RETENTION_MS;
    for (const [id, job] of this.jobs) {
      if (job.status !== 'running' && (job.finished_at ?? job.started_at) < cutoff) {
        this.jobs.delete(id);
      }
    }
  }

  /**
   * Start a restore. Returns immediately with a `running` job; the heavy work
   * proceeds in the background and flips the job to `done`/`error` on
   * completion. Re-uses the in-flight job when one is already running for the
   * Grove, so a double-click doesn't launch two restores into one DB.
   */
  start(params: StartRestoreParams): RestoreJob {
    this.evictFinished();
    const existing = this.runningForGrove(params.groveId);
    if (existing) return existing;

    this.seq += 1;
    const job: RestoreJob = {
      id: `restore-${this.seq}-${this.now()}`,
      grove_id: params.groveId,
      file_name: params.fileName,
      status: 'running',
      started_at: this.now(),
    };
    this.jobs.set(job.id, job);

    this.exec({ dbPath: params.dbPath, backupPath: params.backupPath })
      .then((result) => {
        job.status = 'done';
        job.result = result;
        job.finished_at = this.now();
      })
      .catch((err: unknown) => {
        job.status = 'error';
        job.error = err instanceof Error ? err.message : String(err);
        job.finished_at = this.now();
      });

    return job;
  }

  get(id: string): RestoreJob | undefined {
    return this.jobs.get(id);
  }
}
