import type { RelationalStore, ServerEnv } from '../adapters.js';
import { AlreadyRunning, dispatchPrepared, prepareDispatch } from '../harness.js';
import { hasLiveTaskRun, lastTaskEntryAt } from '../runs.js';
import { leafValues } from '../settings.js';
import { listProjects } from '../../read/sessions.js';
import { CURRENT_SPORE_VECTORS } from './hubness.js';
import { resolveSemanticSearch } from '../search.js';
import { VECTOR_DELETE_RETRY_MS } from './provider.js';

const EMBEDDING_RETRY_MS = 60_000;
export const EMBEDDING_TASK = 'embedding-reconcile';

/** The backlog includes unfinished sources, durable deletion receipts and an incomplete hubness pass. */
export async function hasEmbeddingWork(db: RelationalStore, projectId: string, model: string, now: number): Promise<boolean> {
  const row = await db.prepare(`SELECT EXISTS(SELECT 1 FROM embedding_sources s WHERE s.project_id = ? AND NOT EXISTS
    (SELECT 1 FROM embedding_receipts r WHERE r.project_id = s.project_id AND r.type = s.type AND r.record_id = s.record_id AND r.revision = s.revision AND r.model_key = ? AND r.ready = 1))
    OR EXISTS(SELECT 1 FROM embedding_receipts r WHERE r.project_id = ? AND (r.ready <> -1 OR r.updated_at <= ?) AND (r.model_key <> ? OR NOT EXISTS
    (SELECT 1 FROM embedding_sources s WHERE s.project_id = r.project_id AND s.type = r.type AND s.record_id = r.record_id AND s.revision = r.revision))) AS pending`)
    .bind(projectId, model, projectId, now - VECTOR_DELETE_RETRY_MS, model).first<{ pending: number }>();
  if (row?.pending === 1) return true;
  const count = (await db.prepare(`SELECT COUNT(*) AS n FROM (${CURRENT_SPORE_VECTORS})`).bind(projectId, model).first<{ n: number }>())!.n;
  if (count < 2) return false;
  return (await db.prepare('SELECT 1 AS current FROM embedding_cursors WHERE project_id = ? AND hubness_model = ? AND hubness_count = ?')
    .bind(projectId, model, count).first()) === null;
}

export async function embeddingKeepsAwake(env: ServerEnv, now: number): Promise<boolean> {
  if (env.harnessLaunch === undefined || env.origin === undefined) return false;
  const leaves = await leafValues(env.db, ['embedding.prevent_deep_sleep']);
  if (leaves.get('embedding.prevent_deep_sleep') === 'false') return false;
  const semantic = await resolveSemanticSearch(env);
  if (semantic === null) return false;
  for (const project of await listProjects(env.db)) if (await hasEmbeddingWork(env.db, project.projectId, semantic.provider.modelKey, now)) return true;
  return false;
}

/** Indexing dispatches one held run per project through the shared queue and fleet limits. */
export async function dispatchEmbeddingWork(env: ServerEnv, now: number): Promise<number> {
  if (env.harnessLaunch === undefined || env.origin === undefined) return 0;
  const semantic = await resolveSemanticSearch(env);
  if (semantic === null) return 0;
  let dispatched = 0;
  for (const project of await listProjects(env.db)) {
    const scope = { projectId: project.projectId };
    if (await hasLiveTaskRun(env.db, scope, EMBEDDING_TASK)) continue;
    const last = await lastTaskEntryAt(env.db, scope, EMBEDDING_TASK);
    if (last !== null && now - last < EMBEDDING_RETRY_MS) continue;
    if (!(await hasEmbeddingWork(env.db, project.projectId, semantic.provider.modelKey, now))) continue;
    const prepared = await prepareDispatch(env, EMBEDDING_TASK, project.projectId);
    if (!prepared.ok) continue;
    try {
      await dispatchPrepared(env, prepared.prepared, { serverUrl: env.origin, actor: 'clock' }, now, { singleFlight: true });
      dispatched++;
    } catch (error) { if (!(error instanceof AlreadyRunning)) throw error; }
  }
  return dispatched;
}
