/**
 * The agent run control plane, server-side.
 *
 * The agent does not reach this store. It runs as a process inside a container,
 * which is not a Worker and holds no bindings, so it calls the routes in
 * `api/runs.ts` and this module is what those routes call. That arrangement is
 * the point: atomicity lives with the single writer instead of once per client.
 *
 * Three operations here are atomic in SQL rather than in JavaScript, and each is
 * atomic in the WHERE clause rather than by batching. A batch cannot supply any
 * of them: its statements are fixed before it executes, so any decision taken
 * between a read and a write still happens in the caller, across an await, where
 * two concurrent phases interleave.
 *
 * - `claimRun` is one `INSERT ... SELECT ... WHERE NOT EXISTS`. A separate check
 *   followed by a separate insert admits a run twice under one id.
 * - `mutateState` is compare-and-swap. The caller's callback is arbitrary code
 *   and cannot move into SQL, so the prior value becomes the guard and a refused
 *   update is retried FROM THE READ. Retrying from anywhere else re-applies a
 *   decision taken against a value that is no longer there.
 * - `applyRunUpdate` guards a status change on the row not already being
 *   terminal. A run closing releases the container that ran it, and that release
 *   is what makes the container post an ending of its own, so the two writes
 *   overlap by construction and only the WHERE clause can settle which lands.
 */
import type { DispatchLimits } from './limits.js';
import type { RelationalStore } from './adapters.js';
import { inListChunks, type ReadScope } from '../read/scope.js';
import { providerConfiguredFor, settingsWriter, type ProjectCapability } from './settings.js';

/** The name a dispatch is left alone under when the Project has not moved past the artifact its task already wrote. */
export const INPUT_UNCHANGED = 'input_unchanged';

/** The context a skipped run carries: one shape, written by both skip paths and matched exactly by the interval clock. */
export const skipContext = (reason: string): string => JSON.stringify({ reason });

/** How many times a refused compare-and-swap is recomputed before the write is reported as contended. */
export const MUTATE_ATTEMPTS = 5;

export interface RunInsert {
  id: string;
  agentId: string;
  task: string | null;
  instruction: string | null;
  harness: string | null;
  provider: string | null;
  model: string | null;
  dryRun: boolean;
  startedAt: number;
  runContext: string | null;
  /** The credential that dispatched this run, or null when a schedule did. Supplies member and runtime attribution through `member_credentials`. */
  dispatchedBy: string | null;
}

/** A live run of a task, as much of it as a caller refused a claim needs. */
export interface RunningRunRef {
  id: string;
  task: string | null;
  startedAt: number | null;
  /** When the current attempt began, distinct from `startedAt` on a resumed run. */
  resumedAt: number | null;
}

/**
 * What must hold before a task may run.
 *
 * Two kinds, so a claim names one or the other and neither can be omitted.
 * Most intelligence is governed per Project by a capability. The
 * capture-driven tasks are not — a title and summary rides capture itself and
 * asks only whether this Deployment has a model to call, resolved task-first
 * then default.
 */
export type RunAdmissionGate =
  | { kind: 'capability'; capability: ProjectCapability }
  | { kind: 'embedding' }
  | { kind: 'provider' };

/**
 * Why a claim did not take.
 *
 * `running` names the run already recorded under this id. `notAdmitted` names a
 * Project that does not hold the capability the task needs, and `noProvider` a
 * Deployment with no model to call — settled answers a caller must not retry into.
 */
export type ClaimOutcome =
  | { claimed: true }
  | { claimed: false; running: RunningRunRef | null; notAdmitted?: undefined; noProvider?: undefined }
  | { claimed: false; running?: undefined; notAdmitted: ProjectCapability; noProvider?: undefined }
  | { claimed: false; running?: undefined; notAdmitted?: undefined; noProvider: true };

/** The state row a read returns, or null when the key is unset. */
export interface StateRow {
  key: string;
  value: string;
  updatedAt: number;
}

const CLAIM_SQL = `INSERT INTO agent_runs
    (project_id, id, agent_id, task, instruction, harness, provider, model, status, dry_run, started_at, run_context, dispatched_by)
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?
   WHERE NOT EXISTS (SELECT 1 FROM agent_runs WHERE project_id = ? AND id = ?)`;

/**
 * The claim of a run the server dispatched: the row the dispatcher wrote moves
 * to `running`, and only for the credential the dispatch minted. Everything
 * the dispatch decided — agent, task, context, attribution, and whether the run
 * is dry — stays as written; the runtime adds only what it knows: its harness,
 * and a provider or model it inferred where the dispatch named none.
 *
 * **`dry_run` is the dispatcher's.** A claim that carried it would let a runtime
 * that names nothing turn a dry run into a real one, and the write routes that
 * read `dry_run` off the row would then admit the write the dispatch refused.
 *
 * A `queued` row is claimable on the same terms. A launch answered after its
 * own deadline is taken back into the queue while the child it started is still
 * running, and that child claims under the credential the row still names; the
 * row keeps the start its launch stamped, and drops the holder that described a
 * run that is now running.
 */
const CLAIM_DISPATCHED_SQL = `UPDATE agent_runs
   SET status = 'running', harness = ?, instruction = COALESCE(?, instruction), provider = COALESCE(provider, ?), model = COALESCE(model, ?),
       started_at = COALESCE(started_at, ?), held_by = NULL
 WHERE project_id = ? AND id = ? AND status IN ('pending', 'queued') AND dispatched_by = ?`;

/**
 * The one exclusion rule: a run is never counted by a limit it is itself being
 * admitted against.
 *
 * A row already in the table — one the queue took back, carrying the start of
 * the launch that went out for it — is admitted against the OTHER runs, so
 * admitting it a second time requires leaving it out of every count. The read a
 * dispatcher takes first and the write that decides share this text, which is
 * what holds them to one answer. A caller with no row to leave out binds null.
 */
export const NOT_THE_RUN_ADMITTED = '(? IS NULL OR id != ?)';

/**
 * The limit check, as part of the write that launches: each limit is either
 * unset (its parameter NULL) or compared against the count the same statement
 * reads, so two launches deciding at once cannot both pass a limit of one.
 *
 * Bound as: fleet, run, run, fleet; concurrent, run, run, concurrent;
 * task-concurrent, task, run, run, task-concurrent; per-hour, task, run, run,
 * hour-start, per-hour; single, project, task, run.
 */
