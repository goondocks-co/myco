import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { expandHome } from '@myco/paths/home.js';
import { atomicWriteFileSync } from '@myco/utils/atomic-write.js';
import { getPluginVersion } from '@myco/version.js';
import type { SymbiontManifest } from '@myco/symbionts/manifest-schema.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { isBinaryOnPath, loadManifests } from '@myco/symbionts/detect.js';
import { readProvisionRecord, recordProvision, holdHookTrust, settleHookTrust, type ProvisionRecord } from '@myco/symbionts/member-provision-record.js';
import { provisionGlobally, registeredMemberHarnesses, memberHarnessCurrent, provisionBackup } from '@myco/cli/member.js';
import type { ProvisionedHarnessFact } from '@goondocks/myco-shared/harness-health';
import { deadlineBudget, canStartRequest, subRequestBudget } from '@myco/member/budget.js';
import { readDeploymentFeaturesStrict } from '@myco/member/context-cache.js';
import { listRegistryEntries, deploymentUrl, type RegistryEntry } from '@myco/member/registry.js';
import { ServerClient, classifyEventAnswer, type FetchLike } from '@myco/member/transport.js';
import { HARNESS_HEALTH_FEATURE } from '@goondocks/myco-shared/harness-health';

export const REPAIR_LOCK = 'keep-current.lock';
const REPORT_CAP_MS = 2_000;
export const HARNESS_REPORT_WINDOW_MS = 8_000;

export interface KeepCurrentResult {
  serverUrl: string;
  harnesses: ProvisionedHarnessFact[];
  ready: string[];
  pendingTrust?: ProvisionRecord['pendingTrust'];
}

/** The newest file mtime in the manifest's own activity locations; session contents are never read. */
export function harnessRanAt(manifest: SymbiontManifest): number | undefined {
  let newest: number | undefined;
  const visit = (location: string): void => {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(location); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(location)) visit(path.join(location, child));
    } else if (stat.isFile()) newest = Math.max(newest ?? 0, Math.trunc(stat.mtimeMs));
  };
  for (const location of manifest.health?.activityLocations ?? []) visit(expandHome(location));
  return newest;
}

function installEvidence(manifest: SymbiontManifest, binaryFound: (binary: string) => boolean): boolean {
  return binaryFound(manifest.binary) || (manifest.health?.installLocations ?? []).some((location) => fs.existsSync(expandHome(location)));
}

function rememberState(mycoHome: string, harnesses: ProvisionedHarnessFact[]): void {
  const target = path.join(mycoHome, 'member', 'harness-states.json');
  let before: Record<string, unknown> = {};
  try { before = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const next = Object.fromEntries(harnesses.map(({ id, state, action }) => [id, { state, action }]));
  for (const fact of harnesses) {
    if (fact.action !== undefined && JSON.stringify(before[fact.id]) !== JSON.stringify(next[fact.id])) process.stderr.write(`[myco] keep-current: ${fact.action}\n`);
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
    const discovered = registeredMemberHarnesses(mycoHome, record.serverUrl, { ...deps, exclude: record.agents });
    if (discovered.some((id) => !record!.agents.includes(id))) record = recordProvision(mycoHome, { version: record.version, serverUrl: record.serverUrl, agents: discovered });
    const result: KeepCurrentResult = { serverUrl: record.serverUrl, harnesses: [], ready: [] };
    const manifests = loadManifests();
    for (const id of record.agents) {
      const manifest = manifests.find((m) => m.name === id);
      let state: ProvisionedHarnessFact['state'] = 'ready';
      let action: string | undefined;
      try {
        if (manifest === undefined) throw new Error('This build has no manifest for the provisioned harness');
        const installed = installEvidence(manifest, deps.binaryFound ?? isBinaryOnPath);
        if (installed && !memberHarnessCurrent(id, mycoHome, record.serverUrl, deps)) {
          const backup = provisionBackup(mycoHome);
          try {
            const outcome = provisionGlobally(id, null, mycoHome, { serverUrl: record.serverUrl, packageRoot: deps.packageRoot, backup });
            if (outcome.kind === 'refused') throw Object.assign(new Error(outcome.detail), { code: outcome.code });
            if (outcome.kind === 'unknown') throw new Error('This build cannot provision the harness');
            if (outcome.hooksChanged && manifest.registration?.memberHookTrustAction) holdHookTrust(mycoHome, id, manifest.registration.memberHookTrustAction);
          } finally { backup.pruneUnchanged(); }
        }
        if (installed) result.ready.push(manifest.displayName);
        const pendingTrust = readProvisionRecord(mycoHome)?.pendingTrust?.[id];
        if (pendingTrust !== undefined) {
          state = 'trust_required';
          action = pendingTrust.action;
          result.pendingTrust = { ...result.pendingTrust, [id]: pendingTrust };
        } else if (!installed) {
          state = 'binary_missing';
          action = `Install ${manifest.displayName} again`;
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? ((error as Error).cause as NodeJS.ErrnoException | undefined)?.code;
        state = code === 'EACCES' || code === 'EPERM' || code === 'EROFS' ? 'unwritable' : 'repair_failed';
        action = state === 'unwritable'
          ? `Allow Myco to write ${manifest?.displayName ?? id}'s configuration`
          : `Run myco member provision ${id} to see what needs fixing`;
      }
      let ranAt: number | undefined;
      try { if (manifest !== undefined) ranAt = harnessRanAt(manifest); } catch {
        state = 'repair_failed';
        action = `Allow Myco to inspect ${manifest?.displayName ?? id}'s session times`;
      }
      result.harnesses.push({ id, provisioned: true, state, ...(ranAt === undefined ? {} : { ranAt }), ...(result.pendingTrust?.[id] === undefined ? {} : { hookRepairAt: result.pendingTrust[id].at }), ...(action === undefined ? {} : { action }) });
    }
    if (result.harnesses.every((fact) => fact.state === 'ready' || fact.state === 'trust_required')) recordProvision(mycoHome, { serverUrl: record.serverUrl, agents: [], version: getPluginVersion() });
    rememberState(mycoHome, result.harnesses);
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
  const body = JSON.stringify({ harnesses: result.harnesses });
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  const hashPath = path.join(mycoHome, 'member', `harness-report-${crypto.createHash('sha256').update(deploymentUrl(result.serverUrl)).digest('hex')}.sha256`);
  const acquired = LifecycleLock.acquire(`${hashPath}.lock`, { command: 'myco member harness report' });
  if (!acquired.acquired) return;
  try {
    const advertised = readDeploymentFeaturesStrict(entry, mycoHome).includes(HARNESS_HEALTH_FEATURE);
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
