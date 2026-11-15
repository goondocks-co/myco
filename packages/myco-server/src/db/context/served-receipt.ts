import type { RelationalStore } from '../../core/adapters.js';
import { type ContextAdmission } from '../context-records.js';
import { commitNamed, write } from '../index.js';
import { CONTEXT_RESERVATION_MS, excludedCandidate } from './served-items.js';
import { planSnapshots, type PlanSnapshot } from './served-plans.js';

/** A prompt's selection receipt and retained plan snapshots. */
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

/** Reserve a selection and retain its receipt and plan snapshots under the same atomic admission. */
export async function commitServedReceipt(db: RelationalStore, receipt: ServedReceipt, admission: ContextAdmission): Promise<boolean> {
  if ([receipt.askedAt, receipt.now].some(value => value !== null && !Number.isSafeInteger(value))) throw new Error('material_integer_invalid');
  const { written } = await commitNamed(db, {
    written: receiptWrite.bind(receipt.project, receipt.session, receipt.id, receipt.promptId, receipt.scopeReason,
      receipt.protocol, receipt.askedAt, receipt.promptHash, JSON.stringify(receipt.spores), JSON.stringify(receipt.plans.map(plan => plan.planKey)),
      receipt.now, admission.params[4], JSON.stringify([...receipt.spores.map(id => ['spore', id]), ...receipt.plans.map(plan => ['plan', plan.planKey])])),
    snapshots: planSnapshots({ project: receipt.project, session: receipt.session, receipt: receipt.id, plans: receipt.plans }),
  });
  return written.results.length === 1;
}

const receiptWrite = write<[project: string, session: string, id: string, prompt: string | null, reason: string | null,
  protocol: string, askedAt: number | null, hash: string, spores: string, plans: string, now: number, machine: string | null, candidates: string], { id: string }>({
  name: 'context.injectionReceipt',
  sql: `INSERT OR IGNORE INTO spore_injections(project_id,session_id,id,prompt_id,scope_reason,ask_protocol,asked_at,prompt_hash,spore_ids,plan_ids,created_at)
    SELECT ?1,?2,?3,?4,?5,?6,CAST(?7 AS INTEGER),?8,?9,?10,CAST(?11 AS INTEGER)
    WHERE NOT EXISTS(SELECT 1 FROM sessions r WHERE r.project_id=?1 AND r.session_id=?2 AND r.machine_id IS NOT ?12)
      AND NOT EXISTS(SELECT 1 FROM session_tombstones WHERE project_id=?1 AND session_id=?2)
      AND NOT EXISTS(SELECT 1 FROM spore_injections WHERE project_id=?1 AND session_id=?2 AND prompt_id=?4)
      AND NOT EXISTS(SELECT 1 FROM spore_injections WHERE project_id=?1 AND session_id=?2 AND prompt_hash=?8 AND (delivered_at IS NOT NULL OR created_at>?11-${CONTEXT_RESERVATION_MS}))
      AND NOT EXISTS(${excludedCandidate({ project: '?1', session: '?2', candidates: '?13', now: '?11' })}) RETURNING id`,
});
