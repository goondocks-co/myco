/**
 * Daemon intent files — one per section, atomic-rename per file.
 *
 * Two intent kinds the reconciler drains every tick:
 *   - [restart]  → `<stateDir>/intent.restart.toml`
 *   - [update]   → `<stateDir>/intent.update.toml`
 *
 * Each section is a single file written via atomicWriteFileSync. Concurrent
 * writers never read each other's section, so there is no read-modify-write
 * race like the single-file `intent.toml` had — a `myco restart` and a
 * `myco update --target-version` overlapping at the wall clock land in
 * separate files and both survive.
 *
 * Runtime shape guards (isRestartIntent / isUpdateIntent) reject malformed
 * but valid TOML — a structurally-wrong file is treated as empty, never
 * returned as an `Intent` via `as` cast.
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

export interface UpdateIntent {
  target_version: string;
  requested_at: string;
}

export interface Intent {
  restart?: RestartIntent;
  update?: UpdateIntent;
}

const RESTART_INTENT_FILENAME = 'intent.restart.toml';
const UPDATE_INTENT_FILENAME = 'intent.update.toml';

function restartIntentPath(daemonService: DaemonServiceState): string {
  return join(daemonService.stateDir, RESTART_INTENT_FILENAME);
}

function updateIntentPath(daemonService: DaemonServiceState): string {
  return join(daemonService.stateDir, UPDATE_INTENT_FILENAME);
}

function isRestartIntent(value: unknown): value is RestartIntent {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.requested_at !== 'string') return false;
  if (v.reason !== undefined && typeof v.reason !== 'string') return false;
  return true;
}

function isUpdateIntent(value: unknown): value is UpdateIntent {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.target_version !== 'string' || v.target_version === '') return false;
  if (typeof v.requested_at !== 'string') return false;
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

export function readUpdateIntent(daemonService: DaemonServiceState): UpdateIntent | undefined {
  return readSectionFile(updateIntentPath(daemonService), isUpdateIntent);
}

export function readIntent(daemonService: DaemonServiceState): Intent {
  const restart = readRestartIntent(daemonService);
  const update = readUpdateIntent(daemonService);
  return {
    ...(restart ? { restart } : {}),
    ...(update ? { update } : {}),
  };
}

export function writeRestartIntent(daemonService: DaemonServiceState, intent: RestartIntent): void {
  atomicWriteFileSync(
    restartIntentPath(daemonService),
    stringify(intent as unknown as Record<string, unknown>),
    { mode: 0o600 },
  );
}

export function writeUpdateIntent(daemonService: DaemonServiceState, intent: UpdateIntent): void {
  atomicWriteFileSync(
    updateIntentPath(daemonService),
    stringify(intent as unknown as Record<string, unknown>),
    { mode: 0o600 },
  );
}

export function clearIntentSection(
  daemonService: DaemonServiceState,
  section: 'restart' | 'update',
): void {
  const filePath = section === 'restart'
    ? restartIntentPath(daemonService)
    : updateIntentPath(daemonService);
  try { unlinkSync(filePath); } catch { /* already gone */ }
}
