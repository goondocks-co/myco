import { binaryOrder as core_embedding_selection_import_binaryOrder } from "../scope.js";
import type { RelationalStore as core_embedding_selection_import_RelationalStore } from "../../core/adapters.js";
import { DELETION_RETRIES as core_embedding_selection_import_DELETION_RETRIES } from "../../core/embedding/receipt-state.js";
import { RECEIPT as core_embedding_selection_import_RECEIPT } from "../../core/embedding/receipt-state.js";
import type { VectorType as core_embedding_selection_import_VectorType } from "../../core/embedding/vectors.js";
import { core_embedding_source_state_currentSource } from './embedding-source-state.js';
import { core_embedding_reconcile_embeddingFailureWakeAt } from './embedding-reconcile.js';

interface core_embedding_selection_EmbeddingQuery { sql: string; binds: unknown[] }

interface core_embedding_selection_RetiringReceipt { id: string; model_key: string; type: core_embedding_selection_import_VectorType; record_id: string; revision: string; ready: number; updated_at: number }

/** Separate indexed ranges cover retired models, stale revisions and each deletion retry state. */
function core_embedding_selection_retirementQueries(projectId: string, retained: readonly string[], now: number): core_embedding_selection_EmbeddingQuery[] {
  const models = [...new Set(retained)].sort(core_embedding_selection_import_binaryOrder);
  const order = ' ORDER BY r.updated_at, r.id LIMIT 1';
  const prefix = 'SELECT r.* FROM embedding_receipts r WHERE r.project_id = ?';
  const ranges = Array.from({ length: models.length + 1 }, (_, index) => {
    const lower = models[index - 1], upper = models[index];
    return {
      sql: `${prefix} AND r.ready >= ${core_embedding_selection_import_RECEIPT.journaled}${lower === undefined ? '' : ' AND r.model_key > ?'}${upper === undefined ? '' : ' AND r.model_key < ?'} ORDER BY r.model_key,r.updated_at,r.id LIMIT 1`,
      binds: [projectId, ...(lower === undefined ? [] : [lower]), ...(upper === undefined ? [] : [upper])],
    };
  });
  return [
    ...ranges,
    ...core_embedding_selection_import_DELETION_RETRIES.map(({ state, waitMs }) => ({
      sql: `${prefix} AND r.ready < ${core_embedding_selection_import_RECEIPT.journaled} AND r.ready = ? AND r.updated_at <= ?${order}`, binds: [projectId, state, now - waitMs],
    })),
  ];
}

async function core_embedding_selection_retiringReceipt(
  db: core_embedding_selection_import_RelationalStore,
  projectId: string,
  retained: readonly string[],
  now: number,
): Promise<core_embedding_selection_RetiringReceipt | null> {
  const candidates: core_embedding_selection_RetiringReceipt[] = [];
  for (const model of new Set(retained)) {
    const row = await db
      .prepare(
        `SELECT r.* FROM embedding_retirement_queue q
      CROSS JOIN embedding_receipts r ON r.project_id=q.project_id AND r.model_key=q.model_key AND r.id=q.id
      WHERE q.project_id=? AND q.model_key=? AND r.ready>=0 AND NOT ${core_embedding_source_state_currentSource('r')}
      ORDER BY q.updated_at,q.id LIMIT 1`,
      )
      .bind(projectId, model)
      .first<core_embedding_selection_RetiringReceipt>();
    if (row !== null) candidates.push(row);
  }
  for (const { sql, binds } of core_embedding_selection_retirementQueries(projectId, retained, now)) {
    const row = await db
      .prepare(sql)
      .bind(...binds)
      .first<core_embedding_selection_RetiringReceipt>();
    if (row !== null) candidates.push(row);
  }
  return candidates.sort((a, b) => a.updated_at - b.updated_at || core_embedding_selection_import_binaryOrder(a.id, b.id))[0] ?? null;
}

/** The earliest timed retry, found through the failure and deletion-state indexes. */
async function core_embedding_selection_embeddingWakeAt(db: core_embedding_selection_import_RelationalStore, projectId: string, writes: readonly string[], now: number): Promise<number | null> {
  const deadlines: number[] = [];
  for (const model of writes) {
    const deadline = await core_embedding_reconcile_embeddingFailureWakeAt(db, projectId, model, now);
    if (deadline !== null) deadlines.push(deadline);
  }
  for (const { state, waitMs } of core_embedding_selection_import_DELETION_RETRIES) {
    const row = await db.prepare(`SELECT updated_at AS at FROM embedding_receipts
      WHERE project_id = ? AND ready < ${core_embedding_selection_import_RECEIPT.journaled} AND ready = ? AND updated_at > ? ORDER BY updated_at LIMIT 1`)
      .bind(projectId, state, now - waitMs).first<{ at: number }>();
    if (row !== null) deadlines.push(row.at + waitMs);
  }
  return deadlines.length === 0 ? null : Math.min(...deadlines);
}

export { type core_embedding_selection_RetiringReceipt, core_embedding_selection_retiringReceipt, core_embedding_selection_embeddingWakeAt, type core_embedding_selection_EmbeddingQuery };
