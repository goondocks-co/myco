import { expect } from 'bun:test';
import { memberHeadersFor, type ParityScenario } from '../harness.ts';
import { allowWorkerClaims, putCapability } from '../clients/requests.ts';
import { cancelRun, dispatch, finishRun, repository, runDetail, runList, takeRun } from '../clients/runs.ts';

/** Worker runs cannot use the in-process runtime's platform-replacement callback. */
export const replacedRun: ParityScenario = {
  name: 'a replaced run: a claimed worker cannot declare an in-process runtime replacement',
  dedicated: { timeoutMs: 120_000 },
  async run(target) {
    await allowWorkerClaims(target);
    expect((await putCapability(target, 'vault_evolution', true)).status).toBe(200);
    await repository(target);
    const first = await takeRun(target, (await dispatch(target, 'vault-seed')).runId);
    const response = await fetch(`${target.url}/runs/update`, { method: 'POST', headers: memberHeadersFor(first.runToken, target.projectId, { 'content-type': 'application/json' }), body: JSON.stringify({ runId: first.id, replaced: true, update: { status: 'failed', completed_at: Date.now(), error: 'the platform reclaimed the runtime before the run ended' } }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ persisted: false, code: 'run_scope' });
    expect((await runDetail(target, first.id)).run).toMatchObject({ status: 'running', replaced: false });
    expect((await runList(target)).filter(row => row.replaces === first.id)).toEqual([]);
    expect(await finishRun(target, first)).toMatchObject({ ended: true });
    const manual = await dispatch(target, 'vault-seed');
    await cancelRun(target, manual.runId);
  },
};
