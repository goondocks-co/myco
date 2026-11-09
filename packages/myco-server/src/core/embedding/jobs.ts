import type { ServerEnv } from '../adapters.js';
import { AlreadyRunning, dispatchPrepared, prepareDispatch, hasTaskRuntime } from '../harness.js';
import { hasLiveTaskRunAnywhere, lastTaskEntryAt } from '../../db/runs/claim.js';
import { settingTexts } from '../settings.js';
import {
  advanceWorkAudit, clearWorkAttention, markWorkAttention, providerRetryAt, readyProviders, rotateWorkAttention, workCandidates, workOwed, type CheckedWork,
} from '../../db/embeddings/work.js';
import { WORK_PREDICATE_VERSION, WORK_SWEEP_CONTINUE_MS } from './work-state.js';
import { hasEmbeddingWork } from './work.js';
export { hasEmbeddingWork, type EmbeddingWorkScope } from './work.js';
import { advanceEmbedding } from './step.js';
import { calibrationModel } from './policy.js';
import { completeEmbeddingSwitch, embeddingWorkPlan, type EmbeddingWorkPlan } from './switch.js';
import { readSwitch } from './switch-store.js';

export { EMBEDDING_RETRY_MS, EMBEDDING_TASK } from './task.js';
import { EMBEDDING_RETRY_MS, EMBEDDING_TASK } from './task.js';
export const EMBEDDING_SWEEP_ASSERTION = 'embedding:sweep';
export const PREVENT_DEEP_SLEEP_LEAF = 'embedding.prevent_deep_sleep';
/** How long after a finished audit of every Project the next one starts: the finite pass that finds what no trigger marks. */
export const WORK_AUDIT_INTERVAL_MS = 60 * 60_000;

/** Whether embedding work holds the Deployment awake while it waits: on unless an admin turned it off. */
export async function keepsEmbeddingWhileIdle(db: ServerEnv['db']): Promise<boolean> {
  return (await settingTexts(db, [PREVENT_DEEP_SLEEP_LEAF])).get(PREVENT_DEEP_SLEEP_LEAF) !== JSON.stringify(false);
}

/** Every model a plan writes or keeps, which its provider holds and work rows are read under. */
const planModels = (plan: EmbeddingWorkPlan): string[] => [...new Set([plan.model, ...(plan.building === null ? [] : [plan.building]), ...plan.retain])];

/** The Deployment's work scope: what every Project's check covers, so a change to it starts an audit of every Project. */
const workScope = (plan: EmbeddingWorkPlan, ready: readonly string[]): string => JSON.stringify({
  predicate: WORK_PREDICATE_VERSION, model: plan.model, building: plan.building, retain: [...plan.retain].sort(), switching: plan.switching, ready: [...ready].sort(),
});

/**
 * The Projects with embedding work now, found without reading every Project: those a source, receipt, failure or
 * calibration mutation marked for attention, those whose wake time came, and, while an audit runs, one page of every
 * Project, probed fresh. Each is checked through its maintained work rows; a Project found idle leaves the attention set.
 */
async function projectsWithWork(env: ServerEnv, plan: EmbeddingWorkPlan, now: number, options: { rotate?: boolean } = {}) {
  const ready = await readyProviders(env.db, [plan.model, ...(plan.building === null ? [] : [plan.building])], now);
  const calibrate = calibrationModel(plan.model, plan.switching);
  const scope = workScope(plan, ready);
  const candidates = await workCandidates(env.db, scope, [plan.model, calibrate], now, WORK_AUDIT_INTERVAL_MS, options.rotate === true);
  const found: Array<{ projectId: string; retireOnly: boolean }> = [];
  for (const project of candidates.projects) {
    if (project.gone) { await clearWorkAttention(env.db, project.projectId, []); continue; }
    const checked: CheckedWork = project.retireOnly ? [[plan.model, 'embedding']] : [[plan.model, 'embedding'], [calibrate, 'hubness']];
    if (await hasEmbeddingWork(env.db, project.projectId, plan.model, now, { ...plan, retireOnly: project.retireOnly, ready, fresh: project.audited })) {
      found.push(project);
      if (!project.marked) await markWorkAttention(env.db, project.projectId);
    } else if (project.marked) await clearWorkAttention(env.db, project.projectId, checked);
  }
  if (candidates.audit !== null) await advanceWorkAudit(env.db, candidates.audit, now);
  if (options.rotate === true) await rotateWorkAttention(env.db, candidates.cursor);
  return { found, scope, more: candidates.full };
}

