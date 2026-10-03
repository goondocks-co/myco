/**
 * The member's provisioned harnesses, their registered binaries, and pending hook trust actions.
 * Helper passes and updates reconcile the harnesses this record names through the installer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '@myco/utils/lifecycle-lock.js';

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
  at: number;
}

export function provisionRecordPath(mycoHome: string): string {
  return path.join(mycoHome, PROVISION_RECORD);
}

/** The record, or null where none is written or it cannot be read as one. */
export function readProvisionRecord(mycoHome: string): ProvisionRecord | null {
  try {
    const value = JSON.parse(fs.readFileSync(provisionRecordPath(mycoHome), 'utf8')) as Partial<ProvisionRecord>;
    if (typeof value.version !== 'string' || typeof value.serverUrl !== 'string' || !Array.isArray(value.agents)) return null;
    const binaries = value.binaries !== null && typeof value.binaries === 'object' && !Array.isArray(value.binaries)
      ? Object.fromEntries(Object.entries(value.binaries).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : undefined;
    const pendingTrust = value.pendingTrust !== null && typeof value.pendingTrust === 'object' && !Array.isArray(value.pendingTrust)
      ? Object.fromEntries(Object.entries(value.pendingTrust).filter(([, trust]) => trust !== null && typeof trust === 'object' && typeof trust.action === 'string' && Number.isFinite(trust.at))) : undefined;
    return { version: value.version, serverUrl: value.serverUrl, agents: value.agents.filter((a): a is string => typeof a === 'string'), ...(binaries === undefined ? {} : { binaries }), ...(pendingTrust === undefined ? {} : { pendingTrust }), at: Number(value.at ?? 0) };
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
  const next: ProvisionRecord = { version: record.version, serverUrl: record.serverUrl, agents: [...new Set([...kept, ...record.agents])].sort(), ...(Object.keys(binaries).length === 0 ? {} : { binaries }), ...(pendingTrust === undefined ? {} : { pendingTrust }), at: record.at ?? Date.now() };
  if (record.at === undefined && before !== null && before.version === next.version && before.serverUrl === next.serverUrl && JSON.stringify(before.agents) === JSON.stringify(next.agents) && JSON.stringify(before.binaries) === JSON.stringify(next.binaries) && JSON.stringify(before.pendingTrust) === JSON.stringify(next.pendingTrust)) return before;
  fs.mkdirSync(path.dirname(provisionRecordPath(mycoHome)), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(provisionRecordPath(mycoHome), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** Hold a hook trust action until its report is accepted. */
export function holdHookTrust(mycoHome: string, agent: string, action: string): void {
  withProvisionLock(mycoHome, () => {
    const record = readProvisionRecord(mycoHome);
    if (record === null) throw new Error('Hook repair has no provisioned record');
    writeProvisionRecord(mycoHome, { ...record, pendingTrust: { ...record.pendingTrust, [agent]: { action, at: Math.max(Date.now(), (record.pendingTrust?.[agent]?.at ?? 0) + 1) } } });
  });
}

/** Accept only the trust actions this report carried; actions from a later repair remain pending. */
export function settleHookTrust(mycoHome: string, reported: ProvisionRecord['pendingTrust']): void {
  withProvisionLock(mycoHome, () => {
    const record = readProvisionRecord(mycoHome);
    if (record === null || reported === undefined || record.pendingTrust === undefined) return;
    const pendingTrust = Object.fromEntries(Object.entries(record.pendingTrust).filter(([id, trust]) => reported[id]?.at !== trust.at));
    if (Object.keys(pendingTrust).length !== Object.keys(record.pendingTrust).length) writeProvisionRecord(mycoHome, { ...record, pendingTrust });
  });
}

/** Remove an opted-out harness and its registration metadata under the record lease. */
export function forgetProvision(mycoHome: string, agent: string): void {
  withProvisionLock(mycoHome, () => {
    const record = readProvisionRecord(mycoHome);
    if (record === null) return;
    const binaries = { ...record.binaries };
    const pendingTrust = { ...record.pendingTrust };
    delete binaries[agent];
    delete pendingTrust[agent];
    writeProvisionRecord(mycoHome, { ...record, agents: record.agents.filter((id) => id !== agent), binaries, pendingTrust }, { replace: true });
  });
}
