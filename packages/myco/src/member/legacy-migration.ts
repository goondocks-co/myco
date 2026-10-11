/** Read-only migration receipts; the cutover capability is their only writer. */
import path from 'node:path';
import { readVaultContent, type TableCounts } from '@myco/member/legacy-backup.js';
import { LegacyMigrationUnreadable, legacyRealpath, legacySources, legacyVaultProjectIds, type LegacySources } from '@myco/member/legacy-sources.js';
export { LegacyMigrationUnreadable } from '@myco/member/legacy-sources.js';
import { readPrivateJson } from '@myco/member/store.js';
import { deploymentKeyFor, deploymentUrl } from '@myco/member/registry.js';
import { defaultMycoHome } from '@myco/paths/home.js';

export interface MigrationPass {
  state: 'complete' | 'partial' | 'refused' | 'none';
  at: number;
  failures?: { what: string; cause: string }[];
  endedBy?: string;
}
export interface MigrationProjectReceipt {
  root?: string | null;
  destination?: { serverUrl: string; key: string } | { skip: true; at: number };
  vault?: MigrationPass;
  transcripts?: MigrationPass;
  destinations?: Record<string, { serverUrl: string; digest: string; size: number; mtimeMs: number; vault?: MigrationPass; transcripts?: MigrationPass }>;
}
export interface MigrationReceipt {
  digest: string;
  size: number;
  mtimeMs: number;
  wal?: LegacySources['vaults'][number]['wal'];
  projects: Record<string, MigrationProjectReceipt>;
}
export interface CutoverState {
  version?: 1 | 2;
  backups: Record<string, { copy: string; counts: TableCounts; digest: string; at: number }>;
  handover?: { at: number; legacyHomes: string[]; agents: string[] };
  migrations?: Record<string, MigrationReceipt>;
}
export type LegacyMigrationState = (
  | { state: 'unavailable'; file: string; detail: string }
  | { state: 'changed'; warning: string }
  | { state: 'none' | 'unmoved' | 'needs-destination' | 'handover-pending' | 'partial' | 'moved' }
) & { legacyOwnsCapture?: true };

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string');
const validPass = (value: unknown, transcript: boolean): boolean => value === undefined || (record(value)
  && (transcript ? ['complete', 'partial', 'none'] : ['complete', 'partial', 'refused']).includes(String(value.state))
  && timestamp(value.at) && (value.endedBy === undefined || typeof value.endedBy === 'string')
  && (value.failures === undefined || (Array.isArray(value.failures) && value.failures.every((f) => record(f) && typeof f.what === 'string' && typeof f.cause === 'string'))));
function validProject(value: unknown): boolean {
  if (!record(value) || !validPass(value.vault, false) || !validPass(value.transcripts, true)) return false;
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
  if (value.migrations !== undefined) for (const receipt of Object.values(value.migrations)) {
    if (!record(receipt) || typeof receipt.digest !== 'string' || !timestamp(receipt.size) || !timestamp(receipt.mtimeMs)
      || (receipt.wal !== undefined && receipt.wal !== null && (!record(receipt.wal) || !timestamp(receipt.wal.size) || !timestamp(receipt.wal.mtimeMs)))
      || !record(receipt.projects) || !Object.values(receipt.projects).every(validProject)) throw new LegacyMigrationUnreadable(file, 'invalid migration receipt');
  }
  return value as unknown as CutoverState;
}

export function sameLegacyStamp(vault: LegacySources['vaults'][number], receipt: MigrationReceipt): boolean {
  return vault.size === receipt.size && vault.mtimeMs === receipt.mtimeMs
    && JSON.stringify(vault.wal) === JSON.stringify(receipt.wal ?? null);
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
        if (readVaultContent(vault.path).digest !== receipt.digest) changed = true;
        const ids = legacyVaultProjectIds(vault.path);
        if (ids.some((id) => receipt.projects[id]?.destination === undefined)) needsDestination = true;
      }
      for (const project of Object.values(receipt.projects)) {
        const destination = project.destination;
        if (destination === undefined) { needsDestination = true; continue; }
        if ('skip' in destination && destination.skip === true) continue;
        if (!('serverUrl' in destination) || destination.key !== deploymentKeyFor(deploymentUrl(destination.serverUrl))) { needsDestination = true; continue; }
        const delivered = project.destinations?.[destination.key];
        const passes = delivered ?? project;
        if ((delivered !== undefined && (delivered.serverUrl !== destination.serverUrl || delivered.digest !== receipt.digest))
          || passes.vault?.state !== 'complete' || !['complete', 'none'].includes(passes.transcripts?.state ?? '')
          || passes.vault.endedBy !== undefined || (passes.vault.failures?.length ?? 0) > 0
          || passes.transcripts?.endedBy !== undefined || (passes.transcripts?.failures?.length ?? 0) > 0) partial = true;
      }
    }
    if (changed) return observed({ state: 'changed', warning: 'Myco 1.4 wrote more data after migration. Stop Myco 1.4, then run myco cutover --dry-run before retrying.' });
    if (needsDestination) return observed({ state: 'needs-destination' });
    if (!states.some((s) => s.handover !== undefined) || sources.units.length > 0 || sources.registrations.length > 0) return observed({ state: 'handover-pending' });
    return { state: partial ? 'partial' : 'moved' };
  } catch (error) {
    const file = error instanceof LegacyMigrationUnreadable ? error.file : error instanceof Error && 'path' in error ? String(error.path) : home;
    return { state: 'unavailable', file, detail: new LegacyMigrationUnreadable(file, error).message };
  }
}
