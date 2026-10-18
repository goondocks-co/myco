import { spawnSync } from 'node:child_process';
import type { ReleaseFetch } from '@myco/upgrade/release-resolver.js';
import type { CommandRun } from '@myco/install/place-binary.js';

const UPDATE_COMMAND_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 2_147_483_647;

export class UpdateDeadlineExceeded extends Error {
  readonly code = 'MYCO_UPDATE_DEADLINE';
  constructor() { super('automatic update check ran out of time'); }
}

export interface UpdateDeadline {
  fetch?: ReleaseFetch;
  deadline?: number;
  now?: () => number;
}

/** Every request and executable probe shares the caller's remaining update budget. */
export function updateBudget(options: UpdateDeadline = {}) {
  const remaining = () => {
    const ms = options.deadline === undefined ? Infinity : options.deadline - (options.now ?? Date.now)();
    if (ms <= 0) throw new UpdateDeadlineExceeded();
    return ms;
  };
  const run: CommandRun = (command, args) => {
    const result = spawnSync(command, [...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: Math.max(1, Math.min(UPDATE_COMMAND_TIMEOUT_MS, remaining())),
    });
    remaining();
    return { status: result.status, signal: result.signal, error: result.error, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  };
  const fetch: ReleaseFetch = (input, init) => options.deadline === undefined
    ? (options.fetch ?? globalThis.fetch)(input, init)
    : (options.fetch ?? globalThis.fetch)(input, {
    ...init, signal: AbortSignal.any([
      ...(init?.signal ? [init.signal] : []),
      AbortSignal.timeout(Math.max(1, Math.min(MAX_TIMEOUT_MS, Math.floor(remaining())))),
    ]),
  });
  return { remaining, run, fetch };
}
