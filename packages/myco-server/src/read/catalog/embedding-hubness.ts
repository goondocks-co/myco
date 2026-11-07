import type { RelationalStore as sessions_import_RelationalStore } from "../../core/adapters.js";
import type { RelationalStore as core_embedding_hubness_import_RelationalStore } from "../../core/adapters.js";
import { VECTOR_LOST_MS as core_embedding_hubness_import_VECTOR_LOST_MS } from "../../core/embedding/provider.js";
import { VECTOR_REWRITE_LIMIT as core_embedding_hubness_import_VECTOR_REWRITE_LIMIT } from "../../core/embedding/provider.js";
import { HUBNESS_MEMBER as core_embedding_hubness_import_MEMBER } from "../../core/embedding/receipt-state.js";
import { recordedWork as core_embedding_hubness_import_recordedWork } from "../../core/embedding/work-state.js";
import { WORK_PREDICATE_VERSION as core_embedding_hubness_import_WORK_PREDICATE_VERSION } from "../../core/embedding/work-state.js";
import { core_embedding_source_state_currentHubnessMember, core_embedding_source_state_currentSource } from './embedding-source-state.js';
import { type core_embedding_selection_EmbeddingQuery } from './embedding-selection.js';
import { core_embedding_work_sweep_hubnessSweep } from './embedding-work-sweep.js';

/** Indexed spore receipts under the model whose source revision is current. Binds: project id, model key. */
const core_embedding_hubness_sporeVectors = (columns: string) => `SELECT ${columns} FROM embedding_receipts r INDEXED BY idx_embedding_receipts_spore
  WHERE r.project_id = ? AND r.model_key = ? AND r.type = 'spore' AND r.ready = 1 AND ${core_embedding_source_state_currentSource('r')}`;

/** Every current spore vector, including one left out of calibration while the vector store does not return it. */
const core_embedding_hubness_SPORE_VECTORS = core_embedding_hubness_sporeVectors('r.id');

/** The spore vectors calibration covers: current, and not left out while the vector store does not return them. */
const core_embedding_hubness_CURRENT_SPORE_VECTORS = `${core_embedding_hubness_SPORE_VECTORS} AND r.rewrites = 0`;

const core_embedding_hubness_NOT_MEMBER = `NOT EXISTS (SELECT 1 FROM embedding_hubness_members m
  WHERE m.project_id = r.project_id AND m.model_key = r.model_key AND m.id = r.id)`;

/** Current spore vectors no member row names. Binds: project id, model key. */
const core_embedding_hubness_UNCOVERED = `${core_embedding_hubness_sporeVectors('r.id, r.updated_at, r.rewrites')} AND r.rewrites = 0 AND ${core_embedding_hubness_NOT_MEMBER}`;

/** Spore vectors left out of calibration while the vector store does not return them. Binds: project id, model key. */
const core_embedding_hubness_MISSING = `${core_embedding_hubness_sporeVectors('r.id, r.updated_at, r.rewrites')} AND r.rewrites > 0 AND ${core_embedding_hubness_NOT_MEMBER}`;

/** A left-out spore vector no longer written again: written again the most times, and still not returned `VECTOR_LOST_MS` after the last write. Binds: the lost cutoff. */
const core_embedding_hubness_ABANDONED = `(r.rewrites >= ${core_embedding_hubness_import_VECTOR_REWRITE_LIMIT} AND r.updated_at <= ?)`;

/** Settled members whose moments do not count exactly the other members. Binds: project id, model key. */
const core_embedding_hubness_MISCOUNTED = `SELECT COALESCE(MIN(n) <> COUNT(*) - 1 OR MAX(n) <> COUNT(*) - 1, 0) AS miscounted
  FROM embedding_hubness_members WHERE project_id = ? AND model_key = ?`;

/** A Project's spore vectors under one model left out of calibration while the vector store does not return them. */
interface core_embedding_hubness_MissingSporeVectors {
  /** Being written again, or due to be. */
  rewriting: number;
  /** Written again, and waited on for `VECTOR_LOST_MS` from that write. */
  waiting: number;
  /** Written again `VECTOR_REWRITE_LIMIT` times and still not returned; no longer written again. */
  abandoned: number;
}

