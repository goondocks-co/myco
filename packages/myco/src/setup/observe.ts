import fs from 'node:fs';
import path from 'node:path';
import { readDefaultDeployment } from '@myco/member/default-deployment.js';
import { legacyMigrationState } from '@myco/member/legacy-migration.js';
import { deploymentUrl, listRegistryEntriesResult, readDeploymentMembershipResult, readRegistryEntryResult } from '@myco/member/registry.js';
import { ServerClient } from '@myco/member/transport.js';
import { postRoute } from '@myco/cli/deployment-reader.js';
import { memberHarnessCurrent } from '@myco/cli/member.js';
import type { WorkerServiceDeps } from '@myco/cli/worker-service.js';
import { observationInstant, observeProjectCapture, observeRunnerService } from '@myco/cli/home-observations.js';
import { isLiveRunner, readRunnerRecord } from '@myco/runner/runner-registry.js';
import { signInState } from '@myco/server/github-app.js';
import { detectMachineInstalledSymbionts } from '@myco/symbionts/detect.js';
import { provisionRecordPath, readProvisionRecord } from '@myco/symbionts/member-provision-record.js';
import { getPluginVersion } from '@myco/version.js';
import { legacyCaptureGuidance } from '@myco/cli/legacy-capture.js';
import type { SetupAnswers } from '@myco/setup/answers.js';

export interface Observation {
  id: string;
  scope: string;
  state: 'absent' | 'incomplete' | 'complete' | 'unavailable';
  detail: string;
  informational?: boolean;
  hint?: string;
}
export interface ObserveDeps {
  checkRemote?: boolean;
  fetch?: typeof fetch;
  agents?: () => string[];
  packageRoot?: string;
  worker?: WorkerServiceDeps;
  now?: () => number;
  includeCapture?: boolean;
}
export const setupExitCode = (facts: readonly Observation[]): 0 | 3 | 4 => facts.some((fact) => fact.state === 'unavailable') ? 4
  : facts.some((fact) => !fact.informational && fact.state !== 'complete') ? 3 : 0;

