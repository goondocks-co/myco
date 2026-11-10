import type { RelationalStore } from '../../core/adapters.js';
import { injectionReceiptWrite, type ContextAdmission } from '../context-records.js';
import { commitNamed } from '../index.js';
import { planSnapshots, type PlanSnapshot } from './served-plans.js';

/** What one prompt's receipt records: the prompt it names, and the spores and plans the rendered block served. */
export interface ServedReceipt {
  project: string;
  session: string;
  id: string;
  promptId: string | null;
  scopeReason: string | null;
  protocol: string;
  askedAt: number | null;
  promptHash: string;
  spores: readonly string[];
  plans: readonly PlanSnapshot[];
  now: number;
}

/**
 * Writes a prompt's receipt and each served plan's snapshot in one commit; the receipt's insert adds what it served to
 * its session. The snapshots are conditional on the receipt row, so a receipt held back writes nothing. Answers whether
 * the receipt was written.
 */
export async function commitServedReceipt(db: RelationalStore, receipt: ServedReceipt, admission: ContextAdmission): Promise<boolean> {
  const { written } = await commitNamed(db, {
    written: injectionReceiptWrite({ ...receipt, plans: receipt.plans.map(plan => plan.planKey) }, admission),
    snapshots: planSnapshots({ project: receipt.project, session: receipt.session, receipt: receipt.id, plans: receipt.plans }),
  });
  return written.results.length === 1;
}
