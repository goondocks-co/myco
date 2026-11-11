import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet } from '../index.js';

/** A machine capture recency will show: its claim, the member it belongs to, and the name a labelless claim carries. */
interface ShownMachineOwner {
  machine_id: string;
  member_id: string;
  label: string | null;
  member_label: string | null;
  /** The newest live credential's label. Null when the claim already names the machine, or no live credential does. */
  carried_label: string | null;
}

/**
 * The claim and member of each machine, and, when the claim has no label, the label its newest live credential carries.
 * `machines` is a JSON array of machine ids. Each id is a primary-key lookup; the credential seek follows that machine's
 * issue order and stops at the first live label.
 */
const shown = read<[now: number, machines: string], ShownMachineOwner>({ name: 'capture.shownMachineOwners', sql:
  `SELECT mc.machine_id, mc.member_id, mc.label, m.label AS member_label,
      CASE WHEN mc.label IS NOT NULL THEN NULL ELSE (
        SELECT c.runtime_label FROM member_credentials c INDEXED BY idx_member_credentials_machine
          WHERE c.machine_id = mc.machine_id AND c.revoked_at IS NULL AND c.expires_at > ?1
            AND c.runtime_label IS NOT NULL
          ORDER BY c.issued_at DESC, c.id DESC LIMIT 1) END AS carried_label
    FROM json_each(?2) asked
    CROSS JOIN machine_claims mc ON mc.machine_id = asked.value
    CROSS JOIN members m ON m.id = mc.member_id` });

/** The owners of the machines a capture-recency answer names. An empty list reads nothing. */
export async function shownMachineOwners(db: RelationalStore, nowMs: number, machineIds: readonly string[]): Promise<ShownMachineOwner[]> {
  if (machineIds.length === 0) return [];
  const [rows] = await readSet(db, shown.bind(nowMs, JSON.stringify(machineIds)));
  return rows;
}
