import type { RelationalStore } from '../../core/adapters.js';
import { contextAdmissionSql } from '../context-records.js';
import { commitNamed, write } from '../index.js';

const discard = write<[project: string, session: string, receipt: string, now: number, machine: string | null], { id: string }>({
  name: 'context.discard',
  sql: `UPDATE spore_injections SET discarded_at=?4 WHERE project_id=?1 AND session_id=?2 AND id=?3
    AND delivered_at IS NULL AND discarded_at IS NULL
    AND ${contextAdmissionSql({ project: '?1', session: '?2', machine: '?5' })} RETURNING id`,
});

/** A member releases only its own undelivered selection; replay and a delivered receipt change nothing. */
export async function discardContextReceipt(db: RelationalStore, input: { project: string; session: string; receipt: string; now: number; machine: string | null }): Promise<void> {
  await commitNamed(db, { discarded: discard.bind(input.project, input.session, input.receipt, input.now, input.machine) });
}
