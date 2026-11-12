import { statementRecorder } from '../../helpers/statement-recorder.ts';
import worker, { DeploymentClock, RecoveryProducer } from '../../../packages/myco-server/src/index.ts';
import type { RelationalStore } from '../../../packages/myco-server/src/core/adapters.ts';
import { type CloudflareBindings, type DeferredWork } from '../../../packages/myco-server/src/platform/cloudflare/env.ts';

export { DeploymentClock, RecoveryProducer };

export function measured(db: RelationalStore): { store: RelationalStore; rowsRead: () => number } {
  const recorded = statementRecorder(db, { accounting: 'd1' });
  return {
    store: recorded.db,
    rowsRead: () => recorded.statements.reduce((rows, statement) => rows + (statement.rowsRead ?? 0), 0),
  };
}

export default {
  async fetch(request: Request, bindings: CloudflareBindings, deferred?: DeferredWork) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/status') return worker.fetch(request, bindings, deferred);
    const { store, rowsRead } = measured(bindings.MYCO_DB);
    const response = await worker.fetch(request, { ...bindings, MYCO_DB: store }, deferred);
    const answer = new Response(response.body, response);
    answer.headers.set('x-parity-rows-read', String(rowsRead()));
    return answer;
  },
  scheduled: worker.scheduled,
};
