import { expect } from 'bun:test';
import { waitFor } from '../harness.ts';
import { putSetting, type RouteTarget } from '../clients/requests.ts';
import { dispatch, runDetail } from '../clients/runs.ts';

/** Dispatches the real runtime and waits for its public report before admitting another pass. */
export async function embeddingPass(target: RouteTarget): Promise<string> {
  const { runId } = await dispatch(target, 'embedding-reconcile');
  const answer = await waitFor(() => runDetail(target, runId), value => ['completed', 'failed'].includes(value.run.status));
  expect({ status: answer.run.status, error: answer.run.error }).toMatchObject({ status: 'completed' });
  const report = answer.reports.find((row: any) => row.action === 'embedding');
  expect(report).toBeDefined();
  const phase = answer.toolCalls.filter((call: { tool: string }) => call.tool === '/runs/embedding-step').at(-1)?.op;
  if (typeof phase !== 'string' || phase.length === 0) throw new Error('completed embedding run has no recorded step phase');
  return phase;
}
export async function embeddingSettings(target: RouteTarget): Promise<void> {
  for (const [leaf, value] of Object.entries({ 'agent.scheduled_tasks_enabled': false, 'agent.limits.task_runs_per_hour': 1000 })) expect((await putSetting(target, leaf, value)).status).toBe(200);
}
