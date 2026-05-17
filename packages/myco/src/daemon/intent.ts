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

function intentPath(daemonService: DaemonServiceState): string {
  return join(daemonService.stateDir, 'intent.toml');
}

export function readIntent(daemonService: DaemonServiceState): Intent {
  const p = intentPath(daemonService);
  if (!existsSync(p)) return {};
  try {
    return parse(readFileSync(p, 'utf-8')) as Intent;
  } catch {
    // Malformed intent file — treat as empty. The next writer
    // overwrites; no other behavior depends on its prior contents.
    return {};
  }
}

export function writeIntent(daemonService: DaemonServiceState, intent: Intent): void {
  atomicWriteFileSync(intentPath(daemonService), stringify(intent as Record<string, unknown>));
}

export function mergeIntent(daemonService: DaemonServiceState, patch: Intent): void {
  const current = readIntent(daemonService);
  writeIntent(daemonService, { ...current, ...patch });
}

export function clearIntentSection(daemonService: DaemonServiceState, section: keyof Intent): void {
  const current = readIntent(daemonService);
  delete current[section];
  if (Object.keys(current).length === 0) {
    try { unlinkSync(intentPath(daemonService)); } catch { /* already gone */ }
    return;
  }
  writeIntent(daemonService, current);
}
