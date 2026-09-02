/**
 * The agent run control plane, server-side.
 *
 * The agent does not reach this store. It runs as a process inside a container,
 * which is not a Worker and holds no bindings, so it calls the routes in
 * `api/runs.ts` and this module is what those routes call. That arrangement is
 * the point: atomicity lives with the single writer instead of once per client.
 *
 * Two operations here are atomic in SQL rather than in JavaScript, and both are
 * atomic in the WHERE clause rather than by batching. A batch cannot supply
 * either one: its statements are fixed before it executes, so any decision taken
 * between a read and a write still happens in the caller, across an await, where
 * two concurrent phases interleave.
 *
 * - `claimRun` is one `INSERT ... SELECT ... WHERE NOT EXISTS`. A separate check
 *   followed by a separate insert admits a run twice under one id.
 * - `mutateState` is compare-and-swap. The caller's callback is arbitrary code
 *   and cannot move into SQL, so the prior value becomes the guard and a refused
 *   update is retried FROM THE READ. Retrying from anywhere else re-applies a
 *   decision taken against a value that is no longer there.
 */
import type { RelationalStore } from './adapters.js';
import type { ReadScope } from '../read/scope.js';
import { providerConfiguredFor, settingsWriter, type ProjectCapability } from './settings.js';

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

const RUN_REF_SQL = `SELECT id, task, started_at AS startedAt, resumed_at AS resumedAt FROM agent_runs
   WHERE project_id = ? AND id = ?`;

const RUNNING_SQL = `SELECT id, task, started_at AS startedAt, resumed_at AS resumedAt FROM agent_runs
   WHERE project_id = ? AND task = ? AND status = 'running'
     AND COALESCE(resumed_at, started_at) > ?
   ORDER BY COALESCE(resumed_at, started_at) DESC LIMIT 1`;

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
  guard: { taskName: string; admission: RunAdmissionGate },
  _now: number,
): Promise<ClaimOutcome> {
  if (guard.admission.kind === 'capability') {
    if (!(await settingsWriter(db).capabilityEnabled(scope.projectId, guard.admission.capability))) {
      return { claimed: false, notAdmitted: guard.admission.capability };
    }
  } else if (!(await providerConfiguredFor(db, guard.taskName))) {
    return { claimed: false, noProvider: true };
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

/**
 * Apply a partial update to one run, scoped.
 *
 * Returns how many rows moved: 0 means the run is not in this scope, which a
 * caller must not read as success. An update naming no settable column is
 * refused rather than issued as an empty UPDATE.
 */
export async function applyRunUpdate(
  db: RelationalStore,
  scope: ReadScope,
  runId: string,
  update: RunUpdate,
): Promise<number> {
  const columns = RUN_UPDATE_COLUMNS.filter((c) => c in update);
  if (columns.length === 0) return 0;
  const result = await db
    .prepare(`UPDATE agent_runs SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE project_id = ? AND id = ?`)
    .bind(...columns.map((c) => update[c] ?? null), scope.projectId, runId)
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
