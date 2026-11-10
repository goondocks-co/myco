import type { RelationalStore } from '../../core/adapters.js';
import { commit, first, read, rows, write } from '../index.js';

/** The machine's claimant is still the actor and still a live member: a claim revoked mid-request never writes. */
const claimedBy = (machine: string, member: string): string => `EXISTS (SELECT 1 FROM machine_claims claim JOIN members member ON member.id = claim.member_id
  WHERE claim.machine_id = ${machine} AND claim.member_id = ${member} AND member.revoked_at IS NULL)`;

export interface MachineSettingRow {
  leaf: string | null; value: string | null; updated_at: number | null; updated_by: string | null;
  settings_revision: number; settings_cached_revision: string | null; settings_cached_values: string | null; settings_contract_supported: number;
}

const claimant = read<[machine: string], { member_id: string }>({ name: 'machineSettings.claimant', sql: 'SELECT member_id FROM machine_claims WHERE machine_id=?1' });
const claimed = read<[machine: string, member: string], { held: number }>({ name: 'machineSettings.claimed', sql: 'SELECT 1 AS held FROM machine_claims WHERE machine_id=?1 AND member_id=?2' });
const all = read<[machine: string], MachineSettingRow>({ name: 'machineSettings.read', sql: `SELECT s.leaf,s.value,s.updated_at,s.updated_by,c.settings_revision,c.settings_cached_revision,c.settings_cached_values,c.settings_contract_supported
  FROM machine_claims c LEFT JOIN machine_settings s ON s.machine_id=c.machine_id WHERE c.machine_id=?1` });
const leafRow = read<[machine: string, leaf: string], { value: string }>({ name: 'machineSettings.leaf', sql: 'SELECT value FROM machine_settings WHERE machine_id=?1 AND leaf=?2' });

export const readClaimant = (db: RelationalStore, machine: string) => first(db, claimant.bind(machine));
export const readMachineClaimed = async (db: RelationalStore, machine: string, member: string) => (await first(db, claimed.bind(machine, member))) !== null;
export const readMachineRows = (db: RelationalStore, machine: string) => rows(db, all.bind(machine));
export const readMachineLeaf = (db: RelationalStore, machine: string, leaf: string) => first(db, leafRow.bind(machine, leaf));

const put = write<[machine: string, leaf: string, value: string, now: number, actor: string], { machine_id: string }>({ name: 'machineSettings.put', sql: `INSERT INTO machine_settings(machine_id,leaf,value,updated_at,updated_by)
  SELECT ?1,?2,?3,?4,?5 WHERE ${claimedBy('?1', '?5')}
  ON CONFLICT(machine_id,leaf) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by=excluded.updated_by RETURNING machine_id` });

export async function putMachineLeaf(db: RelationalStore, input: { machine: string; leaf: string; value: string; actor: string; now: number }): Promise<boolean> {
  return (await first(db, put.bind(input.machine, input.leaf, input.value, input.now, input.actor))) !== null;
}

/** Whether the leaf still holds exactly the text the repair read. */
const held = (machine: string, leaf: string, text: string) => `EXISTS (SELECT 1 FROM machine_settings WHERE machine_id=${machine} AND leaf=${leaf} AND value=${text})`;
const bumpRevision = write<[machine: string, leaf: string, actor: string], { machine_id: string }>({ name: 'machineSettings.bumpOnReset', sql: `UPDATE machine_claims SET settings_revision=settings_revision+CASE WHEN EXISTS(SELECT 1 FROM machine_settings WHERE machine_id=?1 AND leaf=?2) THEN 0 ELSE 1 END
  WHERE machine_id=?1 AND ${claimedBy('?1', '?3')} RETURNING machine_id` });
const bumpRepaired = write<[machine: string, leaf: string, actor: string, invalid: string], { machine_id: string }>({ name: 'machineSettings.bumpOnRepair', sql: `UPDATE machine_claims SET settings_revision=settings_revision+CASE WHEN EXISTS(SELECT 1 FROM machine_settings WHERE machine_id=?1 AND leaf=?2) THEN 0 ELSE 1 END
  WHERE machine_id=?1 AND ${claimedBy('?1', '?3')} AND ${held('?1', '?2', '?4')} RETURNING machine_id` });
