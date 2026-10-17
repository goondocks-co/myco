import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '@myco/utils/atomic-write.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import type { BinaryUpdateOutcome } from '@myco/upgrade/guarded-binary.js';
import { writeAutomaticUpdatePreference } from '@myco/install/managed-binary.js';

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
  const acquired = LifecycleLock.acquire(`${statePath(home)}.lock`, {
    command: 'myco update --automatic', wait: true, timeoutMs: waitMs,
  });
  if (!acquired.acquired) throw new Error('An automatic update is running; try again when it finishes.');
  try {
    if (enabled) fs.rmSync(statePath(home), { force: true });
    writeAutomaticUpdatePreference(home, enabled);
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
