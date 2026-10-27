import {planStatusStatement} from '../read/view-store.js';
import type { RelationalStore } from './adapters.js';
import type { ReadScope } from '../read/scope.js';

/**
 * Writes a plan's status as an administrative edit by a member. The stamp lands strictly after the row's, so a capture event replayed with the row's old stamp never wins over the edit. False when no such plan sits in the scope or it already holds the status.
 */
export function preparePlanStatusWrite(
  db: RelationalStore,
  scope: ReadScope,
  planKey: string,
  status: string,
  by: string,
  nowMs: number,
) {
  const effect = { kind: 'plan' as const, recordId: planKey, patch: { status } };
  const statement = planStatusStatement(db,scope,planKey,status,by,nowMs);
  return { statement, effect };
}
