import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet, write, type Bound } from '../index.js';

/** The plan metadata a receipt retains, or `unavailable` with none when the receipt kept no snapshot of that plan. */
interface ServedPlan {
  planKey: string;
  title: string | null;
  sessionId: string | null;
  contentHash: string | null;
  unavailable: boolean;
}

export interface PlanSnapshot { planKey: string; title: string | null; sessionId: string | null; contentHash: string | null }

/** Retains a served plan's metadata on the receipt that served it, written only when that receipt was. */
const snapshot = write<[project: string, receipt: string, plan: string, title: string | null, source: string | null, hash: string | null, session: string]>({
  name: 'servedPlans.snapshot',
  sql: `INSERT INTO injection_served_items(project_id,receipt_id,kind,item_id,title,session_id,content_hash,unavailable)
    SELECT ?1,?2,'plan',?3,?4,?5,?6,0 WHERE EXISTS(SELECT 1 FROM spore_injections WHERE project_id=?1 AND session_id=?7 AND id=?2)`,
});

/** The snapshot statements for the plans a receipt in `session` served. */
export const planSnapshots = (input: { project: string; session: string; receipt: string; plans: readonly PlanSnapshot[] }): Bound[] =>
  input.plans.map(plan => snapshot.bind(input.project, input.receipt, plan.planKey, plan.title, plan.sessionId, plan.contentHash, input.session));

/**
 * Each plan a receipt named, as the receipt's own snapshot holds it. A reference with no snapshot (a receipt older than
 * snapshots, or a snapshot a deleted source session redacted) answers unavailable: today's plan is not what was served.
 */
const receiptPlanRows = read<[receipts: string, project: string], { receipt_id: string; item_id: string; title: string | null; session_id: string | null; content_hash: string | null; unavailable: number }>({
  name: 'servedPlans.ofReceipts',
  sql: `SELECT json_extract(w.value,'$.receiptId') AS receipt_id,item.value AS item_id,s.title,s.session_id,s.content_hash,
      CASE WHEN s.item_id IS NULL THEN 1 ELSE s.unavailable END AS unavailable
    FROM json_each(?1) w CROSS JOIN json_each(json_extract(w.value,'$.planIds')) item
    LEFT JOIN injection_served_items s ON s.project_id=?2 AND s.receipt_id=json_extract(w.value,'$.receiptId')
      AND s.kind='plan' AND s.item_id=item.value
    ORDER BY CAST(w.key AS INTEGER),CAST(item.key AS INTEGER)`,
});

/** Receipts read per statement. */
const RECEIPTS_PER_READ = 100;

/** The plans each named receipt served, in the order it served them. Its cost follows the receipts named. */
export async function receiptPlans(
  db: RelationalStore,
  scope: { projectId: string },
  receipts: readonly { receiptId: string; planIds: readonly string[] }[],
): Promise<Map<string, ServedPlan[]>> {
  const out = new Map<string, ServedPlan[]>(receipts.map(receipt => [receipt.receiptId, []]));
  const runs: Bound<{ receipt_id: string; item_id: string; title: string | null; session_id: string | null; content_hash: string | null; unavailable: number }, 'read'>[] = [];
  for (let start = 0; start < receipts.length; start += RECEIPTS_PER_READ) {
    runs.push(receiptPlanRows.bind(JSON.stringify(receipts.slice(start, start + RECEIPTS_PER_READ)), scope.projectId));
  }
  for (const rows of await readSet(db, ...runs)) {
    for (const row of rows) out.get(row.receipt_id)!.push({
      planKey: row.item_id, title: row.title, sessionId: row.session_id, contentHash: row.content_hash, unavailable: row.unavailable === 1,
    });
  }
  return out;
}
