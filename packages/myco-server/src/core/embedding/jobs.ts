import type { RelationalStore, ServerEnv } from '../adapters.js';
import { AlreadyRunning, dispatchPrepared, prepareDispatch, hasTaskRuntime } from '../harness.js';
import { hasLiveTaskRunAnywhere, lastTaskEntryAt } from '../runs.js';
import { leafValues } from '../settings.js';
import { listProjects } from '../../read/sessions.js';
import { SPORE_VECTORS, hubnessPending } from './hubness.js';
import { resolveSemanticSearch } from '../search.js';
import { DELETION_DUE, SOURCE_HELD, deletionDueBinds } from './reconcile.js';

const EMBEDDING_RETRY_MS = 60_000;
export const EMBEDDING_TASK = 'embedding-reconcile';

/** The backlog includes sources awaiting a write, deletions that are due and pending spore calibration. */
export async function hasEmbeddingWork(db: RelationalStore, projectId: string, model: string, now: number): Promise<boolean> {
  const row = await db.prepare(`SELECT EXISTS(SELECT 1 FROM embedding_sources s WHERE s.project_id = ? AND NOT ${SOURCE_HELD})
    OR EXISTS(SELECT 1 FROM embedding_receipts r WHERE r.project_id = ? AND ${DELETION_DUE}) AS pending`)
    .bind(projectId, model, projectId, ...deletionDueBinds(model, now)).first<{ pending: number }>();
  if (row?.pending === 1) return true;
  const count = (await db.prepare(`SELECT COUNT(*) AS n FROM (${SPORE_VECTORS})`).bind(projectId, model).first<{ n: number }>())!.n;
  return count >= 2 && hubnessPending(db, projectId, model, now);
}

export async function embeddingKeepsAwake(env: ServerEnv, now: number): Promise<boolean> {
  if (!hasTaskRuntime(env, EMBEDDING_TASK) || env.origin === undefined) return false;
  const leaves = await leafValues(env.db, ['embedding.prevent_deep_sleep']);
  if (leaves.get('embedding.prevent_deep_sleep') === 'false') return false;
  const semantic = await resolveSemanticSearch(env);
  if (semantic === null) return false;
  for (const project of await listProjects(env.db)) if (await hasEmbeddingWork(env.db, project.projectId, semantic.provider.modelKey, now)) return true;
  return false;
}

/**
 * Indexing dispatches one held run at a time across the Deployment, through the shared queue and fleet limits.
 *
 * A clock launches a run and ticks on without waiting for it, so a run can still be in flight at every later tick.
 * One in flight Deployment-wide is what keeps chained ticks from stacking runs against the one embedding provider:
 * the next Project's run starts at the first tick after this one closes.
 */
export async function dispatchEmbeddingWork(env: ServerEnv, now: number): Promise<number> {
  if (!hasTaskRuntime(env, EMBEDDING_TASK) || env.origin === undefined) return 0;
  const semantic = await resolveSemanticSearch(env);
  if (semantic === null) return 0;
  if (await hasLiveTaskRunAnywhere(env.db, EMBEDDING_TASK)) return 0;
  // The Project served longest ago goes first, so one Project's long backlog never holds the others' back.
  const served = await Promise.all((await listProjects(env.db)).map(async (project) =>
    ({ projectId: project.projectId, last: await lastTaskEntryAt(env.db, { projectId: project.projectId }, EMBEDDING_TASK) })));
  for (const { projectId, last } of served.sort((a, b) => (a.last ?? 0) - (b.last ?? 0))) {
    if (last !== null && now - last < EMBEDDING_RETRY_MS) continue;
    if (!(await hasEmbeddingWork(env.db, projectId, semantic.provider.modelKey, now))) continue;
    const prepared = await prepareDispatch(env, EMBEDDING_TASK, projectId);
    if (!prepared.ok) continue;
    try {
      await dispatchPrepared(env, prepared.prepared, { serverUrl: env.origin, actor: 'clock' }, now, { singleFlight: true });
      return 1;
    } catch (error) { if (!(error instanceof AlreadyRunning)) throw error; }
  }
  return 0;
}
