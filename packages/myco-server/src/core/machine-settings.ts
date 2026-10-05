/**
 * Settings one machine holds: one set per machine identity, edited on the dashboard and read by that machine (#1393).
 *
 * The one member who may read or change a machine's settings is the member the machine joined as
 * (`machine_claims.member_id`). An admin is not: the settings name folders on that member's own machine, which no
 * other member reaches. A machine receives its own set on its session start (`machineBlockFor`), and on nothing it
 * does not claim. A leaf at its default holds no row, so setting the default is how a leaf is reset.
 */
import { MACHINE_SETTING_SPECS, MACHINE_SETTINGS_FEATURE, isMachineSettingsRevision, parseMachineSettingsRevision, resolveMachineSetting, type MachineSettingLeaf } from '@goondocks/myco-shared/member-protocol';
import { DEPLOYMENT_TARGETS, type EffectiveSetting, type SettingSource } from '@goondocks/myco-shared/settings-contract';
import { sha256Hex } from '../hash.js';
import type { RelationalStore } from './adapters.js';
import { leafRuleViolation, type LeafSpec } from './settings.js';

/** The leaf a machine uses to find its agents' plans beyond the folders each agent's manifest names. */
export const PLAN_DIRS_LEAF = 'capture.plan_dirs';

/** The folders a machine captures repositories under without being asked: a repository beneath one joins by itself. */
export const AUTO_JOIN_ROOTS_LEAF = 'capture.auto_join_roots';
/**
 * The repositories a machine is told to connect from "Needs you", by key: each names the project it joins, or `''` for
 * the project it resolves by its remote or creates. Written by the connect, read by the machine's next hook there.
 */
export const CONNECT_ROOTS_LEAF = 'capture.connect_roots';

/** Every leaf a machine holds, with its rule and its default; `serverWritten` leaves are written by the Deployment alone, never set on the dashboard. */
export const MACHINE_LEAF_SPECS: Readonly<Record<string, { spec: LeafSpec; default: unknown; serverWritten?: true }>> = Object.fromEntries(
  Object.entries(MACHINE_SETTING_SPECS).map(([leaf, declaration]) => {
    const { default: defaultValue, ...spec } = declaration;
    return [leaf, { spec, default: defaultValue, ...('serverWritten' in declaration ? { serverWritten: true as const } : {}) }];
  }),
);

export const MACHINE_LEAVES: readonly string[] = Object.keys(MACHINE_LEAF_SPECS);
const MACHINE_SETTINGS_SNAPSHOT_ATTEMPTS = 3;
export const MACHINE_SETTINGS_SNAPSHOT_LIMIT = 5;

/** One machine leaf as the dashboard reads it. */
export interface MachineLeaf extends EffectiveSetting {
  leaf: string;
  configured: boolean;
  value: unknown;
  updatedAt: number | null;
  updatedBy: string | null;
  application: 'applied' | 'pending' | 'unreported';
  appliedRevision: string | null;
  appliedValue: unknown;
  nextEffective: unknown;
  nextSource: SettingSource;
}

/** Whether the member `actorId` may read and change `machineId`'s settings, which only the member claiming it may: absent when no member claims it. */
export async function machineAccess(db: RelationalStore, actorId: string, machineId: string): Promise<'absent' | 'forbidden' | 'allowed'> {
  const claim = await db.prepare(`SELECT member_id FROM machine_claims WHERE machine_id = ?`).bind(machineId).first<{ member_id: string }>();
  if (claim === null) return 'absent';
  return claim.member_id === actorId ? 'allowed' : 'forbidden';
}

interface MachineSettingRow {
  leaf: string | null; value: string | null; updated_at: number | null; updated_by: string | null;
  settings_revision: number; settings_cached_revision: string | null; settings_cached_values: string | null; settings_contract_supported: number;
}

