import type { RelationalStore } from '../core/adapters.js';
import { inListChunks, type ReadScope } from './scope.js';

/** The plan metadata a receipt retains, or the live metadata for an older receipt. */
export interface ServedPlan {
  planKey: string;
  title: string | null;
  sessionId: string | null;
  contentHash: string | null;
  unavailable: boolean;
}

/** Snapshots take precedence, including an explicit unavailable snapshot; older receipts use exact Project and plan keys. */
export async function receiptPlans(
  db: RelationalStore,
  scope: ReadScope,
  receipts: readonly { receiptId: string; planIds: readonly string[] }[],
): Promise<Map<string, ServedPlan[]>> {
  const out = new Map<string, ServedPlan[]>(receipts.map(receipt => [receipt.receiptId, []]));
  for (const run of inListChunks(receipts)) {
    const { results } = await db.prepare(`SELECT json_extract(w.value, '$.receiptId') AS receipt_id,
        item.value AS item_id,
        CASE WHEN s.item_id IS NOT NULL THEN s.title ELSE p.title END AS title,
        CASE WHEN s.item_id IS NOT NULL THEN s.session_id ELSE p.session_id END AS session_id,
        CASE WHEN s.item_id IS NOT NULL THEN s.content_hash ELSE p.content_hash END AS content_hash,
        CASE WHEN s.item_id IS NOT NULL THEN s.unavailable ELSE p.plan_key IS NULL END AS unavailable
      FROM json_each(?) w CROSS JOIN json_each(json_extract(w.value, '$.planIds')) item
      LEFT JOIN injection_served_items s ON s.project_id = ? AND s.receipt_id = json_extract(w.value, '$.receiptId')
        AND s.kind = 'plan' AND s.item_id = item.value
      LEFT JOIN plans p ON s.item_id IS NULL AND p.project_id = ? AND p.plan_key = item.value
      WHERE s.item_id IS NOT NULL OR p.plan_key IS NOT NULL
      ORDER BY CAST(w.key AS INTEGER), CAST(item.key AS INTEGER)`)
      .bind(JSON.stringify(run), scope.projectId, scope.projectId)
      .all<{ receipt_id: string; item_id: string; title: string | null; session_id: string | null; content_hash: string | null; unavailable: number }>();
    for (const row of results) out.get(row.receipt_id)!.push({
      planKey: row.item_id, title: row.title, sessionId: row.session_id, contentHash: row.content_hash,
      unavailable: row.unavailable === 1,
    });
  }
  return out;
}
