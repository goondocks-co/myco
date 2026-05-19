/**
 * Update-in-progress sentinel.
 *
 * Written by the orchestrator (`/api/update/apply` or `self-reconcile`)
 * when it spawns the update installer script. Honored by:
 *
 *  - `handleUpdateStatus`'s version-sync auto-restart path — won't fire
 *    a redundant `spawnRestartScript`/`scheduleShutdown` while an
 *    update is already in flight.
 *  - `self-reconcile`'s installUpdate path — won't fire a redundant
 *    `installUpdate` call from a PowerManager tick that observes an
 *    intent the script is already handling.
 *  - `handleUpdateApply` itself — second `/api/update/apply` call
 *    while the sentinel exists returns 409 instead of spawning a
 *    second script.
 *
 * Cleared by the new daemon at startup once it confirms its own
 * version matches the sentinel's `targetVersion`. Stale sentinels
 * older than `MAX_AGE_MS` are also cleared (the update presumably
 * failed; we don't want to block future updates forever).
 *
 * Stored as JSON at `<daemonStateDir>/update.in-progress` so it's a
 * sibling to `daemon.json` and `daemon.lock` and follows the same
 * `daemonService.stateDir` lifecycle.
 */

import fs from 'node:fs';
import path from 'node:path';

const FILE_NAME = 'update.in-progress';
const MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

export interface UpdateInProgressSentinel {
  targetVersion: string;
  startedAt: number;
  initiator: 'api/update/apply' | 'self-reconcile';
}

export function sentinelPath(stateDir: string): string {
  return path.join(stateDir, FILE_NAME);
}

export function write(stateDir: string, value: UpdateInProgressSentinel): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(sentinelPath(stateDir), JSON.stringify(value, null, 2) + '\n');
}

export function read(stateDir: string): UpdateInProgressSentinel | null {
  const file = sentinelPath(stateDir);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<UpdateInProgressSentinel>;
    if (typeof parsed.targetVersion !== 'string') return null;
    if (typeof parsed.startedAt !== 'number') return null;
    if (parsed.initiator !== 'api/update/apply' && parsed.initiator !== 'self-reconcile') return null;
    return parsed as UpdateInProgressSentinel;
  } catch {
    return null;
  }
}

export function clear(stateDir: string): void {
  const file = sentinelPath(stateDir);
  try { fs.unlinkSync(file); } catch { /* already gone */ }
}

/**
 * Check whether an update is currently in flight. Returns the sentinel
 * if present and not stale; returns null and removes a stale sentinel
 * as a side effect.
 */
export function inFlight(stateDir: string): UpdateInProgressSentinel | null {
  const s = read(stateDir);
  if (!s) return null;
  if (Date.now() - s.startedAt > MAX_AGE_MS) {
    clear(stateDir);
    return null;
  }
  return s;
}