/** Local files and service-manager queries; remote checks never renew credentials. */
export async function observeSetup(home: string, answers: SetupAnswers, deps: ObserveDeps = {}): Promise<Observation[]> {
  const facts: Observation[] = [];
  const url = answers.url;
  const add = (id: string, state: Observation['state'], detail: string, scope = url ?? home, informational = false): void => {
    facts.push({ id, scope, state, detail, ...(informational ? { informational } : {}) });
  };
  const read = async (id: string, fn: () => void | Promise<void>, informational = false): Promise<void> => {
    try { await fn(); }
    catch (error) { add(id, 'unavailable', error instanceof Error ? error.message : String(error), url ?? home, informational); }
  };
  await read('legacy', () => {
    const migration = legacyMigrationState(home);
    const guidance = legacyCaptureGuidance(migration);
    facts.push({
      id: 'legacy',
      scope: migration.state === 'unavailable' ? migration.file : home,
      state: guidance.status === 'unavailable' ? 'unavailable' : guidance.status === 'deferred' ? 'incomplete' : 'complete',
      detail: [migration.state, guidance.deferral ?? guidance.hint ?? 'No Myco 1.4 capture blocks setup.', guidance.warning].filter(Boolean).join(' '),
      ...(guidance.hint === null ? {} : { hint: guidance.hint }),
    });
  });
  add('journey', answers.role && url ? 'complete' : 'absent', answers.role ?? 'Choose --join <address> or --runner <address>.', home);
  if (!url || !answers.role) return facts;
  await read('default', () => {
    const held = readDefaultDeployment(home, { strict: true });
    add('default', held === null ? 'absent' : 'complete', held?.serverUrl ?? 'No Default Deployment selected.', home, true);
  });
  if (deps.checkRemote) {
    await read('deployment.health', async () => {
      const healthy = await new ServerClient({ serverUrl: url, token: '' }, deps.fetch).health({ connectTimeoutMs: 2000, requestTimeoutMs: 2000 });
      add('deployment.health', healthy ? 'complete' : 'unavailable', healthy ? 'Deployment answers.' : 'Deployment unreachable or unhealthy.');
    });
    if (answers.role === 'join') await read('deployment.signin', async () => {
      const signin = await signInState(url, deps.fetch);
      add('deployment.signin', signin.kind === 'configured' ? 'complete' : signin.kind === 'absent' ? 'absent' : 'unavailable',
        signin.kind === 'configured' ? 'GitHub sign-in configured.' : signin.reason);
    });
  }
  if (answers.role === 'join') {
    add('runner.choice', answers.runWork === undefined ? 'absent' : 'complete', answers.runWork === undefined ? 'unasked' : answers.runWork ? 'run-work' : 'declined');
    await read('machine.signin', async () => {
      const membership = readDeploymentMembershipResult(url, home);
      add('machine.signin', membership.status === 'present' ? 'complete' : membership.status === 'missing' ? 'absent' : 'unavailable',
        membership.status === 'unavailable' ? membership.reason : membership.status);
      if (deps.checkRemote && membership.status === 'present') {
        const answer = await postRoute(new ServerClient(membership.membership, deps.fetch), { connectTimeoutMs: 2000, requestTimeoutMs: 2000 }, '/members/status', {});
        add('machine.credential', answer.ok ? 'complete' : answer.error.code === 'unauthorized' ? 'incomplete' : 'unavailable',
          answer.ok ? 'Credential accepted.' : answer.error.code);
      }
    });
    await read('machine.agents', () => {
      if (facts.some((fact) => fact.id === 'legacy' && fact.state === 'incomplete')) { add('machine.agents', 'incomplete', 'deferred-legacy'); return; }
      const record = readProvisionRecord(home);
      if (record === null && fs.existsSync(provisionRecordPath(home))) throw new Error(`${provisionRecordPath(home)}: cannot read provision record`);
      const same = record !== null && deploymentUrl(record.serverUrl) === url;
      if (answers.noAgents || (same && record.agents.length === 0)) { add('machine.agents', 'complete', 'declined'); return; }
      const agents = (deps.agents ?? (() => detectMachineInstalledSymbionts().map((manifest) => manifest.name)))();
      if (agents.length === 0) { add('machine.agents', 'complete', 'none-installed'); return; }
      const current = same && record.version === getPluginVersion()
        && agents.every((agent) => record.agents.includes(agent) && memberHarnessCurrent(agent, home, url, deps));
      add('machine.agents', current ? 'complete' : record === null ? 'absent' : 'incomplete', current ? 'current' : 'stale');
    });
    const root = answers.root;
    await read('project', () => {
      if (!root) { add('project', 'absent', 'Choose a repository with --root, and --project or --new.'); return; }
      const binding = readRegistryEntryResult(root, home);
      add('project', binding.status === 'unavailable' ? 'unavailable' : binding.status === 'missing' ? 'absent'
        : deploymentUrl(binding.entry.serverUrl) === url ? 'complete' : 'incomplete',
      binding.status !== 'present' ? binding.status : deploymentUrl(binding.entry.serverUrl) === url ? 'bound-here' : `bound-elsewhere: ${binding.entry.serverUrl}`, root);
    });
    if (deps.includeCapture !== false) await read('machine.backlog', () => {
      const listing = listRegistryEntriesResult(home);
      if (!listing.readable || listing.unavailableEntries > 0) throw new Error('Repository routes could not all be read; capture backlog is unknown.');
      const entries = listing.entries.filter((entry) => deploymentUrl(entry.serverUrl) === url);
      if (entries.length === 0) add('machine.backlog', 'complete', 'No repository capture backlog for this Deployment.', url, true);
      for (const entry of entries) {
        const facts = observeProjectCapture(entry, home, (deps.now ?? Date.now)());
        const readable = facts.spool.readable && facts.spool.stateReadable && facts.spool.unacknowledgedTotal !== null;
        add('machine.backlog', !readable ? 'unavailable' : facts.spool.unacknowledgedTotal === 0 ? 'complete' : 'incomplete',
          `${readable ? `${facts.spool.unacknowledgedTotal} event(s) waiting to deliver` : 'Spool or acknowledgement unavailable'}; last delivery ${facts.spool.lastDeliveryAt === null ? 'unknown' : new Date(facts.spool.lastDeliveryAt).toISOString()}. Run myco member drain from this repository to retry delivery.`, entry.root, true);
        add('machine.latch', !facts.latchReadable ? 'unavailable' : facts.latch === null ? 'complete' : 'incomplete',
          !facts.latchReadable ? 'Offline latch unavailable.' : facts.latch === null ? 'Delivery is not held off.' : `Delivery held off; next probe ${new Date(facts.latch.nextProbeAt).toISOString()}. Run myco member drain from this repository.`, entry.root, true);
        const refusals = facts.refusalHistory;
        add('machine.refusals', !refusals.readable ? 'unavailable' : refusals.unreadableLines > 0 || refusals.recent > 0 ? 'incomplete' : 'complete',
          `${refusals.readable ? `${refusals.total} refused event(s); newest ${observationInstant(refusals.latest)}; ${refusals.recent} in the last 7 days; ${refusals.unreadableLines} unreadable log lines` : 'Refusal log unavailable'}. Run myco logs from this repository.`, entry.root, true);
      }
    }, true);
  }
  if (answers.role === 'runner' || answers.runWork) {
    await read('runner.enrollment', async () => {
      const record = readRunnerRecord(url, home);
      add('runner.enrollment', isLiveRunner(record) ? 'complete' : record === null ? 'absent' : 'incomplete', isLiveRunner(record) ? `live: ${record.name}` : record === null ? 'none' : 'pending');
      if (deps.checkRemote && isLiveRunner(record)) add('runner.authority', 'incomplete',
        'Not checked: runner contact writes Deployment telemetry. Check authority with myco runner status.', url, true);
      add('runner.service.choice', answers.runnerService ? 'complete' : 'absent', answers.runnerService ?? 'unasked');
      if (answers.runnerService === 'skip') {
        add('runner.service', 'complete', 'declined');
        add('runner.offer', 'complete', 'Service declined; start with myco runner run when ready.', url, true);
        return;
      }
      const { state, words, unavailable } = observeRunnerService(url, { ...deps.worker, mycoHome: home });
      add('runner.service', unavailable ? 'unavailable' : state.installed && state.loaded && state.running ? 'complete' : state.installed ? 'incomplete' : 'absent', `${unavailable ? 'Service state unavailable' : words}${state.detail ? ` (${state.detail})` : ''}`);
      const threshold = state.installed && state.serving !== null && state.serving.startedAt > 0
        ? Math.max(fs.statSync(state.unitFile).mtimeMs, state.serving.startedAt * 1000) : Infinity;
      const offer = record?.lastOffer;
      add('runner.offer', offer && offer.observedAt >= threshold && offer.offered.length > 0 ? 'complete' : 'incomplete',
        offer === undefined ? 'none' : offer.observedAt < threshold ? 'historical' : `offered ${offer.offered.join(', ') || 'none'}; observed ${new Date(offer.observedAt).toISOString()}`);
    });
  }
  return facts;
}
