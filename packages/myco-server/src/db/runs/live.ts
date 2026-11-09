import { LIVE_RUN_STATUSES, IN_FLIGHT_RUN_STATUSES } from '../run-statuses.js';
import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet, write } from '../index.js';
import { runOriginSql } from '../run-context.js';
import { PROJECT_ID_GRAMMAR } from '../project-id.js';
import { changed, jsonKeys, trigger, type Trigger } from '../ddl.js';
import type { CatchupFamily } from '../projections/family.js';

const RUN_ADMISSION_PROJECTION = 'run_admission';
export const RUN_ADMISSION_READY_SQL = `EXISTS (SELECT 1 FROM projection_catchup WHERE projection='${RUN_ADMISSION_PROJECTION}' AND phase='runs' AND done=1)`;
const fields = ['task', 'status', 'origin', 'queued_at', 'claimable', 'source_hold'] as const;
const live = (row: string) => `CASE WHEN ${row}.${LIVE_RUN_STATUSES} THEN 1 ELSE 0 END`;
const queued = (row: string) => `CASE WHEN ${row}.status='queued' THEN 1 ELSE 0 END`;
const key = (row: string) => `SELECT ${row}.project_id AS project_id,${row}.id AS run_id`;

/** Reconcile only the supplied run identities against the current source, including during catch-up replay. */
function reconcileLive(keys: string): string[] {
  return [
    `DELETE FROM run_live WHERE (project_id,run_id) IN (SELECT project_id,run_id FROM (${keys}))
      AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.project_id=run_live.project_id AND r.id=run_live.run_id AND r.${IN_FLIGHT_RUN_STATUSES})`,
    `INSERT INTO run_live(project_id,run_id,${fields.join(',')})
      SELECT r.project_id,r.id,COALESCE(r.task,''),r.status,${runOriginSql('r')},r.queued_at,CASE WHEN r.dispatched_by IS NULL THEN 1 ELSE 0 END,r.held_by
      FROM (${keys}) k JOIN agent_runs r ON r.project_id=k.project_id AND r.id=k.run_id WHERE r.${IN_FLIGHT_RUN_STATUSES}
      ON CONFLICT(project_id,run_id) DO UPDATE SET ${fields.map(column => `${column}=excluded.${column}`).join(',')}
      WHERE (${fields.map(column => `run_live.${column}`).join(',')}) IS NOT (${fields.map(column => `excluded.${column}`).join(',')})`,
  ];
}

const counter = (row: string, sign: number) => ['fleet', 'task'].map(scope => `INSERT INTO admission_contribution(scope,scope_key,live,queued)
  VALUES('${scope}',${scope === 'fleet' ? "''" : `${row}.task`},${sign}*${live(row)},${sign}*${queued(row)})
  ON CONFLICT(scope,scope_key) DO UPDATE SET live=live+excluded.live,queued=queued+excluded.queued`);
const due = (row: string) => `INSERT INTO task_due(project_id,run_id,task,origin,queued_at,claimable,source_hold)
  SELECT ${row}.project_id,${row}.run_id,${row}.task,${row}.origin,${row}.queued_at,${row}.claimable,${row}.source_hold WHERE ${row}.status='queued'
  ON CONFLICT(project_id,run_id) DO UPDATE SET task=excluded.task,origin=excluded.origin,queued_at=excluded.queued_at,claimable=excluded.claimable,source_hold=excluded.source_hold
  WHERE (task_due.task,task_due.origin,task_due.queued_at,task_due.claimable,task_due.source_hold)
    IS NOT (excluded.task,excluded.origin,excluded.queued_at,excluded.claimable,excluded.source_hold)`;
const head = (row: string, columns: string) => `SELECT ${columns} FROM task_due WHERE project_id=${row}.project_id AND task=${row}.task AND origin=${row}.origin ORDER BY queued_at,run_id LIMIT 1`;
const countHead = (row: string, sign: number) => `INSERT INTO task_runtime(project_id,task,origin,queued_count,revision) VALUES(${row}.project_id,${row}.task,${row}.origin,${sign},1)
  ON CONFLICT(project_id,task,origin) DO UPDATE SET queued_count=queued_count+excluded.queued_count,revision=revision+1`;
const refreshHead = (row: string) => `UPDATE task_runtime SET
  hold_reason=(${head(row, 'source_hold')}),
  hold_since=(${head(row, 'queued_at')}),
  oldest_run_id=(${head(row, 'run_id')}),oldest_queued_at=(${head(row, 'queued_at')}),revision=revision+1
  WHERE project_id=${row}.project_id AND task=${row}.task AND origin=${row}.origin
    AND (oldest_run_id,oldest_queued_at) IS NOT ((${head(row, 'run_id')}),(${head(row, 'queued_at')}))`;

