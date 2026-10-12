import worker, { DeploymentClock, RecoveryProducer } from '../../../packages/myco-server/src/index.ts';
import type { CloudflareBindings, DeferredWork } from '../../../packages/myco-server/src/platform/cloudflare/env.ts';
import { indexFixture } from '../../myco-server/helpers/vector-index.ts';

const vectorize = indexFixture();
export { DeploymentClock, RecoveryProducer };

/** The shipped Worker with deterministic embedding bindings for run-lifecycle parity. */
export default {
  fetch: (request: Request, bindings: CloudflareBindings, deferred?: DeferredWork) =>
    worker.fetch(request, { ...bindings, VECTORIZE: vectorize, AI: { run: async () => ({ data: [[1, 0]] }) } }, deferred),
  scheduled: worker.scheduled,
};
