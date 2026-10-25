import { MemberFileReadRefusal, MemberPendingLogoutError, MemberProvisionConflictError, MemberMcpConflictError, MemberStaleRegistrationError, SymbiontInstaller } from '@myco/symbionts/installer.js';
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
import { LifecycleLock, withFileLockSync } from '@myco/utils/lifecycle-lock.js';
import { isBinaryOnPath, loadManifests, resolvePackageRoot } from '@myco/symbionts/detect.js';
import { readProvisionRecord, settleHookTrust, UnreadableProvisionRecordError, type ProvisionRecord } from '@myco/symbionts/member-provision-record.js';
import { provisionGlobally, withManagedMemberHarnesses, memberHarnessStatus, provisionBackup } from '@myco/cli/member.js';
import type { ProvisionedHarnessFact } from '@goondocks/myco-shared/harness-health';
import { deadlineBudget, canStartRequest, subRequestBudget } from '@myco/member/budget.js';
import { updateProvisionRecord } from '@myco/member/provision-record.js';
import { readDeploymentFeatureEvidence, readDeploymentFeaturesStrict } from '@myco/member/context-cache.js';
import { listRegistryEntriesResult, listDeploymentMembershipsResult, deploymentPath, deploymentUrl, type DeploymentMembership, type RegistryEntry } from '@myco/member/registry.js';
import { ServerClient, classifyEventAnswer, type FetchLike } from '@myco/member/transport.js';
import { deploymentHarnessRanAt } from '@myco/symbionts/harness-attribution.js';
import { readHarnessActivity } from '@myco/symbionts/harness-activity.js';
import { HARNESS_HEALTH_FEATURE, HARNESS_DEPLOYMENT_ACTIVITY_FEATURE, HARNESS_HELD_ELSEWHERE_FEATURE } from '@goondocks/myco-shared/harness-health';

export { REPAIR_LOCK } from '@myco/member/keep-current-lock.js';
const REPORT_CAP_MS = 2_000;
export const HARNESS_REPORT_WINDOW_MS = 8_000;

export interface KeepCurrentResult {
  serverUrl: string;
  harnesses: ProvisionedHarnessFact[];
  ready: string[];
  notices?: string[];
  localActions?: Record<string, string>;
  pendingTrust?: ProvisionRecord['pendingTrust'];
}

/** The newest recent interactive session's time, excluding Myco worker identities. */
export function harnessRanAt(manifest: SymbiontManifest, mycoHome = resolveMycoHome(), now = Date.now()): number | undefined {
  return readHarnessActivity(manifest, mycoHome, now);
}

function scopedHarnessFact(fact: ProvisionedHarnessFact, manifest: SymbiontManifest | undefined, mycoHome: string, serverUrl: string, now: number, sourceUrl = serverUrl): ProvisionedHarnessFact {
  const { ranAt: _ranAt, activityScope: _scope, ...original } = fact;
  let base = original;
  if (deploymentUrl(serverUrl) !== deploymentUrl(sourceUrl) && (base.state === 'ready' || base.state === 'held_elsewhere')) {
    const { toolsDeployment: _tools, ...unheld } = base;
    try {
      const status = memberHarnessStatus(base.id, mycoHome, serverUrl, {});
      base = status.toolsDeployment === undefined ? { ...unheld, state: 'ready' } : { ...unheld, state: 'held_elsewhere', toolsDeployment: status.toolsDeployment };
    } catch (error) {
      const action = error instanceof MemberProvisionConflictError ? joinSentences(error.problem, error.remedy) : `Can't inspect ${manifest?.displayName ?? fact.id}'s tools; run myco doctor to check its configuration`;
      base = { ...unheld, state: 'repair_failed', action };
    }
  }
  try {
    if (manifest === undefined) throw new Error('Harness manifest is unavailable');
    const ranAt = deploymentHarnessRanAt(manifest, mycoHome, serverUrl, now);
    return { ...base, activityScope: 'deployment', ...(ranAt === undefined ? {} : { ranAt }) };
  } catch {
    if (base.state === 'trust_required') return { ...base, activityScope: 'unavailable' };
    const { toolsDeployment: _tools, hookRepairAt: _repair, ...unavailable } = base;
    const activityAction = `Can't tell whether ${manifest?.displayName ?? fact.id} ran for this Deployment; run myco doctor to check session access and capture routing`;
    return { ...unavailable, activityScope: 'unavailable', state: 'repair_failed', action: base.action ?? activityAction };
  }
}

