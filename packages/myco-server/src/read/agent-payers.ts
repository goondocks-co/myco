import { HARNESS_CREDENTIALS } from '@goondocks/myco-shared/harness-providers';
import { offersAgentInstalled, type RunnerCredentialChoice, type RunnerFallbackNotice } from '@goondocks/myco-shared/runner-fleet';
import type { ServerEnv } from '../core/adapters.js';
import { applyFleetSignInAvailability, fleetSelectionContext } from '../db/runs/fleet.js';
import { isStoredKeyFailure, type StoredKeyFailure } from '@goondocks/myco-shared/run-diagnostic';
import { readWorkerFleet, type WorkerFleetRow } from '../core/worker-contacts.js';
import { EXTRACTION_TASK } from '../core/task-catalogue.js';
import { chooseHarness, claimSettings, harnessPreference, selectExecution } from '../core/worker-selection.js';

/** One registered runner that offers an agent, and the sign-in it uses for it: null where it must be chosen again. */
export interface AgentPayer { id: string; name: string; choice: RunnerCredentialChoice | null }

/** `GET /api/runners/agents`: every agent a registered runner offers installed, who pays for it on each, and whether a stored key would work: a key the provider refused does not. */
export interface AgentPayers {
  agents: Array<{ agent: string; storedUsable: boolean; storedFailure?: StoredKeyFailure; fallbacks?: Array<RunnerFallbackNotice & { runnerId: string }>; runners: AgentPayer[] }>;
  /** The agent each registered runner would run learning from sessions with now, by the claim's preference rule; null where none it is signed in to is wanted. */
  today: Array<{ id: string; name: string; agent: string | null }>;
}

/** Every registered runner, of every page, whose last report offers `agent` installed, with its sign-in for it. */
export function runnersOffering(fleet: readonly WorkerFleetRow[], agent: string): AgentPayer[] {
  return fleet.flatMap((row) => {
    if (row.runner === null || row.runner.state === 'removed' || row.offers?.some((offer) => offersAgentInstalled(offer, agent)) !== true) return [];
    const choices = row.runnerDetails?.credentialChoices ?? {};
    return [{ id: row.runner.id, name: row.runner.name, choice: Object.hasOwn(choices, agent) ? choices[agent] ?? null : 'own' }];
  });
}

/** Each agent any registered runner offers installed, in the order its manifest ranks it, with the runners offering it. */
export async function readAgentPayers(env: ServerEnv, now: number): Promise<AgentPayers> {
  const [fleet, settings] = await Promise.all([readWorkerFleet(env.db, now, true), claimSettings(env)]);
  const selection = fleetSelectionContext(env, true, now);
  await applyFleetSignInAvailability(fleet, now, selection.keyState);
  const { preferred, fallback, override } = harnessPreference(settings, EXTRACTION_TASK);
  const today = (await Promise.all(fleet.flatMap((row) => {
    if (row.runner === null || row.runner.state === 'removed' || row.offers === null) return [];
    const { id, name } = row.runner;
    const choices = row.runnerDetails?.credentialChoices ?? {};
    const offers = row.offers.filter(offer => offersAgentInstalled(offer, offer.id));
    return [Object.values(choices).includes('stored-first')
      ? selectExecution(EXTRACTION_TASK, offers, settings, selection.login, choices).then(({ selected }) => ({ id, name, agent: selected?.harness ?? null }))
      : Promise.resolve({ id, name, agent: chooseHarness(preferred, fallback, override, offers) })];
  }))).sort((a, b) => a.name.localeCompare(b.name));
  const agents = await Promise.all(Object.keys(HARNESS_CREDENTIALS).map(async (agent) => {
    const runners = runnersOffering(fleet, agent).sort((a, b) => a.name.localeCompare(b.name));
    if (runners.length === 0) return null;
    const { availability } = await selection.keyState(agent);
    const fallbacks = fleet.flatMap(row => (row.runnerDetails?.fallbackNotices ?? [])
      .filter(notice => notice.agent === agent).map(notice => ({ ...notice, runnerId: row.credentialId })));
    return { agent, storedUsable: availability === true, runners,
      ...(isStoredKeyFailure(availability) ? { storedFailure: availability } : {}),
      ...(fallbacks.length === 0 ? {} : { fallbacks }) };
  }));
  return { agents: agents.filter((entry): entry is NonNullable<typeof entry> => entry !== null), today };
}
