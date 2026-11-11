import { queuedWorkExists } from '../db/runs/queue.js';
import { admissionReady } from '../db/runs/live.js';
import { todayProjects, todayRunning, todayQueued, type ProjectCursor } from '../db/runs/now.js';
import { failureReasons, unresolvedFailures, NOW_WATCHED_TASKS } from '../db/runs/outcomes.js';
import { unclaimedDue } from '../db/runs/unclaimed.js';
import { todaySchedules, curationDispositions } from '../db/learning/curation-now.js';
import { todayMarks } from '../db/meta/marks.js';
/** Current work, waits and unresolved failures, with exact live totals and explicit page coverage. */
import { MAP_TASK } from '@goondocks/myco-shared/canopy';
import { QUEUE_REASON_WORDS } from '@goondocks/myco-shared/runner-fleet';
import { HELD_BY_WORDS, holdSentence, visibleRunHolder } from '@goondocks/myco-shared/run-holds';
import { stepWords } from '@goondocks/myco-shared/step-words';
import { callWords } from '@goondocks/myco-shared/call-words';
import type { StepKind } from '@goondocks/myco-shared/worker-steps';
import type { Marks } from '@goondocks/myco-shared/live-marks';
import type { RelationalStore, ServerEnv } from '../core/adapters.js';
import { CURATION_TASK, EXTRACTION_TASK, TASK_WORDS } from '../core/task-catalogue.js';
import { CARD_TASK } from '@goondocks/myco-shared/turn-card';
import type { WorkerFleetRow } from '../core/worker-contacts.js';
import {
  fleetAvailability,
  applyFleetSignInAvailability,
  fleetSelectionContext,
  fleetWaits,
} from '../db/runs/fleet.js';
import { learningStatusLine, readLearningStatus } from '../core/learning-sessions.js';
import { readTaskBudgetHolds as readBudgetHolds } from '../db/runs/queue.js';
import { BUDGET_WINDOW_MS } from '../core/budget-policy.js';
import { enabledCapabilities, type ProjectCapability } from '../core/settings.js';
import { capabilityOf } from '../core/worker-selection.js';
import { PRE_CONDITIONS, scheduleFor, scheduleLeaves } from '../core/schedule-rules.js';
import { TASK_SCHEDULE } from '../core/jobs.js';
import { ADVANCING_STAGES, type RecoveryProducerStatus } from '../core/recovery-producer.js';
import { within } from '../core/recovery-inventory.js';
import { OUTCOME_LOOKBACK_MS } from '../core/attention-state.js';

/** How long a producer is given to say whether a backup is copying the database. */
const BACKUP_STATUS_MS = 2_000;

/** An open curation group that failed and will be tried again, in its Project. */
interface FailingGroup { projectId: string; group: Record<string, unknown> }

/** A curation group's decisions that settle it: a failure of the run that worked on it no longer needs anyone. */
const SETTLED_DECISIONS: readonly string[] = ['keep', 'resolved', 'changed'];

type WorkNowSection = 'running' | 'waiting' | 'needsYou';

/** A run running now, with the latest thing it did. */
interface NowRunning {
  runId: string;
  projectId: string;
  task: string;
  /** The task in the reader's words. */
  what: string;
  /** The runner holding it, by its own name; null where none is named. */
  machine: string | null;
  /** The runner holding it, by id, and when that runner last checked in; null for a run no runner holds. */
  runnerId: string | null;
  heardAt: number | null;
  harness: string | null;
  model: string | null;
  startedAt: number | null;
  /** Its latest step or call to Myco, in the reader's words; null before it has done anything Myco saw. */
  step: { words: string; at: number } | null;
}

/** Work that waits, and the server's reason. */
interface NowWaiting {
  key: string;
  /** The Project it waits in, or null for what waits Deployment-wide. */
  projectId: string | null;
  what: string;
  /** How many queued runs or due items it stands for, where it is a count. */
  count: number | null;
  why: string;
  /** When it began to wait, where known. */
  since: number | null;
  /** When it is next due, where a schedule says. */
  nextAt: number | null;
}