export function liveTriggers(): Trigger[] {
  const watched = ['project_id', 'id', 'status', 'task', 'origin', 'queued_at', 'dispatched_by', 'held_by'];
  return [
    trigger('run_admission_ready_mark', 'projection_catchup', 'UPDATE OF done', ["UPDATE change_marks SET revision=revision+1 WHERE kind='runs'"],
      `NEW.projection='${RUN_ADMISSION_PROJECTION}' AND OLD.done IS NOT NEW.done`),
    trigger('run_live_insert', 'agent_runs', 'INSERT', reconcileLive(key('NEW'))),
    trigger('run_live_update', 'agent_runs', `UPDATE OF ${watched.join(',')}`, reconcileLive(`${key('OLD')} UNION ${key('NEW')}`), changed(watched)),
    trigger('run_live_delete', 'agent_runs', 'DELETE', ['DELETE FROM run_live WHERE project_id=OLD.project_id AND run_id=OLD.id']),
    trigger('run_live_add', 'run_live', 'INSERT', [...counter('NEW', 1), due('NEW')]),
    trigger('run_live_remove', 'run_live', 'DELETE', [...counter('OLD', -1), 'DELETE FROM task_due WHERE project_id=OLD.project_id AND run_id=OLD.run_id']),
    trigger('run_live_counts', 'run_live', 'UPDATE OF task,status', [...counter('OLD', -1), ...counter('NEW', 1)], 'OLD.task IS NOT NEW.task OR OLD.status IS NOT NEW.status'),
    trigger('run_live_due', 'run_live', 'UPDATE', ["DELETE FROM task_due WHERE project_id=NEW.project_id AND run_id=NEW.run_id AND NEW.status<>'queued'", due('NEW')]),
    trigger('task_due_add', 'task_due', 'INSERT', [countHead('NEW', 1), refreshHead('NEW')]),
    trigger('task_due_remove', 'task_due', 'DELETE', [countHead('OLD', -1), refreshHead('OLD')]),
    trigger('task_due_reclassify', 'task_due', 'UPDATE OF task,origin', [countHead('OLD', -1), countHead('NEW', 1), refreshHead('OLD'), refreshHead('NEW')], 'OLD.task IS NOT NEW.task OR OLD.origin IS NOT NEW.origin'),
    trigger('task_due_head', 'task_due', 'UPDATE', [refreshHead('NEW'),
      `UPDATE task_runtime SET hold_reason=NEW.source_hold,hold_since=NEW.queued_at,revision=revision+1
        WHERE project_id=NEW.project_id AND task=NEW.task AND origin=NEW.origin AND oldest_run_id=NEW.run_id AND OLD.source_hold IS NOT NEW.source_hold AND hold_reason IS NOT NEW.source_hold`]),
    ...['INSERT', 'UPDATE', 'DELETE'].map(action => trigger(`task_runtime_mark_${action.toLowerCase()}`, 'task_runtime', action,
      ["UPDATE change_marks SET revision=revision+1 WHERE kind='runs'"], action === 'UPDATE'
        ? changed(['queued_count', 'oldest_run_id', 'oldest_queued_at', 'hold_reason', 'hold_since']) : '')),
  ];
}