async function core_embedding_hubness_missingSporeVectors(db: core_embedding_hubness_import_RelationalStore, projectId: string, model: string, now: number): Promise<core_embedding_hubness_MissingSporeVectors> {
  const row = await db.prepare(`SELECT COALESCE(SUM(r.ready = 0 OR (r.updated_at <= ? AND r.rewrites < ${core_embedding_hubness_import_VECTOR_REWRITE_LIMIT})), 0) AS rewriting,
      COALESCE(SUM(r.ready = 1 AND r.updated_at > ?), 0) AS waiting,
      COALESCE(SUM(r.ready = 1 AND r.updated_at <= ? AND r.rewrites >= ${core_embedding_hubness_import_VECTOR_REWRITE_LIMIT}), 0) AS abandoned
    FROM embedding_receipts r
    WHERE r.project_id = ? AND r.model_key = ? AND r.rewrites > 0 AND r.ready >= 0 AND r.type = 'spore' AND ${core_embedding_source_state_currentSource('r')}`)
    .bind(now - core_embedding_hubness_import_VECTOR_LOST_MS, now - core_embedding_hubness_import_VECTOR_LOST_MS, now - core_embedding_hubness_import_VECTOR_LOST_MS, projectId, model).first<core_embedding_hubness_MissingSporeVectors>();
  return { rewriting: row?.rewriting ?? 0, waiting: row?.waiting ?? 0, abandoned: row?.abandoned ?? 0 };
}

/**
 * Calibration work is pending: a member of another model, an operation in progress, a member whose vector is no longer
 * current, a current vector no member covers, a left-out vector that is still looked for or due to be written again,
 * statistics still to publish, or settled moments that do not count the other members. Each probe starts at an indexed partition.
 */
function core_embedding_hubness_hubnessQueries(projectId: string, model: string, now: number): core_embedding_selection_EmbeddingQuery[] {
  return [
    ...['<', '>'].map((op) => ({ sql: `SELECT 1 FROM embedding_hubness_members WHERE project_id = ? AND model_key ${op} ? LIMIT 1`, binds: [projectId, model] })),
    { sql: 'SELECT 1 FROM embedding_hubness_members WHERE project_id = ? AND model_key = ? AND state > 0 LIMIT 1', binds: [projectId, model] },
    { sql: 'SELECT 1 FROM embedding_cursors WHERE project_id = ? AND hubness_cursor IS NOT NULL', binds: [projectId] },
    { sql: `SELECT 1 FROM embedding_hubness_members m WHERE m.project_id = ? AND m.model_key = ? AND m.state = 0 AND NOT ${core_embedding_source_state_currentHubnessMember('m')} LIMIT 1`, binds: [projectId, model] },
    { sql: `${core_embedding_hubness_UNCOVERED} LIMIT 1`, binds: [projectId, model] },
    { sql: `${core_embedding_hubness_MISSING} AND NOT ${core_embedding_hubness_ABANDONED} LIMIT 1`, binds: [projectId, model, now - core_embedding_hubness_import_VECTOR_LOST_MS] },
    { sql: `SELECT 1 FROM (${core_embedding_hubness_MISCOUNTED}) WHERE miscounted = 1`, binds: [projectId, model] },
  ];
}

async function core_embedding_hubness_recordedHubness(db: core_embedding_hubness_import_RelationalStore, projectId: string, model: string, now: number): Promise<boolean> {
  const hasPair = async () => {
    const population = await db.prepare(`SELECT total FROM embedding_hubness_population p WHERE p.project_id=? AND p.model_key=?
      AND p.revision=COALESCE((SELECT revision FROM embedding_hubness_revision WHERE project_id=?),0)`)
      .bind(projectId,model,projectId).first<{total:number}>();
    return population === null ? (await db.prepare(`${core_embedding_hubness_SPORE_VECTORS} LIMIT 2`).bind(projectId,model).all()).results.length === 2 : population.total>=2;
  };
  return core_embedding_hubness_import_recordedWork(db, projectId, model, 'hubness', JSON.stringify({ predicate: core_embedding_hubness_import_WORK_PREDICATE_VERSION }), now, async () => {
    if (!(await hasPair())) return { pending: false };
    for (const statement of prepareHubnessWork(db, projectId, model, now)) {
      const found = await statement.first<{updated_at?:number}>();
      if (found === null) continue;
      if (found.updated_at === undefined) return {pending:true};
      const retry = await db.prepare(`SELECT MIN(r.updated_at)+? AS at FROM (${core_embedding_hubness_sporeVectors('r.*')}) r
        WHERE r.updated_at>? AND ${core_embedding_hubness_NOT_MEMBER}`).bind(core_embedding_hubness_import_VECTOR_LOST_MS,projectId,model,now-core_embedding_hubness_import_VECTOR_LOST_MS)
        .first<{at:number|null}>();
      return { pending:true,wakeAt:retry?.at ?? null };
    }
    return { pending: false };
  }, (cursor) => core_embedding_work_sweep_hubnessSweep(db, projectId, model, now, cursor, true));
}

