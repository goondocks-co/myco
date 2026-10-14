import worker, { DeploymentClock, RecoveryProducer } from '../../../packages/myco-server/src/index.ts';
import { readSetupIdentity, readSetupProgress } from '../../../packages/myco-server/src/read/setup.ts';
import { projectRepositoryNeeded } from '../../../packages/myco-server/src/read/repository-requirements.ts';
import { serverEnvFromBindings, type CloudflareBindings, type DeferredWork } from '../../../packages/myco-server/src/platform/cloudflare/env.ts';
import { measured } from '../fleet-budget/worker-entry.ts';
export { DeploymentClock, RecoveryProducer };

export default {
  async fetch(request: Request, bindings: CloudflareBindings, deferred?: DeferredWork) {
    const url = new URL(request.url);
    if (url.pathname !== '/__setup-read-budget' && url.pathname !== '/__repository-read-budget') return worker.fetch(request, bindings, deferred);
    const { store, rowsRead } = measured(bindings.MYCO_DB);
    if (url.pathname === '/__repository-read-budget') {
      const projectId = url.searchParams.get('project');
      if (projectId === null) return Response.json({ error: 'project required' }, { status: 400 });
      const needed = await projectRepositoryNeeded(serverEnvFromBindings({ ...bindings, MYCO_DB: store }, deferred), { projectId });
      return Response.json({ rowsRead: rowsRead(), needed });
    }
    const progress = await readSetupProgress(serverEnvFromBindings({ ...bindings, MYCO_DB: store }, deferred), { all: true }, Date.now());
    const identity = await readSetupIdentity(store, 'fixture');
    return Response.json({ rowsRead: rowsRead(), progress: { ...progress, ...identity } });
  },
  scheduled: worker.scheduled,
};