function installEvidence(manifest: SymbiontManifest, binaryFound: (binary: string) => boolean): boolean {
  return binaryFound(manifest.binary) || (manifest.health?.installLocations ?? []).some((location) => fs.existsSync(expandHome(location)));
}

function rememberState(mycoHome: string, result: KeepCurrentResult, reportedProblems: ReadonlySet<string>): void {
  const { harnesses, localActions } = result;
  const target = `${harnessReportPath(mycoHome, result.serverUrl)}.states`;
  let before: Record<string, unknown> = {};
  try { before = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const next = Object.fromEntries(harnesses.map(({ id, state, action, toolsDeployment }) => [id, { state, action, toolsDeployment, ...(localActions?.[id] === undefined ? {} : { localAction: localActions[id] }) }]));
  for (const fact of harnesses) {
    const words = localActions?.[fact.id] ?? (fact.state === 'held_elsewhere' ? harnessToolsElsewhere(loadManifests().find((m) => m.name === fact.id)?.displayName ?? fact.id, os.hostname(), fact.toolsDeployment!) : fact.action);
    if (words !== undefined && !reportedProblems.has(fact.id) && JSON.stringify(before[fact.id]) !== JSON.stringify(next[fact.id])) process.stderr.write(`[myco] keep-current: ${words}\n`);
  }
  if (JSON.stringify(before) !== JSON.stringify(next)) atomicWriteFileSync(target, JSON.stringify(next));
  try { fs.unlinkSync(path.join(mycoHome, 'member', 'harness-states.json')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function rememberProvisionProblem(mycoHome: string, problem: string | null): void {
  const target = path.join(mycoHome, 'member', 'provision-problem.json');
  withFileLockSync(`${target}.lock`, () => {
    let before: unknown;
    try { before = JSON.parse(fs.readFileSync(target, 'utf8')); } catch { /* Unreadable diagnostic state is replaced below. */ }
    if (before === problem) return;
    atomicWriteFileSync(target, JSON.stringify(problem));
    if (problem !== null) process.stderr.write(`[myco] keep-current: ${problem}\n`);
  });
}

/** Repair the managed harnesses through provisioning, serialized across this home's project helpers. */
export function keepCurrent(mycoHome: string, deps: { binaryFound?: (binary: string) => boolean; packageRoot?: string; serverUrl?: string; wait?: boolean } = {}): KeepCurrentResult | null {
  try {
    return withManagedMemberHarnesses(mycoHome, { ...deps, onInspectionError: message => process.stderr.write(`[myco] keep-current: ${message}\n`) }, (record, discovered, retiredSettingsProblems) => {
      rememberProvisionProblem(mycoHome, null);
      const result: KeepCurrentResult = { serverUrl: record.serverUrl, harnesses: [], ready: [] };
      const manifests = loadManifests();
      for (const id of discovered) {
        const manifest = manifests.find((m) => m.name === id);
        let state: ProvisionedHarnessFact['state'] = 'ready';
        let action: string | undefined;
        let toolsDeployment: string | undefined;
        let waitingForLogout = false;
        try {
          if (manifest === undefined) throw new Error('This build has no manifest for the provisioned harness');
          new SymbiontInstaller(manifest, mycoHome, deps.packageRoot ?? resolvePackageRoot(), false, mycoHome).withoutProjectRoot().forDeployment(record.serverUrl).assertMemberProvisionAllowed();
          const installed = installEvidence(manifest, deps.binaryFound ?? isBinaryOnPath);
          let status = installed ? memberHarnessStatus(id, mycoHome, record.serverUrl, deps) : { current: false };
          if (installed && (!status.current || record.version !== getPluginVersion())) {
            const backup = provisionBackup(mycoHome);
            try {
              const outcome = provisionGlobally(id, null, mycoHome, { serverUrl: record.serverUrl, packageRoot: deps.packageRoot, backup, preserveOtherMemberTools: true });
              if (outcome.kind === 'refused') throw Object.assign(new Error(outcome.detail), { code: outcome.code });
              if (outcome.kind === 'unknown') throw new Error('This build cannot provision the harness');
              if (outcome.stale?.length) (result.notices ??= []).push(...outcome.stale);
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
          waitingForLogout = error instanceof MemberPendingLogoutError;
          toolsDeployment = undefined;
          const code = (error as NodeJS.ErrnoException).code ?? ((error as Error).cause as NodeJS.ErrnoException | undefined)?.code;
          state = code === 'EACCES' || code === 'EPERM' || code === 'EROFS' ? 'unwritable' : 'repair_failed';
          action = error instanceof MemberFileReadRefusal ? error.remedy : state === 'unwritable'
            ? `Allow Myco to write ${manifest?.displayName ?? id}'s configuration`
            : error instanceof MemberStaleRegistrationError ? error.message
            : error instanceof MemberMcpConflictError && error.repairAction !== undefined ? error.repairAction
            : `Run myco doctor to check ${manifest?.displayName ?? id}'s capture configuration`;
          if (error instanceof MemberProvisionConflictError) {
            const remedy = error instanceof MemberMcpConflictError && (state !== 'unwritable' || error instanceof MemberFileReadRefusal) ? error.localRemedy ?? action : action;
            (result.localActions ??= {})[id] = error instanceof MemberStaleRegistrationError ? error.problem : joinSentences(error.problem, remedy);
          }
        }
        const fact: ProvisionedHarnessFact = { id, provisioned: true, state, ...(toolsDeployment === undefined ? {} : { toolsDeployment }), ...(state !== 'trust_required' || result.pendingTrust?.[id] === undefined ? {} : { hookRepairAt: result.pendingTrust[id].at }), ...(action === undefined ? {} : { action }) };
        result.harnesses.push(waitingForLogout ? fact : scopedHarnessFact(fact, manifest, mycoHome, record.serverUrl, Date.now()));
      }
      if (result.harnesses.length === 0 || result.harnesses.some(fact => fact.state === 'ready' || fact.state === 'trust_required' || fact.state === 'held_elsewhere')) {
        updateProvisionRecord(mycoHome, current => current === null || current.version === getPluginVersion() ? undefined : { ...current, version: getPluginVersion(), at: Date.now() }, { strict: true });
      }
      rememberState(mycoHome, result, retiredSettingsProblems);
      return result;
    });
  } catch (error) {
    if (!(error instanceof UnreadableProvisionRecordError)) throw error;
    rememberProvisionProblem(mycoHome, error.message);
    return null;
  }
}

/** Report only to a Deployment that advertised the additive harness-health surface; delivery has its own capped share. */
export async function reportHarnesses(result: KeepCurrentResult | null, mycoHome: string, deadline: number, deps: {
  fetch?: FetchLike; now?: () => number; entry?: RegistryEntry; serverUrl?: string;
} = {}): Promise<void> {
  if (result === null) return;
  const memberships = listDeploymentMembershipsResult(mycoHome);
  const bindings = listRegistryEntriesResult(mycoHome);
  const registryUnavailable = !memberships.readable || memberships.unavailableEntries > 0 || !bindings.readable || bindings.unavailableEntries > 0 || Boolean(bindings.conflicts?.length);
  const destinations = new Map<string, DeploymentMembership | RegistryEntry>();
  for (const entry of [...bindings.entries, ...memberships.memberships]) destinations.set(deploymentUrl(entry.serverUrl), entry);
  if (deps.entry !== undefined) destinations.set(deploymentUrl(deps.entry.serverUrl), deps.entry);
  const live = [...destinations.values()].filter(entry => !entry.refreshTerminal && memberships.readable && !memberships.unavailableFiles.includes(deploymentPath(entry.serverUrl, mycoHome)));
  const errors: unknown[] = registryUnavailable ? [new Error('Harness reporting memberships or project connections are unavailable')] : [];
  for (const entry of live) {
    const selected = deps.entry?.serverUrl ?? deps.serverUrl;
    if (selected !== undefined && deploymentUrl(entry.serverUrl) !== deploymentUrl(selected)) continue;
    try { await reportHarnessesTo(result, mycoHome, deadline, entry, deps); }
    catch (error) { errors.push(error); }
  }
  if (!registryUnavailable) {
    const required = live.filter(entry => readDeploymentFeatureEvidence(entry, mycoHome)?.includes(HARNESS_HEALTH_FEATURE) !== false);
    const settled = Object.fromEntries(Object.entries(result.pendingTrust ?? {}).filter(([id, trust]) => required.length > 0 && required.every(entry => {
      const file = `${harnessReportPath(mycoHome, entry.serverUrl)}.trust`;
      return readHarnessTrustReceipt(file)?.[id] === trust.at;
    })));
    if (Object.keys(settled).length > 0) settleHookTrust(mycoHome, settled);
  }
  if (errors.length > 0) throw new AggregateError(errors, registryUnavailable ? 'Harness reports have unavailable memberships or project connections; run myco doctor to check them' : 'Harness reports could not reach every Deployment');
}

function readHarnessTrustReceipt(file: string): Record<string, number> | null {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  let accepted: Record<string, number>;
  try { accepted = JSON.parse(raw); } catch { throw new Error('Harness trust receipt is invalid'); }
  if (accepted === null || typeof accepted !== 'object' || Array.isArray(accepted) || Object.values(accepted).some(at => !Number.isSafeInteger(at) || at < 0)) throw new Error('Harness trust receipt is invalid');
  return accepted;
}

function harnessReportPath(mycoHome: string, serverUrl: string): string {
  return path.join(mycoHome, 'member', `harness-report-${crypto.createHash('sha256').update(deploymentUrl(serverUrl)).digest('hex')}.sha256`);
}

async function reportHarnessesTo(result: KeepCurrentResult, mycoHome: string, deadline: number, entry: DeploymentMembership | RegistryEntry, deps: { fetch?: FetchLike; now?: () => number }): Promise<void> {
  const now = deps.now ?? Date.now;
  const budget = deadlineBudget(deadline);
  if (!canStartRequest(budget, now())) return;
  const features = readDeploymentFeaturesStrict(entry, mycoHome);
  const manifests = loadManifests();
  const scoped = result.harnesses.map(fact => scopedHarnessFact(fact, manifests.find(manifest => manifest.name === fact.id), mycoHome, entry.serverUrl, now(), result.serverUrl));
  const admitted = features.includes(HARNESS_HELD_ELSEWHERE_FEATURE) ? scoped : scoped.filter(fact => fact.state !== 'held_elsewhere');
  const harnesses = features.includes(HARNESS_DEPLOYMENT_ACTIVITY_FEATURE) ? admitted : admitted.map(({ activityScope: _scope, ...fact }) => fact);
  const body = JSON.stringify({ harnesses });
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  const hashPath = harnessReportPath(mycoHome, entry.serverUrl);
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
      if (!advertised) process.stderr.write(`[myco] keep-current: harness report skipped for ${deploymentUrl(entry.serverUrl)} (${HARNESS_HEALTH_FEATURE} not advertised)\n`);
    }
    if (!advertised) return;
    const trust = Object.fromEntries(harnesses.flatMap(fact => fact.state === 'trust_required' && fact.hookRepairAt !== undefined ? [[fact.id, fact.hookRepairAt]] : []));
    let trustAcknowledged = Object.keys(trust).length === 0;
    if (!trustAcknowledged) {
      try {
        const accepted = readHarnessTrustReceipt(`${hashPath}.trust`);
        trustAcknowledged = Object.entries(trust).every(([id, at]) => accepted?.[id] === at);
      } catch {
        process.stderr.write('[myco] keep-current: harness trust receipt is unavailable; confirming the report again\n');
      }
    }
    try { if (fs.readFileSync(hashPath, 'utf8') === digest && trustAcknowledged) return; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const answer = classifyEventAnswer(await new ServerClient(entry, deps.fetch).request('POST', '/members/harnesses/report', {
      body, headers: { 'content-type': 'application/json' }, scope: 'deployment',
      budget: subRequestBudget(budget, REPORT_CAP_MS, now()),
    }));
    if (answer.class === 'acked') {
      atomicWriteFileSync(`${hashPath}.trust`, JSON.stringify(trust));
      atomicWriteFileSync(hashPath, digest);
    } else process.stderr.write(`[myco] keep-current: harness report not delivered (${answer.class}); the next helper pass retries\n`);
  } finally { acquired.lock.release(); }
}
