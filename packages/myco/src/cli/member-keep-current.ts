import { MemberProvisionConflictError, MemberMcpConflictError, MemberStaleRegistrationError } from '@myco/symbionts/installer.js';
import { joinSentences } from '@myco/utils/sentences.js';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import { harnessToolsElsewhere } from '@goondocks/myco-shared/setup-guidance';
import { expandHome, resolveMycoHome } from '@myco/paths/home.js';
import { atomicWriteFileSync } from '@myco/utils/atomic-write.js';
import { getPluginVersion } from '@myco/version.js';
import type { SymbiontManifest } from '@myco/symbionts/manifest-schema.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { isBinaryOnPath, loadManifests } from '@myco/symbionts/detect.js';
import { readProvisionRecord, recordProvision, settleHookTrust, type ProvisionRecord } from '@myco/symbionts/member-provision-record.js';
import { provisionGlobally, managedMemberHarnesses, memberHarnessStatus, provisionBackup } from '@myco/cli/member.js';
import type { ProvisionedHarnessFact } from '@goondocks/myco-shared/harness-health';
import { deadlineBudget, canStartRequest, subRequestBudget } from '@myco/member/budget.js';
import { readDeploymentFeaturesStrict } from '@myco/member/context-cache.js';
import { listRegistryEntries, deploymentUrl, type RegistryEntry } from '@myco/member/registry.js';
import { ServerClient, classifyEventAnswer, type FetchLike } from '@myco/member/transport.js';
import { readHarnessActivity } from '@myco/symbionts/harness-activity.js';
import { HARNESS_HEALTH_FEATURE, HARNESS_HELD_ELSEWHERE_FEATURE } from '@goondocks/myco-shared/harness-health';

export const REPAIR_LOCK = 'keep-current.lock';
const REPORT_CAP_MS = 2_000;
export const HARNESS_REPORT_WINDOW_MS = 8_000;

export interface KeepCurrentResult {
  serverUrl: string;
  harnesses: ProvisionedHarnessFact[];
  ready: string[];
  localActions?: Record<string, string>;
  pendingTrust?: ProvisionRecord['pendingTrust'];
}

/** The newest recent interactive session's time, excluding Myco worker identities. */
export function harnessRanAt(manifest: SymbiontManifest, mycoHome = resolveMycoHome(), now = Date.now()): number | undefined {
  return readHarnessActivity(manifest, mycoHome, now);
}

function installEvidence(manifest: SymbiontManifest, binaryFound: (binary: string) => boolean): boolean {
  return binaryFound(manifest.binary) || (manifest.health?.installLocations ?? []).some((location) => fs.existsSync(expandHome(location)));
}

