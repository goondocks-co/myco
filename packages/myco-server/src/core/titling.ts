/**
 * A session's title and summary, written on the Deployment by a run of the
 * `title-summary` task on the agent harness.
 *
 * The request that ends a session asks for this, and the wake cycle dispatches
 * it once the session has settled; a person asks for it from the dashboard.
 * Dispatch queues work for a worker, which selects its harness, execution profile
 * and login at claim. This module checks material readiness, session ownership
 * and run limits; it does not ask for provider configuration. The run reads its
 * material and writes its answer over the run routes.
 */
import {
  MATERIAL_EXCERPT_CHARS, MAX_MATERIAL_CHARS, MAX_MATERIAL_PROMPTS, SESSION_END_SETTLE_MS, TITLING_FRESH_RESERVE_DIVISOR, TITLING_FRESH_WINDOW_MS,
  TITLING_IDLE_CLOSE_MINUTES_DEFAULT, TITLING_REFRESH_MIN_INTERVAL_MS, TITLING_REFRESH_MIN_PROMPTS,
} from '../constants.js';
import { emit } from '../telemetry.js';
import type { RelationalStore, ServerEnv } from './adapters.js';
import { countConvergenceTitleSessions, listTitleCandidates, sessionMaterialRows, sessionMaterialTailRows, listReadyTitleSessions, type MaterialRow, type TitleCandidate, type TitleCandidateWindow } from '../read/children.js';
import { deploymentLastTaskEntryAt, deploymentTaskCeilingWindow, deploymentTaskEntriesSince, deploymentTaskRunTally } from './runs.js';
import { TITLING_BACKFILL_SCHEDULE, type ScheduleState } from './jobs.js';
import type { PowerState } from './power.js';
import { scheduleFor, scheduleLeaves } from './scheduled-tasks.js';
import { claimOwnerTitling, claimRefreshTitling, claimTitling, restoreTitlingStamp } from '../read/sessions.js';
import { storedSettings } from './settings.js';
import { CeilingReached, dispatchPrepared, prepareDispatch, type ActorCeiling, type DispatchRefusal, RUN_OVERRUN_MARGIN_MS } from './harness.js';
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
 * a claim another attempt holds. Other outcomes describe pending capture, missing
 * material, run limits, unavailable workers or a surfaced dispatch failure.
 */
export type TitlingOutcome =
  | 'already' | 'no_material' | 'harness_unavailable'
  | 'error' | 'dispatched' | 'queued' | 'capture_pending' | 'ceiling';

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
 * At a session's end: the earliest prompts. On an owner's ask or a refresh: the earliest and the latest halves, each fitted to its own half of the budget — the tail from the latest prompt backwards, so what survives is the arc's end and never its middle.
 */
export async function sessionMaterial(db: RelationalStore, projectId: string, sessionId: string, mode: TitlingMode = 'claim'): Promise<MaterialLine[]> {
  const excerpt = { excerptChars: MATERIAL_EXCERPT_CHARS };
  const toLine = (row: MaterialRow): MaterialLine => ({ prompt: row.prompt, response: row.response ?? null });
  if (mode === 'claim') {
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
  no_provider: 'error',
  probe_preferences_invalid: 'error',
  // No capability gates titling, so a titling dispatch is never refused for one.
  capability_off: 'error',
  // A titling dispatch names a catalogued task and a session the scope already resolved; neither refusal has a path here.
  unknown_task: 'error',
  unknown_project: 'error',
  repository_missing: 'error',
};

/**
 * Titles one session: at its end or once it has gone quiet past `idleBefore` (`claim`, the default; a first attempt unless
 * `retry` admits one that ended untitled), on an owner's ask (`owner`), or as the renewal of the title of a session still open
 * (`refresh`).
 * Validates parsed material and capture admission, reads bounded material,
 * claims the session, then queues its worker run. Resolves with the outcome
 * it emitted; never rejects.
 */
export async function titleSession(env: ServerEnv, target: TitlingTarget, opts: { mode?: TitlingMode; by?: string; actor?: string; ceiling?: ActorCeiling; retry?: boolean; idleBefore?: number } = {}): Promise<TitlingResult> {
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
      : mode === 'refresh'
        ? await claimRefreshTitling(env.db, projectId, sessionId, now, now - TITLING_REFRESH_MIN_INTERVAL_MS)
        : await claimTitling(env.db, projectId, sessionId, now, opts.retry === true ? now - OWNER_TITLING_WINDOW_MS : null, opts.idleBefore ?? null);
    if (!claim.claimed) {
      await assertSessionMaterialReady(env.db, projectId, sessionId);
      return skipped('already');
    }
    const previous = claim.previous;

    const params: TitlingParams = { session_id: sessionId, mode, ...(mode === 'owner' && opts.by !== undefined ? { by: opts.by } : {}) };
    const spec = {
      serverUrl: target.origin,
      actor: opts.actor ?? opts.by ?? DEPLOYMENT_ACTOR,
      timeoutSeconds: TITLING_RUN_TIMEOUT_SECONDS,
      params: { ...params },
    };
    try {
      // A limit holds the run in the queue; the claim stands, and the run's own window opens when it launches.
      const dispatched = await dispatchPrepared(env, prepared.prepared, spec, now, opts.ceiling === undefined ? {} : { ceiling: opts.ceiling });
      if (dispatched.queued) {
        emit({ kind: 'session_title_queued', projectId, sessionId, mode, runId: dispatched.runId, heldBy: dispatched.heldBy });
        return { outcome: 'queued', runId: dispatched.runId };
      }
      emit({ kind: 'session_title_dispatched', projectId, sessionId, mode, runId: dispatched.runId });
      return { outcome: 'dispatched', runId: dispatched.runId };
    } catch (error) {
      // A launch the runtime refused, or a write the ceiling refused: the session keeps its own attempt, and an owner may ask again at once.
      await restoreTitlingStamp(env.db, projectId, sessionId, now, previous);
      return error instanceof CeilingReached ? skipped('ceiling') : failed('error');
    }
  } catch (error) {
    if (error instanceof SessionMaterialPendingError) return skipped('capture_pending');
    return failed('error');
  }
}

