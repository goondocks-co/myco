import worker, { DeploymentClock, RecoveryProducer } from '../../../packages/myco-server/src/index.ts';
import { readSetupIdentity, readSetupProgress } from '../../../packages/myco-server/src/read/setup.ts';
import { serverEnvFromBindings, type CloudflareBindings, type DeferredWork } from '../../../packages/myco-server/src/platform/cloudflare/env.ts';
import { measured } from '../fleet-budget/worker-entry.ts';
export { DeploymentClock, RecoveryProducer };

export default {
  async fetch(request: Request, bindings: CloudflareBindings, deferred?: DeferredWork) {
    if (new URL(request.url).pathname !== '/__setup-read-budget') return worker.fetch(request, bindings, deferred);
    const { store, rowsRead } = measured(bindings.MYCO_DB);
    const progress = await readSetupProgress(serverEnvFromBindings({ ...bindings, MYCO_DB: store }, deferred), { all: true }, Date.now());
    const identity = await readSetupIdentity(store, 'fixture');
    return Response.json({ rowsRead: rowsRead(), progress: { ...progress, ...identity } });
  },
  scheduled: worker.scheduled,
};