export async function embeddingKeepsAwake(env: ServerEnv, now: number): Promise<boolean> {
  if (!hasTaskRuntime(env, EMBEDDING_TASK) || env.origin === undefined) return false;
  if (!(await keepsEmbeddingWhileIdle(env.db))) return false;
  const plan = await embeddingWorkPlan(env, now);
  if (plan === null) return false;
  // A full attention page found idle leaves more Projects to check: the next wake reads them.
  const checked = await projectsWithWork(env, plan, now);
  return checked.found.length > 0 || checked.more;
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
  for (const project of (await projectsWithWork(env, plan, now, { rotate: true })).found) {
    served.push({ ...project, last: await lastTaskEntryAt(env.db, { projectId: project.projectId }, EMBEDDING_TASK) });
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

/**
 * The registry job: dispatch when allowed, then chain another wake while an audit of every Project is under way or a
 * held provider's retry is due.
 */
export async function runEmbeddingJob(env: ServerEnv, now: number, options: { sweepOnly?: boolean; allowDispatch?: boolean } = {}): Promise<{ changed: number; more: boolean; continueAfterMs?: number }> {
  let pending = options.sweepOnly !== true && options.allowDispatch !== false;
  if (!pending && hasTaskRuntime(env, EMBEDDING_TASK) && env.origin !== undefined) {
    // Without a dispatch, the check itself still advances the audit and clears idle Projects.
    const plan = await embeddingWorkPlan(env, now);
    if (plan !== null) { const checked = await projectsWithWork(env, plan, now); if (checked.found.length > 0 || checked.more) pending = true; }
  }
  const changed = pending && options.allowDispatch !== false ? await dispatchEmbeddingWork(env, now) : 0;
  if (!hasTaskRuntime(env, EMBEDDING_TASK) || env.origin === undefined) return { changed, more: false };
  const plan = await embeddingWorkPlan(env, now);
  if (plan !== null && await owed(env, plan, now)) return { changed, more: true, continueAfterMs: WORK_SWEEP_CONTINUE_MS };
  const retryAt = await heldUntil(env, plan, now);
  if (retryAt !== null) return { changed, more: true, continueAfterMs: retryAt - now };
  return { changed, more: false };
}

/** Deferred embedding work holds no depth shallower than sleep. */
export async function embeddingSweepPending(env: ServerEnv, now: number): Promise<boolean> {
  if (!hasTaskRuntime(env, EMBEDDING_TASK) || env.origin === undefined || !(await keepsEmbeddingWhileIdle(env.db))) return false;
  const plan = await embeddingWorkPlan(env, now);
  if (await heldUntil(env, plan, now) !== null) return true;
  return plan !== null && owed(env, plan, now);
}

/** Whether scheduling still owes a check under `plan`: fixed rows, no Project read. */
async function owed(env: ServerEnv, plan: EmbeddingWorkPlan, now: number): Promise<boolean> {
  const ready = await readyProviders(env.db, [plan.model, ...(plan.building === null ? [] : [plan.building])], now);
  return workOwed(env.db, workScope(plan, ready));
}

async function heldUntil(env: ServerEnv, plan: EmbeddingWorkPlan | null, now: number): Promise<number | null> {
  const models = plan === null ? [(await readSwitch(env.db))?.modelKey].filter((m): m is string => m !== undefined) : planModels(plan);
  return providerRetryAt(env.db, models, now);
}
