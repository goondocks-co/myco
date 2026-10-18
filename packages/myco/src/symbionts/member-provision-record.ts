/**
 * The member's provisioned harnesses, their registered binaries, and pending hook trust actions.
 * Helper passes and updates reconcile the harnesses this record names through the installer.
 */
import { deploymentUrl, readDeploymentMembershipResult } from '../member/registry.js';
import { normalizeMemberServerAddress } from '../member/server-url.js';
import { updateProvisionRecord, type ProvisionRecord } from '../member/provision-record.js';
export { PROVISION_RECORD, UnreadableProvisionRecordError, provisionRecordPath, readProvisionRecord, readProvisionRecordStrict, recordProvision, type ProvisionRecord } from '../member/provision-record.js';

function retainedProvisionMetadata(record: ProvisionRecord | null, agents: readonly string[]): Pick<ProvisionRecord, 'binaries' | 'pendingTrust' | 'pendingLogout'> {
  const retain = <V>(entries: Record<string, V> | undefined): Record<string, V> | undefined => entries === undefined ? undefined
    : Object.fromEntries(Object.entries(entries).filter(([id]) => agents.includes(id)));
  return { binaries: retain(record?.binaries), pendingTrust: retain(record?.pendingTrust), pendingLogout: retain(record?.pendingLogout) };
}

/** Hold a hook trust action until its report is accepted. */
export function holdHookTrust(mycoHome: string, agent: string, action: string): void {
  updateProvisionRecord(mycoHome, record => {
    if (record === null) throw new Error('Hook repair has no provisioned record');
    return { ...record, pendingTrust: { ...record.pendingTrust, [agent]: { action, at: Math.max(Date.now(), (record.pendingTrust?.[agent]?.at ?? 0) + 1) } } };
  });
}

/** Accept only the trust actions this report carried; actions from a later repair remain pending. */
export function settleHookTrust(mycoHome: string, reported: ProvisionRecord['pendingTrust']): void {
  updateProvisionRecord(mycoHome, record => {
    if (record === null || reported === undefined || record.pendingTrust === undefined) return;
    const pendingTrust = Object.fromEntries(Object.entries(record.pendingTrust).filter(([id, trust]) => reported[id]?.at !== trust.at));
    if (Object.keys(pendingTrust).length !== Object.keys(record.pendingTrust).length) return { ...record, pendingTrust };
  });
}

/** Retain captured choices, add discovered registrations and prune metadata under the file lease. */
export function reconcileProvisionAgents(mycoHome: string, provision: Pick<ProvisionRecord, 'version' | 'serverUrl'> & { discovered: readonly string[] }, uncapturable: ReadonlySet<string>): ProvisionRecord {
  return updateProvisionRecord(mycoHome, before => {
    const agents = [...new Set([...(before?.agents ?? []).filter(agent => !uncapturable.has(agent) || (before?.pendingLogout?.[agent]?.length ?? 0) > 0), ...provision.discovered])].sort();
    return {
      agents, version: before?.version ?? provision.version, serverUrl: before?.serverUrl ?? provision.serverUrl,
      discoverAgents: before?.discoverAgents,
      ...retainedProvisionMetadata(before, agents),
    };
  }, { strict: true });
}

/** Remove an opted-out harness and its registration metadata under the record lease. */
export function forgetProvision(mycoHome: string, agent: string): void {
  updateProvisionRecord(mycoHome, record => {
    if (record === null) return;
    const agents = record.agents.filter((id) => id !== agent);
    return { ...record, agents, ...retainedProvisionMetadata(record, agents) };
  });
}

/** Move only the leaving Deployment's provision record to the surviving default. */
export function reconcileProvisionDeployment(mycoHome: string, leavingUrl: string, nextDefault: string | null, unreconciledAgents: readonly string[] = []): void {
  updateProvisionRecord(mycoHome, record => {
    if (record === null) return;
    const [held, leaving] = [record.serverUrl, leavingUrl].map((url) => deploymentUrl(normalizeMemberServerAddress(url)?.origin ?? url));
    const pendingLogout: NonNullable<ProvisionRecord['pendingLogout']> = Object.fromEntries(Object.entries(record.pendingLogout ?? {}).flatMap(([agent, urls]) => {
      const kept = urls.filter(url => url !== leaving || unreconciledAgents.includes(agent));
      return kept.length === 0 ? [] : [[agent, kept]];
    }));
    for (const agent of record.agents) if (unreconciledAgents.includes(agent)) pendingLogout[agent] = [...new Set([...pendingLogout[agent] ?? [], leaving])].sort();
    const retrying = Object.values(record.pendingLogout ?? {}).some(urls => urls.includes(leaving));
    if (held !== leaving && !(retrying && readDeploymentMembershipResult(held, mycoHome).status === 'missing')) {
      if (JSON.stringify(record.pendingLogout ?? {}) !== JSON.stringify(pendingLogout)) return { ...record, pendingLogout };
      return;
    }
    if (nextDefault !== null) {
      return { ...record, serverUrl: nextDefault, pendingLogout };
    }
    const agents = record.agents.filter(agent => agent in pendingLogout);
    return agents.length === 0 ? null : { ...record, agents, ...retainedProvisionMetadata({ ...record, pendingLogout }, agents) };
  });
}
