import type { RequestBudget } from './budget.js';
import type { RawAnswer, ServerClient } from './transport.js';
import { RunControlError, runControlResult } from '@goondocks/myco-shared/run-control';
export { RunControlError } from '@goondocks/myco-shared/run-control';

function runControlBody(answer: RawAnswer, path: string): Record<string, unknown> {
  if (answer.kind === 'timeout') throw new RunControlError(path, `timed out during ${answer.phase}`);
  if (answer.kind === 'transport') throw new RunControlError(path, answer.detail);
  return runControlResult(answer.status, answer.json, path);
}

/** One call over a run-control route, answered as the route's body; a refusal or a transport failure throws. */
export async function postRunControl(client: ServerClient, budget: RequestBudget, path: string, payload: unknown): Promise<Record<string, unknown>> {
  return runControlBody(await client.request('POST', path, {
    body: JSON.stringify(payload),
    headers: { 'content-type': 'application/json' },
    budget,
  }), path);
}

/** Record one report over the run-control surface; the server refuses a run this Project does not hold. */
export async function postRunReport(
  client: ServerClient,
  budget: RequestBudget,
  report: { runId: string; agentId: string; action: string; summary: string; details?: string | null },
): Promise<void> {
  await postRunControl(client, budget, '/runs/report', report);
}
