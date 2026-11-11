import type { ServerEnv } from './adapters.js';
import { availableLogin, fleetSelection, type FleetReport } from './worker-selection.js';
import { harnessCredentialAvailability } from './secrets.js';

/** What the recent fleet would run a task under with the current settings, or its current holder. */
export function fleetExecution(env: ServerEnv, task: string, reports: readonly FleetReport[], settings: ReadonlyMap<string, string>,
  login = availableLogin(harnessCredentialAvailability(env.db, env.wrappingKey))) {
  return fleetSelection(task, reports, settings, () => login);
}
