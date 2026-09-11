/**
 * A session's title and summary, written on the Deployment by a run of the
 * `title-summary` task on the agent harness.
 *
 * The request that ends a session schedules this past its answer; a person asks
 * for it from the dashboard. Either way the gate is here and the model call is
 * not: this module decides whether a run should start — a bound runtime, a
 * provider and credential, material to read, the session's claim — and then
 * dispatches through the one dispatcher (`core/harness.ts`). The run reads its
 * material and writes its answer over the run routes; nothing here calls a
 * provider, so a title costs the Deployment exactly what any other task does and
 * uses whatever credential the harness holds.
 *
 * Every step before the launch writes nothing but the claim, and a launch the
 * runtime refuses gives the claim back. Every outcome is emitted; none is thrown.
 */
import { MATERIAL_EXCERPT_CHARS, MAX_MATERIAL_CHARS, MAX_MATERIAL_PROMPTS } from '../constants.js';
import { emit } from '../telemetry.js';
import type { RelationalStore, ServerEnv } from './adapters.js';
import { sessionMaterialRows, sessionMaterialTailRows, listReadyTitleSessions, type MaterialRow } from '../read/children.js';
import { claimOwnerTitling, claimTitling, restoreTitlingStamp } from '../read/sessions.js';
import { dispatchPrepared, prepareDispatch, type DispatchRefusal, RUN_OVERRUN_MARGIN_MS } from './harness.js';
import { TITLING_TASK } from './task-catalogue.js';
import { assertSessionMaterialReady, SessionMaterialPendingError } from '../read/material-readiness.js';

export { TITLING_TASK } from './task-catalogue.js';
import { SUMMARY_MAX_CHARS, TITLE_MAX_CHARS, type TitlingMode, type TitlingParams } from './titling-params.js';
export { SUMMARY_MAX_CHARS, TITLE_MAX_CHARS, TITLING_MODES, titlingParamsOf, type TitlingMode, type TitlingParams } from './titling-params.js';
/** How long a titling run may take. The task definition says the same (`title-summary.yaml`); this is the bound the claim's in-flight window is computed from. */
export const TITLING_RUN_TIMEOUT_SECONDS = 300;
/** How long a run may outlive its own bound before the Deployment gives up on it; the dispatcher's own margin, re-exported so the owner window is computed from one number. */
export { RUN_OVERRUN_MARGIN_MS };
/** How long after an owner's ask a second ask is refused: the run's own bound plus the overrun margin, so a run still writing is never raced by a second one. */
export const OWNER_TITLING_WINDOW_MS = TITLING_RUN_TIMEOUT_SECONDS * 1000 + RUN_OVERRUN_MARGIN_MS;

/**
 * How an ask ended. `dispatched` is the one that started a run; `already` is
 * a claim another attempt holds; the rest are settled refusals an operator
 * clears — in Settings, or by binding a runtime to the Deployment.
 */
export type TitlingOutcome =
  | 'already' | 'no_material' | 'harness_unavailable' | 'no_provider' | 'no_credential' | 'no_endpoint' | 'unsupported_provider'
  | 'error' | 'dispatched' | 'queued' | 'capture_pending';

export type MaterialLine = Pick<MaterialRow, 'prompt' | 'response'>;

const lineCost = (row: MaterialRow): number => row.prompt.length + (row.response?.length ?? 0);

/** The rows that fit a character budget, taken in the given order and answered in that order. */
function fit(rows: readonly MaterialRow[], budget: number): { rows: MaterialRow[]; used: number } {
  const kept: MaterialRow[] = [];
  let used = 0;
  for (const row of rows) {
    const cost = lineCost(row);
    if (used + cost > budget) break;
    used += cost;
    kept.push(row);
  }
  return { rows: kept, used };
}

/**
 * The session's inline user prompts, each with the start of its first inline response, inside the character budget.
 * At a session's end: the earliest prompts. On an owner's ask: the earliest and the latest halves, each fitted to its own half of the budget — the tail from the latest prompt backwards, so what survives is the arc's end and never its middle.
 */
export async function sessionMaterial(db: RelationalStore, projectId: string, sessionId: string, mode: TitlingMode = 'claim'): Promise<MaterialLine[]> {
  const excerpt = { excerptChars: MATERIAL_EXCERPT_CHARS };
  const toLine = (row: MaterialRow): MaterialLine => ({ prompt: row.prompt, response: row.response ?? null });
  if (mode !== 'owner') {
    return fit(await sessionMaterialRows(db, projectId, sessionId, { limit: MAX_MATERIAL_PROMPTS, ...excerpt }), MAX_MATERIAL_CHARS).rows.map(toLine);
  }
  const halfPrompts = Math.ceil(MAX_MATERIAL_PROMPTS / 2);
  const halfChars = Math.ceil(MAX_MATERIAL_CHARS / 2);
  const headRows = await sessionMaterialRows(db, projectId, sessionId, { limit: halfPrompts, ...excerpt });
  const tailRows = await sessionMaterialTailRows(db, projectId, sessionId, { limit: MAX_MATERIAL_PROMPTS - halfPrompts, ...excerpt });
  const seen = new Set(headRows.map((r) => r.promptId));
  const tailOnly = tailRows.filter((r) => !seen.has(r.promptId));
  const tail = fit([...tailOnly].reverse(), halfChars);
  const head = fit(headRows, MAX_MATERIAL_CHARS - tail.used);
  return [...head.rows, ...tail.rows.reverse()].map(toLine);
}

