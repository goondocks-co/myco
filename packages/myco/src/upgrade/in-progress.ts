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

import path from 'node:path';
import { readJsonFile } from '../utils/json.js';
import { clearJsonSentinel, writeJsonSentinel } from '../utils/json-sentinel.js';

const FILE_NAME = 'update.in-progress';
const MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

export const UPDATE_INITIATORS = ['api/upgrade/apply', 'api/update/apply', 'self-reconcile', 'daemon'] as const;
export type UpdateInitiator = typeof UPDATE_INITIATORS[number];

export interface UpdateInProgressSentinel {
  targetVersion: string;
  startedAt: number;
  initiator: UpdateInitiator;
}

function isInitiator(value: unknown): value is UpdateInitiator {
  return typeof value === 'string'
    && (UPDATE_INITIATORS as readonly string[]).includes(value);
}

function isSentinel(value: unknown): value is UpdateInProgressSentinel {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<UpdateInProgressSentinel>;
  return typeof v.targetVersion === 'string'
    && typeof v.startedAt === 'number'
    && isInitiator(v.initiator);
}

export function sentinelPath(stateDir: string): string {
  return path.join(stateDir, FILE_NAME);
}

export function write(stateDir: string, value: UpdateInProgressSentinel): void {
  writeJsonSentinel(sentinelPath(stateDir), value);
}

export function read(stateDir: string): UpdateInProgressSentinel | null {
  return readJsonFile(sentinelPath(stateDir), isSentinel);
}

export function clear(stateDir: string): void {
  clearJsonSentinel(sentinelPath(stateDir));
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