const ADMISSION_WHERE = `
   AND (? IS NULL OR (SELECT COUNT(*) FROM agent_runs WHERE status IN ('pending', 'running') AND ${NOT_THE_RUN_ADMITTED}) < ?)
   AND (? IS NULL OR (SELECT COUNT(*) FROM agent_runs WHERE status IN ('pending', 'running') AND ${NOT_THE_RUN_ADMITTED}) < ?)
   AND (? IS NULL OR (SELECT COUNT(*) FROM agent_runs WHERE status IN ('pending', 'running') AND task = ? AND ${NOT_THE_RUN_ADMITTED}) < ?)
   AND (? IS NULL OR (SELECT COUNT(*) FROM agent_runs WHERE task = ? AND ${NOT_THE_RUN_ADMITTED} AND started_at IS NOT NULL AND started_at >= ?) < ?)
   AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM agent_runs WHERE project_id = ? AND task = ? AND status IN ('pending', 'running', 'queued') AND id != ?))`;

/**
 * What a write is admitted against, or none: an unguarded write is a claim the
 * dispatcher already decided elsewhere. `singleFlight` names a task that runs
 * once at a time in a Project: the write refuses while another run of it is
 * live, in the same statement, so two wakes deciding at once write one row.
 */
export interface WriteAdmission {
  limits: DispatchLimits;
  now: number;
  singleFlight?: boolean;
}

export const NO_LIMITS: DispatchLimits = { concurrent_runs: null, task_concurrent_runs: null, task_runs_per_hour: null, fleet: null };

function admissionParams(scope: ReadScope, task: string | null, runId: string, admission: WriteAdmission | undefined): (string | number | null)[] {
  const l = admission?.limits ?? NO_LIMITS;
  const hourStart = (admission?.now ?? 0) - 3_600_000;
  const single = admission?.singleFlight === true ? task : null;
  return [
    l.fleet, runId, runId, l.fleet,
    l.concurrent_runs, runId, runId, l.concurrent_runs,
    l.task_concurrent_runs, task, runId, runId, l.task_concurrent_runs,
    l.task_runs_per_hour, task, runId, runId, hourStart, l.task_runs_per_hour,
    single, scope.projectId, task, runId,
  ];
}

const RECORD_DISPATCH_SQL = `INSERT INTO agent_runs
    (project_id, id, agent_id, task, instruction, provider, model, status, dry_run, started_at, run_context, dispatched_by)
  SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?
   WHERE NOT EXISTS (SELECT 1 FROM agent_runs WHERE project_id = ? AND id = ?)${ADMISSION_WHERE}`;

const RUN_REF_SQL = `SELECT id, task, started_at AS startedAt, resumed_at AS resumedAt FROM agent_runs
   WHERE project_id = ? AND id = ?`;

const RUNNING_SQL = `SELECT id, task, started_at AS startedAt, resumed_at AS resumedAt FROM agent_runs
   WHERE project_id = ? AND task = ? AND status = 'running'
     AND COALESCE(resumed_at, started_at) > ?
   ORDER BY COALESCE(resumed_at, started_at) DESC LIMIT 1`;

export interface DispatchRecord {
  id: string;
  agentId: string;
  task: string;
  provider: string | null;
  model: string | null;
  /** The prompt the server built for this run, or null for a task the server builds no input for. The run reads it back over `/runs/instruction`. */
  instruction?: string | null;
  /** A run that does the work and writes nothing; its write routes answer `written: false`. */
  dryRun?: boolean;
  /** The dispatch's parameters, which the run routes that serve one task read back; written here, by the server, and never by the runtime. */
  runContext: string | null;
  /** The credential the dispatch minted for this run. */
  dispatchedBy: string | null;
  startedAt: number;
}

/**
 * Record a dispatch: the run's row, `pending`, written by the dispatcher
 * before the runtime starts. What the row says about the run — its task, its
 * context, who dispatched it — is the server's word from here on; the
 * runtime's claim moves it to `running` and can change none of that. Answers
 * false when the id is already taken.
 */
export async function recordDispatch(db: RelationalStore, scope: ReadScope, record: DispatchRecord, admission?: WriteAdmission): Promise<boolean> {
  const result = await db.prepare(RECORD_DISPATCH_SQL).bind(
    scope.projectId, record.id, record.agentId, record.task, record.instruction ?? null, record.provider, record.model,
    record.dryRun === true ? 1 : 0, record.startedAt, record.runContext, record.dispatchedBy,
    scope.projectId, record.id,
    ...admissionParams(scope, record.task, record.id, admission),
  ).run();
  return result.meta.changes === 1;
}

/**
 * Claim a run: one row per run id, exactly once.
 *
 * The run is the unit of work — one minted id, one container — and any number
 * of runs of one task may be live at once, whatever the trigger, session or
 * Project. The claim therefore guards the ID and nothing else: a container that
 * claims twice is refused the second time, and two sessions' titling runs
 * coexist. A limit on how many run at once is a dispatcher's policy, decided at
 * dispatch (#1091), never an admission rule applied here.
 *
 * A run the server dispatched already has its row (`recordDispatch`); its
 * claim moves that row to `running`, and only for the credential the dispatch
 * minted. With `dispatchedOnly` — the runtime member's claims — an id with no
 * such row is refused outright: a dispatched credential names its own run and
 * no other, so the context and attribution the run routes read are always the
 * server's. Without it, a claim under a fresh id inserts the row, which is what
 * a scheduled or local run does.
 *
 * Admission is checked HERE rather than by the caller. A separate call is one a
 * caller can forget and claim anyway; folding it in makes a claim without
 * admission unrepresentable. Absence of a capability row means NOT admitted, so
 * a Project that appeared from a member's first write is admitted to nothing
 * until an operator says so.
 *
 * A refused admission and an id already claimed are different answers. Both
 * report `claimed: false`, so a caller reading one as the other would retry a
 * condition only an operator can clear.
 *
 * On a refused claim the row holding the id is read back. That read is on the
 * refusal path only, after the outcome is already settled.
 */
