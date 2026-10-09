import type { RelationalStore } from '../adapters.js';
import { DELETION_RETRIES, RECEIPT } from './receipt-state.js';
import { embeddingFailureWakeAt, PASSED_OVER, SOURCE_HELD, passedOverBinds } from './reconcile.js';
import { currentSource, eligibleSource } from './source-state.js';
import type { VectorType } from './vectors.js';

export interface EmbeddingQuery { sql: string; binds: unknown[] }
export interface RetiringReceipt { id: string; model_key: string; type: VectorType; record_id: string; revision: string; ready: number; updated_at: number }

/** SQLite BINARY collation compares UTF-8 bytes, including for supplementary Unicode characters. */
const binaryOrder = (a: string, b: string): number => {
  const left = new TextEncoder().encode(a), right = new TextEncoder().encode(b);
  const at = left.findIndex((byte, index) => byte !== right[index]);
  return at < 0 ? left.length - right.length : left[at]! - (right[at] ?? -1);
};

/** Separate indexed ranges cover retired models, stale revisions and each deletion retry state. */
export function retirementQueries(projectId: string, retained: readonly string[], now: number): EmbeddingQuery[] {
  const models = [...new Set(retained)].sort(binaryOrder);
  const order = ' ORDER BY r.updated_at, r.id LIMIT 1';
  const prefix = 'SELECT r.* FROM embedding_receipts r WHERE r.project_id = ?';
  const ranges = Array.from({ length: models.length + 1 }, (_, index) => {
    const lower = models[index - 1], upper = models[index];
    return {
      sql: `${prefix} AND r.ready >= ${RECEIPT.journaled}${lower === undefined ? '' : ' AND r.model_key > ?'}${upper === undefined ? '' : ' AND r.model_key < ?'}${order}`,
      binds: [projectId, ...(lower === undefined ? [] : [lower]), ...(upper === undefined ? [] : [upper])],
    };
  });
  return [
    ...ranges,
    ...models.map((model) => ({ sql: `${prefix} AND r.model_key = ? AND r.ready >= ${RECEIPT.journaled} AND NOT ${currentSource('r')}${order}`, binds: [projectId, model] })),
    ...DELETION_RETRIES.map(({ state, waitMs }) => ({
      sql: `${prefix} AND r.ready < ${RECEIPT.journaled} AND r.ready = ? AND r.updated_at <= ?${order}`, binds: [projectId, state, now - waitMs],
    })),
  ];
}

export async function retiringReceipt(db: RelationalStore, projectId: string, retained: readonly string[], now: number): Promise<RetiringReceipt | null> {
  const candidates: RetiringReceipt[] = [];
  for (const { sql, binds } of retirementQueries(projectId, retained, now)) {
    const row = await db.prepare(sql).bind(...binds).first<RetiringReceipt>();
    if (row !== null) candidates.push(row);
  }
  return candidates.sort((a, b) => a.updated_at - b.updated_at || binaryOrder(a.id, b.id))[0] ?? null;
}

/** Source work starts at the version index; eligibility is a point lookup in its owning source table. */
export function unwrittenQuery(projectId: string, model: string, now: number): EmbeddingQuery {
  return { sql: `SELECT 1 AS pending FROM embedding_versions s WHERE s.project_id = ? AND ${eligibleSource('s')}
    AND NOT ${SOURCE_HELD} AND NOT ${PASSED_OVER} LIMIT 1`, binds: [projectId, model, ...passedOverBinds(model, now)] };
}

/** New sources precede stale sources; each arm follows the attempted-at index in source order. */
export function sourceSelectionQuery(projectId: string, type: string, model: string, now: number, stale: boolean): EmbeddingQuery {
  return { sql: `SELECT s.record_id, s.revision FROM embedding_versions s
    WHERE s.project_id = ? AND s.type = ? AND ${eligibleSource('s')} AND NOT ${SOURCE_HELD} AND NOT ${PASSED_OVER}
      AND ${stale ? '' : 'NOT '}EXISTS (SELECT 1 FROM embedding_receipts r WHERE r.project_id = s.project_id AND r.type = s.type AND r.record_id = s.record_id)
    ORDER BY s.attempted_at, s.record_id LIMIT 1`, binds: [projectId, type, model, ...passedOverBinds(model, now)] };
}

/** The earliest timed retry, found through the failure and deletion-state indexes. */
export async function embeddingWakeAt(db: RelationalStore, projectId: string, writes: readonly string[], now: number): Promise<number | null> {
  const deadlines: number[] = [];
  for (const model of writes) {
    const deadline = await embeddingFailureWakeAt(db, projectId, model, now);
    if (deadline !== null) deadlines.push(deadline);
  }
  for (const { state, waitMs } of DELETION_RETRIES) {
    const row = await db.prepare(`SELECT updated_at AS at FROM embedding_receipts
      WHERE project_id = ? AND ready < ${RECEIPT.journaled} AND ready = ? AND updated_at > ? ORDER BY updated_at LIMIT 1`)
      .bind(projectId, state, now - waitMs).first<{ at: number }>();
    if (row !== null) deadlines.push(row.at + waitMs);
  }
  return deadlines.length === 0 ? null : Math.min(...deadlines);
}
