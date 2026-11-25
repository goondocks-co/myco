import type { QueueReason, RunnerSignInSource } from '@goondocks/myco-shared/runner-fleet';
import type { ServerEnv } from '../core/adapters.js';
import { readDispatchLimits } from '../core/limits.js';
import { automaticBudgetAdmission } from '../core/pulled-admission.js';
import { EXTRACTION_TASK } from '../core/task-catalogue.js';
import { claimSettings } from '../core/worker-selection.js';
import { fleetAvailability, fleetSelectionContext, fleetTaskReason, previewFleet } from '../db/runs/fleet.js';

/** What holds an automatic run: a queue reason, or the rolling work budget. */
export type AgentWorkHold = QueueReason | 'budget';

/** `GET /api/runners/check`: whether learning from sessions could start now, and on what. */
export interface AgentWorkCheck {
  task: string;
  observedAt: number;
  /** What a run started now would wait for, by the rules the claim decides by; `ready` when one could start. */
  reason: AgentWorkHold;
  /** Each agent a machine would run it with, and the machines that would: a legacy worker has no runner name. */
  takers: Array<{ agent: string; runners: Array<{ id: string; name: string | null; payer?: RunnerSignInSource }> }>;
}

/**
 * Whether an automatic run of learning from sessions could start now under the server's current agent and sign-in
 * choices, judged by the selection, dispatch limits and budget admission a claim applies. Nothing is dispatched,
 * claimed, held or spent.
 */
export async function readAgentWorkCheck(env: ServerEnv, now: number): Promise<AgentWorkCheck> {
  const task = EXTRACTION_TASK;
  const selection = fleetSelectionContext(env, true, now);
  const [settings, fleet, limits, budget] = await Promise.all([claimSettings(env), fleetAvailability(env, now, true), readDispatchLimits(env), automaticBudgetAdmission(env.db, task, now)]);
  const [fleetReason, preview] = await Promise.all([
    fleetTaskReason(env, task, fleet, now, settings, limits, undefined, selection),
    previewFleet(env, task, fleet, settings, false, selection),
  ]);
  const runnerOf = new Map(fleet.map((row) => [row.credentialId, row]));
  const takers = new Map<string, Map<string, { id: string; name: string | null; payer?: RunnerSignInSource }>>();
  for (const execution of preview.executions) {
    const runners = takers.get(execution.harness) ?? new Map<string, { id: string; name: string | null; payer?: RunnerSignInSource }>();
    for (const credentialId of execution.credentialIds) {
      const row = runnerOf.get(credentialId);
      const runner = row?.runner ?? null;
      const payer = row?.runnerDetails?.credentialChoices?.[execution.harness] === 'stored-first' ? execution.payers.get(credentialId) : undefined;
      runners.set(credentialId, runner === null ? { id: credentialId, name: null }
        : { id: runner.id, name: runner.name, ...(payer === undefined ? {} : { payer }) });
    }
    takers.set(execution.harness, runners);
  }
  const machineFree = fleetReason === 'ready' || fleetReason === 'capacity';
  const reason: AgentWorkHold = !machineFree ? fleetReason : !budget.active ? 'admission_building' : !budget.fits ? 'budget' : fleetReason;
  return { task, observedAt: now, reason, takers: [...takers].map(([agent, runners]) => ({ agent, runners: [...runners.values()] })) };
}