/** A failure or a stuck item, with the server's own reason and the run to open. */
interface NowNeed {
  key: string;
  projectId: string | null;
  what: string;
  why: string;
  at: number;
  /** The run its reason comes from; null where none does. */
  runId: string | null;
  /** When Myco tries again by itself, where it will. */
  retryAt: number | null;
}

interface WorkNowAnswer {
  observedAt: number;
  scope: 'project' | 'deployment';
  running: NowRunning[];
  waiting: NowWaiting[];
  needsYou: NowNeed[];
  /**
   * What moved between answers: `runs` changes when a run starts, finishes, queues or fails; `sessions` when
   * any session receives capture; `knowledge` when a spore is written, edited, retired or deleted (the per-Project
   * spore revision the spore triggers keep) or a plan changes; `recovery` when a backup attempt starts, advances or
   * settles; `fleet` when a runner comes, goes, pauses or takes a run. The dashboard re-reads a page's other reads only
   * when the mark they follow moves.
   */
  marks: Marks;
  /**
   * How many Projects this answer read per-Project work for, of how many it covers. A Deployment-wide answer reads
   * Projects with live work or unresolved failures first, then by capture activity up to `NOW_PROJECTS_MAX`; when
   * `read` is below `total` the page says so and offers each Project's own page.
   */
  projects: { read: number; total: number; hasMore: boolean; cursor: ProjectCursor | null };
  runningTotal: number;
  runningHasMore: boolean;
  unavailable: WorkNowSection[];
}

/** One Project, or every Project the dashboard lists. */
type WorkNowScope = { projectId: string } | { all: true };

const taskName = (task: string | null): string => (task !== null && task in TASK_WORDS ? TASK_WORDS[task as keyof typeof TASK_WORDS].name : task ?? 'A task');
const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const str = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The latest thing a run did that Myco saw: its worker's latest step, or its latest call to Myco, whichever is later. */
function latestStep(step: Record<string, unknown> | null, call: Record<string, unknown> | null, harness: string | null): NowRunning['step'] {
  const fromStep = step === null ? null : (() => {
    const words = stepWords({ kind: String(step.kind) as StepKind, tool: String(step.tool), target: str(step.target) }, harness);
    return { words: words.target === null ? words.lead : `${words.lead} ${words.target}`, at: Number(step.started_at) };
  })();
  const fromCall = call === null ? null : (() => {
    const op = str(call.op);
    return { words: callWords(String(call.tool_name), op), at: Number(call.recorded_at) };
  })();
  if (fromStep === null) return fromCall;
  if (fromCall === null) return fromStep;
  return fromCall.at > fromStep.at ? fromCall : fromStep;
}

async function readRunning(db: RelationalStore, scope: WorkNowScope) {
  const data = await todayRunning(db, scope);
  const rows = data.rows.map((row): NowRunning => {
    const key = `${String(row.project_id)}\0${String(row.id)}`;
    const attempt = data.profiles.get(key);
    const harness = str(row.harness) ?? str(attempt?.harness);
    return {
      runId: String(row.id), projectId: String(row.project_id), task: String(row.task ?? ''), what: taskName(str(row.task)),
      machine: str(row.runner), runnerId: str(row.runner_id), heardAt: num(row.heard_at), harness, model: str(row.model) ?? str(attempt?.model), startedAt: num(row.started_at),
      step: latestStep(data.steps.get(key) ?? null, data.calls.get(key) ?? null, harness),
    };
  });
  return { rows, total: data.total, hasMore: data.hasMore };
}

