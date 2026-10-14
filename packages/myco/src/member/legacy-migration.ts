/** The local cutover receipt capability. */
import path from 'node:path';
import { readVaultContent, type TableCounts } from '@myco/member/legacy-backup.js';
import { LegacyMigrationUnreadable, legacyRealpath, legacySources, legacyVaultProjectIds, type LegacySources } from '@myco/member/legacy-sources.js';
export { LegacyMigrationUnreadable } from '@myco/member/legacy-sources.js';
import { ensureMemberDir, memberRoot, readPrivateJson, writePrivateFileAtomic } from '@myco/member/store.js';
import { deploymentKeyFor, deploymentUrl, withRegistryLock } from '@myco/member/registry.js';
import { defaultMycoHome } from '@myco/paths/home.js';

export interface MigrationPass {
  state: 'complete' | 'partial' | 'refused' | 'none';
  at: number;
  failures?: { what: string; cause: string }[];
  endedBy?: string;
}
export interface MigrationProjectReceipt {
  evidence?: { kind: 'deployment'; at: number; machineId: string; eventIds: string[] };
  root?: string | null;
  destination?: { serverUrl: string; key: string } | { skip: true; at: number };
  vault?: MigrationPass;
  transcripts?: MigrationPass;
  destinations?: Record<string, { serverUrl: string; digest: string; size: number; mtimeMs: number; vault?: MigrationPass; transcripts?: MigrationPass; evidence?: MigrationProjectReceipt['evidence'] }>;
}
export interface MigrationReceipt {
  digest: string;
  size: number;
  mtimeMs: number;
  wal?: LegacySources['vaults'][number]['wal'];
  projects: Record<string, MigrationProjectReceipt>;
}
export interface SourceReconciliation { before: string; after: string; sessionsAdded: number }
export interface CutoverState {
  version?: 1 | 2;
  backups: Record<string, { copy: string; counts: TableCounts; digest: string; at: number }>;
  pendingSource?: SourceReconciliation;
  handover?: { at: number; legacyHomes: string[]; agents: string[]; reconciliation?: SourceReconciliation };
  migrations?: Record<string, MigrationReceipt>;
}
export type LegacyMigrationState = (
  | { state: 'unavailable'; file: string; detail: string }
  | { state: 'changed'; warning: string }
  | { state: 'none' | 'unmoved' | 'needs-destination' | 'handover-pending' | 'partial' | 'moved' }
) & { legacyOwnsCapture?: true; confirmation?: 'unavailable' | 'not-found' };

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');
function validSourcePlan(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const plan: unknown = JSON.parse(value);
    return record(plan) && typeof plan.home === 'string' && strings(plan.agents)
      && Array.isArray(plan.vaults) && plan.vaults.every(v => record(v) && typeof v.vault === 'string' && typeof v.digest === 'string')
      && Array.isArray(plan.destinations) && plan.destinations.every(d => record(d) && typeof d.vault === 'string' && typeof d.projectId === 'string'
        && (d.root === null || typeof d.root === 'string') && (d.kind === 'skip' || (d.kind === 'destination' && typeof d.serverUrl === 'string')));
  } catch { return false; }
}
const validPass = (value: unknown, transcript: boolean): boolean => value === undefined || (record(value)
  && (transcript ? ['complete', 'partial', 'none'] : ['complete', 'partial', 'refused']).includes(String(value.state))
  && timestamp(value.at) && (value.endedBy === undefined || typeof value.endedBy === 'string')
  && (value.failures === undefined || (Array.isArray(value.failures) && value.failures.every((f) => record(f) && typeof f.what === 'string' && typeof f.cause === 'string'))));
function validProject(value: unknown): boolean {
  if (!record(value) || !validPass(value.vault, false) || !validPass(value.transcripts, true)) return false;
  if (value.evidence !== undefined && (!record(value.evidence) || value.evidence.kind !== 'deployment' || !timestamp(value.evidence.at)
    || typeof value.evidence.machineId !== 'string' || !strings(value.evidence.eventIds) || value.evidence.eventIds.length === 0)) return false;
  if (value.root !== undefined && value.root !== null && typeof value.root !== 'string') return false;
  const dest = value.destination;
  if (dest !== undefined && (!record(dest) || ('skip' in dest
    ? dest.skip !== true || !timestamp(dest.at) || 'serverUrl' in dest
    : typeof dest.serverUrl !== 'string' || dest.serverUrl.length === 0 || dest.key !== deploymentKeyFor(deploymentUrl(dest.serverUrl))))) return false;
  return value.destinations === undefined || (record(value.destinations) && Object.entries(value.destinations).every(([key, d]) => record(d) && typeof d.serverUrl === 'string' && key === deploymentKeyFor(d.serverUrl) && typeof d.digest === 'string' && timestamp(d.size) && timestamp(d.mtimeMs) && validPass(d.vault, false) && validPass(d.transcripts, true)));
}