const remove = write<[machine: string, leaf: string, actor: string]>({ name: 'machineSettings.remove', sql: `DELETE FROM machine_settings WHERE machine_id=?1 AND leaf=?2 AND ${claimedBy('?1', '?3')}` });
const removeInvalid = write<[machine: string, leaf: string, actor: string, invalid: string]>({ name: 'machineSettings.removeInvalid', sql: `DELETE FROM machine_settings WHERE machine_id=?1 AND leaf=?2 AND ${claimedBy('?1', '?3')} AND ${held('?1', '?2', '?4')}` });
const repair = write<[machine: string, leaf: string, actor: string, invalid: string, value: string, now: number]>({ name: 'machineSettings.repair', sql: `UPDATE machine_settings SET value=?5,updated_at=?6,updated_by=?3 WHERE machine_id=?1 AND leaf=?2 AND ${claimedBy('?1', '?3')} AND ${held('?1', '?2', '?4')}` });

/** Clear a leaf. Answers whether the claim still stood when the revision moved. */
export async function clearMachineLeaf(db: RelationalStore, input: { machine: string; leaf: string; actor: string }): Promise<boolean> {
  const [claim] = await commit(db, bumpRevision.bind(input.machine, input.leaf, input.actor), remove.bind(input.machine, input.leaf, input.actor));
  return claim.results.length === 1;
}

/**
 * Clear or repair a server-written document, only while it still holds the invalid text this repair read. `stale` is a
 * claim that stands over a document another write has changed; `absent` is a claim that no longer stands.
 */
export async function repairMachineLeaf(db: RelationalStore, input: { machine: string; leaf: string; actor: string; invalid: string; repaired: string | null; now: number }): Promise<'landed' | 'stale' | 'absent'> {
  const { machine, leaf, actor, invalid, repaired, now } = input;
  const [landed, , claim] = await commit(db, bumpRepaired.bind(machine, leaf, actor, invalid),
    repaired === null ? removeInvalid.bind(machine, leaf, actor, invalid) : repair.bind(machine, leaf, actor, invalid, repaired, now),
    stillClaimed.bind(machine, actor));
  if (landed.results.length === 1) return 'landed';
  return claim.results.length === 1 ? 'stale' : 'absent';
}

const stillClaimed = read<[machine: string, actor: string], { held: number }>({ name: 'machineSettings.stillClaimed', sql: `SELECT 1 AS held WHERE ${claimedBy('?1', '?2')}` });

const noteContract = write<[machine: string, member: string]>({ name: 'machineSettings.noteContract', sql: 'UPDATE machine_claims SET settings_contract_supported=1 WHERE machine_id=?1 AND member_id=?2' });
export const noteMachineContract = (db: RelationalStore, machine: string, member: string) => commit(db, noteContract.bind(machine, member));

const dropSnapshots = write<[machine: string, member: string, order: number]>({ name: 'machineSettings.dropSnapshots', sql: `DELETE FROM machine_settings_snapshots WHERE machine_id=?1
  AND EXISTS (SELECT 1 FROM machine_claims WHERE machine_id=?1 AND member_id=?2 AND settings_report_order<?3)` });
const clearCache = write<[machine: string, member: string, order: number]>({ name: 'machineSettings.clearCache', sql: `UPDATE machine_claims SET settings_cached_revision=NULL,settings_cached_values=NULL,settings_report_order=?3
  WHERE machine_id=?1 AND member_id=?2 AND settings_report_order<?3` });

/** A machine reported its cache gone: forget what it holds and what it applied, in report order. */
export const invalidateMachineCache = (db: RelationalStore, input: { machine: string; member: string; order: number }) =>
  commit(db, dropSnapshots.bind(input.machine, input.member, input.order), clearCache.bind(input.machine, input.member, input.order));

