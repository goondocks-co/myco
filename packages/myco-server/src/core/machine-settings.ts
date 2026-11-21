import { MACHINE_UPDATE_LEAVES, RELEASE_CHANNELS, machineUpdateReport, machineUpdateRequests, validMachineUpdateValue, type MachineUpdateReport, type MachineUpdateLeaf, type MachineSettingsBlock } from '@goondocks/myco-shared/member-protocol';
/**
 * Settings one machine holds: one set per machine identity, edited on the dashboard and read by that machine (#1393).
 *
 * The one member who may read or change a machine's settings is the member the machine joined as
 * (`machine_claims.member_id`). An admin is not: the settings name folders on that member's own machine, which no
 * other member reaches. A machine receives its own set on its session start (`machineBlockFor`), and on nothing it
 * does not claim. A capture leaf at its default holds no row. An update request holds a value and its canonical id.
 */
import { DISMISSED_ROOTS_LEAF, MACHINE_SETTING_SPECS, MACHINE_SETTINGS_FEATURE, isMachineSettingsRevision, parseMachineSettingsRevision, resolveMachineSetting, type MachineSettingLeaf } from '@goondocks/myco-shared/member-protocol';
import { DEPLOYMENT_TARGETS, type EffectiveSetting, type SettingSource } from '@goondocks/myco-shared/settings-contract';
import { sha256Hex } from '../hash.js';
import type { RelationalStore } from './adapters.js';
import { leafRuleViolation, type LeafSpec } from './settings.js';
import {
  acknowledgeMachineRevision, clearMachineLeaf, invalidateMachineCache, noteMachineContract, publishMachineSnapshot, putMachineLeaf,
  reportMachineUpdates, readClaimant, readMachineLeaf, readMachineRows, repairMachineLeaf, writeMachineRoots,
  type MachineSettingRow,
} from '../db/settings/machines.js';
import { commitDismissal, type LeafEdit } from '../db/settings/machine-dismissals.js';

/**
 * The repositories a machine is told to connect from "Needs you", by key: each names the project it joins, or `''` for
 * the project it resolves by its remote or creates. Written by the connect, read by the machine's next hook there.
 */
const CONNECT_ROOTS_LEAF = 'capture.connect_roots';
/** The folders whose repositories the machine never asks about: the member's own setting, which the machine applies. */
const QUIET_ROOTS_LEAF = 'capture.quiet_roots';

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
  requestId?: string;
  appliedValue: unknown;
  nextEffective: unknown;
  nextSource: SettingSource;
}

/** Whether the member `actorId` may read and change `machineId`'s settings, which only the member claiming it may: absent when no member claims it. */
export async function machineAccess(db: RelationalStore, actorId: string, machineId: string): Promise<'absent' | 'forbidden' | 'allowed'> {
  const claim = await readClaimant(db, machineId);
  if (claim === null) return 'absent';
  return claim.member_id === actorId ? 'allowed' : 'forbidden';
}

/** Stored values and the revision their member last confirmed, read in one database snapshot. */
export async function readMachineSettings(db: RelationalStore, machineId: string): Promise<MachineLeaf[]> {
  return resolveMachineSettings(await readMachineRows(db, machineId));
}

