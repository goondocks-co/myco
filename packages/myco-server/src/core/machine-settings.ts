/**
 * Settings one machine holds: one set per machine identity, edited on the dashboard and read by that machine (#1393).
 *
 * The one member who may read or change a machine's settings is the member the machine joined as
 * (`machine_claims.member_id`). An admin is not: the settings name folders on that member's own machine, which no
 * other member reaches. A machine receives its own set on its session start (`machineBlockFor`), and on nothing it
 * does not claim. A leaf at its default holds no row, so setting the default is how a leaf is reset.
 */
import type { RelationalStore } from './adapters.js';
import { leafRuleViolation, type LeafSpec } from './settings.js';

/** The leaf a machine uses to find its agents' plans beyond the folders each agent's manifest names. */
export const PLAN_DIRS_LEAF = 'capture.plan_dirs';

/** Every leaf a machine holds, with its rule and its default. */
export const MACHINE_LEAF_SPECS: Readonly<Record<string, { spec: LeafSpec; default: unknown }>> = {
  [PLAN_DIRS_LEAF]: { spec: { type: 'path-list', maxItems: 16, maxChars: 256 }, default: [] },
};

export const MACHINE_LEAVES: readonly string[] = Object.keys(MACHINE_LEAF_SPECS);

/** One machine leaf as the dashboard reads it. */
export interface MachineLeaf {
  leaf: string;
  configured: boolean;
  value: unknown;
  updatedAt: number | null;
  updatedBy: string | null;
}

/** Whether the member `actorId` may read and change `machineId`'s settings, which only the member claiming it may: absent when no member claims it. */
export async function machineAccess(db: RelationalStore, actorId: string, machineId: string): Promise<'absent' | 'forbidden' | 'allowed'> {
  const claim = await db.prepare(`SELECT member_id FROM machine_claims WHERE machine_id = ?`).bind(machineId).first<{ member_id: string }>();
  if (claim === null) return 'absent';
  return claim.member_id === actorId ? 'allowed' : 'forbidden';
}

/** Every machine leaf, configured or at its default. */
export async function readMachineSettings(db: RelationalStore, machineId: string): Promise<MachineLeaf[]> {
  const { results } = await db.prepare(`SELECT leaf, value, updated_at, updated_by FROM machine_settings WHERE machine_id = ?`)
    .bind(machineId).all<{ leaf: string; value: string; updated_at: number; updated_by: string }>();
  const stored = new Map((results ?? []).map((row) => [row.leaf, row]));
  return MACHINE_LEAVES.map((leaf) => {
    const row = stored.get(leaf);
    return row === undefined
      ? { leaf, configured: false, value: MACHINE_LEAF_SPECS[leaf]!.default, updatedAt: null, updatedBy: null }
      : { leaf, configured: true, value: JSON.parse(row.value) as unknown, updatedAt: Number(row.updated_at), updatedBy: row.updated_by };
  });
}

export type MachineWrite = { applied: true } | { applied: false; reason: 'unknown_leaf' | 'invalid_value' | 'absent'; detail?: string };

/**
 * Set one leaf of the machine `actor` claims. The default removes the row. Both writes are conditioned on that claim
 * in the same statement, so a machine the actor does not claim, or no longer claims, is left as it is.
 */
export async function setMachineLeaf(db: RelationalStore, machineId: string, leaf: string, value: unknown, actor: string, now: number): Promise<MachineWrite> {
  const declared = MACHINE_LEAF_SPECS[leaf];
  if (declared === undefined) return { applied: false, reason: 'unknown_leaf' };
  const violation = leafRuleViolation(declared.spec, value);
  if (violation !== null) return { applied: false, reason: 'invalid_value', detail: violation };
  if (JSON.stringify(value) === JSON.stringify(declared.default)) {
    await db.prepare(`DELETE FROM machine_settings WHERE machine_id = ? AND leaf = ? AND EXISTS (SELECT 1 FROM machine_claims WHERE machine_id = ? AND member_id = ?)`)
      .bind(machineId, leaf, machineId, actor).run();
    return { applied: true };
  }
  const written = await db.prepare(
    `INSERT INTO machine_settings (machine_id, leaf, value, updated_at, updated_by)
       SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM machine_claims WHERE machine_id = ? AND member_id = ?)
       ON CONFLICT (machine_id, leaf) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).bind(machineId, leaf, JSON.stringify(value), now, actor, machineId, actor).run();
  return written.meta.changes === 1 ? { applied: true } : { applied: false, reason: 'absent' };
}

/**
 * The settings a machine is answered with: its own leaves, keyed by leaf, when the member asking claims the machine,
 * and null for any other: a credential that joined no machine (a run's) is told nothing about any.
 */
export async function machineBlockFor(db: RelationalStore, memberId: string, machineId: string): Promise<{ leaves: Record<string, unknown> } | null> {
  const claimed = await db.prepare(`SELECT 1 AS held FROM machine_claims WHERE machine_id = ? AND member_id = ?`).bind(machineId, memberId).first<{ held: number }>();
  if (claimed === null) return null;
  const leaves = await readMachineSettings(db, machineId);
  return { leaves: Object.fromEntries(leaves.map((l) => [l.leaf, l.value])) };
}
