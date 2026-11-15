import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '@myco/utils/atomic-write.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import type { BinaryUpdateOutcome } from '@myco/upgrade/guarded-binary.js';
import { AUTOMATIC_UPDATE_PREFERENCE_FILE, writeUpdatePreferences } from '../../scripts/install-marker.mjs';
import { MACHINE_UPDATE_LEAVES, RELEASE_CHANNELS, validMachineUpdateValue, machineUpdateRequests, type MachineUpdateRequests } from '@goondocks/myco-shared/member-protocol';

export const AUTOMATIC_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const AUTOMATIC_UPDATE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
export interface AutomaticUpdateState {
  lastAttemptAt: number;
  lastOutcome: Pick<BinaryUpdateOutcome, 'kind'> & { version?: string; reason?: string };
}
const statePath = (home: string) => path.join(home, 'member', 'keep-current.json');
const PREFERENCE_WAIT_MS = 15_000;

/** Save the installation preference and make an enabled check due under the helper's lease. */
export function setAutomaticUpdates(home: string, enabled: boolean, waitMs = PREFERENCE_WAIT_MS): void {
  setUpdatePreferences(home, { automaticUpdates: enabled }, waitMs);
}

/** Apply update preferences under the automatic check's lease and make its next check due. */
export function setUpdatePreferences(home: string, preferences: { automaticUpdates?: boolean; channel?: string }, waitMs = PREFERENCE_WAIT_MS): void {
  changeUpdatePreferences(home, preferences, waitMs);
}

interface StoredUpdatePreferences {
  machineRequests?: Record<string, unknown>;
  changedAt?: Record<string, number>;
}