/** The most deferred session titles one wake can attempt. */
export const SESSION_TITLE_BATCH = 20;

/**
 * Live end requests not yet attempted, once their session has settled and its
 * parsed material can be claimed. A request is taken only here, never as its
 * end arrives: the end hook sends the transcript bytes the end closes after the
 * end itself, so a title dispatched on the end would read material still
 * arriving (`SESSION_END_SETTLE_MS`).
 */
export async function titleReadySessions(env: ServerEnv, now: number): Promise<number> {
  const requests = await listReadyTitleSessions(env.db, SESSION_TITLE_BATCH, now - SESSION_END_SETTLE_MS);
  if (requests.length === 0) return 0;
  if (env.origin === undefined) throw new Error('Deferred titling requires the Deployment origin to be configured.');
  let dispatched = 0;
  for (const target of requests) {
    const result = await titleSession(env, { ...target, now, origin: env.origin });
    if (result.outcome === 'dispatched' || result.outcome === 'queued') dispatched += 1;
  }
  return dispatched;
}

/** Who the titling convergence is attributed to; the actor its runs carry, and the one its ceiling and interval count. */
export const TITLING_BACKFILL_ACTOR = 'backfill';
/** The most sessions one wake of the convergence attempts. */
export const TITLING_BACKFILL_BATCH = 5;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** The leaf holding how long a session still open may be quiet before it counts as ended for titling. */
const IDLE_CLOSE_LEAF = 'agent.titling_idle_close_minutes';

/** Minutes without activity after which a session still open counts as ended for titling; unset, or a stored value the leaf's rule refuses, means the default. */
export async function titlingIdleCloseMinutes(env: ServerEnv): Promise<number> {
  const held = (await storedSettings(env.db, [IDLE_CLOSE_LEAF])).get(IDLE_CLOSE_LEAF);
  return held !== undefined && held.violation === null ? held.value as number : TITLING_IDLE_CLOSE_MINUTES_DEFAULT;
}

/** The daily runs held back from older backlog so a fresh session is titled the day it goes quiet. */
export const freshReserve = (runsPerDay: number): number => Math.floor(runsPerDay / TITLING_FRESH_RESERVE_DIVISOR);

export interface TitlingBackfillPolicy {
  /** Whether the Deployment runs scheduled intelligence at all (`agent.scheduled_tasks_enabled`). */
  scheduledTasksEnabled: boolean;
  /** Whether the backfill's own block is on: the declared `enabled` under the owner's `title-summary` override. */
  backfillEnabled: boolean;
  /** The daily ceiling across the Deployment, from the block's `maxRunsPerDay`; absent means unbounded. */
  runsPerDay: number | null;
  /** The least time between two dispatching wakes, from the block's `intervalSeconds`. */
  intervalSeconds: number;
  /** The power states a wake dispatches in, from the block's `runIn`. */
  runIn: readonly ScheduleState[];
  /** `skip` holds a wake while a backfill run is in flight; `queue` lets the dispatch limits hold it. */
  overlap: 'skip' | 'queue';
  /** Whether wholly imported sessions are admitted: scheduling on and the block on. */
  enabled: boolean;
}