export async function claimRun(
  db: RelationalStore,
  scope: ReadScope,
  row: RunInsert,
  guard: { taskName: string; admission: RunAdmissionGate; dispatchedOnly?: boolean; embeddingConfigured?: boolean },
  _now: number,
): Promise<ClaimOutcome> {
  if (guard.admission.kind === 'capability') {
    if (!(await settingsWriter(db).capabilityEnabled(scope.projectId, guard.admission.capability))) {
      return { claimed: false, notAdmitted: guard.admission.capability };
    }
  } else if (guard.admission.kind === 'embedding' ? guard.embeddingConfigured !== true : !(await providerConfiguredFor(db, guard.taskName))) {
    return { claimed: false, noProvider: true };
  }
  if (row.dispatchedBy !== null) {
    const dispatched = await db.prepare(CLAIM_DISPATCHED_SQL).bind(
      row.harness, row.instruction, row.provider, row.model, row.startedAt,
      scope.projectId, row.id, row.dispatchedBy,
    ).run();
    if (dispatched.meta.changes === 1) return { claimed: true };
  }
  if (guard.dispatchedOnly === true) {
    const held = await db.prepare(RUN_REF_SQL).bind(scope.projectId, row.id).first<RunningRunRef>();
    return { claimed: false, running: held ?? null };
  }
  const result = await db.prepare(CLAIM_SQL).bind(
    scope.projectId, row.id, row.agentId, row.task, row.instruction, row.harness, row.provider, row.model,
    row.dryRun ? 1 : 0, row.startedAt, row.runContext, row.dispatchedBy,
    scope.projectId, row.id,
  ).run();

  if (result.meta.changes === 1) return { claimed: true };
  const running = await db.prepare(RUN_REF_SQL).bind(scope.projectId, row.id).first<RunningRunRef>();
  return { claimed: false, running: running ?? null };
}

/**
 * The most recent live run of a task inside a Project, or null: a read for a
 * dispatcher's own policy — a scheduled sweep that should not overlap itself
 * decides that at dispatch — never an admission rule.
 *
 * `maxAgeSeconds` is what makes a stale run stop counting: a run whose process
 * died leaves its row `running` forever. Every timestamp this server stores is
 * epoch MILLISECONDS while the floor is expressed in SECONDS, matching the
 * caller's vocabulary; the conversion is explicit here. The clock is
 * `COALESCE(resumed_at, started_at)` — the CURRENT attempt — so a run resumed
 * seconds ago is live however old its original dispatch.
 */
export async function getRunningRunForTask(db: RelationalStore, scope: ReadScope, taskName: string, maxAgeSeconds: number, now: number): Promise<RunningRunRef | null> {
  const floor = now - maxAgeSeconds * 1000;
  return db.prepare(RUNNING_SQL).bind(scope.projectId, taskName, floor).first<RunningRunRef>();
}

const STATE_READ_SQL = `SELECT key, value, updated_at AS updatedAt FROM agent_state
   WHERE project_id = ? AND agent_id = ? AND key = ?`;

/** First write for a key. A row another writer inserted between the read and here makes this change nothing, which the caller reads as contention. */
const STATE_INSERT_SQL = `INSERT INTO agent_state (project_id, agent_id, key, value, updated_at)
  VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`;

/**
 * Subsequent writes, guarded by the value the caller computed against.
 *
 * `value IS ?` rather than `=`: comparing to NULL with `=` yields NULL, never
 * true, so `=` cannot match a key whose prior value is absent.
 */
const STATE_UPDATE_SQL = `UPDATE agent_state SET value = ?, updated_at = ?
   WHERE project_id = ? AND agent_id = ? AND key = ? AND value IS ?`;

export async function getState(db: RelationalStore, scope: ReadScope, agentId: string, key: string): Promise<StateRow | null> {
  return db.prepare(STATE_READ_SQL).bind(scope.projectId, agentId, key).first<StateRow>();
}

/**
 * Atomic read-modify-write over one state key.
 *
 * Returns false when every attempt is refused, which reports contention rather than
 * failure: the value another writer left stands, and the caller is told the
 * mutation did not land rather than being allowed to believe it did.
 */
export async function mutateState(
  db: RelationalStore,
  scope: ReadScope,
  agentId: string,
  key: string,
  mutate: (current: string | null) => string | null,
  now: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < MUTATE_ATTEMPTS; attempt += 1) {
    const row = await getState(db, scope, agentId, key);
    const current = row?.value ?? null;
    const next = mutate(current);
    if (next === null) return true;

    const result = current === null
      ? await db.prepare(STATE_INSERT_SQL).bind(scope.projectId, agentId, key, next, now).run()
      : await db.prepare(STATE_UPDATE_SQL).bind(next, now, scope.projectId, agentId, key, current).run();

    if (result.meta.changes === 1) return true;
  }
  return false;
}

export interface AgentIdentity {
  id: string;
  name: string;
  provider: string | null;
  model: string | null;
  enabled: boolean;
}

/**
 * Declare an agent identity, idempotently.
 *
 * Deployment-scoped: one agent configuration serves every Project the Deployment
 * holds, so this takes no scope. `created_at` is preserved on a re-declaration —
 * the row's identity outlives any one edit of its configuration.
 */
export async function upsertAgent(db: RelationalStore, agent: AgentIdentity, now: number): Promise<void> {
  await db.prepare(`INSERT INTO agents (id, name, provider, model, source, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'built-in', ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET
        name = excluded.name, provider = excluded.provider, model = excluded.model,
        enabled = excluded.enabled, updated_at = excluded.updated_at`)
    .bind(agent.id, agent.name, agent.provider, agent.model, agent.enabled ? 1 : 0, now, now).run();
}

/**
 * Declare an agent identity only where none exists.
 *
 * The dispatch path calls this so a first dispatch does not depend on a
 * separate registration step, while an owner-registered row keeps every field
 * of its registration: a dispatch never edits configuration.
 */
export async function ensureAgent(db: RelationalStore, agent: AgentIdentity, now: number): Promise<void> {
  await db.prepare(`INSERT INTO agents (id, name, provider, model, source, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'built-in', ?, ?, ?)
      ON CONFLICT (id) DO NOTHING`)
    .bind(agent.id, agent.name, agent.provider, agent.model, agent.enabled ? 1 : 0, now, now).run();
}

export async function listAgents(db: RelationalStore): Promise<AgentIdentity[]> {
  const { results } = await db.prepare(`SELECT id, name, provider, model, enabled FROM agents ORDER BY id`)
    .all<{ id: string; name: string; provider: string | null; model: string | null; enabled: number }>();
  return results.map((r) => ({ ...r, enabled: r.enabled === 1 }));
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

/**
 * The columns a run update may set.
 *
 * A FIXED list, never the caller's keys. Locally this reads as tidiness; on a
 * Deployment holding many Projects for many members it is the boundary itself.
 * `project_id`, `id`, `agent_id` and `dispatched_by` are absent on purpose: an
 * update that could set them would let a caller move a run to another Project,
 * change which agent ran it, or reattribute it to another member — the last
 * undoing the claim route's rule that the dispatcher comes from the credential
 * and never from the body.
 */
/** The statuses after which a run does no further work; the update surface releases run-scoped resources when one lands. */
export const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'skipped'] as const;

