import path from 'node:path';
import { REPAIR_LOCK } from '@myco/member/keep-current-lock.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { readProvisionRecordStrict } from '@myco/symbionts/member-provision-record.js';
import { loadManifests, resolvePackageRoot } from '@myco/symbionts/detect.js';
import { SymbiontInstaller } from '@myco/symbionts/installer.js';

const MEMBER_REPAIR_WAIT_MS = 15_000;

export class MemberRepairBusyError extends Error {
  constructor() {
    super("Myco is updating this machine's agents. Retry this command after the current update finishes.");
  }
}

export function withMemberRepair<T>(mycoHome: string, command: string, fn: () => T, opts: { wait: true; timeoutMs?: number }): T;
export function withMemberRepair<T>(mycoHome: string, command: string, fn: () => T, opts?: { wait?: boolean; timeoutMs?: number }): T | null;
export function withMemberRepair<T>(mycoHome: string, command: string, fn: () => T, opts: { wait?: boolean; timeoutMs?: number } = {}): T | null {
  const acquired = LifecycleLock.acquire(path.join(mycoHome, 'member', REPAIR_LOCK), { command, ...opts, ...(opts.wait ? { timeoutMs: opts.timeoutMs ?? MEMBER_REPAIR_WAIT_MS } : {}) });
  if (!acquired.acquired) {
    if (opts.wait) throw new MemberRepairBusyError();
    return null;
  }
  try { return fn(); } finally { acquired.lock.release(); }
}

/** Reconcile project routing for provisioned agents under the shared repair lease. */
export function reconcileProjectMcp(root: string, mycoHome: string, opts: { packageRoot?: string } = {}): string[] {
  return withMemberRepair(mycoHome, 'myco member project tools', () => {
    const record = readProvisionRecordStrict(mycoHome);
    const ready: string[] = [];
    for (const manifest of loadManifests().filter(manifest => record?.agents.includes(manifest.name) && manifest.registration?.memberMcpRouting !== undefined)) {
      const installer = new SymbiontInstaller(manifest, root, opts.packageRoot ?? resolvePackageRoot(), false, mycoHome);
      installer.reconcileMemberProjectMcp();
      if (installer.inspectMemberMcp().some(scope => scope.readable && scope.present && scope.scope === 'local')) ready.push(manifest.name);
    }
    return ready;
  }, { wait: true });
}