/** The convergence's policy: the declared block under the owner's `agent.tasks` override; its switch, behind the Deployment's scheduling switch, admits wholly imported sessions. */
export async function titlingBackfillPolicy(env: ServerEnv): Promise<TitlingBackfillPolicy> {
  const leaves = await scheduleLeaves(env);
  const schedule = scheduleFor(TITLING_TASK, TITLING_BACKFILL_SCHEDULE, leaves.overrides);
  const backfillEnabled = schedule.enabled !== false;
  return {
    scheduledTasksEnabled: leaves.enabled,
    backfillEnabled,
    runsPerDay: schedule.maxRunsPerDay ?? null,
    intervalSeconds: schedule.intervalSeconds,
    runIn: schedule.runIn,
    overlap: schedule.overlap,
    enabled: leaves.enabled && backfillEnabled,
  };
}

/**
 * Why a wake of the convergence dispatched nothing: out of the block's states,
 * inside its interval, held by a run in flight under `overlap: skip`, at the
 * daily ceiling, at the share of it older backlog may use (`reserved`: the rest
 * is kept for fresh work), or every candidate it tried met a refusal before a run
 * started. `until` is when the hold lifts, where a clock decides it: the interval's
 * end, or the instant the ceiling's window next frees a place.
 */
export type BackfillWaitReason = 'state' | 'interval' | 'overlap' | 'ceiling' | 'reserved' | 'skipped';
export interface BackfillWait {
  reason: BackfillWaitReason;
  until: number | null;
}

/** The interval's hold at `now`, from the last entry the backfill made; null once it has passed. */
export function intervalWait(policy: Pick<TitlingBackfillPolicy, 'intervalSeconds'>, lastEntryAt: number | null, now: number): BackfillWait | null {
  if (lastEntryAt === null || now - lastEntryAt >= policy.intervalSeconds * 1000) return null;
  return { reason: 'interval', until: lastEntryAt + policy.intervalSeconds * 1000 };
}

/** The ceiling's hold, from the window `deploymentTaskCeilingWindow` read; null while the window holds fewer entries than the ceiling. It lifts the instant the pivot entry falls out of the trailing day. */
export function ceilingWait(policy: Pick<TitlingBackfillPolicy, 'runsPerDay'>, window: { used: number; pivotAt: number | null }, reason: 'ceiling' | 'reserved' = 'ceiling'): BackfillWait | null {
  if (policy.runsPerDay === null || window.used < policy.runsPerDay) return null;
  return { reason, until: window.pivotAt === null ? null : window.pivotAt + DAY_MS + 1 };
}

/** The share of the daily ceiling older backlog may use: the ceiling less what fresh work keeps; null where there is no ceiling. */
const backlogShare = (runsPerDay: number | null): number | null => (runsPerDay === null ? null : runsPerDay - freshReserve(runsPerDay));

/**
 * The wait each Deployment's convergence last reported, by its store: a wake
 * reports a wait only when it differs from the one before, and forgets it on a
 * wake that dispatches or finds nothing to title. It decides nothing; a process
 * that starts afresh reports the standing wait once more.
 */
const reportedWaits = new WeakMap<RelationalStore, string>();

function reportWait(db: RelationalStore, wait: BackfillWait | null, detail: Record<string, unknown> = {}): void {
  if (wait === null) {
    reportedWaits.delete(db);
    return;
  }
  const key = JSON.stringify([wait.reason, wait.until, detail]);
  if (reportedWaits.get(db) === key) return;
  reportedWaits.set(db, key);
  const named: BackfillWaitReason = wait.reason;
  emit({ kind: 'titling_backfill_waiting', wait: named, until: wait.until, ...detail });
}

/**
 * Converges every ended or quiet session on a title, and keeps the title of a recently active session current, a bounded
 * page per wake, in the block's states, inside its interval and daily ceiling, and under its overlap rule. A session
 * counts as ended for titling once it has sent nothing for `agent.titling_idle_close_minutes`; its own `ended_at` is
 * untouched. A titled session, open or ended, active within the day, takes a refresh after enough prompts received
 * after the material of its standing title and enough time after its last titling stamp. Order: first titles of fresh
 * sessions, refreshes, then first titles of older backlog, each newest first. A third of the ceiling is held back from
 * refreshes and backlog, so a saturated day still gives a first title to what just ended or went quiet.
 * A session its own capture owes a title — an end request whose attempt ended untitled, a live session that ended or
 * went quiet without one — is always a candidate; a wholly imported session is one only while scheduled intelligence
 * and the block are both on. Each attempt is the same `claim` a session's own end makes, bounded by the attempts
 * workers took, and never over a title that stands except by a refresh. The ceiling, the interval and the overlap
 * count this actor's runs across every Project. The ceiling is held by the run write itself: the count read here
 * sizes the page, and the statement that records each run refuses past the ceiling, so wakes deciding at once write at
 * most the ceiling between them and a refused session keeps its claim. Idempotent: a session claimed by one wake is no
 * longer a candidate for the next, and a wake out of state, inside the interval, at the ceiling or held by overlap
 * dispatches nothing. A wake that dispatches nothing names its wait in `titling_backfill_waiting` when the wait changes.
 */
