import type { RelationalStore } from '../../core/adapters.js';
import type { core_embedding_reconcile_PassedOverSource as PassedOverSource } from '../../read/catalog/embedding-reconcile.js';
import { CURRENT_EMBEDDING_SOURCES } from '../embedding-sources.js';
import { read, readSet } from '../index.js';

export const PASSED_OVER_PAGE_SIZE = 100;
const membership = `FROM embedding_passed_over INDEXED BY idx_embedding_passed_over_model
  WHERE model_key IN (SELECT value FROM json_each(?1)) AND (expires_at IS NULL OR expires_at>?2)`;
const pageSql = `SELECT project_id,type,record_id,model_key,reason,MAX(recorded_at) AS at ${membership}
  GROUP BY project_id,type,record_id ORDER BY at DESC,record_id,project_id,type LIMIT ${PASSED_OVER_PAGE_SIZE}`;
const readiness = read<[], { done: number }>({ name: 'embedding.healthReadiness', sql: "SELECT done FROM projection_catchup WHERE projection='passed_over' AND phase='failures'" });
const count = read<[string, number], { n: number }>({ name: 'embedding.healthCount', sql: `SELECT COUNT(*) AS n FROM (SELECT DISTINCT project_id,type,record_id ${membership})` });
const page = read<[string, number], PassedOverSource>({ name: 'embedding.healthPage', sql: `SELECT f.project_id AS projectId,p.name AS projectName,f.type,f.record_id AS recordId,f.model_key AS modelKey,f.reason,f.at AS recordedAt,
  CASE f.type ${CURRENT_EMBEDDING_SOURCES.map(s => `WHEN '${s.type}' THEN (SELECT ${s.title} FROM ${s.table} WHERE project_id=f.project_id AND ${s.id}=f.record_id)`).join(' ')} END AS title
  FROM (${pageSql}) f LEFT JOIN projects p ON p.project_id=f.project_id ORDER BY f.at DESC,f.record_id,f.project_id,f.type` });

export async function passedOverHealth(db: RelationalStore, models: readonly string[], now: number):
Promise<{ state: 'building' } | { state: 'ready'; sources: PassedOverSource[]; count: number }> {
  const keys = JSON.stringify([...new Set(['', ...models])]);
  const [phases, sources, totals] = await readSet(db, readiness.bind(), page.bind(keys, now), count.bind(keys, now));
  return phases[0]?.done === 1 ? { state: 'ready', sources, count: totals[0]!.n } : { state: 'building' };
}
