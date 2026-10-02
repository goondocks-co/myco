import type { RelationalStore, ServerEnv } from '../adapters.js';
import { AlreadyRunning, dispatchPrepared, prepareDispatch, hasTaskRuntime } from '../harness.js';
import { hasLiveTaskRunAnywhere, lastTaskEntryAt } from '../runs.js';
import { settingTexts } from '../settings.js';
import { listProjects } from '../../read/sessions.js';
import { calibrationPending } from './hubness.js';
import { calibrationModel, completeEmbeddingSwitch, embeddingWorkPlan } from './switch.js';
import { DELETION_DUE, PASSED_OVER, SOURCE_HELD, deletionDueBinds, passedOverBinds } from './reconcile.js';

export const EMBEDDING_RETRY_MS = 60_000;
export { EMBEDDING_TASK } from './task.js';
import { EMBEDDING_TASK } from './task.js';
export const PREVENT_DEEP_SLEEP_LEAF = 'embedding.prevent_deep_sleep';

/** What a Project's embedding work covers while a switch stands, and whether the Project is archived. */
export interface EmbeddingWorkScope {
  /** A switch's model while it is asked: sources it has not written, or skipped, are work. */
  building?: string | null;
  /** Every further model whose vectors are kept. */
  retain?: readonly string[];
  /** A standing switch's model, which calibration covers instead of `model`. */
  switching?: string | null;
  /** An archived Project's only work is retiring vectors. */
  retireOnly?: boolean;
}

/**
 * The backlog includes sources awaiting a write, passed-over sources aside, under `model` or under a switch's `building` model, deletions that are
 * due and pending spore calibration, under a standing switch's model while it stands. An archived Project's backlog is
 * its due deletions alone.
 */
export async function hasEmbeddingWork(db: RelationalStore, projectId: string, model: string, now: number, scope: EmbeddingWorkScope = {}): Promise<boolean> {
  const writes = scope.retireOnly === true ? [] : [model, ...(scope.building == null ? [] : [scope.building])];
  const unwritten = writes.map(() => `EXISTS(SELECT 1 FROM embedding_sources s WHERE s.project_id = ? AND NOT ${SOURCE_HELD} AND NOT ${PASSED_OVER}) OR `).join('');
  const row = await db.prepare(`SELECT ${unwritten}EXISTS(SELECT 1 FROM embedding_receipts r WHERE r.project_id = ? AND ${DELETION_DUE}) AS pending`)
    .bind(...writes.flatMap((key) => [projectId, key, ...passedOverBinds(key, now)]), projectId, ...deletionDueBinds([model, ...writes, ...(scope.retain ?? [])], now)).first<{ pending: number }>();
  if (row?.pending === 1) return true;
  return scope.retireOnly !== true && calibrationPending(db, projectId, calibrationModel(model, scope.switching ?? null), now);
}

/** Every Project embedding work may serve, the archived ones only retiring. */
async function workProjects(db: RelationalStore): Promise<Array<{ projectId: string; retireOnly: boolean }>> {
  return (await listProjects(db, { includeArchived: true })).map((project) => ({ projectId: project.projectId, retireOnly: project.archivedAt !== null }));
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
  if (await hasLiveTaskRunAnywhere(env.db, EMBEDDING_TASK)) return 0;
  // The Project served longest ago goes first, so one Project's long backlog never holds the others' back.
  const served = await Promise.all((await workProjects(env.db)).map(async (project) =>
    ({ ...project, last: await lastTaskEntryAt(env.db, { projectId: project.projectId }, EMBEDDING_TASK) })));
  for (const { projectId, retireOnly, last } of served.sort((a, b) => (a.last ?? 0) - (b.last ?? 0))) {
    if (last !== null && now - last < EMBEDDING_RETRY_MS) continue;
    if (!(await hasEmbeddingWork(env.db, projectId, plan.model, now, { ...plan, retireOnly }))) continue;
    const prepared = await prepareDispatch(env, EMBEDDING_TASK, projectId);
    if (!prepared.ok) continue;
    try {
      await dispatchPrepared(env, prepared.prepared, { serverUrl: env.origin, actor: 'clock' }, now, { singleFlight: true });
      return 1;
    } catch (error) { if (!(error instanceof AlreadyRunning)) throw error; }
  }
  return 0;
}
