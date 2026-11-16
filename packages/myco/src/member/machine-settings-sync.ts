import { MACHINE_SETTINGS_FEATURE, MACHINE_SETTINGS_HEADER, MACHINE_UPDATE_HEADER, PROTOCOL_HEADER } from '@goondocks/myco-shared/member-protocol';
import { canStartRequest, subRequestBudget, type HookBudget } from './budget.js';
import { machineSettingsExchange, machineSettingsReportPending, seedMachineSettings } from './machine-settings.js';
import { memberServerDialUrl } from './server-url.js';
import { terminalText } from '@myco/utils/terminal-text.js';
import type { FetchLike } from './transport.js';

const SETTINGS_EXCHANGE_CAP_MS = 2_000;

/** Capture carries settings; a final applied receipt gets one acknowledgement when no later delivery carried it. */
export function machineSettingsDelivery(serverUrl: string, home: string, fetchImpl: FetchLike, now: () => number) {
  const target = memberServerDialUrl(serverUrl).replace(/\/$/, '');
  const advisory = async <T>(work: () => T | Promise<T>): Promise<T | undefined> => {
    try { return await work(); }
    catch (error) { process.stderr.write(`[myco] member: machine settings exchange failed: ${terminalText(String(error))}\n`); }
  };
  const fetch: FetchLike = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    const route = url.startsWith(`${target}/`) ? url.slice(target.length) : '';
    const paired = (route === '/events' || route.startsWith('/blobs/') || route === '/members/harnesses/report')
      && headers.has(PROTOCOL_HEADER) && !headers.has(MACHINE_SETTINGS_HEADER);
    const exchange = paired ? await advisory(() => machineSettingsExchange(serverUrl, home)) : undefined;
    const response = await fetchImpl(input, exchange === undefined ? init : {
      ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), ...exchange.headers },
    });
    if (exchange !== undefined && response.status === 200 && response.headers.has(PROTOCOL_HEADER)) {
      await advisory(async () => {
        const body = response.headers.get(MACHINE_SETTINGS_HEADER) === MACHINE_SETTINGS_FEATURE
          ? await response.clone().json() as { machine?: unknown } : {};
        exchange.receive({ machine: body.machine, acknowledged: response.headers.get(MACHINE_UPDATE_HEADER), at: now() });
      });
    }
    return response;
  };
  return {
    fetch,
    async flush(readRecord: () => { serverUrl: string; token: string } | null, budget: HookBudget): Promise<void> {
      if (canStartRequest(budget, now()) && machineSettingsReportPending(serverUrl, home)) {
        const record = readRecord();
        if (record !== null) await seedMachineSettings(record, { mycoHome: home, fetch, budget: subRequestBudget(budget, SETTINGS_EXCHANGE_CAP_MS, now()) });
      }
    },
  };
}
