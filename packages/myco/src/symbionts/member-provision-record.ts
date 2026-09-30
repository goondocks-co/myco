/**
 * What a member's provisioning set up, and with which build (#1499).
 *
 * 2.0 has no updater that runs on its own, so a member's agent hooks, MCP entries and skill links are refreshed when
 * the binary changes: `myco upgrade` and `myco update` re-run the provisioning this record names, and `myco doctor`
 * reports a record written by another build, or none, as setup to refresh.
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

/** The record, under the member home. */
export const PROVISION_RECORD = path.join('member', 'provisioned.json');

export interface ProvisionRecord {
  /** The build that last provisioned. */
  version: string;
  /** The Deployment the agents were provisioned for. */
  serverUrl: string;
  /** The agents provisioning set up, by manifest name. */
  agents: string[];
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
    return { version: value.version, serverUrl: value.serverUrl, agents: value.agents.filter((a): a is string => typeof a === 'string'), at: Number(value.at ?? 0) };
  } catch {
    return null;
  }
}

/** Record `agents` as provisioned for `serverUrl` by `version`, beside any agent recorded before for the same Deployment. */
export function recordProvision(mycoHome: string, record: Omit<ProvisionRecord, 'at'> & { at?: number }, opts: { replace?: boolean } = {}): ProvisionRecord {
  const before = readProvisionRecord(mycoHome);
  const kept = !opts.replace && before !== null && before.serverUrl === record.serverUrl ? before.agents : [];
  const next: ProvisionRecord = { version: record.version, serverUrl: record.serverUrl, agents: [...new Set([...kept, ...record.agents])].sort(), at: record.at ?? Date.now() };
  fs.mkdirSync(path.dirname(provisionRecordPath(mycoHome)), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(provisionRecordPath(mycoHome), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