/** Absent records are empty; permission, format and I/O failures stop a cutover. */
export function readCutoverState(home: string): CutoverState {
  const file = path.join(home, 'member', 'cutover.json');
  const read = readPrivateJson<unknown>(file);
  if (!read.ok) {
    if (read.reason === 'missing') return { backups: {} };
    throw new LegacyMigrationUnreadable(file, read.reason === 'loose-mode' ? 'permissions must be 0600' : `${read.reason}: ${read.detail ?? ''}`);
  }
  const value = read.value;
  if (!record(value) || !record(value.backups) || (value.version !== undefined && value.version !== 1 && value.version !== 2)
    || (value.migrations !== undefined && !record(value.migrations))) throw new LegacyMigrationUnreadable(file, 'invalid cutover record');
  if (value.handover !== undefined && (!record(value.handover) || !timestamp(value.handover.at) || !strings(value.handover.legacyHomes) || !strings(value.handover.agents))) throw new LegacyMigrationUnreadable(file, 'invalid handover receipt');
  for (const r of [value.pendingSource, record(value.handover) ? value.handover.reconciliation : undefined]) if (r !== undefined) {
    if (!record(r) || !validSourcePlan(r.before) || !validSourcePlan(r.after) || !timestamp(r.sessionsAdded) || !Number.isInteger(r.sessionsAdded)) throw new LegacyMigrationUnreadable(file, 'invalid quiescent source receipt');
  }
  if (value.migrations !== undefined) for (const receipt of Object.values(value.migrations)) {
    if (!record(receipt) || typeof receipt.digest !== 'string' || !timestamp(receipt.size) || !timestamp(receipt.mtimeMs)
      || (receipt.wal !== undefined && receipt.wal !== null && (!record(receipt.wal) || !timestamp(receipt.wal.size) || !timestamp(receipt.wal.mtimeMs)))
      || !record(receipt.projects) || !Object.values(receipt.projects).every(validProject)) throw new LegacyMigrationUnreadable(file, 'invalid migration receipt');
  }
  return value as unknown as CutoverState;
}

/** Atomically publish the receipt journal and its per-destination completion records under the registry lock. */
export function writeCutoverState(home: string, state: CutoverState): void {
  withRegistryLock(() => publishCutoverState(home, state), home);
}

/** Read, admit and publish a backfill while registry routes and the receipt stay locked. */
export function updateCutoverState(home: string, update: (state: CutoverState) => boolean): void {
  withRegistryLock(() => {
    const state = readCutoverState(home);
    if (update(state)) publishCutoverState(home, state);
  }, home);
}

function publishCutoverState(home: string, state: CutoverState): void {
  for (const receipt of Object.values(state.migrations ?? {})) for (const project of Object.values(receipt.projects)) {
    if (project.destination !== undefined && 'key' in project.destination) {
      project.destinations ??= {};
      project.destinations[project.destination.key] = { serverUrl: project.destination.serverUrl, digest: receipt.digest, size: receipt.size, mtimeMs: receipt.mtimeMs, vault: project.vault, transcripts: project.transcripts, evidence: project.evidence };
    }
  }
  ensureMemberDir(memberRoot(home), home);
  writePrivateFileAtomic(path.join(memberRoot(home), 'cutover.json'), `${JSON.stringify(state, null, 2)}\n`);
}

export function sameLegacyStamp(vault: LegacySources['vaults'][number], receipt: MigrationReceipt): boolean {
  return vault.size === receipt.size && vault.mtimeMs === receipt.mtimeMs
    && JSON.stringify(vault.wal) === JSON.stringify(receipt.wal ?? null);
}

/** Completion belongs to the recorded source and destination, independently of live Project state. */
export function completedLegacyDestination(receipt: MigrationReceipt, project: MigrationProjectReceipt): string | null {
  const destination = project.destination;
  if (destination === undefined || !('serverUrl' in destination)) return null;
  const delivered = project.destinations?.[destination.key];
  const passes = delivered ?? project;
  if ((delivered !== undefined && (delivered.serverUrl !== destination.serverUrl || delivered.digest !== receipt.digest))
    || passes.vault?.state !== 'complete' || !['complete', 'none'].includes(passes.transcripts?.state ?? '')
    || passes.vault.endedBy !== undefined || (passes.vault.failures?.length ?? 0) > 0
    || passes.transcripts?.endedBy !== undefined || (passes.transcripts?.failures?.length ?? 0) > 0) return null;
  return destination.serverUrl;
}

