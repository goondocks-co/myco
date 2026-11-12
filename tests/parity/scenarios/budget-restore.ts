import { expect } from 'bun:test';
import type { ParityScenario } from '../harness.ts';
import { owner, wake } from '../clients/requests.ts';
import { selectOwner } from '../clients/identity.ts';
import { budgetArtifact } from '../historical-storage/budget.ts';

export const budgetRestore: ParityScenario = {
  name: 'budget: portable restore preserves every attempt cost and dispatch origin',
  dedicated: { timeoutMs: 180_000 },
  async run(target) {
    await selectOwner(target);
    const artifact = await budgetArtifact(target, target.deploymentId);
    const restore = await owner(target, '/api/backups/restore-upload', { method: 'POST', body: JSON.stringify({ artifact }) });
    expect(restore).toMatchObject({ status: 200, body: { applied: true } });
    await wake(target);
    expect((await owner(target, '/api/status')).body).toMatchObject({ budget: { active: true, state: 'ready', automaticUsd: expect.closeTo(0.8), manualUsd: 0.2, unconfirmed: { count: 0, estimatedUsd: 0 } } });
    const saved = await owner(target, '/api/backups', { method: 'POST', body: '{}' });
    expect(saved.status).toBe(200);
    const response = await fetch(`${target.url}/api/backups/${saved.body.backup.id}/artifact`, { headers: target.ownerHeaders() });
    expect(response.status).toBe(200);
    const rows = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    expect(rows.filter(row => row.t === 'agent_run_attempts').map(({ r }) => [r.attempt_id, r.cost_usd]).sort()).toEqual([['budget-A', 0.7], ['budget-B', 0.1], ['budget-M', 0.2]]);
  },
};