async function resolveMachineSettings(results: MachineSettingRow[]): Promise<MachineLeaf[]> {
  const stored = new Map(results.filter((row) => row.leaf !== null).map((row) => [row.leaf, row]));
  const claim = results[0];
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
  const captureSettings = resolvedSettings.map(({ leaf, row, value, resolved, violation, invalid, nextSource, clearReason }): MachineLeaf => {
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
  const reports = appliedValues?.['$updates'];
  const reported = machineUpdateReport(reports);
  const updates = MACHINE_UPDATE_LEAVES.map((leaf): MachineLeaf => {
    const row = stored.get(leaf);
    let storedValue: unknown = null;
    if (row?.value != null) {
      try { storedValue = JSON.parse(row.value); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; storedValue = row.value; }
    }
    const request = machineUpdateRequests({ [leaf]: storedValue })[leaf];
    const invalid = row !== undefined && request === undefined;
    const actual = reported?.values[leaf] ?? null;
    const waiting = request !== undefined && reported?.requests[leaf]?.id !== request.id;
    const application = waiting ? 'pending' : actual === null ? 'unreported' : 'applied';
    return {
      leaf, configured: row !== undefined, value: request?.value ?? actual, stored: request?.value ?? storedValue,
      ...(request === undefined ? {} : { requestId: request.id }),
      updatedAt: row?.updated_at ?? null, updatedBy: row?.updated_by ?? null,
      effective: actual, appliedValue: actual, application, appliedRevision: null,
      nextEffective: waiting ? request!.value : actual, nextSource: waiting ? 'configured' : 'member-cache',
      source: actual === null ? 'unset' : 'member-cache', state: invalid ? 'invalid' : application === 'applied' ? 'active' : 'inactive',
      storedApplies: request === undefined ? null : !waiting && actual === request.value,
      reason: invalid ? 'The saved update setting cannot be used. Choose a valid value to replace it.' : waiting ? 'Waiting for this machine to read its settings and report back.' : actual === null ? 'This machine has not reported this setting.' : 'Last reported by this machine.',
      appliesTo: DEPLOYMENT_TARGETS, revision,
    };
  });
  return [...captureSettings, ...updates];
}

type MachineWrite = { applied: true } | { applied: false; reason: 'unknown_leaf' | 'invalid_value' | 'absent' | 'conflict'; detail?: string };

/**
 * Set one leaf of the machine `actor` claims. The default removes the row. Both writes are conditioned on that claim
 * in the same statement, so a machine the actor does not claim, or no longer claims, is left as it is.
 */
export async function setMachineLeaf(db: RelationalStore, machineId: string, leaf: string, value: unknown, actor: string, now: number): Promise<MachineWrite> {
  if (MACHINE_UPDATE_LEAVES.includes(leaf as MachineUpdateLeaf)) {
    if (!validMachineUpdateValue(leaf as MachineUpdateLeaf, value)) return {
      applied: false, reason: 'invalid_value', detail: leaf === 'update.channel'
        ? `Release channel ${JSON.stringify(value)} was not saved; use ${RELEASE_CHANNELS.join(', ')}. Next call: PUT /api/machines/${machineId}/settings/update.channel with {"value":"stable"}.`
        : `Automatic updates ${JSON.stringify(value)} was not saved; use true or false. Next call: PUT /api/machines/${machineId}/settings/update.automatic with {"value":true}.`,
    };
    const request = { id: crypto.randomUUID(), value };
    return await putMachineLeaf(db, { machine: machineId, leaf, value: JSON.stringify(request), actor, now }) ? { applied: true } : { applied: false, reason: 'absent' };
  }
  const declared = MACHINE_LEAF_SPECS[leaf];
  // A leaf the Deployment writes is not set from the dashboard: connecting a repository goes through its own route.
  if (declared === undefined || declared.serverWritten === true) return { applied: false, reason: 'unknown_leaf' };
  const violation = leafRuleViolation(declared.spec, value);
  if (violation !== null) return { applied: false, reason: 'invalid_value', detail: violation };
  if (JSON.stringify(value) === JSON.stringify(declared.default)) return resetMachineLeaf(db, machineId, leaf, actor, now);

  return await putMachineLeaf(db, { machine: machineId, leaf, value: JSON.stringify(value), actor, now }) ? { applied: true } : { applied: false, reason: 'absent' };
}

/** Clear a claimant's stored value; a connection repair retains every usable assignment and refuses a valid document. */
export async function resetMachineLeaf(db: RelationalStore, machineId: string, leaf: string, actor: string, now: number): Promise<MachineWrite> {
  if (MACHINE_UPDATE_LEAVES.includes(leaf as MachineUpdateLeaf)) return await clearMachineLeaf(db, { machine: machineId, leaf, actor }) ? { applied: true } : { applied: false, reason: 'absent' };
  const declaration = MACHINE_LEAF_SPECS[leaf];
  if (declaration === undefined) return { applied: false, reason: 'unknown_leaf' };
  let invalidDocument: string | null = null;
  let repairedConnections: string | null = null;
  if (declaration.serverWritten === true) {
    const row = await readMachineLeaf(db, machineId, leaf);
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
  if (invalidDocument === null) return await clearMachineLeaf(db, { machine: machineId, leaf, actor }) ? { applied: true } : { applied: false, reason: 'absent' };
  const repaired = await repairMachineLeaf(db, { machine: machineId, leaf, actor, invalid: invalidDocument, repaired: repairedConnections, now });
  if (repaired === 'landed') return { applied: true };
  if (repaired === 'absent') return { applied: false, reason: 'absent' };
  return { applied: false, reason: 'conflict', detail: `This machine's stored connections changed while they were being repaired; nothing was saved. Read them with GET /api/machines/${machineId}/settings, then repeat the reset.` };
}

/**
 * The settings a machine is answered with: its own leaves, keyed by leaf, when the member asking claims the machine,
 * and null for any other: a credential that joined no machine (a run's) is told nothing about any.
 */
export async function machineBlockFor(
  db: RelationalStore, memberId: string, machineId: string, support: { machineSettingsFeature?: boolean; machineSettingsRevision?: string; machineSettingsOrder?: number; machineSettingsInvalidated?: boolean; machineUpdateReport?: MachineUpdateReport; clock?: () => number; answer?: 'changes' } = {},
): Promise<MachineSettingsBlock | null> {
  let snapshot = await readMachineRows(db, machineId);
  const claim = snapshot[0];
  if (claim?.member_id !== memberId) return null;
  let changed = false;
  if (support.machineSettingsFeature === true && claim.settings_contract_supported !== 1) {
    await noteMachineContract(db, machineId, memberId); changed = true;
  }
  const reportOrder = support.machineSettingsOrder;
  const ordered = support.machineSettingsFeature === true && reportOrder !== undefined && Number.isSafeInteger(reportOrder) && reportOrder >= 0;
  if (ordered && reportOrder > claim.settings_report_order && support.machineSettingsInvalidated === true) {
    await invalidateMachineCache(db, { machine: machineId, member: memberId, order: reportOrder });
    changed = true;
  } else if (ordered && reportOrder > claim.settings_report_order && isMachineSettingsRevision(support.machineSettingsRevision)) {
    await acknowledgeMachineRevision(db, { machine: machineId, member: memberId, revision: support.machineSettingsRevision, order: reportOrder });
    changed = true;
  }
  if (support.machineUpdateReport !== undefined) {
    const previous = claim.settings_cached_values === null ? null : machineUpdateReport(JSON.parse(claim.settings_cached_values)?.['$updates']);
    if (support.machineUpdateReport.order > (previous?.order ?? -1)) {
      await reportMachineUpdates(db, { machine: machineId, member: memberId, report: JSON.stringify(support.machineUpdateReport), order: support.machineUpdateReport.order });
      changed = true;
    }
  }
  if (changed) snapshot = await readMachineRows(db, machineId);
  for (let attempt = 0; attempt < MACHINE_SETTINGS_SNAPSHOT_ATTEMPTS; attempt += 1) {
    if (snapshot[0]?.member_id !== memberId) return null;
    const settings = await resolveMachineSettings(snapshot);
    const leaves = Object.fromEntries(settings.filter(leaf => MACHINE_LEAVES.includes(leaf.leaf)).map((leaf) => [leaf.leaf, leaf.nextEffective]));
    if (support.machineSettingsFeature !== true) return { leaves };
    const revision = settings[0]!.revision;
    if (support.answer === 'changes' && revision === support.machineSettingsRevision && !settings.some(leaf => leaf.requestId !== undefined)) return null;
    const counter = parseMachineSettingsRevision(revision)!.counter;
    if ((support.answer === 'changes' && revision === snapshot[0]?.settings_cached_revision)
      || await publishMachineSnapshot(db, { machine: machineId, member: memberId, revision, leaves: JSON.stringify(leaves), counter, keep: MACHINE_SETTINGS_SNAPSHOT_LIMIT })) {
      const updates = support.machineUpdateReport === undefined ? {} : machineUpdateRequests(Object.fromEntries(
        settings.filter(row => row.requestId !== undefined).map(row => [row.leaf, { id: row.requestId, value: row.value, savedAt: row.updatedAt ?? 0 }]),
      ));
      return { leaves, feature: MACHINE_SETTINGS_FEATURE, revision, ...(snapshot[0]?.settings_cached_revision === revision ? { cacheConfirmed: true as const } : {}), ...(support.machineUpdateReport === undefined ? {} : { updateRequests: updates, serverNow: (support.clock ?? Date.now)() }) };
    }
    snapshot = await readMachineRows(db, machineId);
  }
  throw new Error('Machine settings changed while preparing their revision.');
}

/**
 * Connect one repository of a machine: `project` is the project it joins, or `''` for the one it resolves by its remote
 * or creates. The claimant must still hold the machine when the write lands; the machine's other entries stand.
 */
export async function connectMachineRoot(db: RelationalStore, machineId: string, rootKey: string, project: string, actor: string, now: number): Promise<MachineWrite> {
  const result = await editMachineRoots(db, machineId, actor, now, current => ({ ...current, [rootKey]: project }));
  return result.applied ? { applied: true } : result;
}

/**
 * Dismiss one repository of a machine from "Needs you", and with `folder`, never ask about any repository under that
 * folder: both leaves and the waiting row change in one commit, rechecked against what this read, or nothing does.
 */
export async function dismissMachineRoot(db: RelationalStore, input: { machineId: string; rootKey: string; label: string; folder: string | null; actor: string; now: number }): Promise<RootsWrite> {
  const { machineId, rootKey, label, folder, actor, now } = input;
  for (let attempt = 0; attempt < MACHINE_SETTINGS_SNAPSHOT_ATTEMPTS; attempt++) {
    if (await machineAccess(db, actor, machineId) !== 'allowed') return { applied: false, reason: 'absent' };
    const dismissed = await leafEdit<Record<string, string>>(db, machineId, DISMISSED_ROOTS_LEAF, (current) => ({ ...current, [rootKey]: label }));
    if ('refused' in dismissed) {
      const full = Object.keys(dismissed.current ?? {}).length >= MACHINE_SETTING_SPECS[DISMISSED_ROOTS_LEAF].maxItems;
      return { applied: false, reason: 'invalid_value', detail: full
        ? `this machine already holds ${MACHINE_SETTING_SPECS[DISMISSED_ROOTS_LEAF].maxItems} dismissed repositories; ask again about some under My machines, in this machine's settings, or with POST /api/uncaptured/${machineId}/{rootKey}/restore for one`
        : dismissed.refused };
    }
    const quiet = folder === null ? null : await leafEdit<string[]>(db, machineId, QUIET_ROOTS_LEAF, (current) => current.includes(folder) ? current : [...current, folder]);
    if (quiet !== null && 'refused' in quiet) return { applied: false, reason: 'invalid_value', detail: quiet.refused };
    if (await commitDismissal(db, { machine: machineId, rootKey, actor, now, edits: [dismissed, ...(quiet === null ? [] : [quiet])] })) return { applied: true, changed: true };
  }
  return { applied: false, reason: 'conflict' };
}

/** Ask again about a dismissed repository: a later report of it is listed. Connecting it does the same. */
export async function restoreMachineRoot(db: RelationalStore, machineId: string, rootKey: string, actor: string, now: number): Promise<RootsWrite> {
  return editMachineLeaf<Record<string, string>>(db, machineId, DISMISSED_ROOTS_LEAF, actor, now, current => Object.fromEntries(Object.entries(current).filter(([key]) => key !== rootKey)));
}

/** One capture leaf's edit from its stored text, or why the stored value or the edited one breaks the leaf's rule. */
async function leafEdit<T extends object>(db: RelationalStore, machineId: string, leaf: string, edit: (current: T) => T): Promise<LeafEdit | { refused: string; current: T | null }> {
  const row = await readMachineLeaf(db, machineId, leaf);
  const spec = MACHINE_LEAF_SPECS[leaf]!.spec;
  let current: unknown = MACHINE_LEAF_SPECS[leaf]!.default;
  if (row !== null) {
    try { current = JSON.parse(row.value); }
    catch (error) { if (error instanceof SyntaxError) return { refused: 'the stored value cannot be read', current: null }; throw error; }
  }
  const invalid = leafRuleViolation(spec, current);
  if (invalid !== null) return { refused: invalid, current: null };
  const next = edit(current as T);
  const violation = leafRuleViolation(spec, next);
  return violation === null ? { leaf, previous: row?.value ?? null, value: JSON.stringify(next) } : { refused: violation, current: current as T };
}

type RootsWrite = { applied: true; changed: boolean } | Extract<MachineWrite, { applied: false }>;

/** Recompute a connection edit from the exact stored text that its conditional write replaces. */
function editMachineRoots(
  db: RelationalStore, machineId: string, actor: string, now: number,
  edit: (current: Record<string, string>) => Record<string, string>,
): Promise<RootsWrite> {
  return editMachineLeaf(db, machineId, CONNECT_ROOTS_LEAF, actor, now, edit);
}

/** Recompute an edit of one capture leaf from the exact stored text that its conditional write replaces; the rest stand. */
async function editMachineLeaf<T extends object>(
  db: RelationalStore, machineId: string, leaf: string, actor: string, now: number, edit: (current: T) => T,
): Promise<RootsWrite> {
  for (let attempt = 0; attempt < MACHINE_SETTINGS_SNAPSHOT_ATTEMPTS; attempt++) {
    if (await machineAccess(db, actor, machineId) !== 'allowed') return { applied: false, reason: 'absent' };
    const edited = await leafEdit<T>(db, machineId, leaf, edit);
    if ('refused' in edited) return { applied: false, reason: 'invalid_value', detail: edited.refused };
    if (edited.value === (edited.previous ?? JSON.stringify(MACHINE_LEAF_SPECS[leaf]!.default))) return { applied: true, changed: false };
    if (await writeMachineRoots(db, { machine: machineId, leaf, value: edited.value, actor, now, previous: edited.previous })) {
      return { applied: true, changed: true };
    }
  }
  return { applied: false, reason: 'conflict' };
}

/** Stop telling a machine to connect a repository, retaining every sibling entry. */
export async function disconnectMachineRoot(db: RelationalStore, machineId: string, rootKey: string, actor: string, now: number): Promise<RootsWrite> {
  return editMachineRoots(db, machineId, actor, now, current => Object.fromEntries(Object.entries(current).filter(([key]) => key !== rootKey)));
}

/** What a machine is told to connect a repository to: a project, `''` for any, or null where it is told nothing. */
export async function connectedRoot(db: RelationalStore, machineId: string, rootKey: string): Promise<string | null> {
  const map = (await readMachineSettings(db, machineId)).find((leaf) => leaf.leaf === CONNECT_ROOTS_LEAF)?.nextEffective as Record<string, string> | undefined;
  return map?.[rootKey] ?? null;
}