/** Stored values and the revision their member last confirmed, read in one database snapshot. */
export async function readMachineSettings(db: RelationalStore, machineId: string): Promise<MachineLeaf[]> {
  const { results } = await db.prepare(
    `SELECT s.leaf, s.value, s.updated_at, s.updated_by, c.settings_revision, c.settings_cached_revision, c.settings_cached_values, c.settings_contract_supported
       FROM machine_claims c LEFT JOIN machine_settings s ON s.machine_id = c.machine_id WHERE c.machine_id = ?`,
  ).bind(machineId).all<MachineSettingRow>();
  const stored = new Map((results ?? []).filter((row) => row.leaf !== null).map((row) => [row.leaf, row]));
  const claim = results?.[0];
  const resolvedSettings = MACHINE_LEAVES.map((leaf) => {
    const row = stored.get(leaf);
    const declared = MACHINE_LEAF_SPECS[leaf]!;
    let value: unknown = declared.default;
    let malformed = false;
    if (row !== undefined) {
      try { value = JSON.parse(row.value!) as unknown; }
      catch { value = row.value; malformed = true; }
    }
    const resolved = resolveMachineSetting(leaf as MachineSettingLeaf, malformed ? undefined : value);
    const violation = row === undefined ? null : malformed ? 'The stored value cannot be read.' : leafRuleViolation(declared.spec, value);
    const invalid = violation !== null;
    const nextSource: SettingSource = invalid ? 'invalid' : row === undefined ? 'default' : 'configured';
    const clearReason = declared.serverWritten === true ? 'Remove entries that no longer apply. Valid connections are kept.' : 'Clear the stored value to restore the default.';
    return { leaf, row, declared, value, resolved, violation, invalid, nextSource, clearReason };
  });
  const resolvedLeaves = Object.fromEntries(resolvedSettings.map(({ leaf, resolved }) => [leaf, resolved.effective]));
  const revision = `m${Number(claim?.settings_revision ?? 0)}-${await sha256Hex(JSON.stringify(resolvedLeaves))}`;
  const supported = claim?.settings_contract_supported === 1;
  const appliedRevision = supported ? claim?.settings_cached_revision ?? null : null;
  const appliedValues = !supported || claim?.settings_cached_values === null || claim?.settings_cached_values === undefined ? null : JSON.parse(claim.settings_cached_values) as Record<string, unknown>;
  const application = appliedRevision === null ? 'unreported' : appliedRevision === revision ? 'applied' : 'pending';
  const applicationReason = application === 'applied' ? 'Applied by this machine.' : application === 'pending' ? 'Saved. Applies at the next session start.' : supported ? 'Applies at the next session start. This machine’s current cached settings are not confirmed.' : 'Applies at the next session start. This machine’s Myco doesn’t report when it applied.';
  return resolvedSettings.map(({ leaf, row, value, resolved, violation, invalid, nextSource, clearReason }) => {
    return {
      leaf, configured: row !== undefined, value, updatedAt: row?.updated_at === undefined ? null : Number(row.updated_at), updatedBy: row?.updated_by ?? null,
      stored: row === undefined ? null : value, effective: appliedValues?.[leaf] ?? null, nextEffective: resolved.effective, nextSource,
      source: application === 'unreported' ? 'unset' : application === 'pending' ? 'member-cache' : nextSource,
      state: invalid ? 'invalid' : application === 'applied' ? 'active' : 'inactive', storedApplies: row === undefined ? null : !invalid && application === 'applied',
      reason: invalid ? `${(resolved.refusal ?? violation ?? 'The stored value does not apply').replace(/[.!?]$/, '')}. The next session uses the valid entries or the default. ${clearReason} ${applicationReason}` : applicationReason,
      appliesTo: DEPLOYMENT_TARGETS, revision, application, appliedRevision,
      appliedValue: appliedValues?.[leaf] ?? null,
    };
  });
}

export type MachineWrite = { applied: true } | { applied: false; reason: 'unknown_leaf' | 'invalid_value' | 'absent'; detail?: string };

