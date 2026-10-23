import worker, { DeploymentClock, RecoveryProducer } from '../../../packages/myco-server/src/index.ts';
import type { CloudflareBindings, DeferredWork } from '../../../packages/myco-server/src/platform/cloudflare/env.ts';
import { receiptSnapshotEndpoint } from './endpoint.ts';

export { DeploymentClock, RecoveryProducer };

export default {
  fetch: async (request: Request, bindings: CloudflareBindings, deferred?: DeferredWork) =>
    await receiptSnapshotEndpoint(request, bindings.MYCO_DB) ?? worker.fetch(request, bindings, deferred),
  scheduled: worker.scheduled,
};
