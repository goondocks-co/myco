import fs from 'node:fs';
import path from 'node:path';
import { readDefaultDeployment } from '@myco/member/default-deployment.js';
import { legacyMigrationPending } from '@myco/member/legacy-migration.js';
import { deploymentUrl, readDeploymentMembershipResult, readRegistryEntryResult } from '@myco/member/registry.js';
import { ServerClient } from '@myco/member/transport.js';
import { postRoute } from '@myco/cli/deployment-reader.js';
import { memberHarnessCurrent } from '@myco/cli/member.js';
import { runnerServiceContact } from '@myco/cli/runner-service.js';
import { executorServiceTarget, type WorkerServiceDeps } from '@myco/cli/worker-service.js';
import { isLiveRunner, readRunnerRecord } from '@myco/runner/runner-registry.js';
import { workerServiceInstalled, workerServiceSpec } from '@myco/runner/service.js';
import { servicePaths } from '@myco/server/service.js';
import { signInState } from '@myco/server/github-app.js';
import { detectMachineInstalledSymbionts } from '@myco/symbionts/detect.js';
import { provisionRecordPath, readProvisionRecord } from '@myco/symbionts/member-provision-record.js';
import { getPluginVersion } from '@myco/version.js';
import type { SetupAnswers } from '@myco/setup/answers.js';

export interface Observation {
  id: string;
  scope: string;
  state: 'absent' | 'incomplete' | 'complete' | 'unavailable';
  detail: string;
  informational?: boolean;
}
export interface ObserveDeps {
  checkRemote?: boolean;
  fetch?: typeof fetch;
  agents?: () => string[];
  packageRoot?: string;
  worker?: WorkerServiceDeps;
}
export const setupExitCode = (facts: readonly Observation[]): 0 | 3 | 4 => facts.some((fact) => fact.state === 'unavailable') ? 4
  : facts.some((fact) => !fact.informational && fact.state !== 'complete') ? 3 : 0;

/** File-only by default; remote observations neither renew credentials nor contact a service manager. */
export async function observeSetup(home: string, answers: SetupAnswers, deps: ObserveDeps = {}): Promise<Observation[]> {
  const facts: Observation[] = [];
  const url = answers.url;
  const add = (id: string, state: Observation['state'], detail: string, scope = url ?? home, informational = false): void => {
    facts.push({ id, scope, state, detail, ...(informational ? { informational } : {}) });
  };
  const read = async (id: string, fn: () => void | Promise<void>): Promise<void> => {
    try { await fn(); }
    catch (error) { add(id, 'unavailable', error instanceof Error ? error.message : String(error)); }
  };
  await read('legacy', () => add('legacy', legacyMigrationPending(home) ? 'incomplete' : 'complete',
    'Legacy migration checked through legacyMigrationPending; pending migration requires myco cutover --dry-run.', home));
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
    add('machine.backlog', 'incomplete', 'Not checked: the backlog reader takes locks. Use myco member status; myco member drain retries delivery.', url, true);
  }
  if (answers.role === 'runner' || answers.runWork) {
    await read('runner.enrollment', async () => {
      const record = readRunnerRecord(url, home);
      add('runner.enrollment', isLiveRunner(record) ? 'complete' : record === null ? 'absent' : 'incomplete', isLiveRunner(record) ? `live: ${record.name}` : record === null ? 'none' : 'pending');
      if (deps.checkRemote && isLiveRunner(record)) {
        const answer = await runnerServiceContact(url, { ...deps.worker, mycoHome: home, fetch: deps.fetch, renew: false });
        if (answer.class === 'acked') {
          const runner = answer.body.runner;
          const state = runner !== null && typeof runner === 'object' ? Reflect.get(runner, 'state') : undefined;
          add('runner.authority', state === 'enabled' ? 'complete' : state === 'paused' ? 'incomplete' : 'unavailable', typeof state === 'string' ? state : 'Unreadable runner authority.');
        } else add('runner.authority', answer.class === 'unauthorized' || answer.class === 'refused' ? 'incomplete' : 'unavailable',
          answer.class === 'refused' ? answer.code : answer.class);
      }
      add('runner.service.choice', answers.runnerService ? 'complete' : 'absent', answers.runnerService ?? 'unasked');
      if (answers.runnerService === 'skip') {
        add('runner.service', 'complete', 'declined');
        add('runner.offer', 'complete', 'Service declined; start with myco runner run when ready.', url, true);
        return;
      }
      const target = executorServiceTarget(url, { ...deps.worker, mycoHome: home }, 'runner');
      const installed = workerServiceInstalled(target);
      add('runner.service', installed ? 'incomplete' : 'absent', installed ? 'installed; runtime unchecked (myco runner status)' : 'not-installed');
      const unitFile = servicePaths(workerServiceSpec(target, []), target.platform).unitFile;
      const threshold = installed ? fs.statSync(unitFile).mtimeMs : Infinity;
      const offer = record?.lastOffer;
      add('runner.offer', offer && offer.observedAt >= threshold && offer.offered.length > 0 ? 'complete' : 'incomplete',
        offer === undefined ? 'none' : offer.observedAt < threshold ? 'historical' : `offered ${offer.offered.join(', ') || 'none'}; observed ${new Date(offer.observedAt).toISOString()}`);
    });
  }
  return facts;
}