/** A title as the run offered it, made fit to store: one line, no trailing period, inside the bound; null when nothing usable remains. */
export function cleanTitle(title: string): string | null {
  const cleaned = title.replace(/\s+/g, ' ').trim().replace(/[.…]+$/, '').trim();
  return cleaned.length === 0 || cleaned.length > TITLE_MAX_CHARS ? null : cleaned;
}

/** A summary as the run offered it, trimmed and inside the bound; null when nothing usable remains. */
export function cleanSummary(summary: string): string | null {
  const cleaned = summary.trim();
  return cleaned.length === 0 || cleaned.length > SUMMARY_MAX_CHARS ? null : cleaned;
}

/** Who an automatic titling is attributed to: the Deployment itself, acting on a capture. */
const DEPLOYMENT_ACTOR = 'deployment';

export interface TitlingTarget {
  projectId: string;
  sessionId: string;
  now: number;
  /** The origin of the request that asked: where the run calls back to. */
  origin: string;
}

export interface TitlingResult {
  outcome: TitlingOutcome;
  /** The run that will write the title, on `dispatched`. */
  runId?: string;
}

const REFUSAL_OUTCOME: Readonly<Record<DispatchRefusal, TitlingOutcome>> = {
  harness_unavailable: 'harness_unavailable',
  no_instruction: 'error',
  not_landed: 'error',
  no_provider: 'no_provider',
  no_credential: 'no_credential',
  no_endpoint: 'no_endpoint',
  unsupported_provider: 'unsupported_provider',
  // A titling dispatch names a catalogued task and a session the scope already resolved; neither refusal has a path here.
  unknown_task: 'error',
  unknown_project: 'error',
  repository_missing: 'error',
};

/**
 * Titles one session: at its end (`claim`, the default) or on an owner's ask
 * (`owner`). Decides in this order, and writes nothing before the claim:
 * a bound runtime, a provider and its credential, material to read, the claim,
 * the launch. Resolves with the outcome it emitted; never rejects.
 */
export async function titleSession(env: ServerEnv, target: TitlingTarget, opts: { mode?: TitlingMode; by?: string } = {}): Promise<TitlingResult> {
  const { projectId, sessionId, now } = target;
  const mode = opts.mode ?? 'claim';
  const skipped = (outcome: TitlingOutcome): TitlingResult => { emit({ kind: 'session_title_skipped', projectId, sessionId, outcome, mode }); return { outcome }; };
  const failed = (outcome: TitlingOutcome): TitlingResult => { emit({ kind: 'session_title_failed', projectId, sessionId, outcome, mode }); return { outcome }; };
  try {
    await assertSessionMaterialReady(env.db, projectId, sessionId);
    const prepared = await prepareDispatch(env, TITLING_TASK, projectId);
    if (!prepared.ok) return skipped(REFUSAL_OUTCOME[prepared.refusal]);

    const material = await sessionMaterial(env.db, projectId, sessionId, mode);
    if (material.length === 0) return skipped('no_material');

    // The claim is the last thing before the launch, so a refusal decided above costs nothing.
    const claim = mode === 'owner'
      ? await claimOwnerTitling(env.db, projectId, sessionId, now, OWNER_TITLING_WINDOW_MS)
      : { claimed: await claimTitling(env.db, projectId, sessionId, now), previous: null };
    if (!claim.claimed) {
      await assertSessionMaterialReady(env.db, projectId, sessionId);
      return skipped('already');
    }
    const previous = claim.previous;

    const params: TitlingParams = { session_id: sessionId, mode, ...(mode === 'owner' && opts.by !== undefined ? { by: opts.by } : {}) };
    const spec = {
      serverUrl: target.origin,
      actor: opts.by ?? DEPLOYMENT_ACTOR,
      timeoutSeconds: TITLING_RUN_TIMEOUT_SECONDS,
      params: { ...params },
    };
    try {
      // A limit holds the run in the queue; the claim stands, and the run's own window opens when it launches.
      const dispatched = await dispatchPrepared(env, prepared.prepared, spec, now);
      if (dispatched.queued) {
        emit({ kind: 'session_title_queued', projectId, sessionId, mode, runId: dispatched.runId, heldBy: dispatched.heldBy });
        return { outcome: 'queued', runId: dispatched.runId };
      }
      emit({ kind: 'session_title_dispatched', projectId, sessionId, mode, runId: dispatched.runId });
      return { outcome: 'dispatched', runId: dispatched.runId };
    } catch {
      // A launch the runtime refused: the session keeps its own attempt, and an owner may ask again at once.
      await restoreTitlingStamp(env.db, projectId, sessionId, now, previous);
      return failed('error');
    }
  } catch (error) {
    if (error instanceof SessionMaterialPendingError) return skipped('capture_pending');
    return failed('error');
  }
}

/** The most deferred session titles one wake can attempt. */
export const SESSION_TITLE_BATCH = 20;

/** New live session-end requests wait until parsed material can be claimed. */
export async function titleReadySessions(env: ServerEnv, now: number): Promise<number> {
  const requests = await listReadyTitleSessions(env.db, SESSION_TITLE_BATCH);
  if (requests.length === 0) return 0;
  if (env.origin === undefined) throw new Error('Deferred titling requires the Deployment origin to be configured.');
  let dispatched = 0;
  for (const target of requests) {
    const result = await titleSession(env, { ...target, now, origin: env.origin });
    if (result.outcome === 'dispatched' || result.outcome === 'queued') dispatched += 1;
  }
  return dispatched;
}
