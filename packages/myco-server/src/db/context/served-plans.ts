import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet, write, type Bound } from '../index.js';

/** The plan metadata a receipt retains, or the live metadata for an older receipt. */
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

/** Snapshots take precedence, including an explicit unavailable snapshot; older receipts use exact Project and plan keys. */
const receiptPlanRows = read<[receipts: string, project: string], { receipt_id: string; item_id: string; title: string | null; session_id: string | null; content_hash: string | null; unavailable: number }>({
  name: 'servedPlans.ofReceipts',
  sql: `SELECT json_extract(w.value,'$.receiptId') AS receipt_id,item.value AS item_id,
      CASE WHEN s.item_id IS NOT NULL THEN s.title ELSE p.title END AS title,
      CASE WHEN s.item_id IS NOT NULL THEN s.session_id ELSE p.session_id END AS session_id,
      CASE WHEN s.item_id IS NOT NULL THEN s.content_hash ELSE p.content_hash END AS content_hash,
      CASE WHEN s.item_id IS NOT NULL THEN s.unavailable ELSE p.plan_key IS NULL END AS unavailable
    FROM json_each(?1) w CROSS JOIN json_each(json_extract(w.value,'$.planIds')) item
    LEFT JOIN injection_served_items s ON s.project_id=?2 AND s.receipt_id=json_extract(w.value,'$.receiptId')
      AND s.kind='plan' AND s.item_id=item.value
    LEFT JOIN plans p ON s.item_id IS NULL AND p.project_id=?2 AND p.plan_key=item.value
    WHERE s.item_id IS NOT NULL OR p.plan_key IS NOT NULL
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
