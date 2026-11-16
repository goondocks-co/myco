import { canStartRequest, subRequestBudget, type HookBudget } from './budget.js';
import { machineUpdateState, seedMachineSettings } from './machine-settings.js';
import type { FetchLike } from './transport.js';

/** Each settings exchange shares the helper's deadline with capture delivery. */
const SETTINGS_EXCHANGE_CAP_MS = 2_000;

/** Read on each active helper pass and report newly applied requests before the pass ends. */
export async function syncMachineSettings(record: { serverUrl: string; token: string }, opts: {
  mycoHome: string; fetch: FetchLike; budget: HookBudget; now: () => number;
}): Promise<void> {
  const read = async () => {
    if (!canStartRequest(opts.budget, opts.now())) return false;
    return seedMachineSettings(record, {
      mycoHome: opts.mycoHome, fetch: opts.fetch,
      budget: subRequestBudget(opts.budget, SETTINGS_EXCHANGE_CAP_MS, opts.now()),
    });
  };
  const before = JSON.stringify(machineUpdateState(record.serverUrl, opts.mycoHome));
  await read();
  if (JSON.stringify(machineUpdateState(record.serverUrl, opts.mycoHome)) !== before) await read();
}
