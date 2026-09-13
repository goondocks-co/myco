import type { RequestBudget } from './budget.js';
import type { RawAnswer, ServerClient } from './transport.js';

/** A server answer that is not a 200 the route classified itself. */
export class RunControlError extends Error {
  constructor(readonly path: string, detail: string) {
    super(`run control ${path}: ${detail}`);
    this.name = 'RunControlError';
  }
}

function runControlBody(answer: RawAnswer, path: string): Record<string, unknown> {
  if (answer.kind === 'timeout') throw new RunControlError(path, `timed out during ${answer.phase}`);
  if (answer.kind === 'transport') throw new RunControlError(path, answer.detail);
  if (answer.status !== 200 || answer.json === null) throw new RunControlError(path, `status ${answer.status}`);
  // A terminal refusal answers 200 with `persisted:false` and a stable code; it
  // is the caller's own request that is wrong, so it must not be retried.
  if (answer.json.persisted === false) {
    throw new RunControlError(path, `${String(answer.json.code ?? 'refused')}: ${String(answer.json.reason ?? '')}`);
  }
  return answer.json;
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
