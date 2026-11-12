import type { RouteTarget } from '../clients/requests.ts';
import { owner } from '../clients/requests.ts';

/** The historical artifact witnesses two settled attempts on one automatic run and a separately priced manual run. */
export async function budgetArtifact(target: RouteTarget, deploymentId: string): Promise<string> {
  const now = Date.now();
  const schemaVersion = (await owner(target, '/api/status')).body.schema.found;
  const rows = [
    { t: 'agents', r: { id: 'budget-agent', name: 'Budget history', source: 'built-in', enabled: 1, created_at: now } },
    ...[['budget-auto', 'automatic', 0.1], ['budget-manual', 'manual', 0.2]].map(([id, origin, cost]) => ({ t: 'agent_runs', r: { project_id: target.projectId, id, agent_id: 'budget-agent', task: 'title-summary', status: 'completed', started_at: now, completed_at: now, cost_usd: cost, origin } })),
    ...[['budget-auto', 'budget-A', 0.7], ['budget-auto', 'budget-B', 0.1], ['budget-manual', 'budget-M', 0.2]].map(([run, attempt, cost]) => ({ t: 'agent_run_attempts', r: { project_id: target.projectId, run_id: run, attempt_id: attempt, leased_by: 'historical-worker', claimed_at: now, estimate_usd: 0.1, cost_usd: cost, cost_source: 'actual' } })),
  ];
  return [{ format: 'myco-backup/1', deploymentId, schemaVersion, createdAt: now, producer: 'historical-budget', counts: { agents: 1, agent_runs: 2, agent_run_attempts: 3 } }, ...rows].map(row => JSON.stringify(row)).join('\n') + '\n';
}
