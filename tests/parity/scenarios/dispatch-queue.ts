import { expect } from 'bun:test';
import { type ParityScenario } from '../harness.ts';
import { allowWorkerClaims, putCapability, putSetting, resetSetting, wake } from '../clients/requests.ts';
import { dispatch, failRun, repository, runDetail, runList, takeRun } from '../clients/runs.ts';

/** Worker-served runs wait in order, including after a slot becomes available. */
export const dispatchQueue: ParityScenario = {
  name: 'the claim queue: a worker\'s runs wait in order whatever the limit says, and no front door launches one',
  dedicated: { timeoutMs: 120_000 },
  async run(target) {
    await allowWorkerClaims(target);
    expect((await putCapability(target, 'vault_evolution', true)).status).toBe(200);
    await repository(target);
    expect((await putSetting(target, 'agent.limits.concurrent_runs', 1)).status).toBe(200);
    const blocker = await takeRun(target, (await dispatch(target, 'vault-seed')).runId);
    const a = await dispatch(target, 'vault-seed');
    expect(a).toMatchObject({ queued: true, heldBy: 'concurrent_runs' });
    expect(await failRun(target, blocker)).toMatchObject({ ended: true });
    const b = await dispatch(target, 'vault-seed');
    expect(b).toMatchObject({ queued: true, heldBy: 'worker' });
    const queued = await runList(target, 'status=queued');
    expect(queued.map(row => row.id).sort()).toEqual([a.runId, b.runId].sort());
    expect(queued.map(row => [row.waitReason, row.taskQueued])).toEqual([['concurrent_runs', 2], ['concurrent_runs', 2]]);
    expect((await resetSetting(target, 'agent.limits.concurrent_runs')).status).toBe(200);
    await wake(target);
    expect((await runDetail(target, a.runId)).run).toMatchObject({ status: 'queued', heldBy: 'concurrent_runs', harness: null });
    expect((await runDetail(target, b.runId)).run).toMatchObject({ status: 'queued', heldBy: 'worker', harness: null });
    const first = await takeRun(target, a.runId);
    expect(await failRun(target, first)).toMatchObject({ ended: true });
    const second = await takeRun(target, b.runId);
    expect(await failRun(target, second)).toMatchObject({ ended: true });
  },
};
