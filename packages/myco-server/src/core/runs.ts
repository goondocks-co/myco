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
 *   followed by a separate insert admits two dispatches that both saw no live
 *   run.
 * - `mutateState` is compare-and-swap. The caller's callback is arbitrary code
 *   and cannot move into SQL, so the prior value becomes the guard and a refused
 *   update is retried FROM THE READ. Retrying from anywhere else re-applies a
 *   decision taken against a value that is no longer there.
 */
import type { RelationalStore } from './adapters.js';
import type { ReadScope } from '../read/scope.js';

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

export type ClaimOutcome = { claimed: true } | { claimed: false; running: RunningRunRef | null };

/** The state row a read returns, or null when the key is unset. */
export interface StateRow {
  key: string;
  value: string;
  updatedAt: number;
}

const CLAIM_SQL = `INSERT INTO agent_runs
    (project_id, id, agent_id, task, instruction, harness, provider, model, status, dry_run, started_at, run_context, dispatched_by)
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?
   WHERE NOT EXISTS (
     SELECT 1 FROM agent_runs
      WHERE project_id = ? AND task = ? AND status = 'running'
        AND COALESCE(resumed_at, started_at) > ?)`;

const RUNNING_SQL = `SELECT id, task, started_at AS startedAt, resumed_at AS resumedAt FROM agent_runs
   WHERE project_id = ? AND task = ? AND status = 'running'
     AND COALESCE(resumed_at, started_at) > ?
   ORDER BY COALESCE(resumed_at, started_at) DESC LIMIT 1`;

/**
 * Single-flight claim.
 *
 * `maxAgeSeconds` is what makes a stale run stop blocking: a run whose process
 * died leaves its row `running` forever, and the floor is how a later dispatch
 * gets past it.
 *
 * The clock is `COALESCE(resumed_at, started_at)` — the CURRENT attempt — never
 * `started_at` alone. A resumed run keeps its original dispatch time, so an
 * age floor read off `started_at` treats a run resumed seconds ago as stale and
 * admits a second run of the same task: the exact defect single-flighting
 * exists to prevent.
 *
 * On a refused claim the live run is read back. That read is on the refusal path
 * only, after the outcome is already settled, so it cannot change the decision —
 * it can return a run that finished in between, which reports contention that
 * has just cleared rather than admitting a second run.
 */
export async function claimRun(
  db: RelationalStore,
  scope: ReadScope,
  row: RunInsert,
  guard: { taskName: string; maxAgeSeconds: number },
  now: number,
): Promise<ClaimOutcome> {
  const floor = now - guard.maxAgeSeconds;
  const result = await db.prepare(CLAIM_SQL).bind(
    scope.projectId, row.id, row.agentId, row.task, row.instruction, row.harness, row.provider, row.model,
    row.dryRun ? 1 : 0, row.startedAt, row.runContext, row.dispatchedBy,
    scope.projectId, guard.taskName, floor,
  ).run();

  if (result.meta.changes === 1) return { claimed: true };
  const running = await db.prepare(RUNNING_SQL).bind(scope.projectId, guard.taskName, floor).first<RunningRunRef>();
  return { claimed: false, running: running ?? null };
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

export async function listAgents(db: RelationalStore): Promise<AgentIdentity[]> {
  const { results } = await db.prepare(`SELECT id, name, provider, model, enabled FROM agents ORDER BY id`)
    .all<{ id: string; name: string; provider: string | null; model: string | null; enabled: number }>();
  return results.map((r) => ({ ...r, enabled: r.enabled === 1 }));
}