/**
 * Set one leaf of the machine `actor` claims. The default removes the row. Both writes are conditioned on that claim
 * in the same statement, so a machine the actor does not claim, or no longer claims, is left as it is.
 */
export async function setMachineLeaf(db: RelationalStore, machineId: string, leaf: string, value: unknown, actor: string, now: number): Promise<MachineWrite> {
  const declared = MACHINE_LEAF_SPECS[leaf];
  // A leaf the Deployment writes is not set from the dashboard: connecting a repository goes through its own route.
  if (declared === undefined || declared.serverWritten === true) return { applied: false, reason: 'unknown_leaf' };
  const violation = leafRuleViolation(declared.spec, value);
  if (violation !== null) return { applied: false, reason: 'invalid_value', detail: violation };
  if (JSON.stringify(value) === JSON.stringify(declared.default)) return resetMachineLeaf(db, machineId, leaf, actor, now);

  const written = await db.prepare(
    `INSERT INTO machine_settings (machine_id, leaf, value, updated_at, updated_by)
       SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM machine_claims WHERE machine_id = ? AND member_id = ?)
       ON CONFLICT (machine_id, leaf) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).bind(machineId, leaf, JSON.stringify(value), now, actor, machineId, actor).run();
  return written.meta.changes > 0 ? { applied: true } : { applied: false, reason: 'absent' };
}

/** Clear a claimant's stored value; a connection repair retains every usable assignment and refuses a valid document. */
export async function resetMachineLeaf(db: RelationalStore, machineId: string, leaf: string, actor: string, now: number): Promise<MachineWrite> {
  const declaration = MACHINE_LEAF_SPECS[leaf];
  if (declaration === undefined) return { applied: false, reason: 'unknown_leaf' };
  let invalidDocument: string | null = null;
  let repairedConnections: string | null = null;
  if (declaration.serverWritten === true) {
    const row = await db.prepare(`SELECT value FROM machine_settings WHERE machine_id = ? AND leaf = ?`).bind(machineId, leaf).first<{ value: string }>();
    if (row === null) return { applied: false, reason: 'unknown_leaf' };
    let parsed = true;
    let value: unknown;
    try { value = JSON.parse(row.value); }
    catch { parsed = false; }
    const invalid = !parsed || leafRuleViolation(declaration.spec, value) !== null;
    if (!invalid) return { applied: false, reason: 'unknown_leaf' };
    invalidDocument = row.value;
    const usable = resolveMachineSetting(leaf as MachineSettingLeaf, value).effective as Record<string, string>;
    if (Object.keys(usable).length > 0) repairedConnections = JSON.stringify(usable);
  }
  const documentGuard = invalidDocument === null ? '' : ' AND EXISTS (SELECT 1 FROM machine_settings WHERE machine_id = ? AND leaf = ? AND value = ?)';
  const guardedValue = invalidDocument === null ? [] : [machineId, leaf, invalidDocument];
  const removeOrRepair = repairedConnections === null
    ? db.prepare(`DELETE FROM machine_settings WHERE machine_id = ? AND leaf = ? AND EXISTS (SELECT 1 FROM machine_claims WHERE machine_id = ? AND member_id = ?)${documentGuard}`).bind(machineId, leaf, machineId, actor, ...guardedValue)
    : db.prepare(`UPDATE machine_settings SET value = ?, updated_at = ?, updated_by = ? WHERE machine_id = ? AND leaf = ? AND EXISTS (SELECT 1 FROM machine_claims WHERE machine_id = ? AND member_id = ?)${documentGuard}`).bind(repairedConnections, now, actor, machineId, leaf, machineId, actor, ...guardedValue);
  const [claim] = await db.batch([
    db.prepare(`UPDATE machine_claims SET settings_revision = settings_revision + CASE WHEN EXISTS (SELECT 1 FROM machine_settings WHERE machine_id = ? AND leaf = ?) THEN 0 ELSE 1 END WHERE machine_id = ? AND member_id = ?${documentGuard}`).bind(machineId, leaf, machineId, actor, ...guardedValue),
    removeOrRepair,
  ]);
  return claim!.meta.changes === 1 ? { applied: true } : { applied: false, reason: 'absent' };
}

/**
 * The settings a machine is answered with: its own leaves, keyed by leaf, when the member asking claims the machine,
 * and null for any other: a credential that joined no machine (a run's) is told nothing about any.
 */
export async function machineBlockFor(
  db: RelationalStore, memberId: string, machineId: string, support: { machineSettingsFeature?: boolean; machineSettingsRevision?: string; machineSettingsOrder?: number; machineSettingsInvalidated?: boolean } = {},
): Promise<{ leaves: Record<string, unknown>; feature?: typeof MACHINE_SETTINGS_FEATURE; revision?: string } | null> {
  const claimed = await db.prepare(`SELECT 1 AS held FROM machine_claims WHERE machine_id = ? AND member_id = ?`).bind(machineId, memberId).first<{ held: number }>();
  if (claimed === null) return null;
  if (support.machineSettingsFeature === true) {
    await db.prepare(`UPDATE machine_claims SET settings_contract_supported = 1 WHERE machine_id = ? AND member_id = ?`)
      .bind(machineId, memberId).run();
  }
  const reportOrder = support.machineSettingsOrder;
  const ordered = support.machineSettingsFeature === true && reportOrder !== undefined && Number.isSafeInteger(reportOrder) && reportOrder >= 0;
  if (ordered && support.machineSettingsInvalidated === true) {
    await db.batch([
      db.prepare(`DELETE FROM machine_settings_snapshots WHERE machine_id = ? AND EXISTS (
        SELECT 1 FROM machine_claims WHERE machine_id = ? AND member_id = ? AND settings_report_order < ?)
      `).bind(machineId, machineId, memberId, reportOrder),
      db.prepare(`UPDATE machine_claims SET settings_cached_revision = NULL, settings_cached_values = NULL, settings_report_order = ?
        WHERE machine_id = ? AND member_id = ? AND settings_report_order < ?
      `).bind(reportOrder, machineId, memberId, reportOrder),
    ]);
  } else if (ordered && isMachineSettingsRevision(support.machineSettingsRevision)) {
    const revision = support.machineSettingsRevision;
    await db.prepare(
      `WITH reported AS (
         SELECT COALESCE((SELECT leaves FROM machine_settings_snapshots WHERE machine_id = ? AND revision = ?),
           CASE WHEN settings_cached_revision = ? THEN settings_cached_values ELSE NULL END) AS leaves
           FROM machine_claims WHERE machine_id = ? AND member_id = ?)
       UPDATE machine_claims SET settings_cached_revision = CASE WHEN (SELECT leaves FROM reported) IS NULL THEN NULL ELSE ? END,
         settings_cached_values = (SELECT leaves FROM reported), settings_report_order = ?
        WHERE machine_id = ? AND member_id = ?
          AND (settings_report_order < ? OR (settings_report_order = ? AND settings_cached_revision = ?))`,
    ).bind(machineId, revision, revision, machineId, memberId, revision, reportOrder, machineId, memberId, reportOrder, reportOrder, revision).run();
  }
  for (let attempt = 0; attempt < MACHINE_SETTINGS_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const settings = await readMachineSettings(db, machineId);
    const leaves = Object.fromEntries(settings.map((leaf) => [leaf.leaf, leaf.nextEffective]));
    if (support.machineSettingsFeature !== true) return { leaves };
    const revision = settings[0]!.revision;
    const [sent] = await db.batch([
      db.prepare(
        `INSERT INTO machine_settings_snapshots (machine_id, revision, leaves, sent_order)
           SELECT ?, ?, ?, COALESCE((SELECT MAX(sent_order) FROM machine_settings_snapshots WHERE machine_id = ?), 0) + 1
             WHERE EXISTS (SELECT 1 FROM machine_claims WHERE machine_id = ? AND member_id = ? AND settings_revision = ?)
           ON CONFLICT (machine_id, revision) DO UPDATE SET leaves = excluded.leaves, sent_order = excluded.sent_order`,
      ).bind(machineId, revision, JSON.stringify(leaves), machineId, machineId, memberId, parseMachineSettingsRevision(revision)!.counter),
      db.prepare(`DELETE FROM machine_settings_snapshots WHERE machine_id = ? AND revision NOT IN (
          SELECT revision FROM machine_settings_snapshots WHERE machine_id = ? ORDER BY sent_order DESC LIMIT ?)
          AND EXISTS (SELECT 1 FROM machine_claims WHERE machine_id = ? AND member_id = ?)`)
        .bind(machineId, machineId, MACHINE_SETTINGS_SNAPSHOT_LIMIT, machineId, memberId),
    ]);
    if (sent!.meta.changes === 1) return { leaves, feature: MACHINE_SETTINGS_FEATURE, revision };
  }
  throw new Error('Machine settings changed while preparing their revision.');
}

/**
 * Connect one repository of a machine: `project` is the project it joins, or `''` for the one it resolves by its remote
 * or creates. The claimant must still hold the machine when the write lands; the machine's other entries stand.
 */
export async function connectMachineRoot(db: RelationalStore, machineId: string, rootKey: string, project: string, actor: string, now: number): Promise<MachineWrite> {
  const current = (await readMachineSettings(db, machineId)).find((l) => l.leaf === CONNECT_ROOTS_LEAF)?.value;
  const next = { ...((current ?? {}) as Record<string, string>), [rootKey]: project };
  const violation = leafRuleViolation(MACHINE_LEAF_SPECS[CONNECT_ROOTS_LEAF]!.spec, next);
  if (violation !== null) return { applied: false, reason: 'invalid_value', detail: violation };
  const written = await db.prepare(
    `INSERT INTO machine_settings (machine_id, leaf, value, updated_at, updated_by)
       SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM machine_claims WHERE machine_id = ? AND member_id = ?)
       ON CONFLICT (machine_id, leaf) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).bind(machineId, CONNECT_ROOTS_LEAF, JSON.stringify(next), now, actor, machineId, actor).run();
  return written.meta.changes > 0 ? { applied: true } : { applied: false, reason: 'absent' };
}