/** Queued runs grouped by Project and task, each with its stored holder's sentence or the fleet's current wait. */
async function readQueued(env: ServerEnv, scope: WorkNowScope, fleet: readonly WorkerFleetRow[], now: number, includeSignIn: boolean): Promise<NowWaiting[]> {
  if (!(await admissionReady(env.db))) return (await queuedWorkExists(env.db, scope)) ? [{ key: 'queued:building', projectId: 'projectId' in scope ? scope.projectId : null,
    what: 'Queued work', count: null, why: QUEUE_REASON_WORDS.queue_building, since: null, nextAt: null }] : [];
  const results = await todayQueued(env.db, scope);
  const groups = new Map<string, { projectId: string; task: string | null; held: string | null; count: number; since: number | null }>();
  for (const row of results) {
    const held = visibleRunHolder(str(row.held_by), includeSignIn);
    const key = `${String(row.project_id)}\u0000${String(row.task)}\u0000${held ?? ''}`;
    const group = groups.get(key) ?? { projectId: String(row.project_id), task: str(row.task), held, count: 0, since: null };
    group.count += Number(row.count);
    const at = num(row.since);
    if (at !== null) group.since = group.since === null ? at : Math.min(group.since, at);
    groups.set(key, group);
  }
  const waits = await fleetWaits(env, [...groups.values()].filter((g) => holdSentence(g.held) === null).map((g) => g.task), now, includeSignIn, fleet);
  return [...groups.entries()].map(([key, group]) => ({
    key: `queued:${key}`, projectId: group.projectId, what: taskName(group.task), count: group.count,
    why: holdSentence(group.held) ?? QUEUE_REASON_WORDS[waits.get(group.task)?.reason ?? 'unavailable'],
    since: group.since, nextAt: null,
  }));
}

/** Per-Project schedules: an open curation group not yet running, and the code map's next refresh. */
async function readScheduled(env: ServerEnv, projects: readonly string[], onePage: boolean, live: ReadonlySet<string>, now: number): Promise<{ waiting: NowWaiting[]; failingGroups: FailingGroup[] }> {
  const failingGroups: FailingGroup[] = [];
  if (projects.length === 0) return { waiting: [], failingGroups };
  const mapCapability = capabilityOf(MAP_TASK);
  const capabilities: ProjectCapability[] = ['spore_curation', ...(mapCapability === null ? [] : [mapCapability])];
  const [enabled, leaves] = await Promise.all([enabledCapabilities(env.db, capabilities, projects.length === 1 ? projects[0] : undefined), scheduleLeaves(env)]);
  const has = new Set(enabled.filter((row) => projects.includes(row.projectId)).map((row) => `${row.projectId}\u0000${row.capability}`));
  const curating = projects.filter((projectId) => has.has(`${projectId}\u0000spore_curation`));
  const mapping = leaves.enabled && leaves.mapRefresh.enabled ? projects.filter((projectId) => mapCapability === null || has.has(`${projectId}\u0000${mapCapability}`)) : [];
  const answers = await todaySchedules(env.db, curating, mapping, now);
  const waiting: NowWaiting[] = [];
  curating.forEach((projectId, i) => {
    const next = (answers[i * 3]![0] as Record<string, unknown> | undefined) ?? null;
    for (const group of answers[i * 3 + 1]! as Record<string, unknown>[]) failingGroups.push({ projectId, group });
    const day = answers[i * 3 + 2]![0] as Record<string, unknown>;
    if (next === null || live.has(`${projectId}\u0000${CURATION_TASK}`)) return;
    const started = Number(day.started);
    const limit = Number(day.limit_value);
    const dueAt = Number(next.due_at);
    const oldest = num(day.oldest);
    const why = started >= limit
      ? `Paused: ${started} of ${limit} new curation groups started in the last 24 hours. The next starts as the earliest leaves that window; a group that failed retries meanwhile.`
      : dueAt > now ? 'Its next group of overlapping spores comes due at the time shown.'
        : 'A group of overlapping spores is due; it starts when the server next checks, inside the daily budget.';
    waiting.push({ key: `curation:${projectId}`, projectId, what: 'Curation', count: null, why, since: null,
      nextAt: started >= limit && oldest !== null ? oldest + BUDGET_WINDOW_MS : dueAt > now ? dueAt : null });
  });
  const mapSchedule = scheduleFor(MAP_TASK, TASK_SCHEDULE[MAP_TASK]!, leaves.overrides);
  const condition = mapSchedule.preCondition === undefined ? undefined : PRE_CONDITIONS[mapSchedule.preCondition];
  const intervalMs = leaves.mapRefresh.intervalSeconds * 1000;
  const every = `It refreshes every ${plural(Math.max(1, Math.round(intervalMs / 3_600_000)), 'hour')}`;
  const ready = await Promise.all(mapping.map((projectId) => condition === undefined ? true : condition({ db: env.db, projectId, now })));
  mapping.forEach((projectId, i) => {
    if (live.has(`${projectId}\u0000${MAP_TASK}`)) return;
    const last = num((answers[curating.length * 3 + i]![0] as Record<string, unknown> | undefined)?.at);
    if (!ready[i]) {
      // A quiet project's map waits on nothing anyone can act on; only its own page says so.
      if (onePage) waiting.push({ key: `map:${projectId}`, projectId, what: 'Code map', count: null, since: last, nextAt: null,
        why: `${every}, and only after new session material arrives. None has arrived since the last refresh.` });
      return;
    }
    const dueAt = last === null ? now : last + intervalMs;
    waiting.push({ key: `map:${projectId}`, projectId, what: 'Code map', count: null, since: last, nextAt: dueAt > now ? dueAt : null,
      why: dueAt > now ? `${every}. New session material has arrived since the last refresh.` : 'Due now. It starts when the server next checks.' });
  });
  return { waiting, failingGroups };
}

