import worker, { DeploymentClock, RecoveryProducer } from './worker-entry.ts';
import type { CloudflareBindings, DeferredWork } from '../../../packages/myco-server/src/platform/cloudflare/env.ts';
import { indexFixture } from '../../myco-server/helpers/vector-index.ts';

const vectorize = indexFixture();
export { DeploymentClock, RecoveryProducer };

/** Live-actor commit races with a deterministic embedding binding. */
export default {
  fetch: (request: Request, bindings: CloudflareBindings, deferred?: DeferredWork) =>
    worker.fetch(request, { ...bindings, VECTORIZE: vectorize, AI: { run: async () => ({ data: [[1, 0]] }) } }, deferred),
  scheduled: worker.scheduled,
};