export function liveSchemaStatements(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS run_live(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),run_id TEXT NOT NULL,
      task TEXT NOT NULL,status TEXT NOT NULL CHECK(${IN_FLIGHT_RUN_STATUSES}),origin TEXT NOT NULL,
      queued_at INTEGER,claimable INTEGER NOT NULL CHECK(claimable IN (0,1)),source_hold TEXT,PRIMARY KEY(project_id,run_id)) WITHOUT ROWID`,
    `CREATE INDEX IF NOT EXISTS idx_agent_runs_admission_catchup ON agent_runs(project_id,id) WHERE ${IN_FLIGHT_RUN_STATUSES}`,
    'CREATE INDEX IF NOT EXISTS idx_run_live_id ON run_live(run_id)',
    `CREATE TABLE IF NOT EXISTS admission_contribution(scope TEXT NOT NULL CHECK(scope IN ('fleet','task')),scope_key TEXT NOT NULL,
      live INTEGER NOT NULL DEFAULT 0,queued INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(scope,scope_key)) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS task_due(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),run_id TEXT NOT NULL,task TEXT NOT NULL,origin TEXT NOT NULL,
      queued_at INTEGER,claimable INTEGER NOT NULL CHECK(claimable IN (0,1)),source_hold TEXT,PRIMARY KEY(project_id,run_id)) WITHOUT ROWID`,
    'CREATE INDEX IF NOT EXISTS idx_task_due_unclaimed ON task_due(claimable)',
    'CREATE INDEX IF NOT EXISTS idx_task_due_claim ON task_due(task,origin,claimable,queued_at,run_id,project_id)',
    'CREATE INDEX IF NOT EXISTS idx_task_due_head ON task_due(project_id,task,origin,queued_at,run_id)',
    `CREATE TABLE IF NOT EXISTS task_runtime(project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),task TEXT NOT NULL,origin TEXT NOT NULL CHECK(origin IN ('manual','automatic')),queued_count INTEGER NOT NULL DEFAULT 0,
      oldest_run_id TEXT,oldest_queued_at INTEGER,hold_reason TEXT,hold_since INTEGER,revision INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(project_id,task,origin)) WITHOUT ROWID`,
    'CREATE INDEX IF NOT EXISTS idx_task_runtime_task ON task_runtime(task,project_id) WHERE queued_count>0',
    ...liveTriggers().map(trigger => trigger.sql),
    `INSERT INTO projection_catchup(projection,phase,done) SELECT '${RUN_ADMISSION_PROJECTION}','runs',NOT EXISTS(SELECT 1 FROM agent_runs WHERE ${IN_FLIGHT_RUN_STATUSES})`,
  ];
}

const LIVE_RECONCILE = reconcileLive(jsonKeys(['project_id', 'run_id'])).map((sql, i) => write<[string]>({ name: `runs.livePage${i}`, sql }));
export const RUN_ADMISSION_CATCHUP = {
  projection: RUN_ADMISSION_PROJECTION,
  phases: { runs: { source: { table: 'agent_runs INDEXED BY idx_agent_runs_admission_catchup', columns: ['project_id', 'id'], where: IN_FLIGHT_RUN_STATUSES }, reconcile: LIVE_RECONCILE } },
} as const satisfies CatchupFamily;
const readiness = read<[], { ready: number }>({ name: 'runs.admissionReady', sql: `SELECT ${RUN_ADMISSION_READY_SQL} AS ready` });
export async function admissionReady(db: RelationalStore): Promise<boolean> {
  const [rows] = await readSet(db, readiness.bind());
  return rows[0]!.ready === 1;
}

/** Maintained scope counts, excluding only the admitted run's canonical Project/run identity. */
export const liveCountSql = (scope: 'fleet' | 'task', task: string, project: string, run: string) =>
  `(COALESCE((SELECT live FROM admission_contribution WHERE scope='${scope}' AND scope_key=${scope === 'fleet' ? "''" : task}),0)
    - EXISTS(SELECT 1 FROM run_live WHERE project_id=${project} AND run_id=${run} AND ${LIVE_RUN_STATUSES}${scope === 'task' ? ` AND task=${task}` : ''}))`;

const load = read<[string, number, string | null], { liveRuns: number; liveTaskRuns: number; taskRunsLastHour: number; ready: number }>({ name: 'runs.dispatchLoad', sql: `SELECT ${RUN_ADMISSION_READY_SQL} AS ready,
  COALESCE((SELECT live FROM admission_contribution WHERE scope='fleet' AND scope_key=''),0)
    -(SELECT COUNT(*) FROM run_live WHERE run_id=?3 AND ${LIVE_RUN_STATUSES}) AS liveRuns,
  COALESCE((SELECT live FROM admission_contribution WHERE scope='task' AND scope_key=?1),0)
    -(SELECT COUNT(*) FROM run_live WHERE run_id=?3 AND task=?1 AND ${LIVE_RUN_STATUSES}) AS liveTaskRuns,
  (SELECT COUNT(*) FROM agent_runs INDEXED BY idx_agent_runs_task_started WHERE task=?1 AND started_at IS NOT NULL AND started_at>=?2 AND (?3 IS NULL OR id<>?3)) AS taskRunsLastHour` });
export async function dispatchLoad(db: RelationalStore, task: string, now: number, exclude?: string) {
  const [rows] = await readSet(db, load.bind(task, now - 3_600_000, exclude ?? null));
  const { ready, ...counts } = rows[0]!;
  return ready === 1 ? counts : { ...counts, ready: false };
}
