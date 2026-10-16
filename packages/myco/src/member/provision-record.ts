/**
 * The member's provisioned harnesses, their registered binaries, and pending hook trust actions.
 * Helper passes and updates reconcile the harnesses this record names through the installer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { withFileLockSync } from '@myco/utils/lifecycle-lock.js';
import { writePrivateFileAtomic } from './store.js';

/** The record, under the member home. */
export const PROVISION_RECORD = path.join('member', 'provisioned.json');

export interface ProvisionRecord {
  /** The build that last provisioned. */
  version: string;
  /** The Deployment the agents were provisioned for. */
  serverUrl: string;
  /** The agents provisioning set up, by manifest name. */
  agents: string[];
  /** The binary each harness's last successful registration names. */
  binaries?: Record<string, string>;
  /** Hook trust actions waiting to reach the Deployment. */
  pendingTrust?: Record<string, { action: string; at: number }>;
  /** Each agent's Deployments awaiting configuration logout reconciliation. */
  pendingLogout?: Record<string, string[]>;
  at: number;
}

export function provisionRecordPath(mycoHome: string): string {
  return path.join(mycoHome, PROVISION_RECORD);
}

export class UnreadableProvisionRecordError extends Error {
  constructor(mycoHome: string) {
    super(`Myco's agent setup record at ${provisionRecordPath(mycoHome)} could not be read. Restore it from a backup or delete it, then run myco member provision --refresh.`);
  }
}

/** Missing records are distinct from existing records that cannot be read. */
export function readProvisionRecordStrict(mycoHome: string): ProvisionRecord | null {
  const record = readProvisionRecordFile(mycoHome, true);
  if (record === null && fs.existsSync(provisionRecordPath(mycoHome))) throw new UnreadableProvisionRecordError(mycoHome);
  return record;
}

/** The record, or null where none is written or it cannot be read as one. */
export function readProvisionRecord(mycoHome: string): ProvisionRecord | null {
  return readProvisionRecordFile(mycoHome, false);
}