function rememberState(mycoHome: string, result: KeepCurrentResult): void {
  const { harnesses, localActions } = result;
  const target = path.join(mycoHome, 'member', 'harness-states.json');
  let before: Record<string, unknown> = {};
  try { before = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const next = Object.fromEntries(harnesses.map(({ id, state, action, toolsDeployment }) => [id, { state, action, toolsDeployment, ...(localActions?.[id] === undefined ? {} : { localAction: localActions[id] }) }]));
  for (const fact of harnesses) {
    const words = localActions?.[fact.id] ?? (fact.state === 'held_elsewhere' ? harnessToolsElsewhere(loadManifests().find((m) => m.name === fact.id)?.displayName ?? fact.id, os.hostname(), fact.toolsDeployment!) : fact.action);
    if (words !== undefined && JSON.stringify(before[fact.id]) !== JSON.stringify(next[fact.id])) process.stderr.write(`[myco] keep-current: ${words}\n`);
  }
  if (JSON.stringify(before) !== JSON.stringify(next)) atomicWriteFileSync(target, JSON.stringify(next));
}

/** Repair the recorded harnesses through provisioning, serialized across this home's project helpers. */
export function keepCurrent(mycoHome: string, deps: { binaryFound?: (binary: string) => boolean; packageRoot?: string } = {}): KeepCurrentResult | null {
  let record = readProvisionRecord(mycoHome);
  if (record === null) return null;
  const acquired = LifecycleLock.acquire(path.join(mycoHome, 'member', REPAIR_LOCK), { command: 'myco member keep-current' });
  if (!acquired.acquired) return null;
  try {
    const discovered = managedMemberHarnesses(mycoHome, record.serverUrl, deps);
    if (discovered.some((id) => !record!.agents.includes(id))) record = recordProvision(mycoHome, { version: record.version, serverUrl: record.serverUrl, agents: discovered });
    const result: KeepCurrentResult = { serverUrl: record.serverUrl, harnesses: [], ready: [] };
    const manifests = loadManifests();
    for (const id of discovered) {
      const manifest = manifests.find((m) => m.name === id);
      let state: ProvisionedHarnessFact['state'] = 'ready';
      let action: string | undefined;
      let toolsDeployment: string | undefined;
      try {
        if (manifest === undefined) throw new Error('This build has no manifest for the provisioned harness');
        const installed = installEvidence(manifest, deps.binaryFound ?? isBinaryOnPath);
        let status = installed ? memberHarnessStatus(id, mycoHome, record.serverUrl, deps) : { current: false };
        if (installed && !status.current) {
          const backup = provisionBackup(mycoHome);
          try {
            const outcome = provisionGlobally(id, null, mycoHome, { serverUrl: record.serverUrl, packageRoot: deps.packageRoot, backup, preserveOtherMemberTools: true });
            if (outcome.kind === 'refused') throw Object.assign(new Error(outcome.detail), { code: outcome.code });
            if (outcome.kind === 'unknown') throw new Error('This build cannot provision the harness');
          } finally { backup.pruneUnchanged(); }
          status = memberHarnessStatus(id, mycoHome, record.serverUrl, deps);
          if (!status.current) {
            if (status.stale?.length) throw new MemberStaleRegistrationError(status.stale);
            throw new Error('Capture configuration is still incomplete');
          }
        }
        if (status.toolsDeployment !== undefined) {
          state = 'held_elsewhere';
          toolsDeployment = status.toolsDeployment;
        }
        if (installed) result.ready.push(manifest.displayName);
        const pendingTrust = readProvisionRecord(mycoHome)?.pendingTrust?.[id];
        if (pendingTrust !== undefined) {
          state = 'trust_required';
          toolsDeployment = undefined;
          action = pendingTrust.action;
          result.pendingTrust = { ...result.pendingTrust, [id]: pendingTrust };
        } else if (!installed) {
          state = 'binary_missing';
          action = `Install ${manifest.displayName} again`;
        }
      } catch (error) {
        toolsDeployment = undefined;
        const code = (error as NodeJS.ErrnoException).code ?? ((error as Error).cause as NodeJS.ErrnoException | undefined)?.code;
        state = code === 'EACCES' || code === 'EPERM' || code === 'EROFS' ? 'unwritable' : 'repair_failed';
        action = state === 'unwritable'
          ? `Allow Myco to write ${manifest?.displayName ?? id}'s configuration`
          : error instanceof MemberStaleRegistrationError ? error.message
          : error instanceof MemberMcpConflictError && error.repairAction !== undefined ? error.repairAction
          : `Run myco doctor to check ${manifest?.displayName ?? id}'s capture configuration`;
        if (error instanceof MemberProvisionConflictError) {
          const remedy = state !== 'unwritable' && error instanceof MemberMcpConflictError ? error.localRemedy ?? action : action;
          (result.localActions ??= {})[id] = error instanceof MemberStaleRegistrationError ? error.problem : joinSentences(error.problem, remedy);
        }
      }
      let ranAt: number | undefined;
      try { if (manifest !== undefined) ranAt = harnessRanAt(manifest, mycoHome); } catch {
        state = 'repair_failed';
        delete result.localActions?.[id];
        toolsDeployment = undefined;
        action = `Can't tell whether ${manifest?.displayName ?? id} ran; open it and check access to its session store`;
      }
      result.harnesses.push({ id, provisioned: true, state, ...(toolsDeployment === undefined ? {} : { toolsDeployment }), ...(ranAt === undefined ? {} : { ranAt }), ...(result.pendingTrust?.[id] === undefined ? {} : { hookRepairAt: result.pendingTrust[id].at }), ...(action === undefined ? {} : { action }) });
    }
    if (result.harnesses.every((fact) => fact.state === 'ready' || fact.state === 'trust_required' || fact.state === 'held_elsewhere')) recordProvision(mycoHome, { serverUrl: record.serverUrl, agents: [], version: getPluginVersion() });
    rememberState(mycoHome, result);
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
  if (!canStartRequest(budget, now())) return;
  const features = readDeploymentFeaturesStrict(entry, mycoHome);
  const harnesses = features.includes(HARNESS_HELD_ELSEWHERE_FEATURE) ? result.harnesses : result.harnesses.filter((fact) => fact.state !== 'held_elsewhere');
  const body = JSON.stringify({ harnesses });
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  const hashPath = path.join(mycoHome, 'member', `harness-report-${crypto.createHash('sha256').update(deploymentUrl(result.serverUrl)).digest('hex')}.sha256`);
  const acquired = LifecycleLock.acquire(`${hashPath}.lock`, { command: 'myco member harness report' });
  if (!acquired.acquired) return;
  try {
    const advertised = features.includes(HARNESS_HEALTH_FEATURE);
    const featureStatePath = `${hashPath}.feature`;
    const state = advertised ? 'advertised' : 'missing';
    let previous: string | undefined;
    try { previous = fs.readFileSync(featureStatePath, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (previous !== state) {
      atomicWriteFileSync(featureStatePath, state);
      if (!advertised) process.stderr.write(`[myco] keep-current: harness report skipped for ${deploymentUrl(result.serverUrl)} (${HARNESS_HEALTH_FEATURE} not advertised)\n`);
    }
    if (!advertised) return;
    try { if (fs.readFileSync(hashPath, 'utf8') === digest) return; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const answer = classifyEventAnswer(await new ServerClient(entry, deps.fetch).request('POST', '/members/harnesses/report', {
      body, headers: { 'content-type': 'application/json' },
      budget: subRequestBudget(budget, REPORT_CAP_MS, now()),
    }));
    if (answer.class === 'acked') {
      settleHookTrust(mycoHome, result.pendingTrust);
      atomicWriteFileSync(hashPath, digest);
    } else process.stderr.write(`[myco] keep-current: harness report not delivered (${answer.class}); the next helper pass retries\n`);
  } finally { acquired.lock.release(); }
}
