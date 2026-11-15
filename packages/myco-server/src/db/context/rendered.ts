import type { RelationalStore } from '../../core/adapters.js';
import { contextAdmissionSql } from '../context-records.js';
import { commit, write } from '../index.js';
import { receiptExclusions } from './served-items.js';

const rendered = write<[project: string, session: string, receipts: string, machine: string | null]>({
  name: 'context.renderedReceipts',
  sql: receiptExclusions(`SELECT r.project_id,r.session_id,r.id FROM json_each(?3) j CROSS JOIN spore_injections r
    ON r.project_id=?1 AND r.session_id=?2 AND r.id=j.value
    WHERE ${contextAdmissionSql({ project: '?1', session: '?2', machine: '?4' })}`, { delivered: true }),
});

/** A member's rendered receipts exclude their items while its delivery events await acknowledgment. */
export async function retainRenderedReceipts(db: RelationalStore, input: { project: string; session: string; receipts: readonly string[]; machine: string | null }): Promise<void> {
  if (input.receipts.length > 0) await commit(db, rendered.bind(input.project, input.session, JSON.stringify(input.receipts), input.machine));
}
