/** The estimator's Deployment-wide progress: its epoch, cycle, watermark and refresh stamp. */
import type { PreparedStatement, RelationalStore } from '../../core/adapters.js';
import { read, readSet, write, type Bound } from '../index.js';
import { BUDGET_ENABLED } from './budget-activation.js';

const REFRESHED_KEY = 'budget.estimates_refreshed_at';
const WATERMARK_KEY = 'budget.estimate_watermark';
const PROGRESS_KEY = 'budget.estimate_progress';
const EPOCH_KEY = 'budget.estimate_epoch';
const RESTORED_FLOOR_KEY = 'budget.restored_estimate_floor';

const refreshedAt = read<[], { value: string }>({ name: 'meta.estimatesRefreshedAt', sql: `SELECT value FROM schema_meta WHERE key='${REFRESHED_KEY}'` });

interface EstimateCursor {
  value: string | null; epoch: string | null; enabled: string | null; restoredFloor: string | null; watermark: string | null; latest: number;
}
const cursor = read<[], EstimateCursor>({
  name: 'meta.estimateCursor',
  sql: `SELECT (SELECT value FROM schema_meta WHERE key='${PROGRESS_KEY}') AS value,
    (SELECT value FROM schema_meta WHERE key='${EPOCH_KEY}') AS epoch,
    (SELECT value FROM schema_meta WHERE key='${BUDGET_ENABLED}') AS enabled,
    (SELECT value FROM schema_meta WHERE key='${RESTORED_FLOOR_KEY}') AS restoredFloor,
    (SELECT value FROM schema_meta WHERE key='${WATERMARK_KEY}') AS watermark,
    COALESCE((SELECT settled_seq FROM agent_run_attempts INDEXED BY idx_attempts_settled
      WHERE profile_json IS NOT NULL AND cost_usd IS NOT NULL ORDER BY settled_seq DESC LIMIT 1),0) AS latest`,
});
const startProgress = write<[next: string, epoch: string | null, refreshedBefore: number], { key: string }>({
  name: 'meta.startEstimateProgress',
  sql: `INSERT INTO schema_meta(key,value) SELECT '${PROGRESS_KEY}',?1 WHERE (SELECT value FROM schema_meta WHERE key='${EPOCH_KEY}') IS ?2
    AND NOT EXISTS(SELECT 1 FROM schema_meta WHERE key='${REFRESHED_KEY}' AND CAST(value AS INTEGER)>?3) ON CONFLICT(key) DO NOTHING RETURNING key`,
});
const advanceProgress = write<[next: string, held: string], { key: string }>({
  name: 'meta.advanceEstimateProgress',
  sql: `UPDATE schema_meta SET value=?1 WHERE key='${PROGRESS_KEY}' AND value=?2 RETURNING key`,
});
const revisionHeld = `EXISTS(SELECT 1 FROM schema_meta WHERE key='${PROGRESS_KEY}' AND json_extract(value,'$.revision')=?2)`;
const stampWatermark = write<[until: string, revision: string]>({
  name: 'meta.stampEstimateWatermark',
  sql: `INSERT INTO schema_meta(key,value) SELECT '${WATERMARK_KEY}',?1 WHERE ${revisionHeld} ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
});
const stampRefreshed = write<[now: string, revision: string]>({
  name: 'meta.stampEstimatesRefreshed',
  sql: `INSERT INTO schema_meta(key,value) SELECT '${REFRESHED_KEY}',?1 WHERE ${revisionHeld} ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
});
const clearProgress = write<[revision: string]>({
  name: 'meta.clearEstimateProgress',
  sql: `DELETE FROM schema_meta WHERE key='${PROGRESS_KEY}' AND json_extract(value,'$.revision')=?1`,
});

export async function estimatesRefreshedAt(db: RelationalStore): Promise<string | null> {
  const [[row]] = await readSet(db, refreshedAt.bind());
  return row?.value ?? null;
}

export async function estimateCursor(db: RelationalStore): Promise<EstimateCursor | null> {
  const [[row]] = await readSet(db, cursor.bind());
  return row ?? null;
}

const sampleWrite = write<[project: string, agent: string, key: string, value: string, now: number, revision: string]>({
  name: 'meta.publishEstimateSample',
  sql: `INSERT INTO agent_state(project_id,agent_id,key,value,updated_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM schema_meta WHERE key='${PROGRESS_KEY}' AND json_extract(value,'$.revision')=?)
    ON CONFLICT(project_id,agent_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`,
});

/** A page publishes a sample only while its progress revision still stands. */
export function estimateSampleStatement(projectId: string, agentId: string, key: string, value: string, now: number, revision: string): Bound<never, 'write'> {
  return sampleWrite.bind(projectId, agentId, key, value, now, revision);
}

/** Answers a row when this page took the progress record, and none when another refresh or an invalidation won. */
export function estimateAdvanceStatement(held: string | null, next: string, epoch: string | null, refreshedBefore: number): Bound<{ key: string }, 'write'> {
  return held === null ? startProgress.bind(next, epoch, refreshedBefore) : advanceProgress.bind(next, held);
}

export function estimateCompletionStatements(until: number, now: number, revision: string): Bound<never, 'write'>[] {
  return [stampWatermark.bind(String(until), revision), stampRefreshed.bind(String(now), revision), clearProgress.bind(revision)];
}

export interface EstimateSettlement { seq: number; projectId: string; task: string; profile: string; cost: number; estimate: number | null }
const settlementPage = read<[after: number, until: number, floor: number, limit: number], EstimateSettlement>({
  name: 'meta.estimateSettlements',
  sql: `SELECT a.settled_seq AS seq,a.project_id AS projectId,r.task,a.profile_json AS profile,
    a.cost_usd AS cost,a.estimate_usd AS estimate FROM agent_run_attempts a INDEXED BY idx_attempts_settled JOIN agent_runs r ON r.project_id=a.project_id AND r.id=a.run_id
    WHERE a.settled_seq>?1 AND a.settled_seq<=?2 AND a.claimed_at>=?3 AND a.profile_json IS NOT NULL AND a.cost_usd IS NOT NULL
    ORDER BY a.settled_seq LIMIT ?4`,
});

/** Priced attempts settled after `after` through `until`, claimed at or after `floor`, oldest first. */
export async function estimateSettlements(db: RelationalStore, after: number, until: number, floor: number, limit: number): Promise<EstimateSettlement[]> {
  const [rows] = await readSet(db, settlementPage.bind(after, until, floor, limit));
  return rows;
}

/** Restarts the estimator's cycle while a restore's own guard, written against the rows it replaces, still holds. */
export function estimateInvalidationStatements(db: RelationalStore, guard: { sql: string; params: unknown[] }, restoredFloor?: number): PreparedStatement[] {
  return [
    db.prepare(`INSERT OR REPLACE INTO schema_meta(key,value) SELECT '${EPOCH_KEY}',? WHERE ${guard.sql}`).bind(crypto.randomUUID(), ...guard.params),
    db.prepare(`DELETE FROM schema_meta WHERE key IN ('${REFRESHED_KEY}','${PROGRESS_KEY}','${WATERMARK_KEY}') AND (${guard.sql})`).bind(...guard.params),
    ...(restoredFloor === undefined ? [] : [db.prepare(`INSERT INTO schema_meta(key,value) SELECT '${RESTORED_FLOOR_KEY}',? WHERE ${guard.sql}
      ON CONFLICT(key) DO UPDATE SET value=CAST(MIN(CAST(value AS INTEGER),CAST(excluded.value AS INTEGER)) AS TEXT)`)
      .bind(String(restoredFloor), ...guard.params)]),
  ];
}
