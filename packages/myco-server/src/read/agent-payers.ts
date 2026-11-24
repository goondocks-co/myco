import { HARNESS_CREDENTIALS } from '@goondocks/myco-shared/harness-providers';
import { offersAgentInstalled, type RunnerCredentialChoice } from '@goondocks/myco-shared/runner-fleet';
import type { ServerEnv } from '../core/adapters.js';
import { harnessCredentialAvailability } from '../core/secrets.js';
import { readWorkerFleet, type WorkerFleetRow } from '../core/worker-contacts.js';
import { EXTRACTION_TASK } from '../core/task-catalogue.js';
import { chooseHarness, claimSettings, harnessPreference } from '../core/worker-selection.js';

/** One registered runner that offers an agent, and the sign-in it uses for it: null where it must be chosen again. */
export interface AgentPayer { id: string; name: string; choice: RunnerCredentialChoice | null }

/** `GET /api/runners/agents`: every agent a registered runner offers installed, who pays for it on each, and whether a stored key would work: a key the provider refused does not. */
export interface AgentPayers {
  agents: Array<{ agent: string; storedUsable: boolean; runners: AgentPayer[] }>;
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
  const usable = harnessCredentialAvailability(env.db, env.wrappingKey);
  const { preferred, fallback, override } = harnessPreference(settings, EXTRACTION_TASK);
  const today = fleet.flatMap((row) => row.runner === null || row.runner.state === 'removed' || row.offers === null ? []
    : [{ id: row.runner.id, name: row.runner.name, agent: chooseHarness(preferred, fallback, override, row.offers.filter((offer) => offersAgentInstalled(offer, offer.id))) }]).sort((a, b) => a.name.localeCompare(b.name));
  const agents = await Promise.all(Object.keys(HARNESS_CREDENTIALS).map(async (agent) => {
    const runners = runnersOffering(fleet, agent).sort((a, b) => a.name.localeCompare(b.name));
    return runners.length === 0 ? null : { agent, storedUsable: await usable(agent) === true, runners };
  }));
  return { agents: agents.filter((entry): entry is NonNullable<typeof entry> => entry !== null), today };
}
