import { statementRecorder } from '../../helpers/statement-recorder.ts';
import worker, { DeploymentClock, RecoveryProducer } from '../../../packages/myco-server/src/index.ts';
import { readFleetProjection } from '../../../packages/myco-server/src/db/runs/fleet';
import type { RelationalStore } from '../../../packages/myco-server/src/core/adapters.ts';
import { serverEnvFromBindings, type CloudflareBindings, type DeferredWork } from '../../../packages/myco-server/src/platform/cloudflare/env.ts';

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
    if (url.pathname !== '/__fleet-read-budget') return worker.fetch(request, bindings, deferred);
    if (url.searchParams.has('old_inventory_query')) {
      const result = await bindings.MYCO_DB.prepare(`SELECT c.id FROM member_credentials c
        LEFT JOIN worker_contacts w ON w.credential_id = c.id
        LEFT JOIN agent_runs r ON r.leased_by = c.id AND r.status = 'running' AND r.lease_expires_at > ?
        WHERE w.credential_id IS NOT NULL OR r.id IS NOT NULL`).bind(Date.now()).all();
      return Response.json({ rowsRead: Number((result as typeof result & { meta?: { rows_read?: number } }).meta?.rows_read ?? 0) });
    }
    const { store, rowsRead } = measured(bindings.MYCO_DB);
    const projection = await readFleetProjection(serverEnvFromBindings({ ...bindings, MYCO_DB: store }, deferred), Date.now());
    return Response.json({ rowsRead: rowsRead(), workers: projection.fleet.length, queued: projection.queue.count });
  },
  scheduled: worker.scheduled,
};