/** Stop telling a machine to connect a repository: its other entries stand. Whether the machine held an entry for it. */
export async function disconnectMachineRoot(db: RelationalStore, machineId: string, rootKey: string, actor: string, now: number): Promise<boolean> {
  const current = (await readMachineSettings(db, machineId)).find((l) => l.leaf === CONNECT_ROOTS_LEAF)?.value as Record<string, string> | undefined;
  if (current === undefined || !Object.prototype.hasOwnProperty.call(current, rootKey)) return false;
  const next = Object.fromEntries(Object.entries(current).filter(([key]) => key !== rootKey));
  const written = await db.prepare(`UPDATE machine_settings SET value = ?, updated_at = ?, updated_by = ?
    WHERE machine_id = ? AND leaf = ?
      AND EXISTS (SELECT 1 FROM machine_claims WHERE machine_id = ? AND member_id = ?)`)
    .bind(JSON.stringify(next), now, actor, machineId, CONNECT_ROOTS_LEAF, machineId, actor).run();
  return written.meta.changes === 1;
}

/** What a machine is told to connect a repository to: a project, `''` for any, or null where it is told nothing. */
export async function connectedRoot(db: RelationalStore, machineId: string, rootKey: string): Promise<string | null> {
  const map = (await readMachineSettings(db, machineId)).find((leaf) => leaf.leaf === CONNECT_ROOTS_LEAF)?.nextEffective as Record<string, string> | undefined;
  return map?.[rootKey] ?? null;
}