/** Whether a run carrying this status has already ended. */
export function isTerminalRunStatus(status: unknown): boolean {
  return typeof status === 'string' && (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

export const RUN_UPDATE_COLUMNS = [
  'status', 'task', 'instruction', 'harness', 'provider', 'model', 'session_ref',
  'resumable', 'resume_status', 'resume_mode', 'resumed_at', 'resume_attempts',
  'checkpoints', 'usage_data', 'completed_at', 'tokens_used', 'cost_usd',
  'actual_cost_usd', 'estimated_cost_usd', 'cost_source', 'cost_data',
  'actions_taken', 'error', 'run_context', 'dry_run', 'reasoning_level',
  'execution_overrides',
] as const;
export type RunUpdateColumn = (typeof RUN_UPDATE_COLUMNS)[number];

/** Columns a run update may never set, named so the gate reads the same list the code does. */
export const RUN_IMMUTABLE_COLUMNS = ['project_id', 'id', 'agent_id', 'dispatched_by'] as const;

/**
 * Columns the DISPATCHER owns on a run it recorded.
 *
 * A local run writes both itself, so they stay settable in general. On a run the
 * server dispatched they are the server's own word about what it decided: the
 * context carries the hash the artifact is filed under and the parameters the
 * task routes read back, and `dry_run` says whether the run may write at all. A
 * runtime that could move either would file its own hash as current, or turn the
 * dispatch's dry run into a real one — and both read as the server's decision
 * afterwards.
 */
export const DISPATCHER_OWNED_COLUMNS = ['run_context', 'dry_run'] as const;

export type RunUpdate = Partial<Record<RunUpdateColumn, string | number | null>>;

export interface RunRow {
  id: string;
  agentId: string;
  task: string | null;
  status: string;
  /** The parameters the run's dispatch named, as the runtime's claim recorded them; the run routes that serve one task read the session it names from here. */
  runContext: string | null;
  startedAt: number | null;
  resumedAt: number | null;
  completedAt: number | null;
  error: string | null;
  checkpoints: string | null;
  resumable: number;
  resumeStatus: string | null;
  resumeAttempts: number;
  dryRun: number;
  dispatchedBy: string | null;
}

const RUN_SELECT = `SELECT id, agent_id AS agentId, task, status, run_context AS runContext, started_at AS startedAt,
    resumed_at AS resumedAt, completed_at AS completedAt, error, checkpoints,
    resumable, resume_status AS resumeStatus, resume_attempts AS resumeAttempts,
    dry_run AS dryRun, dispatched_by AS dispatchedBy
  FROM agent_runs WHERE project_id = ? AND id = ?`;

export async function getRun(db: RelationalStore, scope: ReadScope, runId: string): Promise<RunRow | null> {
  return db.prepare(RUN_SELECT).bind(scope.projectId, runId).first<RunRow>();
}

/** The hash of the material the server built this run's prompt from, as its context records it. */
export function inputHashOf(run: RunRow): string | null {
  if (run.runContext === null) return null;
  try {
    const parsed: unknown = JSON.parse(run.runContext);
    const value = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as { input_hash?: unknown }).input_hash : undefined;
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * The instruction one run carries, read on its own.
 *
 * Kept out of `RUN_SELECT`: `getRun` runs on every served tool call
 * (`api/run-admission.ts`), and an instruction is tens of kilobytes that no
 * caller of it reads. A run asks for its own prompt once, at its start.
 */
export async function runInstruction(db: RelationalStore, scope: ReadScope, runId: string): Promise<string | null> {
  const row = await db.prepare(`SELECT instruction FROM agent_runs WHERE project_id = ? AND id = ?`)
    .bind(scope.projectId, runId).first<{ instruction: string | null }>();
  return row?.instruction ?? null;
}

/**
 * Apply a partial update to one run, scoped.
 *
 * Returns how many rows moved: 0 means the run is not in this scope, which a
 * caller must not read as success. An update naming no settable column is
 * refused rather than issued as an empty UPDATE.
 *
 * **The first terminal write wins.** An update naming `status` lands only on a
 * run that has not already ended, and the guard is in the WHERE clause where the
 * row's own status decides it. Both sides of a close are in flight at once: the
 * update route releases the container the instant a terminal status lands, and
 * the runtime answers that release with a terminal status of its own. A check
 * read in JavaScript ahead of this write admits the second one, and the row then
 * carries an ending that contradicts the artifact the run left behind.
 *
 * An update naming no `status` is unguarded, and applies to a terminal row: the
 * tokens, the cost and the error detail a close measures ride the same write as
 * that close or a write of their own, and both are the ending being described
 * rather than a change of it.
 */
export async function applyRunUpdate(
  db: RelationalStore,
  scope: ReadScope,
  runId: string,
  update: RunUpdate,
): Promise<number> {
  const columns = RUN_UPDATE_COLUMNS.filter((c) => c in update);
  if (columns.length === 0) return 0;
  const guarded = 'status' in update;
  const guard = guarded ? ` AND status NOT IN (${TERMINAL_RUN_STATUSES.map(() => '?').join(', ')})` : '';
  const result = await db
    .prepare(`UPDATE agent_runs SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE project_id = ? AND id = ?${guard}`)
    .bind(...columns.map((c) => update[c] ?? null), scope.projectId, runId, ...(guarded ? TERMINAL_RUN_STATUSES : []))
    .run();
  return result.meta.changes;
}

/**
 * Retire the resumability of failed runs equivalent to this one.
 *
 * Equivalence is agent, task, Project and `dry_run` together. **`dry_run` is
 * part of it**: a dry run and a real run of the same task are not the same work,
 * and treating them as equivalent would let a dry run retire a real run's
 * resumability.
 */
export async function supersedeEquivalentResumableRuns(
  db: RelationalStore,
  scope: ReadScope,
  excludeRunId: string,
  match: { agentId: string; taskName: string; dryRun: boolean },
): Promise<number> {
  const result = await db
    .prepare(`UPDATE agent_runs SET resumable = 0, resume_status = 'superseded'
       WHERE project_id = ? AND id != ? AND resumable = 1 AND status = 'failed'
         AND agent_id = ? AND task = ? AND dry_run = ?`)
    .bind(scope.projectId, excludeRunId, match.agentId, match.taskName, match.dryRun ? 1 : 0)
    .run();
  return result.meta.changes;
}

export interface ReportRow {
  id: number;
  runId: string;
  agentId: string;
  action: string;
  summary: string;
  details: string | null;
  createdAt: number;
}

export async function listReports(db: RelationalStore, scope: ReadScope, runId: string): Promise<ReportRow[]> {
  const { results } = await db
    .prepare(`SELECT id, run_id AS runId, agent_id AS agentId, action, summary, details, created_at AS createdAt
       FROM agent_reports WHERE project_id = ? AND run_id = ? ORDER BY id ASC`)
    .bind(scope.projectId, runId)
    .all<ReportRow>();
  return results;
}

export interface ReportInsert {
  runId: string;
  agentId: string;
  action: string;
  summary: string;
  details: string | null;
  createdAt: number;
}

/** Record one report against a run this Project holds; an unknown run or an unregistered agent writes nothing and answers false — a foreign-key throw would read as retryable, and neither condition is. */
export async function insertReport(db: RelationalStore, scope: ReadScope, report: ReportInsert): Promise<boolean> {
  const result = await db
    .prepare(`INSERT INTO agent_reports (project_id, run_id, agent_id, action, summary, details, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM agent_runs WHERE project_id = ? AND id = ?)
          AND EXISTS (SELECT 1 FROM agents WHERE id = ?)`)
    .bind(scope.projectId, report.runId, report.agentId, report.action, report.summary, report.details, report.createdAt,
          scope.projectId, report.runId, report.agentId)
    .run();
  return result.meta.changes === 1;
}

export interface RunEventRowInsert {
  runId: string;
  phaseName: string | null;
  eventType: string;
  toolName: string | null;
  outcome: string | null;
  durationMs: number | null;
  payload: string | null;
  recordedAt: number;
}

/** Record a burst of run events in one batch; each row lands independently through its own EXISTS guard, and a row naming a run this Project does not hold writes nothing. Answers how many landed. */
export async function recordRunEvents(db: RelationalStore, scope: ReadScope, events: readonly RunEventRowInsert[]): Promise<number> {
  const statements = events.map((event) => db
    .prepare(`INSERT INTO agent_run_events (project_id, run_id, phase_name, event_type, tool_name, outcome, duration_ms, payload, recorded_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM agent_runs WHERE project_id = ? AND id = ?)`)
    .bind(scope.projectId, event.runId, event.phaseName, event.eventType, event.toolName, event.outcome, event.durationMs, event.payload, event.recordedAt,
          scope.projectId, event.runId));
  const results = await db.batch(statements);
  return results.reduce((landed, result) => landed + result.meta.changes, 0);
}

export interface CortexInstructionsUpsert {
  agentId: string;
  content: string;
  inputHash: string;
  generatedAt: number;
  sourceRunId: string | null;
  id?: string;
}

/**
 * Write the current Cortex instructions for an agent within a Project.
 *
 * The conflict resolves on `(project_id, id)`, and those two are exactly the
 * columns the update leaves alone — rewriting either would move the row rather
 * than update it.
 */
export async function upsertCortexInstructions(
  db: RelationalStore,
  scope: ReadScope,
  row: CortexInstructionsUpsert,
): Promise<void> {
  const id = row.id ?? `${row.agentId}:instructions`;
  await db.prepare(`INSERT INTO cortex_instructions
      (project_id, id, agent_id, content, input_hash, source_run_id, generated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (project_id, id) DO UPDATE SET
        agent_id = excluded.agent_id, content = excluded.content,
        input_hash = excluded.input_hash, source_run_id = excluded.source_run_id,
        generated_at = excluded.generated_at`)
    .bind(scope.projectId, id, row.agentId, row.content, row.inputHash, row.sourceRunId, row.generatedAt)
    .run();
}

/**
 * Whether a Project is admitted to a capability.
 *
 * The claim is the enforcing check and this is not a substitute for it — a
 * caller that asks and then claims still meets the same gate inside `claimRun`.
 * It exists so a caller can report WHY a run will not start without first
 * attempting one and reading the refusal.
 */
export async function projectAdmission(
  db: RelationalStore,
  scope: ReadScope,
  capability: ProjectCapability,
): Promise<{ admitted: boolean; capability: ProjectCapability }> {
  return { admitted: await settingsWriter(db).capabilityEnabled(scope.projectId, capability), capability };
}

// ---------------------------------------------------------------------------
// Deployment-scoped reads and writes for the tick's jobs
// ---------------------------------------------------------------------------

/**
 * A live run anywhere on the Deployment. The sweep and the drain read across
 * Projects — the first reads here without a scope: the runtime that went
 * away, and the capacity that came back, are the Deployment's, not one
 * Project's.
 */
export interface LiveRunRef {
  projectId: string;
  id: string;
  task: string | null;
  status: string;
  startedAt: number | null;
  runContext: string | null;
  dispatchedBy: string | null;
}

/**
 * Which runs are in flight.
 *
 * A `pending` row counts as one: the dispatcher writes the row before the
 * runtime starts. Every reader of the fleet shares this predicate — the sweep,
 * the drain's load, and the read a deploy makes before it recreates the
 * container — and each projects the columns it needs from it.
 */
export const LIVE_RUN_STATUSES = "status IN ('pending', 'running')";

const LIVE_RUNS_SQL = `SELECT project_id AS projectId, id, task, status, started_at AS startedAt,
    run_context AS runContext, dispatched_by AS dispatchedBy
  FROM agent_runs WHERE ${LIVE_RUN_STATUSES}
  ORDER BY started_at ASC, id ASC LIMIT ?`;

export async function listLiveRunsAcrossProjects(db: RelationalStore, limit: number): Promise<LiveRunRef[]> {
  const { results } = await db.prepare(LIVE_RUNS_SQL).bind(limit).all<LiveRunRef>();
  return results;
}

/** A live run whose runtime went away is failed exactly once; a run that landed terminal on its own in the meantime is left as it landed. */
const FAIL_STALE_SQL = `UPDATE agent_runs SET status = 'failed', completed_at = ?, error = ?
  WHERE project_id = ? AND id = ? AND ${LIVE_RUN_STATUSES}`;

export async function failStaleRun(db: RelationalStore, scope: ReadScope, runId: string, now: number, error: string): Promise<boolean> {
  const result = await db.prepare(FAIL_STALE_SQL).bind(now, error, scope.projectId, runId).run();
  return result.meta.changes === 1;
}

const RETENTION_CANDIDATES_SQL = `SELECT project_id AS projectId, id FROM agent_runs
  WHERE status IN ('completed', 'failed', 'skipped') AND resumable = 0 AND COALESCE(completed_at, started_at) < ?
  ORDER BY COALESCE(completed_at, started_at) ASC, id ASC LIMIT ?`;

/**
 * Remove terminal, non-resumable runs older than the cutoff, up to `limit`
 * of them, each with its turns and reports. Those two tables reference a run
 * without a cascade, so they are deleted in the same batch ahead of the run;
 * events and write intents cascade, and a digest revision keeps its row with
 * the run reference cleared. Answers how many runs went.
 */
export async function pruneTerminalRuns(db: RelationalStore, cutoffMs: number, limit: number): Promise<number> {
  const { results } = await db.prepare(RETENTION_CANDIDATES_SQL).bind(cutoffMs, limit).all<{ projectId: string; id: string }>();
  if (results.length === 0) return 0;
  const byProject = new Map<string, string[]>();
  for (const row of results) byProject.set(row.projectId, [...(byProject.get(row.projectId) ?? []), row.id]);
  let removed = 0;
  for (const [projectId, ids] of byProject) {
    for (const chunk of inListChunks(ids)) {
      const marks = chunk.map(() => '?').join(', ');
      const statements = [
        db.prepare(`DELETE FROM agent_turns WHERE project_id = ? AND run_id IN (${marks})`).bind(projectId, ...chunk),
        db.prepare(`DELETE FROM agent_reports WHERE project_id = ? AND run_id IN (${marks})`).bind(projectId, ...chunk),
        db.prepare(`DELETE FROM agent_runs WHERE project_id = ? AND id IN (${marks})`).bind(projectId, ...chunk),
      ];
      const outcomes = await db.batch(statements);
      removed += outcomes[2]?.meta.changes ?? 0;
    }
  }
  return removed;
}

/**
 * Revoked harness credentials past the cutoff, and referenced by no run.
 *
 * A dispatch mints one credential per run and revokes it at close, so the table
 * grows with every run the Deployment has ever made. A credential a run row
 * still names is left: `agent_runs.dispatched_by` references it, and the run
 * retention pass above is what clears that reference.
 */
const REVOKED_CREDENTIALS_SQL = `DELETE FROM member_credentials
  WHERE id IN (
    SELECT c.id FROM member_credentials c
     WHERE c.member_id = ? AND c.revoked_at IS NOT NULL AND c.revoked_at < ?
       AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.dispatched_by = c.id)
     ORDER BY c.revoked_at ASC LIMIT ?)`;

/** Remove revoked credentials of one member older than the cutoff, up to `limit`. Answers how many went. */
export async function pruneRevokedCredentials(db: RelationalStore, memberId: string, cutoffMs: number, limit: number): Promise<number> {
  const result = await db.prepare(REVOKED_CREDENTIALS_SQL).bind(memberId, cutoffMs, limit).run();
  return result.meta.changes ?? 0;
}

/** A run inside its bound, anywhere on the Deployment: one exists or none does. The bound is the run's own, from its context, or the dispatcher's default. */
const RUN_INSIDE_BOUND_SQL = `SELECT 1 AS one FROM agent_runs
  WHERE ${LIVE_RUN_STATUSES} AND started_at IS NOT NULL
    AND ? < started_at + COALESCE(json_extract(run_context, '$.timeoutSeconds'), ?) * 1000 + ?
  LIMIT 1`;

export async function hasRunInsideBound(db: RelationalStore, now: number, defaultTimeoutSeconds: number, marginMs: number): Promise<boolean> {
  return (await db.prepare(RUN_INSIDE_BOUND_SQL).bind(now, defaultTimeoutSeconds, marginMs).first<{ one: number }>()) !== null;
}

// ---------------------------------------------------------------------------
// The queue: a run that waits is a run row
// ---------------------------------------------------------------------------

/** What a queued run keeps until it launches: everything a launch is told, so the drain launches it exactly as the dispatch asked. */
export interface QueuedRecord {
  id: string;
  agentId: string;
  task: string;
  provider: string | null;
  model: string | null;
  heldBy: string;
  queuedAt: number;
  /** The prompt the server built at the dispatch. A task with an input builder has it rebuilt at launch, and this is what the rebuild replaces. */
  instruction?: string | null;
  /** A run that does the work and writes nothing. */
  dryRun?: boolean;
  /** The launch spec as JSON: server URL, actor, bound and parameters. */
  dispatchSpec: string;
}

const RECORD_QUEUED_SQL = `INSERT INTO agent_runs
    (project_id, id, agent_id, task, instruction, provider, model, status, dry_run, queued_at, held_by, dispatch_spec)
  SELECT ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?
   WHERE NOT EXISTS (SELECT 1 FROM agent_runs WHERE project_id = ? AND id = ?)
   AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM agent_runs WHERE project_id = ? AND task = ? AND status IN ('pending', 'running', 'queued')))`;

/** Record a dispatch the Deployment holds back: a run row in `queued`, with no credential until it launches. A single-flight task is refused while another run of it is live. */
export async function recordQueued(db: RelationalStore, scope: ReadScope, record: QueuedRecord, options: { singleFlight?: boolean } = {}): Promise<boolean> {
  const result = await db.prepare(RECORD_QUEUED_SQL).bind(
    scope.projectId, record.id, record.agentId, record.task, record.instruction ?? null, record.provider, record.model,
    record.dryRun === true ? 1 : 0, record.queuedAt, record.heldBy, record.dispatchSpec,
    scope.projectId, record.id,
    options.singleFlight === true ? record.task : null, scope.projectId, record.task,
  ).run();
  return result.meta.changes === 1;
}

/**
 * A queued run moves to `pending` for the credential its launch minted — once,
 * and only from `queued`. The instruction is rewritten where the launch carries
 * one: a task whose input the server builds has it rebuilt at the instant it
 * launches, so a run started an hour after it queued reads the vault as it
 * stands rather than as it stood.
 */
const LAUNCH_QUEUED_SQL = `UPDATE agent_runs
   SET status = 'pending', dispatched_by = ?, started_at = ?, run_context = ?, instruction = COALESCE(?, instruction),
       provider = COALESCE(?, provider), model = COALESCE(?, model), held_by = NULL
 WHERE project_id = ? AND id = ? AND status = 'queued'${ADMISSION_WHERE}`;

export async function launchQueued(db: RelationalStore, scope: ReadScope, runId: string, launch: { task: string; dispatchedBy: string; startedAt: number; runContext: string | null; instruction?: string | null; provider: string | null; model: string | null }, admission?: WriteAdmission): Promise<boolean> {
  const result = await db.prepare(LAUNCH_QUEUED_SQL).bind(
    launch.dispatchedBy, launch.startedAt, launch.runContext, launch.instruction ?? null, launch.provider, launch.model, scope.projectId, runId,
    ...admissionParams(scope, launch.task, runId, admission),
  ).run();
  return result.meta.changes === 1;
}

/**
 * A run whose runtime would not take it goes back to the queue, from `pending`
 * alone: the launch credential is dropped from the row, it takes the holder
 * that describes why, and it carries the launch spec the drain relaunches it
 * from.
 *
 * `queued_at` is kept where the row already had one, so a run returned here
 * keeps its place in the queue's order rather than moving to the back of it.
 * The launch's own context is dropped, and the drain rebuilds it when it
 * launches.
 *
 * The caller names the credential the row is to carry. A launch can be answered
 * late — after the supervisor has already started a child under the credential
 * that launch carried — and the child claims under it, so the row goes on
 * naming one live credential; whichever one it stops naming is retired by the
 * caller in the same breath.
 *
 * `started_at` and `run_context` STAY. The attempt did start: the row's start
 * is the instant its launch went out, and its context carries the bound that
 * launch carries. A deploy bounds such a row from those two, so sparing a child
 * that is working requires both to survive the write — the default budget, or a
 * clock reset to when the row first joined the queue, each bound it to an
 * instant already past.
 */
const RETURN_TO_QUEUE_SQL = `UPDATE agent_runs
   SET status = 'queued', held_by = ?, dispatch_spec = ?, dispatched_by = ?,
       queued_at = COALESCE(queued_at, ?)
 WHERE project_id = ? AND id = ? AND status = 'pending'`;

export async function returnToQueue(
  db: RelationalStore, scope: ReadScope, runId: string,
  hold: { heldBy: string; dispatchSpec: string; credential: string | null; now: number },
): Promise<boolean> {
  const result = await db.prepare(RETURN_TO_QUEUE_SQL)
    .bind(hold.heldBy, hold.dispatchSpec, hold.credential, hold.now, scope.projectId, runId)
    .run();
  return result.meta.changes === 1;
}

/** What ending a queued row did: whether the write landed, and the credential that row named when it did. */
export interface QueuedRunEnd {
  applied: boolean;
  displaced: string | null;
}

/**
 * Put a run's dispatching credential back, from `pending` alone.
 *
 * A relaunch of a run the runtime is already running mints a credential nothing
 * will present: the child in flight claims under its own, and the row has to
 * name that one for the claim to be admitted.
 */
export async function restoreDispatchCredential(db: RelationalStore, scope: ReadScope, runId: string, tokenId: string): Promise<boolean> {
  const result = await db
    .prepare(`UPDATE agent_runs SET dispatched_by = ? WHERE project_id = ? AND id = ? AND status = 'pending'`)
    .bind(tokenId, scope.projectId, runId).run();
  return result.meta.changes === 1;
}

/**
 * A queued run the Deployment decided not to launch is skipped by name, from
 * `queued` alone; its context names why, as a clock's skip does.
 *
 * `started_at` is left as it is. A run that never ran has no start, and
 * `taskRunsLastHour` counts starts: stamping one here would spend an hour of
 * the task's rate on a run that did no work. A reader shows when such a row
 * ended instead.
 *
 * The write answers with the credential the row named at the instant it landed,
 * so a caller retires what its own write displaced rather than what it read
 * before it — a drain that relaunched and re-queued the row in between leaves
 * the row naming a different credential from the one the caller saw.
 */
export async function skipQueued(db: RelationalStore, scope: ReadScope, runId: string, now: number, reason: string): Promise<QueuedRunEnd> {
  const row = await db
    .prepare(`UPDATE agent_runs SET status = 'skipped', completed_at = ?, run_context = ?, held_by = NULL, dispatch_spec = NULL
       WHERE project_id = ? AND id = ? AND status = 'queued'
     RETURNING dispatched_by AS displaced`)
    .bind(now, skipContext(reason), scope.projectId, runId)
    .first<{ displaced: string | null }>();
  return { applied: row !== null, displaced: row?.displaced ?? null };
}

/**
 * A queued run the Deployment can no longer launch is failed by name, from
 * `queued` alone.
 *
 * `started_at` is left as it is, as it is for a skipped row: a run that never
 * ran has no start, and `taskRunsLastHour` counts starts. The write answers
 * with the credential the row named at the instant it landed, for the same
 * reason a skip does.
 */
const FAIL_QUEUED_SQL = `UPDATE agent_runs SET status = 'failed', completed_at = ?, error = ?, held_by = NULL
  WHERE project_id = ? AND id = ? AND status = 'queued'
RETURNING dispatched_by AS displaced`;

export async function failQueuedRun(db: RelationalStore, scope: ReadScope, runId: string, now: number, error: string): Promise<QueuedRunEnd> {
  const row = await db.prepare(FAIL_QUEUED_SQL).bind(now, error, scope.projectId, runId).first<{ displaced: string | null }>();
  return { applied: row !== null, displaced: row?.displaced ?? null };
}

export interface QueuedRunRef {
  projectId: string;
  id: string;
  task: string | null;
  queuedAt: number;
  heldBy: string | null;
  dispatchSpec: string | null;
  /** The credential a re-queued row still carries, for the child a late answer may have started; null for a row that never launched. */
  dispatchedBy: string | null;
}

const QUEUED_RUNS_SQL = `SELECT project_id AS projectId, id, task, queued_at AS queuedAt, held_by AS heldBy,
    dispatch_spec AS dispatchSpec, dispatched_by AS dispatchedBy
  FROM agent_runs WHERE status = 'queued' ORDER BY queued_at ASC, id ASC LIMIT ?`;

/** Every queued run on the Deployment, oldest first: the drain's read, across Projects like the sweep's. */
export async function listQueuedAcrossProjects(db: RelationalStore, limit: number): Promise<QueuedRunRef[]> {
  const { results } = await db.prepare(QUEUED_RUNS_SQL).bind(limit).all<QueuedRunRef>();
  return results;
}

export async function hasQueuedRun(db: RelationalStore): Promise<boolean> {
  return (await db.prepare(`SELECT 1 AS one FROM agent_runs WHERE status = 'queued' LIMIT 1`).first<{ one: number }>()) !== null;
}

/** What the Deployment is doing for one task: the counts admission compares against the limits. */
export async function dispatchLoad(db: RelationalStore, task: string, now: number, exclude?: string): Promise<{ liveRuns: number; liveTaskRuns: number; taskRunsLastHour: number }> {
  // The same rule the write applies (`NOT_THE_RUN_ADMITTED`): the row being
  // admitted is not counted by any of these. A caller with no row to leave out
  // binds null, and every count is then of everything.
  const other = exclude ?? null;
  const row = await db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM agent_runs WHERE ${LIVE_RUN_STATUSES} AND ${NOT_THE_RUN_ADMITTED}) AS liveRuns,
       (SELECT COUNT(*) FROM agent_runs WHERE ${LIVE_RUN_STATUSES} AND task = ? AND ${NOT_THE_RUN_ADMITTED}) AS liveTaskRuns,
       (SELECT COUNT(*) FROM agent_runs WHERE task = ? AND ${NOT_THE_RUN_ADMITTED} AND started_at IS NOT NULL AND started_at >= ?) AS taskRunsLastHour`,
  ).bind(other, other, task, other, other, task, other, other, now - 3_600_000)
    .first<{ liveRuns: number; liveTaskRuns: number; taskRunsLastHour: number }>();
  return row ?? { liveRuns: 0, liveTaskRuns: 0, taskRunsLastHour: 0 };
}

/** A recording launch marks the run as launched by the recorder and starts nothing: the parity harness's runtime, never a Deployment's. */
export async function markRecordedLaunch(db: RelationalStore, runId: string): Promise<void> {
  await db.prepare(`UPDATE agent_runs SET harness = 'record' WHERE id = ?`).bind(runId).run();
}

// ---------------------------------------------------------------------------
// What the clock reads before it schedules a task, per Project
// ---------------------------------------------------------------------------

/**
 * When this task last entered the Project's run list — launched, queued, or
 * left alone over material that had not moved — or null when it never has.
 *
 * A skip counts here only under `INPUT_UNCHANGED`. That skip is the clock
 * having done the work the interval is for: it rebuilt the task's input and
 * found the Project standing where its artifact already stands. Excluding it
 * would leave the interval unmoved, and every wake would rebuild the whole
 * payload again. Every other skip is a gate the clock never got past, and must
 * not push the next attempt out.
 *
 * The per-day ceiling is the opposite reading and keeps excluding every skip:
 * a skip costs nothing, so it spends nothing of the day.
 */
export async function lastTaskEntryAt(db: RelationalStore, scope: ReadScope, task: string): Promise<number | null> {
  const row = await db.prepare(
    `SELECT MAX(COALESCE(queued_at, started_at)) AS at FROM agent_runs
      WHERE project_id = ? AND task = ? AND (status != 'skipped' OR run_context = ?)`,
  ).bind(scope.projectId, task, skipContext(INPUT_UNCHANGED)).first<{ at: number | null }>();
  return row?.at ?? null;
}

/**
 * One key of a run's context as a value a WHERE clause can compare, and null
 * where the context holds no such key. A context the store did not write is not
 * read as JSON at all, so a caller's own string cannot fail the query.
 */
const contextValue = (key: string): string => `CASE WHEN json_valid(run_context) THEN json_extract(run_context, '$.${key}') END`;

/**
 * Runs of this task the Project entered from the instant on, skips excluded.
 *
 * A run the platform replaced mid-flight is excluded with them. The Project
 * asked for one run of the task and got a deployment instead; counting it would
 * spend the day's ceiling on work nobody received, and the successor queued in
 * its place would meet a cap the failure itself created.
 *
 * `lastTaskEntryAt` above still counts a replaced row, and must: the ceiling is
 * the day's spend and a replaced run spent none of it, while the interval is
 * when the task last entered the list — which it did, so the clock does not
 * dispatch it again the same instant.
 */
export async function taskEntriesSince(db: RelationalStore, scope: ReadScope, task: string, sinceMs: number): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS c FROM agent_runs WHERE project_id = ? AND task = ? AND status != 'skipped'
       AND COALESCE(${contextValue('replaced')}, 0) != 1
       AND COALESCE(queued_at, started_at) >= ?`,
  ).bind(scope.projectId, task, sinceMs).first<{ c: number }>();
  return row?.c ?? 0;
}

/**
 * Mark a run as one the platform replaced, keeping every other word its context
 * carries.
 *
 * The context is the dispatcher's column and a runtime may not set it; this is
 * the one key a runtime adds, through the failure it posts, and it adds nothing
 * else. A context that is not an object is left exactly as it stands and the
 * answer says so: a number or a bare string is valid JSON on its own, and
 * setting a key on one would rewrite the whole value. The type is asked inside
 * a CASE so a context that is no JSON at all answers rather than raising.
 */
export async function markRunReplaced(db: RelationalStore, scope: ReadScope, runId: string): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE agent_runs SET run_context = json_set(COALESCE(run_context, '{}'), '$.replaced', json('true'))
      WHERE project_id = ? AND id = ?
        AND (run_context IS NULL OR json_type(CASE WHEN json_valid(run_context) THEN run_context END) = 'object')`,
  ).bind(scope.projectId, runId).run();
  return result.meta.changes === 1;
}

/** Whether some run already names this one as the run it replaces. */
export async function hasSuccessorOf(db: RelationalStore, scope: ReadScope, runId: string): Promise<boolean> {
  return (await db.prepare(
    `SELECT 1 AS one FROM agent_runs WHERE project_id = ? AND ${contextValue('replaces')} = ? LIMIT 1`,
  ).bind(scope.projectId, runId).first<{ one: number }>()) !== null;
}

/** Runs of this task the Project entered from the instant on that stand in for a run the platform replaced. */
export async function successorsSince(db: RelationalStore, scope: ReadScope, task: string, sinceMs: number): Promise<number> {
  const row = await db.prepare(
    `SELECT COUNT(*) AS c FROM agent_runs WHERE project_id = ? AND task = ?
       AND ${contextValue('replaces')} IS NOT NULL
       AND COALESCE(queued_at, started_at) >= ?`,
  ).bind(scope.projectId, task, sinceMs).first<{ c: number }>();
  return row?.c ?? 0;
}

/** Whether a run of this task is live — pending, running or queued — in the Project. */
export async function hasLiveTaskRun(db: RelationalStore, scope: ReadScope, task: string): Promise<boolean> {
  return (await db.prepare(
    `SELECT 1 AS one FROM agent_runs WHERE project_id = ? AND task = ? AND status IN ('pending', 'running', 'queued') LIMIT 1`,
  ).bind(scope.projectId, task).first<{ one: number }>()) !== null;
}

/**
 * A scheduled run the clock decided not to start, recorded as a run row in
 * `skipped` naming why in its context, so a ceiling met is never silent.
 */
export async function recordSkipped(db: RelationalStore, scope: ReadScope, record: { id: string; agentId: string; task: string; reason: string; at: number }): Promise<void> {
  await db.prepare(
    `INSERT INTO agent_runs (project_id, id, agent_id, task, status, dry_run, started_at, completed_at, run_context)
       SELECT ?, ?, ?, ?, 'skipped', 0, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM agent_runs WHERE project_id = ? AND id = ?)`,
  ).bind(scope.projectId, record.id, record.agentId, record.task, record.at, record.at, skipContext(record.reason), scope.projectId, record.id).run();
}