export async function backfillTitles(env: ServerEnv, now: number, state: PowerState): Promise<number> {
  const policy = await titlingBackfillPolicy(env);
  if (!(policy.runIn as readonly string[]).includes(state)) {
    reportWait(env.db, { reason: 'state', until: null }, { state });
    return 0;
  }
  const interval = intervalWait(policy, await deploymentLastTaskEntryAt(env.db, TITLING_TASK, TITLING_BACKFILL_ACTOR), now);
  if (interval !== null) {
    reportWait(env.db, interval);
    return 0;
  }
  const since = now - DAY_MS;
  if (policy.overlap === 'skip' && (await deploymentTaskRunTally(env.db, TITLING_TASK, since, TITLING_BACKFILL_ACTOR)).inFlight > 0) {
    reportWait(env.db, { reason: 'overlap', until: null });
    return 0;
  }
  let page = TITLING_BACKFILL_BATCH;
  let used = 0;
  let freshCeiling: ActorCeiling | undefined;
  let backlogCeiling: ActorCeiling | undefined;
  if (policy.runsPerDay !== null) {
    const window = await deploymentTaskCeilingWindow(env.db, TITLING_TASK, since, TITLING_BACKFILL_ACTOR, policy.runsPerDay);
    const held = ceilingWait(policy, window);
    if (held !== null) {
      reportWait(env.db, held, { runsPerDay: policy.runsPerDay });
      return 0;
    }
    used = window.used;
    page = Math.min(page, policy.runsPerDay - used);
    const ceilingOf = (perDay: number): ActorCeiling => ({ actor: TITLING_BACKFILL_ACTOR, task: TITLING_TASK, perDay, sinceMs: since });
    freshCeiling = ceilingOf(policy.runsPerDay);
    backlogCeiling = ceilingOf(backlogShare(policy.runsPerDay)!);
  }
  const idleBefore = now - (await titlingIdleCloseMinutes(env)) * MINUTE_MS;
  const candidates = await listTitleCandidates(env.db, titleWindow(now, idleBefore, policy.enabled), page);
  const share = backlogShare(policy.runsPerDay);
  const sharedRows = [...candidates.freshRefreshes, ...candidates.backlogClaims];
  if (env.origin === undefined && candidates.freshClaims.length + sharedRows.length > 0) throw new Error('The titling backfill requires the Deployment origin to be configured.');
  let dispatched = 0;
  let attempts = 0;
  let atCeiling = false;
  const outcomes: Partial<Record<TitlingOutcome, number>> = {};
  const attempt = async (target: TitleCandidate, ceiling: ActorCeiling | undefined): Promise<boolean> => {
    const { projectId, sessionId, mode } = target;
    attempts += 1;
    const result = await titleSession(env, { projectId, sessionId, now, origin: env.origin! }, { mode, actor: TITLING_BACKFILL_ACTOR, retry: true, idleBefore, ...(ceiling === undefined ? {} : { ceiling }) });
    outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1;
    if (result.outcome === 'dispatched' || result.outcome === 'queued') dispatched += 1;
    return result.outcome !== 'ceiling';
  };
  // First titles of fresh sessions may use the whole ceiling; refreshes and older backlog stop at the share that leaves the reserve unspent.
  const tiers: Array<{ rows: TitleCandidate[]; ceiling: ActorCeiling | undefined }> = [
    { rows: candidates.freshClaims, ceiling: freshCeiling },
    { rows: candidates.freshRefreshes, ceiling: backlogCeiling },
    { rows: candidates.backlogClaims, ceiling: backlogCeiling },
  ];
  tiers: for (const { rows, ceiling } of tiers) {
    for (const target of rows) {
      if (attempts >= page) break tiers;
      if (ceiling !== undefined && used + dispatched >= ceiling.perDay) break;
      if (!(await attempt(target, ceiling))) { atCeiling = true; break tiers; }
    }
  }
  if (dispatched > 0) reportWait(env.db, null);
  else if (atCeiling) reportWait(env.db, { reason: 'ceiling', until: null }, { runsPerDay: policy.runsPerDay });
  else if (attempts > 0) reportWait(env.db, { reason: 'skipped', until: null }, { outcomes });
  else if (sharedRows.length > 0 && share !== null && used >= share) {
    const held = ceilingWait({ runsPerDay: share }, await deploymentTaskCeilingWindow(env.db, TITLING_TASK, since, TITLING_BACKFILL_ACTOR, share), 'reserved');
    reportWait(env.db, held ?? { reason: 'reserved', until: null }, { runsPerDay: policy.runsPerDay });
  } else reportWait(env.db, null);
  return dispatched;
}

