import type { RelationalStore } from '../adapters.js';
import { VECTOR_LOST_MS, VECTOR_REWRITE_LIMIT } from './provider.js';
import { HUBNESS_MEMBER, RECEIPT, deletionRetryDue } from './receipt-state.js';
import { PASSED_OVER, SOURCE_HELD, passedOverBinds } from './reconcile.js';
import { currentSource, currentHubnessMember, eligibleSource } from './source-state.js';
import { WORK_SWEEP_PAGE, type WorkSweep } from './work-state.js';

type SweepPhase = 'sources' | 'receipts' | 'members';
interface SweepCursor { phase: SweepPhase; a: string; b: string; count: number; min: number | null; max: number | null; uncovered: boolean }
const begin = (phase: SweepPhase): SweepCursor => ({ phase, a: '', b: '', count: 0, min: null, max: null, uncovered: false });
const resume = (cursor: string | null, phase: SweepPhase): SweepCursor => cursor === null ? begin(phase) : JSON.parse(cursor) as SweepCursor;
const advance = (phase: SweepPhase): string => JSON.stringify(begin(phase));

/** One indexed page of source versions or receipts; no full-corpus probe runs during an idle safety sweep. */
export async function embeddingSweep(
  db: RelationalStore, projectId: string, writes: readonly string[], retained: readonly string[], now: number, saved: string | null,
): Promise<WorkSweep> {
  const cursor = resume(saved, 'sources');
  if (cursor.phase === 'sources') {
    const predicate = writes.length === 0 ? '0' : `(${writes.map(() => `(NOT ${SOURCE_HELD} AND NOT ${PASSED_OVER})`).join(' OR ')})`;
    const rows = (await db.prepare(`WITH page AS MATERIALIZED (SELECT * FROM embedding_versions
      WHERE project_id = ? AND (type,record_id) > (?,?) ORDER BY type,record_id LIMIT ${WORK_SWEEP_PAGE})
      SELECT s.type,s.record_id,(${eligibleSource('s')} AND ${predicate}) AS pending FROM page s`)
      .bind(projectId, cursor.a, cursor.b, ...writes.flatMap((model) => [model, ...passedOverBinds(model, now)]))
      .all<{ type: string; record_id: string; pending: number }>()).results;
    const last = rows.at(-1);
    return { pending: rows.some((row) => row.pending === 1), cursor: rows.length < WORK_SWEEP_PAGE ? advance('receipts')
      : JSON.stringify({ ...cursor, a: last!.type, b: last!.record_id }) };
  }
  const rows = (await db.prepare(`WITH page AS MATERIALIZED (SELECT * FROM embedding_receipts
    WHERE project_id = ? AND (model_key,id) > (?,?) ORDER BY model_key,id LIMIT ${WORK_SWEEP_PAGE})
    SELECT r.*,${currentSource('r')} AS current FROM page r`).bind(projectId, cursor.a, cursor.b)
    .all<{ model_key: string; id: string; ready: number; updated_at: number; current: number }>()).results;
  const pending = rows.some((row) => row.ready >= RECEIPT.journaled ? !retained.includes(row.model_key) || row.current === 0
    : deletionRetryDue(row.ready, row.updated_at, now));
  const last = rows.at(-1);
  return { pending, cursor: rows.length < WORK_SWEEP_PAGE ? null : JSON.stringify({ ...cursor, a: last!.model_key, b: last!.id }) };
}

/** Bounded receipt and membership pages also recompute the moments-count invariant over a complete sweep cycle. */
export async function hubnessSweep(
  db: RelationalStore, projectId: string, model: string, now: number, saved: string | null, paired: boolean,
): Promise<WorkSweep> {
  const cursor = resume(saved, 'receipts');
  if (cursor.phase === 'receipts') {
    const rows = (await db.prepare(`WITH page AS MATERIALIZED (SELECT * FROM embedding_receipts INDEXED BY idx_embedding_receipts_spore
      WHERE project_id = ? AND model_key = ? AND type = 'spore' AND ready = ${RECEIPT.ready} AND id > ? ORDER BY id LIMIT ${WORK_SWEEP_PAGE})
      SELECT r.id,r.rewrites,r.updated_at,${currentSource('r')} AS current,EXISTS (SELECT 1 FROM embedding_hubness_members m
        WHERE m.project_id=r.project_id AND m.model_key=r.model_key AND m.id=r.id) AS member FROM page r`)
      .bind(projectId, model, cursor.b).all<{ id: string; rewrites: number; updated_at: number; current: number; member: number }>()).results;
    const count = Math.min(2, cursor.count + rows.filter((row) => row.current === 1).length);
    const uncovered = cursor.uncovered || rows.some((row) => row.current === 1 && row.member === 0
      && !(row.rewrites >= VECTOR_REWRITE_LIMIT && row.updated_at <= now - VECTOR_LOST_MS));
    if ((!paired || count === 2) && uncovered) return { pending: true, cursor: null };
    const last = rows.at(-1);
    if (rows.length === WORK_SWEEP_PAGE) return { pending: false, cursor: JSON.stringify({ ...cursor, count, uncovered, b: last!.id }) };
    return { pending: false, cursor: paired && count < 2 ? null : advance('members') };
  }
  const active = await db.prepare('SELECT hubness_cursor FROM embedding_cursors WHERE project_id = ?').bind(projectId).first<{ hubness_cursor: string | null }>();
  if (active?.hubness_cursor != null) return { pending: true, cursor: null };
  const rows = (await db.prepare(`WITH page AS MATERIALIZED (SELECT * FROM embedding_hubness_members
    WHERE project_id = ? AND (model_key,id) > (?,?) ORDER BY model_key,id LIMIT ${WORK_SWEEP_PAGE})
    SELECT m.model_key,m.id,m.state,m.n,${currentHubnessMember('m')} AS current FROM page m`)
    .bind(projectId, cursor.a, cursor.b).all<{ model_key: string; id: string; state: number; n: number; current: number }>()).results;
  if (rows.some((row) => row.model_key !== model || row.state !== HUBNESS_MEMBER.settled || row.current === 0)) return { pending: true, cursor: null };
  const ns = rows.map((row) => row.n);
  const next = { ...cursor, count: cursor.count + rows.length,
    min: ns.length === 0 ? cursor.min : Math.min(cursor.min ?? Infinity, ...ns),
    max: ns.length === 0 ? cursor.max : Math.max(cursor.max ?? -Infinity, ...ns) };
  const last = rows.at(-1);
  return rows.length === WORK_SWEEP_PAGE
    ? { pending: false, cursor: JSON.stringify({ ...next, a: last!.model_key, b: last!.id }) }
    : { pending: next.count > 0 && (next.min !== next.count - 1 || next.max !== next.count - 1), cursor: null };
}
