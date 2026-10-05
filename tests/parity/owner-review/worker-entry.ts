import worker, { DeploymentClock, RecoveryProducer } from '../../../packages/myco-server/src/index.ts';
import type { CloudflareBindings, DeferredWork } from '../../../packages/myco-server/src/platform/cloudflare/env.ts';
import { stopRaceFixture } from './stop-race.ts';

const race = stopRaceFixture();

export { DeploymentClock, RecoveryProducer };

export default {
  fetch: async (request: Request, bindings: CloudflareBindings, deferred?: DeferredWork) =>
    await race.endpoint(request) ?? worker.fetch(request, { ...bindings, MYCO_DB: race.wrap(bindings.MYCO_DB) }, deferred),
  scheduled: worker.scheduled,
};
