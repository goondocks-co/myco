import worker, { DeploymentClock, RecoveryProducer } from '../../../packages/myco-server/src/index.ts';
import {
  serverEnvFromBindings,
  type CloudflareBindings,
  type DeferredWork,
} from '../../../packages/myco-server/src/platform/cloudflare/env.ts';
import { viewWriterEndpoint } from './endpoint.ts';
export { DeploymentClock, RecoveryProducer };
export default {
  fetch: async (request: Request, bindings: CloudflareBindings, deferred?: DeferredWork) =>
    (await viewWriterEndpoint(request, serverEnvFromBindings(bindings, deferred))) ??
    worker.fetch(request, bindings, deferred),
  scheduled: worker.scheduled,
};
