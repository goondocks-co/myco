import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet } from '../index.js';

interface OwnMachineName { machine_id: string; name: string | null }

const SELECT = `SELECT mc.machine_id, COALESCE(mc.label, (
      SELECT c.runtime_label FROM member_credentials c
        WHERE c.machine_id = mc.machine_id AND c.member_id = mc.member_id AND c.revoked_at IS NULL
          AND c.expires_at > ?1 AND c.runtime_label IS NOT NULL ORDER BY c.issued_at DESC, c.id DESC LIMIT 1)) AS name
    FROM machine_claims mc WHERE mc.member_id = ?2`;
const all = read<[now: number, member: string], OwnMachineName>({ name: 'capture.ownMachineNames', sql: SELECT });
const named = read<[now: number, member: string, machines: string], OwnMachineName>({ name: 'capture.ownMachineNamesFor', sql:
  `${SELECT} AND mc.machine_id IN (SELECT value FROM json_each(?3))` });

/** Each claimed machine of `member` with its label, else the label its newest live credential carries; restricted to `machineIds` when given. */
export async function ownMachineLabels(db: RelationalStore, member: string, now: number, machineIds?: readonly string[]): Promise<OwnMachineName[]> {
  const [rows] = await readSet(db, machineIds === undefined ? all.bind(now, member) : named.bind(now, member, JSON.stringify(machineIds)));
  return rows;
}