/** A completed cutover's repository destination remains authoritative across setup journeys. */
export function legacyProjectDestination(home: string, root: string, projectId: string): string | null {
  const state = readCutoverState(home);
  if (!state.handover) return null;
  for (const receipt of Object.values(state.migrations ?? {})) {
    const project = receipt.projects[projectId];
    if (project?.root !== root || !project.destination || !('serverUrl' in project.destination)) continue;
    const completed = completedLegacyDestination(receipt, project);
    if (completed !== null) return completed;
  }
  return null;
}

export function legacyMigrationState(home: string): LegacyMigrationState {
  try {
    const initialHomes = [...new Set([home, defaultMycoHome()].map(legacyRealpath))];
    const initialStates = initialHomes.map(readCutoverState);
    const homes = [...new Set([...initialHomes, ...initialStates.flatMap((s) => s.handover?.legacyHomes ?? [])].map(legacyRealpath))];
    const folders = initialStates.flatMap((s) => Object.values(s.migrations ?? {}).flatMap((v) => Object.values(v.projects).flatMap((p) => typeof p.root === 'string' ? [p.root] : [])));
    const sources = legacySources(home, { homes, folders });
    const observed = (state: LegacyMigrationState): LegacyMigrationState => sources.units.length > 0 || sources.registrations.length > 0
      ? { ...state, legacyOwnsCapture: true } : state;
    const states = sources.homes.map(readCutoverState);
    if (sources.vaults.length === 0 && sources.units.length === 0 && sources.registrations.length === 0) return { state: 'none' };
    const migrations = states.flatMap((s) => Object.entries(s.migrations ?? {}).map(([file, receipt]) => ({ file: legacyRealpath(file), receipt, state: s })));
    const held = sources.vaults.map((vault) => ({ vault, entries: migrations.filter((r) => r.file === vault.path) }));
    if (held.some(({ vault, entries }) => entries.length === 0 && !states.some((s) => Object.keys(s.backups).some((file) => legacyRealpath(file) === vault.path)))) return observed({ state: 'unmoved' });
    let changed = false;
    let needsDestination = false;
    let partial = false;
    for (const { vault, entries } of held) {
      if (entries.length === 0) { needsDestination = true; continue; }
      // Current metadata avoids opening and hashing an unchanged vault.
      const entry = entries.find((e) => sameLegacyStamp(vault, e.receipt)) ?? entries[0];
      const receipt = entry.receipt;
      const current = sameLegacyStamp(vault, receipt);
      if (!current) {
        if (readVaultContent(vault.path).digest !== receipt.digest) {
          const imported = Object.values(receipt.projects).some(p => p.vault !== undefined || p.transcripts !== undefined
            || Object.values(p.destinations ?? {}).some(d => d.vault !== undefined || d.transcripts !== undefined));
          if (imported) changed = true;
          else partial = true;
        }
        const ids = legacyVaultProjectIds(vault.path);
        if (ids.some((id) => receipt.projects[id]?.destination === undefined)) needsDestination = true;
      }
      for (const project of Object.values(receipt.projects)) {
        const destination = project.destination;
        if (destination === undefined) { needsDestination = true; continue; }
        if ('skip' in destination && destination.skip === true) continue;
        if (!('serverUrl' in destination) || destination.key !== deploymentKeyFor(deploymentUrl(destination.serverUrl))) { needsDestination = true; continue; }
        if (completedLegacyDestination(receipt, project) === null) partial = true;
      }
    }
    if (changed) return observed({ state: 'changed', warning: 'Myco 1.4 wrote more data after migration. Keep its files and run myco setup --cutover to review the new data, or preview manually with myco cutover --dry-run.' });
    if (needsDestination) return observed({ state: 'needs-destination' });
    const confirmed = held.every(({ entries }) => entries.some(({ receipt }) => Object.values(receipt.projects).length > 0
      && Object.values(receipt.projects).every(project => project.evidence?.kind === 'deployment')));
    if ((!states.some((s) => s.handover !== undefined) && !confirmed) || sources.units.length > 0 || sources.registrations.length > 0) return observed({ state: 'handover-pending' });
    return { state: partial ? 'partial' : 'moved' };
  } catch (error) {
    const file = error instanceof LegacyMigrationUnreadable ? error.file : error instanceof Error && 'path' in error ? String(error.path) : home;
    return { state: 'unavailable', file, detail: new LegacyMigrationUnreadable(file, error).message };
  }
}