/** Deployment-wide holds: the rolling budget spent, learning's backlog, and a backup that holds the database. */
async function readHolds(env: ServerEnv, scope: WorkNowScope, fleet: readonly WorkerFleetRow[], live: ReadonlySet<string>, now: number, includeSignIn: boolean,
  recovery: RecoveryProducerStatus | null): Promise<NowWaiting[]> {
  const waiting: NowWaiting[] = [];
  const holds = await readBudgetHolds(env.db);
  const held = holds.heldHeads ?? [];
  const tooSmall = held.find((head) => head.reason === 'budget_too_small');
  if (held.length > 0) {
    waiting.push({ key: 'budget', projectId: null, what: 'Automatic work', count: null, since: null, nextAt: null,
      why: tooSmall !== undefined && tooSmall.requiredUsd !== null
        ? `The next ${taskName(tooSmall.task).toLowerCase()} run needs about $${tooSmall.requiredUsd.toFixed(2)}, more than the whole daily budget of $${holds.dailyUsd.toFixed(2)}. Raise the daily budget in Settings.`
        : 'Paused: the rolling 24-hour budget has no room for the next automatic run. It resumes as earlier spending leaves the window.' });
  }
  const projectId = 'projectId' in scope ? scope.projectId : null;
  const learning = await readLearningStatus(env.db, now, projectId === null ? undefined : { projectId });
  const learningLive = [...live].some((key) => key.endsWith(`\u0000${EXTRACTION_TASK}`) || key.endsWith(`\u0000${CARD_TASK}`));
  if (!learningLive && (learning.dueSessions > 0 || learning.turnsAwaitingCards > 0)) {
    const task = learning.turnsAwaitingCards > 0 ? CARD_TASK : EXTRACTION_TASK;
    const waits = await fleetWaits(env, [task], now, includeSignIn, fleet);
    const reason = [...waits.values()][0]?.reason;
    const line = learningStatusLine(learning, null, now, reason === 'not_signed_in' || reason === 'credential_unavailable',
      held.some((head) => head.task === task));
    waiting.push({ key: 'learning', projectId, what: 'Learning from sessions', count: learning.dueSessions, why: line[0]!.toUpperCase() + line.slice(1), since: null, nextAt: null });
  }
  if (recovery !== null && (ADVANCING_STAGES as readonly string[]).includes(recovery.stage)) {
    waiting.push({ key: 'backup', projectId: null, what: 'Backup', count: null, since: recovery.startedAt, nextAt: null,
      why: 'A backup is copying the database. Work that reads it waits until the copy finishes.' });
  }
  return waiting;
}