/** Calibration has work only with at least two current spore vectors. */
async function core_embedding_hubness_calibrationPending(db: core_embedding_hubness_import_RelationalStore, projectId: string, model: string, now: number): Promise<boolean> {
  return core_embedding_hubness_recordedHubness(db, projectId, model, now);
}

export function prepareLeavingHubness(db: sessions_import_RelationalStore, projectId: string, model: string, limit: number) {
  return db.prepare(`SELECT m.id FROM embedding_hubness_members m WHERE m.project_id = ? AND m.model_key = ?
      AND m.state = ${core_embedding_hubness_import_MEMBER.settled} AND NOT ${core_embedding_source_state_currentHubnessMember('m')} ORDER BY m.id LIMIT ?`).bind(projectId, model, limit);
}

export function prepareJoiningHubness(db: sessions_import_RelationalStore, projectId: string, model: string, limit: number) {
  return db.prepare(`${core_embedding_hubness_UNCOVERED} ORDER BY r.id LIMIT ?`).bind(projectId, model, limit);
}

export function prepareMissingHubness(db: sessions_import_RelationalStore, projectId: string, model: string, lostBefore: number, probe: string, limit: number) {
  return db.prepare(`${core_embedding_hubness_MISSING} ORDER BY ${core_embedding_hubness_ABANDONED}, ${core_embedding_hubness_ABANDONED} AND r.id <= ?, r.id LIMIT ?`).bind(projectId, model, lostBefore, lostBefore, probe, limit);
}

export async function countCurrentSporeVectors(db: sessions_import_RelationalStore, projectId: string, model: string, covered: boolean) {
  const sql = covered ? core_embedding_hubness_CURRENT_SPORE_VECTORS : core_embedding_hubness_SPORE_VECTORS;
  return (await db.prepare("SELECT COUNT(*) AS n FROM (" + sql + ")").bind(projectId, model).first<{ n: number }>())!.n;
}

/** One population snapshot per source revision; page commits fence that revision through the calibration token. */
export function prepareHubnessPopulation(db: sessions_import_RelationalStore, projectId: string, model: string) {
  return db.prepare(`INSERT OR REPLACE INTO embedding_hubness_population(project_id,model_key,revision,total,covered,members,miscounted,complete)
    SELECT ?,?,COALESCE((SELECT revision FROM embedding_hubness_revision WHERE project_id=?),0),
      (SELECT COUNT(*) FROM (${core_embedding_hubness_SPORE_VECTORS})),
      (SELECT COUNT(*) FROM (${core_embedding_hubness_CURRENT_SPORE_VECTORS})),
      (SELECT COUNT(*) FROM embedding_hubness_members WHERE project_id=? AND model_key=?),
      (SELECT miscounted FROM (${core_embedding_hubness_MISCOUNTED})),
      NOT EXISTS(SELECT 1 FROM embedding_hubness_members m WHERE m.project_id=? AND m.model_key=?
        AND m.state<>${core_embedding_hubness_import_MEMBER.leaving} AND NOT ${core_embedding_source_state_currentHubnessMember('m')})
        AND NOT EXISTS(${core_embedding_hubness_UNCOVERED}) RETURNING revision,total,covered,members,miscounted,complete`)
    .bind(projectId,model,projectId,projectId,model,projectId,model,projectId,model,projectId,model,projectId,model,projectId,model);
}

export function* prepareHubnessWork(db: sessions_import_RelationalStore, projectId: string, model: string, now: number) {
  for (const { sql, binds } of core_embedding_hubness_hubnessQueries(projectId, model, now)) yield db.prepare(sql).bind(...binds);
}

export async function currentSporeVectorIds(db: sessions_import_RelationalStore, projectId: string, model: string): Promise<string[]> {
  return (await db.prepare(core_embedding_hubness_CURRENT_SPORE_VECTORS + ' ORDER BY r.id').bind(projectId,model).all<{id:string}>()).results.map(row=>row.id);
}

export { type core_embedding_hubness_MissingSporeVectors, core_embedding_hubness_missingSporeVectors, core_embedding_hubness_calibrationPending };
