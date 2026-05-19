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

export function attemptDaemonStartup(
  opts: AttemptDaemonStartupOptions,
): AttemptDaemonStartupResult {
  const acquireOpts: AcquireOptions = {};
  if (opts.command !== undefined) acquireOpts.command = opts.command;
  const result = LifecycleLock.acquire(opts.lockPath, acquireOpts);
  if (result.acquired) {
    return { outcome: 'acquired', lock: result.lock };
  }
  return {
    outcome: 'refused',
    holder: result.holder,
    holderPid: result.holderPid,
    reason:
      result.holderPid !== null
        ? `another daemon is running (pid ${result.holderPid})`
        : 'another daemon is running (holder pid unavailable)',
  };
}
