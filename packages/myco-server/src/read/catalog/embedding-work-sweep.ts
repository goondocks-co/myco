import type { RelationalStore as core_embedding_work_sweep_import_RelationalStore } from "../../core/adapters.js";
import { VECTOR_LOST_MS as core_embedding_work_sweep_import_VECTOR_LOST_MS } from "../../core/embedding/provider.js";
import { VECTOR_REWRITE_LIMIT as core_embedding_work_sweep_import_VECTOR_REWRITE_LIMIT } from "../../core/embedding/provider.js";
import { HUBNESS_MEMBER as core_embedding_work_sweep_import_HUBNESS_MEMBER } from "../../core/embedding/receipt-state.js";
import { RECEIPT as core_embedding_work_sweep_import_RECEIPT } from "../../core/embedding/receipt-state.js";
import { WORK_SWEEP_PAGE as core_embedding_work_sweep_import_WORK_SWEEP_PAGE } from "../../core/embedding/work-state.js";
import type { WorkSweep as core_embedding_work_sweep_import_WorkSweep } from "../../core/embedding/work-state.js";
import { core_embedding_source_state_currentHubnessMember, core_embedding_source_state_currentSource } from './embedding-source-state.js';

type core_embedding_work_sweep_SweepPhase = 'sources' | 'receipts' | 'members';

interface core_embedding_work_sweep_SweepCursor { phase: core_embedding_work_sweep_SweepPhase; a: string; b: string; count: number; min: number | null; max: number | null; uncovered: boolean }

const core_embedding_work_sweep_begin = (phase: core_embedding_work_sweep_SweepPhase): core_embedding_work_sweep_SweepCursor => ({ phase, a: '', b: '', count: 0, min: null, max: null, uncovered: false });

const core_embedding_work_sweep_resume = (cursor: string | null, phase: core_embedding_work_sweep_SweepPhase): core_embedding_work_sweep_SweepCursor => cursor === null ? core_embedding_work_sweep_begin(phase) : JSON.parse(cursor) as core_embedding_work_sweep_SweepCursor;

const core_embedding_work_sweep_advance = (phase: core_embedding_work_sweep_SweepPhase): string => JSON.stringify(core_embedding_work_sweep_begin(phase));

/** Bounded receipt and membership pages also recompute the moments-count invariant over a complete sweep cycle. */
async function core_embedding_work_sweep_hubnessSweep(
  db: core_embedding_work_sweep_import_RelationalStore, projectId: string, model: string, now: number, saved: string | null, paired: boolean,
): Promise<core_embedding_work_sweep_import_WorkSweep> {
  const cursor = core_embedding_work_sweep_resume(saved, 'receipts');
  if (cursor.phase === 'receipts') {
    const rows = (await db.prepare(`WITH page AS MATERIALIZED (SELECT * FROM embedding_receipts INDEXED BY idx_embedding_receipts_spore
      WHERE project_id = ? AND model_key = ? AND type = 'spore' AND ready = ${core_embedding_work_sweep_import_RECEIPT.ready} AND id > ? ORDER BY id LIMIT ${core_embedding_work_sweep_import_WORK_SWEEP_PAGE})
      SELECT r.id,r.rewrites,r.updated_at,${core_embedding_source_state_currentSource('r')} AS current,EXISTS (SELECT 1 FROM embedding_hubness_members m
        WHERE m.project_id=r.project_id AND m.model_key=r.model_key AND m.id=r.id) AS member FROM page r`)
      .bind(projectId, model, cursor.b).all<{ id: string; rewrites: number; updated_at: number; current: number; member: number }>()).results;
    const count = Math.min(2, cursor.count + rows.filter((row) => row.current === 1).length);
    const uncovered = cursor.uncovered || rows.some((row) => row.current === 1 && row.member === 0
      && !(row.rewrites >= core_embedding_work_sweep_import_VECTOR_REWRITE_LIMIT && row.updated_at <= now - core_embedding_work_sweep_import_VECTOR_LOST_MS));
    if ((!paired || count === 2) && uncovered) return { pending: true, cursor: null };
    const last = rows.at(-1);
    if (rows.length === core_embedding_work_sweep_import_WORK_SWEEP_PAGE) return { pending: false, cursor: JSON.stringify({ ...cursor, count, uncovered, b: last!.id }) };
    return { pending: false, cursor: paired && count < 2 ? null : core_embedding_work_sweep_advance('members') };
  }
  const active = await db.prepare('SELECT hubness_cursor FROM embedding_cursors WHERE project_id = ?').bind(projectId).first<{ hubness_cursor: string | null }>();
  if (active?.hubness_cursor != null) return { pending: true, cursor: null };
  const rows = (await db.prepare(`WITH page AS MATERIALIZED (SELECT * FROM embedding_hubness_members
    WHERE project_id = ? AND (model_key,id) > (?,?) ORDER BY model_key,id LIMIT ${core_embedding_work_sweep_import_WORK_SWEEP_PAGE})
    SELECT m.model_key,m.id,m.state,m.n,${core_embedding_source_state_currentHubnessMember('m')} AS current FROM page m`)
    .bind(projectId, cursor.a, cursor.b).all<{ model_key: string; id: string; state: number; n: number; current: number }>()).results;
  if (rows.some((row) => row.model_key !== model || row.state !== core_embedding_work_sweep_import_HUBNESS_MEMBER.settled || row.current === 0)) return { pending: true, cursor: null };
  const ns = rows.map((row) => row.n);
  const next = {
    ...cursor, count: cursor.count + rows.length,
    min: ns.length === 0 ? cursor.min : Math.min(cursor.min ?? Infinity, ...ns),
    max: ns.length === 0 ? cursor.max : Math.max(cursor.max ?? -Infinity, ...ns)
  };
  const last = rows.at(-1);
  return rows.length === core_embedding_work_sweep_import_WORK_SWEEP_PAGE
    ? { pending: false, cursor: JSON.stringify({ ...next, a: last!.model_key, b: last!.id }) }
    : { pending: next.count > 0 && (next.min !== next.count - 1 || next.max !== next.count - 1), cursor: null };
}

export { core_embedding_work_sweep_hubnessSweep };