function readProvisionRecordFile(mycoHome: string, strict: boolean): ProvisionRecord | null {
  try {
    const value = JSON.parse(fs.readFileSync(provisionRecordPath(mycoHome), 'utf8')) as Partial<ProvisionRecord>;
    if (typeof value.version !== 'string' || typeof value.serverUrl !== 'string' || !Array.isArray(value.agents)) return null;
    const binaries = value.binaries !== null && typeof value.binaries === 'object' && !Array.isArray(value.binaries)
      ? Object.fromEntries(Object.entries(value.binaries).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : undefined;
    const pendingTrust = value.pendingTrust !== null && typeof value.pendingTrust === 'object' && !Array.isArray(value.pendingTrust)
      ? Object.fromEntries(Object.entries(value.pendingTrust).filter(([, trust]) => trust !== null && typeof trust === 'object' && typeof trust.action === 'string' && Number.isFinite(trust.at))) : undefined;
    const entries = value.pendingLogout !== null && typeof value.pendingLogout === 'object' && !Array.isArray(value.pendingLogout) ? Object.entries(value.pendingLogout) : null;
    const valid = (entry: [string, unknown]): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every(url => typeof url === 'string');
    if (strict && value.pendingLogout !== undefined && (entries === null || !entries.every(valid))) return null;
    const pendingLogout = entries === null ? undefined : Object.fromEntries(entries.filter(valid));
    return { version: value.version, serverUrl: value.serverUrl, agents: value.agents.filter((a): a is string => typeof a === 'string'), ...(binaries === undefined ? {} : { binaries }), ...(pendingTrust === undefined ? {} : { pendingTrust }), ...(pendingLogout === undefined ? {} : { pendingLogout }), at: Number(value.at ?? 0) };
  } catch {
    return null;
  }
}

/** Record `agents` as provisioned for `serverUrl` by `version`, beside every harness recorded before. */
export function recordProvision(mycoHome: string, record: Omit<ProvisionRecord, 'at'> & { at?: number }, opts: { replace?: boolean } = {}): ProvisionRecord {
  return withProvisionLock(mycoHome, () => writeProvisionRecord(mycoHome, record, opts));
}

function withProvisionLock<T>(mycoHome: string, fn: () => T): T {
  fs.mkdirSync(path.dirname(provisionRecordPath(mycoHome)), { recursive: true, mode: 0o700 });
  return withFileLockSync(`${provisionRecordPath(mycoHome)}.lock`, fn);
}

function writeProvisionRecord(mycoHome: string, record: Omit<ProvisionRecord, 'at'> & { at?: number }, opts: { replace?: boolean } = {}): ProvisionRecord {
  const before = readProvisionRecord(mycoHome);
  const kept = !opts.replace && before !== null ? before.agents : [];
  const binaries = { ...(!opts.replace && before !== null ? before.binaries : {}), ...record.binaries };
  const pendingTrust = record.pendingTrust ?? (!opts.replace && before !== null ? before.pendingTrust : undefined);
  const pendingLogout = record.pendingLogout ?? (!opts.replace && before !== null ? before.pendingLogout : undefined);
  const next: ProvisionRecord = { version: record.version, serverUrl: record.serverUrl, agents: [...new Set([...kept, ...record.agents])].sort(), ...(Object.keys(binaries).length === 0 ? {} : { binaries }), ...(pendingTrust === undefined ? {} : { pendingTrust }), ...(pendingLogout === undefined || Object.keys(pendingLogout).length === 0 ? {} : { pendingLogout }), at: record.at ?? Date.now() };
  if (record.at === undefined && before !== null && before.version === next.version && before.serverUrl === next.serverUrl && JSON.stringify(before.agents) === JSON.stringify(next.agents) && JSON.stringify(before.binaries) === JSON.stringify(next.binaries) && JSON.stringify(before.pendingTrust) === JSON.stringify(next.pendingTrust) && JSON.stringify(before.pendingLogout) === JSON.stringify(next.pendingLogout)) return before;
  fs.mkdirSync(path.dirname(provisionRecordPath(mycoHome)), { recursive: true, mode: 0o700 });
  writePrivateFileAtomic(provisionRecordPath(mycoHome), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

type ProvisionUpdate = Omit<ProvisionRecord, 'at'> & { at?: number };

export function updateProvisionRecord(mycoHome: string, update: (record: ProvisionRecord | null) => ProvisionUpdate, opts?: { strict?: boolean }): ProvisionRecord;
export function updateProvisionRecord(mycoHome: string, update: (record: ProvisionRecord | null) => ProvisionUpdate | null | undefined, opts?: { strict?: boolean }): ProvisionRecord | null;
/** Apply fresh record changes, deletion or no change under the record lease. */
export function updateProvisionRecord(mycoHome: string, update: (record: ProvisionRecord | null) => ProvisionUpdate | null | undefined, opts: { strict?: boolean } = {}): ProvisionRecord | null {
  return withProvisionLock(mycoHome, () => {
    const before = opts.strict ? readProvisionRecordStrict(mycoHome) : readProvisionRecord(mycoHome);
    const next = update(before);
    if (next === undefined) return before;
    if (next === null) {
      fs.rmSync(provisionRecordPath(mycoHome), { force: true });
      return null;
    }
    return writeProvisionRecord(mycoHome, next, { replace: true });
  });
}

/** Clear a joined Deployment's pending logouts under the provision record lease. */
export function clearJoinedProvisionLogouts(mycoHome: string, serverUrl: string): void {
  if (!fs.existsSync(provisionRecordPath(mycoHome))) return;
  updateProvisionRecord(mycoHome, record => {
    if (record?.pendingLogout === undefined) return;
    const pendingLogout = Object.fromEntries(Object.entries(record.pendingLogout).flatMap(([agent, urls]) => {
      const kept = urls.filter(url => url !== serverUrl);
      return kept.length === 0 ? [] : [[agent, kept]];
    }));
    if (JSON.stringify(pendingLogout) !== JSON.stringify(record.pendingLogout)) return { ...record, pendingLogout };
  });
}
