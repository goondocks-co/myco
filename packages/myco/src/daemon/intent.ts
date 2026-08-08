/**
 * Daemon intent files — one per section, atomic-rename per file.
 *
 * One intent kind the reconciler drains every tick:
 *   - [restart]  → `<stateDir>/intent.restart.toml`
 *
 * There is no `[update]` intent section: binary upgrades are driven
 * directly by `initiateAdopt` paths (idle-job sentinel, `api/upgrade`
 * apply, `myco upgrade` CLI) with no intent-indirection hop.
 *
 * Each section is a single file written via atomicWriteFileSync. Concurrent
 * writers never read each other's section, so there is no read-modify-write
 * race like the single-file `intent.toml` had.
 *
 * Runtime shape guards (isRestartIntent) reject malformed but valid TOML —
 * a structurally-wrong file is treated as empty, never returned as an
 * `Intent` via `as` cast.
 *
 * ## TRUST MODEL — these files drive code execution
 *
 * intent.restart.toml triggers the daemon to exit and be re-spawned by
 * the supervisor. The file is daemon-EXECUTED, not merely daemon-READ.
 *
 * Protections (single-machine, single-user trust boundary):
 *   - Files live under `~/.myco/service/` (chmod 0o700 — see
 *     `service-state.ts:writeDaemonState`) so directory enumeration is
 *     restricted to the owner.
 *   - Each file is chmod 0o600 (see writers below) so even with
 *     directory descend, the bytes are owner-only.
 *   - `isRestartIntent` shape guards reject structurally-malformed TOML
 *     before the reconciler reads it as an `Intent`.
 *
 * Any future writer of these files must preserve the chmod 0o600 gate.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import type { DaemonServiceState } from './service-state.js';

export interface RestartIntent {
  requested_at: string; // ISO8601
  reason?: string;
}

export interface Intent {
  restart?: RestartIntent;
}

const RESTART_INTENT_FILENAME = 'intent.restart.toml';

function restartIntentPath(daemonService: DaemonServiceState): string {
  return join(daemonService.stateDir, RESTART_INTENT_FILENAME);
}

function isRestartIntent(value: unknown): value is RestartIntent {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.requested_at !== 'string') return false;
  if (v.reason !== undefined && typeof v.reason !== 'string') return false;
  return true;
}

function readSectionFile<T>(filePath: string, guard: (value: unknown) => value is T): T | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const parsed = parse(readFileSync(filePath, 'utf-8'));
    return guard(parsed) ? parsed : undefined;
  } catch {
    // Malformed TOML — treat as absent. The next writer overwrites.
    return undefined;
  }
}

export function readRestartIntent(daemonService: DaemonServiceState): RestartIntent | undefined {
  return readSectionFile(restartIntentPath(daemonService), isRestartIntent);
}

export function readIntent(daemonService: DaemonServiceState): Intent {
  const restart = readRestartIntent(daemonService);
  return {
    ...(restart ? { restart } : {}),
  };
}

export function writeRestartIntent(daemonService: DaemonServiceState, intent: RestartIntent): void {
  atomicWriteFileSync(
    restartIntentPath(daemonService),
    stringify(intent as unknown as Record<string, unknown>),
    { mode: 0o600 },
  );
}

export function clearRestartIntent(daemonService: DaemonServiceState): void {
  try { unlinkSync(restartIntentPath(daemonService)); } catch { /* already gone */ }
}
