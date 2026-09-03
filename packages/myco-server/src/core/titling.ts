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
import { sessionMaterialRows, sessionMaterialTailRows, type MaterialRow } from '../read/children.js';
import { claimOwnerTitling, claimTitling, restoreTitlingStamp } from '../read/sessions.js';
import { dispatchPrepared, prepareDispatch, type DispatchRefusal, RUN_OVERRUN_MARGIN_MS } from './harness.js';

export const TITLING_TASK = 'title-summary';
export const TITLE_MAX_CHARS = 80;
export const SUMMARY_MAX_CHARS = 1200;
/** How long a titling run may take. The task definition says the same (`title-summary.yaml`); this is the bound the claim's in-flight window is computed from. */
export const TITLING_RUN_TIMEOUT_SECONDS = 300;
/** How long a run's container may outlive the run's own bound before its hold is released; the same margin the hosted runtime applies (`HOLD_OVERRUN_MARGIN_MS`, pinned equal by test). */
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
  | 'error' | 'dispatched' | 'queued';

export type MaterialLine = Pick<MaterialRow, 'prompt' | 'response'>;

/**
 * How a title is asked for. `claim` is the end of a session: one attempt ever,
 * writing only where no title exists, over the session's opening prompts. `owner`
 * is a person asking from the dashboard: any session, ended or not, over the
 * opening and closing prompts, writing over whatever title is there.
 */
export type TitlingMode = 'claim' | 'owner';
export const TITLING_MODES: readonly TitlingMode[] = ['claim', 'owner'];

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

/** The parameters a titling run is dispatched with, as the runtime and the run routes read them back from the run's context the server wrote. */
export interface TitlingParams {
  session_id: string;
  mode: TitlingMode;
  /** The member whose ask this is, on an owner's ask; the write names them as `titled_by`. */
  by?: string;
}

/** The parameters a run's stored context names, or null when the context is not a titling dispatch. */
export function titlingParamsOf(runContext: string | null): TitlingParams | null {
  if (runContext === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(runContext); } catch { return null; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const { session_id: sessionId, mode, by } = parsed as Record<string, unknown>;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  if (!TITLING_MODES.includes(mode as TitlingMode)) return null;
  return { session_id: sessionId, mode: mode as TitlingMode, ...(typeof by === 'string' && by.length > 0 ? { by } : {}) };
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
  no_provider: 'no_provider',
  no_credential: 'no_credential',
  no_endpoint: 'no_endpoint',
  unsupported_provider: 'unsupported_provider',
  // A titling dispatch names a catalogued task and a session the scope already resolved; neither refusal has a path here.
  unknown_task: 'error',
  unknown_project: 'error',
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
    const prepared = await prepareDispatch(env, TITLING_TASK, projectId);
    if (!prepared.ok) return skipped(REFUSAL_OUTCOME[prepared.refusal]);

    const material = await sessionMaterial(env.db, projectId, sessionId, mode);
    if (material.length === 0) return skipped('no_material');

    // The claim is the last thing before the launch, so a refusal decided above costs nothing.
    let previous: number | null = null;
    if (mode === 'owner') {
      const claim = await claimOwnerTitling(env.db, projectId, sessionId, now, OWNER_TITLING_WINDOW_MS);
      if (!claim.claimed) return skipped('already');
      previous = claim.previous;
    } else if (!(await claimTitling(env.db, projectId, sessionId, now))) {
      return skipped('already');
    }

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
  } catch {
    return failed('error');
  }
}