const acknowledge = write<[machine: string, member: string, revision: string, order: number]>({ name: 'machineSettings.acknowledge', sql: `WITH reported AS (
    SELECT COALESCE((SELECT leaves FROM machine_settings_snapshots WHERE machine_id=?1 AND revision=?3),
      CASE WHEN settings_cached_revision=?3 THEN settings_cached_values ELSE NULL END) AS leaves
    FROM machine_claims WHERE machine_id=?1 AND member_id=?2)
  UPDATE machine_claims SET settings_cached_revision=CASE WHEN (SELECT leaves FROM reported) IS NULL THEN NULL ELSE ?3 END,
    settings_cached_values=(SELECT leaves FROM reported),settings_report_order=?4
  WHERE machine_id=?1 AND member_id=?2 AND (settings_report_order<?4 OR (settings_report_order=?4 AND settings_cached_revision=?3))` });
export const acknowledgeMachineRevision = (db: RelationalStore, input: { machine: string; member: string; revision: string; order: number }) =>
  commit(db, acknowledge.bind(input.machine, input.member, input.revision, input.order));

const publish = write<[machine: string, revision: string, leaves: string, member: string, counter: number], { machine_id: string }>({ name: 'machineSettings.publish', sql: `INSERT INTO machine_settings_snapshots(machine_id,revision,leaves,sent_order)
  SELECT ?1,?2,?3,COALESCE((SELECT MAX(sent_order) FROM machine_settings_snapshots WHERE machine_id=?1),0)+1
    WHERE EXISTS (SELECT 1 FROM machine_claims WHERE machine_id=?1 AND member_id=?4 AND settings_revision=?5)
  ON CONFLICT(machine_id,revision) DO UPDATE SET leaves=excluded.leaves,sent_order=excluded.sent_order RETURNING machine_id` });
const trim = write<[machine: string, keep: number, member: string]>({ name: 'machineSettings.trim', sql: `DELETE FROM machine_settings_snapshots WHERE machine_id=?1 AND revision NOT IN (
    SELECT revision FROM machine_settings_snapshots WHERE machine_id=?1 ORDER BY sent_order DESC LIMIT ?2)
  AND EXISTS (SELECT 1 FROM machine_claims WHERE machine_id=?1 AND member_id=?3)` });

/** Record what a machine is about to be sent; false when the revision moved under it, so nothing is published. */
export async function publishMachineSnapshot(db: RelationalStore, input: { machine: string; member: string; revision: string; leaves: string; counter: number; keep: number }): Promise<boolean> {
  const { machine, member, revision, leaves, counter, keep } = input;
  const [sent] = await commit(db, publish.bind(machine, revision, leaves, member, counter), trim.bind(machine, keep, member));
  return sent.results.length === 1;
}

const insertRoots = write<[machine: string, leaf: string, value: string, now: number, actor: string], { machine_id: string }>({ name: 'machineSettings.insertRoots', sql: `INSERT INTO machine_settings(machine_id,leaf,value,updated_at,updated_by)
  SELECT ?1,?2,?3,?4,?5 WHERE ${claimedBy('?1', '?5')} AND NOT EXISTS (SELECT 1 FROM machine_settings WHERE machine_id=?1 AND leaf=?2) RETURNING machine_id` });
const updateRoots = write<[machine: string, leaf: string, value: string, now: number, actor: string, previous: string], { machine_id: string }>({ name: 'machineSettings.updateRoots', sql: `UPDATE machine_settings SET value=?3,updated_at=?4,updated_by=?5
  WHERE machine_id=?1 AND leaf=?2 AND value IS ?6 AND ${claimedBy('?1', '?5')} RETURNING machine_id` });

/** Replace the roots document only if it still holds the text the edit read; a RETURNING row, not a count, says it landed. */
export async function writeMachineRoots(db: RelationalStore, input: { machine: string; leaf: string; value: string; actor: string; now: number; previous: string | null }): Promise<boolean> {
  const { machine, leaf, value, actor, now, previous } = input;
  const written = previous === null ? insertRoots.bind(machine, leaf, value, now, actor) : updateRoots.bind(machine, leaf, value, now, actor, previous);
  return (await first(db, written)) !== null;
}
