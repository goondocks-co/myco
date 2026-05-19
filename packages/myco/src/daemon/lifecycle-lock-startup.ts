/**
 * Daemon-startup entry that gates on `LifecycleLock`.
 *
 * Sole authoritative check for "is another daemon already running?" —
 * runs before any SQLite open, schema write, or HTTP bind. When the
 * lock is denied, the caller decides whether to step aside (holder
 * healthy) or evict (holder unhealthy/dead); this module does not
 * make that policy decision.
 */

import {
  LifecycleLock,
  type AcquireOptions,
  type LockHandle,
  type LockHolder,
} from '../utils/lifecycle-lock.js';

export type { LockHandle, LockHolder } from '../utils/lifecycle-lock.js';

export interface AttemptDaemonStartupOptions {
  /** Path to the daemon lockfile. Typically
   *  `~/.myco/<variant>/daemon.lock`. */
  lockPath: string;
  /** Path to the Grove database. Surfaced on the options shape so
   *  future phases can verify the lock holder owns the DB the caller
   *  is about to open; unused today. */
  databasePath: string;
  /** Optional override for the command string written to the lock
   *  file. Defaults to `process.argv.join(' ')`. */
  command?: string;
  /** If non-zero and the first acquire is denied, poll on a short
   *  interval until the budget elapses. Lets a respawn (e.g. `myco
   *  update` post-install, `launchctl bootout` followed by a new
   *  daemon) tolerate the brief window where the prior holder is
   *  mid-SIGTERM. Default 0 (one-shot). */
  waitForReleaseMs?: number;
  /** Interval between poll attempts when `waitForReleaseMs` is set. */
  pollIntervalMs?: number;
}

export interface AttemptDaemonStartupAcquired {
  outcome: 'acquired';
  lock: LockHandle;
}

export interface AttemptDaemonStartupRefused {
  outcome: 'refused';
  holder: LockHolder | null;
  holderPid: number | null;
  reason: string;
}

export type AttemptDaemonStartupResult =
  | AttemptDaemonStartupAcquired
  | AttemptDaemonStartupRefused;

export async function attemptDaemonStartup(
  opts: AttemptDaemonStartupOptions,
): Promise<AttemptDaemonStartupResult> {
  const acquireOpts: AcquireOptions = {};
  if (opts.command !== undefined) acquireOpts.command = opts.command;
  const waitBudgetMs = Math.max(0, opts.waitForReleaseMs ?? 0);
  const pollIntervalMs = Math.max(10, opts.pollIntervalMs ?? 100);
  const deadline = Date.now() + waitBudgetMs;

  let lastResult = LifecycleLock.acquire(opts.lockPath, acquireOpts);
  while (!lastResult.acquired && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
    lastResult = LifecycleLock.acquire(opts.lockPath, acquireOpts);
  }

  if (lastResult.acquired) {
    return { outcome: 'acquired', lock: lastResult.lock };
  }
  return {
    outcome: 'refused',
    holder: lastResult.holder,
    holderPid: lastResult.holderPid,
    reason:
      lastResult.holderPid !== null
        ? `another daemon is running (pid ${lastResult.holderPid})`
        : 'another daemon is running (holder pid unavailable)',
  };
}
