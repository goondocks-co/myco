import type { RelationalStore, ServerEnv } from '../adapters.js';
import { AlreadyRunning, dispatchPrepared, prepareDispatch, hasTaskRuntime } from '../harness.js';
import { hasLiveTaskRunAnywhere, lastTaskEntryAt } from '../runs.js';
import { settingTexts } from '../settings.js';
import { WORK_SWEEP_CONTINUE_MS } from './work-state.js';
import { hasEmbeddingSweep, hasEmbeddingWork } from './work.js';
export { hasEmbeddingWork, type EmbeddingWorkScope } from './work.js';
import { advanceEmbedding } from './step.js';
import { completeEmbeddingSwitch, embeddingWorkPlan, type EmbeddingWorkPlan } from './switch.js';
import { readSwitch } from './switch-store.js';

export { EMBEDDING_RETRY_MS, EMBEDDING_TASK } from './task.js';
import { EMBEDDING_RETRY_MS, EMBEDDING_TASK } from './task.js';
export const EMBEDDING_SWEEP_ASSERTION = 'embedding:sweep';
export const PREVENT_DEEP_SLEEP_LEAF = 'embedding.prevent_deep_sleep';

/** Every Project embedding work may serve, the archived ones only retiring. */
async function workProjects(db: RelationalStore): Promise<Array<{ projectId: string; retireOnly: boolean }>> {
  return (await db.prepare('SELECT project_id, archived_at FROM projects ORDER BY project_id')
    .all<{ project_id: string; archived_at: number | null }>()).results
    .map((project) => ({ projectId: project.project_id, retireOnly: project.archived_at !== null }));
}

/** Whether embedding work holds the Deployment awake while it waits: on unless an admin turned it off. */
export async function keepsEmbeddingWhileIdle(db: RelationalStore): Promise<boolean> {
  return (await settingTexts(db, [PREVENT_DEEP_SLEEP_LEAF])).get(PREVENT_DEEP_SLEEP_LEAF) !== JSON.stringify(false);
}

export async function embeddingKeepsAwake(env: ServerEnv, now: number): Promise<boolean> {
  if (!hasTaskRuntime(env, EMBEDDING_TASK) || env.origin === undefined) return false;
  if (!(await keepsEmbeddingWhileIdle(env.db))) return false;
  const plan = await embeddingWorkPlan(env, now);
  if (plan === null) return false;
  for (const { projectId, retireOnly } of await workProjects(env.db)) if (await hasEmbeddingWork(env.db, projectId, plan.model, now, { ...plan, retireOnly })) return true;
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
  await completeEmbeddingSwitch(env, now);
  if (!hasTaskRuntime(env, EMBEDDING_TASK) || env.origin === undefined) return 0;
  const plan = await embeddingWorkPlan(env, now);
  if (plan === null) return 0;
  // The Project served longest ago goes first, so one Project's long backlog never holds the others' back.
  const served = [];
  for (const project of await workProjects(env.db)) {
    if (await hasEmbeddingWork(env.db, project.projectId, plan.model, now, { ...plan, retireOnly: project.retireOnly })) {
      served.push({ ...project, last: await lastTaskEntryAt(env.db, { projectId: project.projectId }, EMBEDDING_TASK) });
    }
  }
  if (served.length === 0 || await hasLiveTaskRunAnywhere(env.db, EMBEDDING_TASK)) return 0;
  let changed = 0;
  let retired = false;
  for (const { projectId, last, retireOnly } of served.sort((a, b) => (a.last ?? 0) - (b.last ?? 0))) {
    if (last !== null && now - last < EMBEDDING_RETRY_MS) continue;
    if (retireOnly) {
      if (retired) continue;
      retired = true;
      const step = await advanceEmbedding(env, projectId, now, { retireOnly: true });
      changed += 'processed' in step ? step.processed : 0;
      continue;
    }
    const prepared = await prepareDispatch(env, EMBEDDING_TASK, projectId);
    if (!prepared.ok) continue;
    try {
      await dispatchPrepared(env, prepared.prepared, { serverUrl: env.origin, actor: 'clock' }, now, { singleFlight: true });
      return changed + 1;
    } catch (error) { if (!(error instanceof AlreadyRunning)) throw error; }
  }
  return changed;
}

/** The registry chains bounded sweep pages independently of dispatching an embedding run. */
export async function runEmbeddingJob(env: ServerEnv, now: number, options: { sweepOnly?: boolean; allowDispatch?: boolean } = {}): Promise<{ changed: number; more: boolean; continueAfterMs?: number }> {
  let pending = options.sweepOnly !== true;
  if (options.sweepOnly === true && hasTaskRuntime(env, EMBEDDING_TASK) && env.origin !== undefined) {
    const plan = await embeddingWorkPlan(env, now);
    if (plan !== null) for (const { projectId, retireOnly } of await workProjects(env.db)) {
      if (await hasEmbeddingWork(env.db, projectId, plan.model, now, { ...plan, retireOnly })) pending = true;
    }
  }
  const changed = pending && options.allowDispatch !== false ? await dispatchEmbeddingWork(env, now) : 0;
  if (!hasTaskRuntime(env, EMBEDDING_TASK) || env.origin === undefined) return { changed, more: false };
  const plan = await embeddingWorkPlan(env, now);
  if (plan !== null) for (const { projectId, retireOnly } of await workProjects(env.db)) {
    if (await hasEmbeddingSweep(env.db, projectId, plan.model, { ...plan, retireOnly })) return { changed, more: true, continueAfterMs: WORK_SWEEP_CONTINUE_MS };
  }
  const retryAt = await providerRetryAt(env.db,plan,now);
  if (retryAt !== null) return { changed,more:true,continueAfterMs:retryAt-now };
  return { changed, more: false };
}

/** Deferred embedding work holds no depth shallower than sleep. */
export async function embeddingSweepPending(env: ServerEnv, now: number): Promise<boolean> {
  if (!hasTaskRuntime(env, EMBEDDING_TASK) || env.origin === undefined || !(await keepsEmbeddingWhileIdle(env.db))) return false;
  const plan = await embeddingWorkPlan(env, now);
  if (await providerRetryAt(env.db,plan,now) !== null) return true;
  if (plan === null) return false;
  for (const { projectId, retireOnly } of await workProjects(env.db)) {
    if (await hasEmbeddingSweep(env.db, projectId, plan.model, { ...plan, retireOnly })) return true;
  }
  return false;
}

async function providerRetryAt(db:RelationalStore,plan:EmbeddingWorkPlan|null,now:number):Promise<number|null> {
  const models = plan === null ? [(await readSwitch(db))?.modelKey] : [plan.model,plan.building,...plan.retain];
  const held = await db.prepare(`SELECT retry_at FROM embedding_provider_holds
    WHERE model_key IN (SELECT value FROM json_each(?)) AND retry_at>? ORDER BY retry_at LIMIT 1`)
    .bind(JSON.stringify(models),now).first<{ retry_at:number }>();
  return held?.retry_at ?? null;
}