function storedUpdatePreferences(home: string): StoredUpdatePreferences {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(path.join(home, AUTOMATIC_UPDATE_PREFERENCE_FILE), 'utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid installation update preferences');
    return value as StoredUpdatePreferences;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

/** Receipts name requests this installation has applied or superseded with a later local command. */
export function readAppliedUpdateRequests(home: string, deployment: string): MachineUpdateRequests {
  return machineUpdateRequests(storedUpdatePreferences(home).machineRequests?.[deployment]);
}

type RemotePreferences = { deployment: string; requests: MachineUpdateRequests };

/** Apply pending preferences together, publishing their receipts atomically with their local values. */
export function applyMachineUpdateRequests(home: string, remote: RemotePreferences): void {
  for (const leaf of MACHINE_UPDATE_LEAVES) {
    const request = remote.requests[leaf];
    if (request !== undefined && !validMachineUpdateValue(leaf, request.value)) throw new Error(`Invalid ${leaf} request`);
  }
  if (Object.keys(remote.requests).length === 0) return;
  changeUpdatePreferences(home, { machineUpdate: remote }, 0);
}

function pendingUpdatePreferences(home: string, remote: RemotePreferences): { automaticUpdates?: boolean; channel?: string; machineUpdate: RemotePreferences } | null {
  const stored = storedUpdatePreferences(home);
  const applied = machineUpdateRequests(stored.machineRequests?.[remote.deployment]);
  const pending = Object.fromEntries(MACHINE_UPDATE_LEAVES.flatMap(leaf => {
    const request = remote.requests[leaf];
    return request === undefined || applied[leaf]?.id === request.id ? [] : [[leaf, request]];
  })) as MachineUpdateRequests;
  if (Object.keys(pending).length === 0) return null;
  const apply = (leaf: keyof MachineUpdateRequests) => pending[leaf] !== undefined && (pending[leaf]!.savedAt ?? 0) >= (stored.changedAt?.[leaf] ?? 0);
  return {
    ...(!apply('update.automatic') ? {} : { automaticUpdates: pending['update.automatic']!.value as boolean }),
    ...(!apply('update.channel') ? {} : { channel: pending['update.channel']!.value as string }),
    machineUpdate: { deployment: remote.deployment, requests: pending },
  };
}

function changeUpdatePreferences(home: string, preferences: { automaticUpdates?: boolean; channel?: string; machineUpdate?: RemotePreferences }, waitMs: number): void {
  if (preferences.channel !== undefined && !RELEASE_CHANNELS.includes(preferences.channel as typeof RELEASE_CHANNELS[number])) throw new Error(`Invalid release channel; use ${RELEASE_CHANNELS.join(', ')}`);
  if (preferences.machineUpdate !== undefined && pendingUpdatePreferences(home, preferences.machineUpdate) === null) return;
  const acquired = LifecycleLock.acquire(`${statePath(home)}.lock`, {
    command: 'myco update preferences', wait: true, timeoutMs: waitMs,
  });
  if (!acquired.acquired) throw new Error('An automatic update is running; try again when it finishes.');
  try {
    const selected = preferences.machineUpdate === undefined ? preferences : pendingUpdatePreferences(home, preferences.machineUpdate);
    if (selected === null) return;
    const now = Date.now();
    const changedAt = preferences.machineUpdate === undefined ? {
      ...(selected.automaticUpdates === undefined ? {} : { 'update.automatic': now }),
      ...(selected.channel === undefined ? {} : { 'update.channel': now }),
    } : undefined;
    if (selected.automaticUpdates !== undefined || selected.channel !== undefined) fs.rmSync(statePath(home), { force: true });
    writeUpdatePreferences(home, { ...selected, ...(changedAt === undefined ? {} : { changedAt }) }, (file, text) => atomicWriteFileSync(file, text, { durable: true, mode: 0o600 }));
  } finally { acquired.lock.release(); }
}

/** Missing or damaged scheduling state is due on the next helper pass. */
export function readAutomaticUpdate(home: string): AutomaticUpdateState | null {
  let state: AutomaticUpdateState;
  try { state = JSON.parse(fs.readFileSync(statePath(home), 'utf8')); }
  catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (state === null || typeof state !== 'object' || !Number.isFinite(state.lastAttemptAt) || !Number.isFinite(new Date(state.lastAttemptAt).getTime()) || state.lastAttemptAt < 0
    || !state.lastOutcome || !['skipped', 'failed', 'adopted', 'already-current', 'rolled-back'].includes(state.lastOutcome.kind)
    || (state.lastOutcome.version !== undefined && typeof state.lastOutcome.version !== 'string')
    || (state.lastOutcome.reason !== undefined && typeof state.lastOutcome.reason !== 'string')
    || (['skipped', 'failed', 'rolled-back'].includes(state.lastOutcome.kind) && !state.lastOutcome.reason)
    || (['adopted', 'already-current', 'rolled-back'].includes(state.lastOutcome.kind) && !state.lastOutcome.version)) return null;
  return state;
}

/** Serialize the due check, attempt and atomic result across this home's helpers. */
export async function attemptAutomaticUpdate(
  home: string,
  now: () => number,
  attempt: () => Promise<BinaryUpdateOutcome>,
  afterAdoption?: (outcome: Extract<BinaryUpdateOutcome, { kind: 'adopted' }>) => Promise<void>,
): Promise<AutomaticUpdateState | null> {
  const acquired = LifecycleLock.acquire(`${statePath(home)}.lock`, { command: 'myco automatic update check' });
  if (!acquired.acquired) return null;
  try {
    const previous = readAutomaticUpdate(home);
    const lastAttemptAt = now();
    if (previous !== null && previous.lastAttemptAt <= lastAttemptAt + AUTOMATIC_UPDATE_CLOCK_SKEW_MS
      && lastAttemptAt - previous.lastAttemptAt < AUTOMATIC_UPDATE_INTERVAL_MS) return null;
    const write = (lastOutcome: AutomaticUpdateState['lastOutcome']) => {
      const state = { lastAttemptAt, lastOutcome };
      atomicWriteFileSync(statePath(home), JSON.stringify(state));
      return state;
    };
    write({ kind: 'failed', reason: 'the check did not finish' });
    let outcome: BinaryUpdateOutcome;
    try { outcome = await attempt(); }
    catch (error) { outcome = { kind: 'failed', reason: error instanceof Error ? error.message : String(error) }; }
    const lastOutcome = {
      kind: outcome.kind,
      ...('version' in outcome ? { version: outcome.version } : {}),
      ...('reason' in outcome ? { reason: outcome.reason } : {}),
    };
    let state = write(lastOutcome);
    if (outcome.kind === 'adopted' && afterAdoption !== undefined) {
      try { await afterAdoption(outcome); }
      catch (error) {
        state = write({ ...lastOutcome, reason: `agents could not be refreshed: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    return state;
  } finally { acquired.lock.release(); }
}

export function automaticUpdateWords(outcome: AutomaticUpdateState['lastOutcome']): string {
  const rawReason = outcome.reason?.replace(/[\r\n]+/g, ' ');
  const reason = rawReason?.startsWith('runtime pin selects another binary')
    ? `Another Myco build is selected for this machine${rawReason.startsWith('runtime pin selects another binary: ') ? ` (${rawReason.slice('runtime pin selects another binary: '.length)})` : ''}`
    : rawReason === 'development build' ? 'This is a development build'
    : rawReason === 'this is not the default Myco home' ? 'This installation uses a separately managed Myco home'
    : rawReason === 'an update is running' ? 'Another Myco update is in progress' : rawReason;
  switch (outcome.kind) {
    case 'adopted': return `updated to ${outcome.version}${reason ? `; ${reason}` : ''}`;
    case 'already-current': return `up to date at ${outcome.version}${reason ? ` (${reason})` : ''}`;
    case 'skipped': return `update skipped: ${reason}`;
    case 'failed': return `update failed: ${reason}`;
    case 'rolled-back': return `update rolled back to ${outcome.version}: ${reason}`;
  }
}