/** How long due work may wait with no machine taking it before it needs someone. */
export const UNCLAIMED_WAIT_MS = 30 * 60_000;
const MINUTE_MS = 60_000;
/** A wait as a reader says it: minutes under two hours, else hours. */
const waitedWords = (ms: number): string => ms < 120 * MINUTE_MS ? plural(Math.floor(ms / MINUTE_MS), 'minute') : plural(Math.floor(ms / (60 * MINUTE_MS)), 'hour');

async function readNeeds(env: ServerEnv, projects: readonly string[], failingGroups: readonly FailingGroup[], fleet: readonly WorkerFleetRow[], now: number): Promise<NowNeed[]> {
  const unclaimed = await unclaimedDue(env.db, projects, now - UNCLAIMED_WAIT_MS);
  const pairs = projects.flatMap((projectId) => NOW_WATCHED_TASKS.map((task) => ({ projectId, task })));
  const failing = (await unresolvedFailures(env.db, pairs)).filter(failure =>
    failure.at >= now - OUTCOME_LOOKBACK_MS &&
    !(failure.task === CURATION_TASK && failingGroups.some(group => group.projectId === failure.projectId)));
  const curation = failing.filter((f) => f.task === CURATION_TASK);
  const dispositions = await curationDispositions(env.db, curation);
  const stopped = new Map<string, string>();
  curation.forEach((f, i) => {
    const group = dispositions[i]![0] as { decision?: unknown; reason?: unknown } | undefined;
    if (group?.decision === undefined || group.decision === null) return;
    if (SETTLED_DECISIONS.includes(String(group.decision))) failing.splice(failing.indexOf(f), 1);
    else stopped.set(f.runId, String(group.reason ?? ''));
  });
  const groups = failingGroups.filter(({ group }) => group.run_id !== null);
  const reasons = await failureReasons(env.db, [...failing, ...groups.map(({ projectId, group }) => ({ projectId, runId: String(group.run_id) }))]);
  const refusal = (raw: unknown): string | null => {
    if (typeof raw !== 'string') return null;
    try { const error = (JSON.parse(raw) as { error?: unknown }).error; return typeof error === 'string' && error.trim() !== '' ? error.trim() : null; } catch { return null; }
  };
  const reason = (projectId: string, runId: string) => reasons.get(`${projectId}\u0000${runId}`) ?? 'Myco didn’t record why.';
  const atLeast = (n: number, more = false) => (more ? `at least ${n} times` : n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
  return [
    ...failingGroups.map(({ projectId, group }): NowNeed => ({
      key: `curation-group:${projectId}:${String(group.cluster_key)}`, projectId,
      what: `A curation group failed ${atLeast(Number(group.failures))}`,
      why: refusal(group.write_refusal) ?? (group.run_id === null ? 'Myco didn’t record why.' : reason(projectId, String(group.run_id))),
      at: now, runId: str(group.run_id), retryAt: num(group.due_at),
    })),
    ...failing.map((f): NowNeed => ({
      key: `failed:${f.projectId}:${f.task}`, projectId: f.projectId,
      what: stopped.has(f.runId) ? 'Curation stopped on a group without a decision'
        : `${taskName(f.task)} failed ${f.failures === 1 ? 'on its latest run' : `${atLeast(f.failures, f.hasMore)} in a row`}`,
      why: stopped.get(f.runId) || reason(f.projectId, f.runId), at: f.at, runId: f.runId, retryAt: null,
    })),
    ...fleet.flatMap((row): NowNeed[] => {
      const runner = row.runnerDetails;
      const code = runner?.readiness.code;
      if (runner === undefined || row.runner?.state !== 'enabled' || (code !== 'not_signed_in' && code !== 'credential_unavailable')) return [];
      return [{ key: `sign-in:${row.runner.id}`, projectId: null, what: `${row.runner.name} can’t sign in to a coding agent`,
        why: runner.readiness.reason, at: runner.readiness.observedAt ?? now, runId: null, retryAt: null }];
    }),
    ...unclaimed.map((due): NowNeed => ({
      key: `unclaimed:${due.project_id}:${due.task}`, projectId: due.project_id,
      what: `${taskName(due.task)} has waited ${waitedWords(now - due.since)} with no machine taking it`,
      why: `${due.runs === 1 ? 'One run is' : `${due.runs} runs are`} due. ${HELD_BY_WORDS.worker}`,
      at: due.since, runId: due.run_id, retryAt: null,
    })),
  ];
}

/** Every section, each read on its own so one that fails is named and the rest still answer. */
export async function readWorkNow(env: ServerEnv, scope: WorkNowScope, now: number, includeSignIn: boolean, cursor: ProjectCursor | null = null): Promise<WorkNowAnswer> {
  const unavailable: WorkNowSection[] = [];
  const settle = async <T>(section: WorkNowSection, read: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await read(); } catch { if (!unavailable.includes(section)) unavailable.push(section); return fallback; }
  };
  const producer = env.recovery;
  const [fleet, marks, runningPage, recovery] = await Promise.all([
    settle('waiting', async () => {
      const rows = await fleetAvailability(env, now, includeSignIn);
      if (includeSignIn) await applyFleetSignInAvailability(rows, now, fleetSelectionContext(env, true).available);
      return rows;
    }, [] as WorkerFleetRow[]),
    todayMarks(env.db).catch(() => Array.from({ length: 5 }, () => `unread:${now}`)),
    settle('running', () => readRunning(env.db, scope), { rows: [] as NowRunning[], total: 0, hasMore: false }),
    producer === undefined ? null : within(() => producer.status(), BACKUP_STATUS_MS, Date.now).catch(() => null),
  ]);
  const running = runningPage.rows;
  const queued = await settle('waiting', () => readQueued(env, scope, fleet, now, includeSignIn), [] as NowWaiting[]);
  const live = new Set([...running.map((r) => `${r.projectId}\u0000${r.task}`), ...queued.map((q) => q.key.slice('queued:'.length).split('\u0000').slice(0, 2).join('\u0000'))]);
  const projects = await settle('needsYou', () => todayProjects(env.db, scope, cursor), { read: [] as string[], total: 0, hasMore: false, cursor: null });
  const [scheduled, holds] = await Promise.all([
    settle('waiting', () => readScheduled(env, projects.read, 'projectId' in scope, live, now), { waiting: [], failingGroups: [] as FailingGroup[] }),
    settle('waiting', () => readHolds(env, scope, fleet, live, now, includeSignIn, recovery), [] as NowWaiting[]),
  ]);
  const needsYou = await settle('needsYou', () => readNeeds(env, projects.read, scheduled.failingGroups, fleet, now), [] as NowNeed[]);
  const waiting = [...holds, ...queued, ...scheduled.waiting];
  return {
    observedAt: now, scope: 'projectId' in scope ? 'project' : 'deployment', running, waiting, needsYou, unavailable,
    projects: { read: projects.read.length, total: projects.total, hasMore: projects.hasMore, cursor: projects.cursor },
    runningTotal: runningPage.total, runningHasMore: runningPage.hasMore,
    marks: {
      runs: [marks[0], ...running.map((r) => r.runId), ...waiting.map((w) => `${w.key}=${w.count ?? ''}`), ...needsYou.map((n) => n.key)].join('|'),
      sessions: marks[1]!,
      knowledge: `${marks[2]}|${marks[3]}|${marks[5]}`,
      attention: marks[4]!,
      recovery: recovery === null ? '' : `${recovery.attempt ?? ''}:${recovery.stage}:${recovery.staged?.parts ?? ''}:${recovery.staged?.downloadedBytes ?? ''}`,
      fleet: fleet.map((row) => `${row.runner?.id ?? row.credentialId}:${row.runnerDetails?.display ?? (row.recent ? 'recent' : 'quiet')}:${row.busy?.runId ?? ''}`).join('|'),
    },
  };
}