/** The instants a wake reads candidates by, from its clock and the idle bound. */
function titleWindow(now: number, idleBefore: number, imported: boolean): TitleCandidateWindow {
  return {
    retryBefore: now - OWNER_TITLING_WINDOW_MS,
    idleBefore,
    freshAfter: now - TITLING_FRESH_WINDOW_MS,
    refreshBefore: now - TITLING_REFRESH_MIN_INTERVAL_MS,
    refreshPrompts: TITLING_REFRESH_MIN_PROMPTS,
    imported,
  };
}

/** What an owner reads of the convergence's wait: the holds a clock decides. The power state and a skipped candidate are known only to a wake, and are reported by it. */
export type TitlingBackfillWait = BackfillWait & { reason: 'interval' | 'overlap' | 'ceiling' | 'reserved' };

export interface TitlingBackfillProgress extends TitlingBackfillPolicy {
  /** Wholly imported sessions still untitled and ready for the backfill. */
  remaining: number;
  /** Sessions their own capture owes a title, still untitled and ready; converged whether or not the backfill is on. */
  owed: number;
  /** Runs this actor dispatched in the trailing day; what the ceiling is measured against. */
  usedToday: number;
  /** Runs of the trailing day still queued or running. */
  inFlight: number;
  /** Runs of the trailing day that closed with a title written. */
  completedToday: number;
  /** Runs of the trailing day that closed without one. */
  failedToday: number;
  /** What holds the next dispatch while sessions wait for one: the ceiling first, then a run in flight, then the interval; null when nothing waits or nothing holds it. */
  waiting: TitlingBackfillWait | null;
}

/** Where the backfill stands: its policy, what is left, how the trailing day's runs went, and what the next dispatch waits for. */
export async function titlingBackfillProgress(env: ServerEnv, now: number): Promise<TitlingBackfillProgress> {
  const policy = await titlingBackfillPolicy(env);
  const since = now - DAY_MS;
  const idleBefore = now - (await titlingIdleCloseMinutes(env)) * MINUTE_MS;
  const share = backlogShare(policy.runsPerDay);
  const [left, usedToday, tally, window, last, backlogWindow, freshOwed] = await Promise.all([
    countConvergenceTitleSessions(env.db, now - OWNER_TITLING_WINDOW_MS, idleBefore),
    deploymentTaskEntriesSince(env.db, TITLING_TASK, since, TITLING_BACKFILL_ACTOR),
    deploymentTaskRunTally(env.db, TITLING_TASK, since, TITLING_BACKFILL_ACTOR),
    policy.runsPerDay === null ? null : deploymentTaskCeilingWindow(env.db, TITLING_TASK, since, TITLING_BACKFILL_ACTOR, policy.runsPerDay),
    deploymentLastTaskEntryAt(env.db, TITLING_TASK, TITLING_BACKFILL_ACTOR),
    share === null ? null : deploymentTaskCeilingWindow(env.db, TITLING_TASK, since, TITLING_BACKFILL_ACTOR, share),
    listTitleCandidates(env.db, titleWindow(now, idleBefore, policy.enabled), 1).then((c) => c.freshClaims.length > 0),
  ]);
  const waits = left.live > 0 || (policy.enabled && left.imported > 0);
  const overlap: BackfillWait | null = policy.overlap === 'skip' && tally.inFlight > 0 ? { reason: 'overlap', until: null } : null;
  const reserved = backlogWindow === null || share === null || freshOwed ? null : ceilingWait({ runsPerDay: share }, backlogWindow, 'reserved');
  const waiting = !waits ? null : ((window === null ? null : ceilingWait(policy, window)) ?? reserved ?? overlap ?? intervalWait(policy, last, now)) as TitlingBackfillWait | null;
  return { ...policy, remaining: left.imported, owed: left.live, usedToday, inFlight: tally.inFlight, completedToday: tally.completed, failedToday: tally.failed, waiting };
}
