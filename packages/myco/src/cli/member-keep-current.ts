import path from 'node:path';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { isBinaryOnPath, loadManifests } from '@myco/symbionts/detect.js';
import { readProvisionRecord, recordProvision, holdHookTrust, settleHookTrust, type ProvisionRecord } from '@myco/symbionts/member-provision-record.js';
import { provisionGlobally, registeredMemberHarnesses } from '@myco/cli/member.js';
import type { ProvisionedHarnessFact } from '@goondocks/myco-shared/harness-health';
import { deadlineBudget, canStartRequest, subRequestBudget } from '@myco/member/budget.js';
import { readProjectContext } from '@myco/member/context-cache.js';
import { spoolDirFor } from '@myco/member/spool.js';
import { listRegistryEntries, deploymentUrl, type RegistryEntry } from '@myco/member/registry.js';
import { ServerClient, classifyEventAnswer, type FetchLike } from '@myco/member/transport.js';
import { HARNESS_HEALTH_FEATURE } from '@goondocks/myco-shared/harness-health';

const REPAIR_LOCK = 'keep-current.lock';
const REPORT_CAP_MS = 2_000;
export const HARNESS_REPORT_WINDOW_MS = 8_000;

export interface KeepCurrentResult {
  serverUrl: string;
  harnesses: ProvisionedHarnessFact[];
  ready: string[];
  pendingTrust?: ProvisionRecord['pendingTrust'];
}

/** Repair the recorded harnesses through provisioning, serialized across this home's project helpers. */
export function keepCurrent(mycoHome: string, deps: { binaryFound?: (binary: string) => boolean; packageRoot?: string } = {}): KeepCurrentResult | null {
  let record = readProvisionRecord(mycoHome);
  if (record === null) return null;
  const acquired = LifecycleLock.acquire(path.join(mycoHome, 'member', REPAIR_LOCK), { command: 'myco member keep-current' });
  if (!acquired.acquired) return null;
  try {
    const discovered = registeredMemberHarnesses(mycoHome, record.serverUrl, deps);
    if (discovered.some((id) => !record!.agents.includes(id))) record = recordProvision(mycoHome, { version: record.version, serverUrl: record.serverUrl, agents: discovered });
    const result: KeepCurrentResult = { serverUrl: record.serverUrl, harnesses: [], ready: [] };
    const manifests = loadManifests();
    for (const id of record.agents) {
      const manifest = manifests.find((m) => m.name === id);
      let state: ProvisionedHarnessFact['state'] = 'ready';
      let action: string | undefined;
      try {
        if (manifest === undefined) throw new Error('This build has no manifest for the provisioned harness');
        const outcome = provisionGlobally(id, null, mycoHome, { serverUrl: record.serverUrl, packageRoot: deps.packageRoot });
        if (outcome.kind === 'refused') throw Object.assign(new Error(outcome.detail), { code: outcome.code });
        if (outcome.kind === 'unknown') throw new Error('This build cannot provision the harness');
        result.ready.push(manifest.displayName);
        if (outcome.hooksChanged && manifest.registration?.memberHookTrustAction) holdHookTrust(mycoHome, id, manifest.registration.memberHookTrustAction);
        const pendingTrust = readProvisionRecord(mycoHome)?.pendingTrust?.[id];
        if (!(deps.binaryFound ?? isBinaryOnPath)(manifest.binary)) {
          state = 'binary_missing';
          action = `Install ${manifest.displayName} again`;
        } else if (pendingTrust !== undefined) {
          state = 'trust_required';
          action = pendingTrust.action;
          result.pendingTrust = { ...result.pendingTrust, [id]: pendingTrust };
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        state = code === 'EACCES' || code === 'EPERM' || code === 'EROFS' ? 'unwritable' : 'repair_failed';
        action = state === 'unwritable'
          ? `Allow Myco to write ${manifest?.displayName ?? id}'s configuration`
          : `Run myco member provision ${id} to see what needs fixing`;
        process.stderr.write(`[myco] keep-current: ${manifest?.displayName ?? id}: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      result.harnesses.push({ id, provisioned: true, state, ...(action === undefined ? {} : { action }) });
      if (action !== undefined) process.stderr.write(`[myco] keep-current: ${action}\n`);
    }
    return result;
  } finally { acquired.lock.release(); }
}

/** Report only to a Deployment that advertised the additive harness-health surface; delivery has its own capped share. */
export async function reportHarnesses(result: KeepCurrentResult | null, mycoHome: string, deadline: number, deps: {
  fetch?: FetchLike; now?: () => number; entry?: RegistryEntry;
} = {}): Promise<void> {
  if (result === null) return;
  const now = deps.now ?? Date.now;
  const entry = deps.entry ?? listRegistryEntries(mycoHome).find((candidate) => deploymentUrl(candidate.serverUrl) === deploymentUrl(result.serverUrl));
  if (entry === undefined || deploymentUrl(entry.serverUrl) !== deploymentUrl(result.serverUrl)) return;
  const budget = deadlineBudget(deadline);
  if (!canStartRequest(budget, now()) || !readProjectContext(spoolDirFor(entry.projectId, mycoHome)).features.includes(HARNESS_HEALTH_FEATURE)) return;
  const answer = classifyEventAnswer(await new ServerClient(entry, deps.fetch).request('POST', '/members/harnesses/report', {
    body: JSON.stringify({ harnesses: result.harnesses }), headers: { 'content-type': 'application/json' },
    budget: subRequestBudget(budget, REPORT_CAP_MS, now()),
  }));
  if (answer.class === 'acked') settleHookTrust(mycoHome, result.pendingTrust);
  else process.stderr.write(`[myco] keep-current: harness report not delivered (${answer.class}); the next helper pass retries\n`);
}
