import { expect } from 'bun:test';
import { offeredHarness } from '../../myco-server/helpers/offered-harness.ts';
import { type ParityScenario } from '../harness.ts';
import { allowWorkerClaims, putCapability } from '../clients/requests.ts';
import { cancelRun, dispatch, repository, runDetail, worker } from '../clients/runs.ts';

/** A queued map names the capability missing from the recently heard fleet. */
export const capabilityHold: ParityScenario = {
  name: 'capability hold: a queued map run names the capability no worker heard from lately reports',
  dedicated: { timeoutMs: 120_000 },
  async run(target) {
    await allowWorkerClaims(target);
    expect((await putCapability(target, 'canopy', true)).status).toBe(200);
    await repository(target);
    const { runId } = await dispatch(target, 'canopy-map');
    for (const [capabilities, heldBy] of [[[], 'repository-checkout'], [['repository-checkout'], 'repository-digests']] as const) {
      expect(await worker(target, 'claim', { harnesses: [offeredHarness('claude-code')], capabilities })).toMatchObject({ claimed: false, reason: 'no_work' });
      expect((await runDetail(target, runId)).run.heldBy).toBe(heldBy);
    }
    await cancelRun(target, runId);
  },
};
