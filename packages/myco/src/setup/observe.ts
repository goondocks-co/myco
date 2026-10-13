import fs from 'node:fs';
import path from 'node:path';
import { readDefaultDeployment } from '@myco/member/default-deployment.js';
import { legacyMigrationState } from '@myco/member/legacy-migration.js';
import { deploymentUrl, listDeploymentMembershipsResult, listRegistryEntriesResult, readDeploymentMembershipResult, readRegistryEntryResult } from '@myco/member/registry.js';
import { ServerClient } from '@myco/member/transport.js';
import { postRoute } from '@myco/cli/deployment-reader.js';
import { memberHarnessCurrent } from '@myco/cli/member.js';
import type { WorkerServiceDeps } from '@myco/cli/worker-service.js';
import { observationInstant, observeProjectCapture, observeRunnerService } from '@myco/cli/home-observations.js';
import { isLiveRunner, listRunnerRecordsResult, readRunnerRecord } from '@myco/runner/runner-registry.js';
import { signInState } from '@myco/server/github-app.js';
import { detectMachineInstalledSymbionts } from '@myco/symbionts/detect.js';
import { provisionRecordPath, readProvisionRecord } from '@myco/symbionts/member-provision-record.js';
import { getPluginVersion } from '@myco/version.js';
import { legacyCaptureGuidance } from '@myco/cli/legacy-capture.js';
import type { SetupAnswers } from '@myco/setup/answers.js';
import { inspectLocal, type LocalLifecycleDeps } from '@myco/server/local-lifecycle.js';
import { peekDeploymentRecord } from '@myco/server/cloudflare.js';
import { cloudflareOwnerLinked, type CloudflareOwnerOptions } from '@myco/server/cloudflare-owner.js';
import { peekLocalPaths } from '@myco/server/local.js';

export interface Observation {
  id: string;
  scope: string;
  state: 'absent' | 'incomplete' | 'complete' | 'unavailable';
  detail: string;
  informational?: boolean;
  hint?: string;
  deployment?: string;
  hooksDeployment?: string;
  joinedDeployments?: string[];
  legacyError?: string;
  capture?: { waiting?: number | null; nextProbeAt?: number; recentRefusals?: number; unreadableLines?: number };
  target?: 'cloudflare' | 'local';
}
export interface ObserveDeps {
  checkRemote?: boolean;
  fetch?: typeof fetch;
  agents?: () => string[];
  packageRoot?: string;
  worker?: WorkerServiceDeps;
  now?: () => number;
  includeCapture?: boolean;
  status?: boolean;
  local?: LocalLifecycleDeps;
  cloudflare?: Omit<CloudflareOwnerOptions, 'accountId'>;
}
export const setupExitCode = (facts: readonly Observation[]): 0 | 3 | 4 => facts.some((fact) => fact.state === 'unavailable') ? 4
  : facts.some((fact) => !fact.informational && fact.state !== 'complete') ? 3 : 0;

/** Local files and service-manager queries; status remote checks never renew credentials. */
export async function observeSetup(home: string, answers: SetupAnswers, deps: ObserveDeps = {}): Promise<Observation[]> {
  answers = { ...answers };
  const facts: Observation[] = [];
  let observedUrl = answers.url;
  const add = (id: string, state: Observation['state'], detail: string, scope = observedUrl ?? home, informational = false, capture?: Observation['capture']): void => {
    facts.push({ id, scope, state, detail, ...(answers.role === 'create' && answers.target ? { target: answers.target } : {}), ...(informational ? { informational } : {}), ...(capture ? { capture } : {}) });
  };
  const read = async (id: string, fn: () => void | Promise<void>, informational = false): Promise<void> => {
    try { await fn(); }
    catch (error) { add(id, 'unavailable', error instanceof Error ? error.message : String(error), observedUrl ?? home, informational); }
  };
  await read('legacy', () => {
    const migration = legacyMigrationState(home);
    const guidance = legacyCaptureGuidance(migration);
    facts.push({
      id: 'legacy',
      ...(migration.state === 'unavailable' ? { legacyError: migration.detail } : {}),
      scope: migration.state === 'unavailable' ? migration.file : home,
      state: guidance.status === 'unavailable' ? 'unavailable' : guidance.status === 'deferred' ? 'incomplete' : 'complete',
      detail: [migration.state, guidance.deferral ?? guidance.hint ?? 'No Myco 1.4 capture blocks setup.', guidance.warning].filter(Boolean).join(' '),
      ...(guidance.hint === null ? {} : { hint: guidance.hint }),
    });
  });
  if (answers.role === 'create') {
    if (answers.target === 'local') await read('deployment.create', async () => {
      const local = await inspectLocal(home, { ...deps.local, fetchImpl: deps.fetch ?? deps.local?.fetchImpl, checkRemote: deps.checkRemote === true });
      answers.url = observedUrl = local.url;
      const state = (value: typeof local.creation | typeof local.signIn | typeof local.owner, complete: string): Observation['state'] =>
        typeof value === 'object' ? 'unavailable' in value ? 'unavailable' : 'incomplete' : value === complete ? 'complete' : value === 'absent' || value === 'none' ? 'absent' : 'incomplete';
      for (const [id, value, complete] of [['deployment.create', local.creation, 'complete'], ['deployment.signin', local.signIn, 'configured'], ['deployment.owner', local.owner, 'linked']] as const) {
        add(id, state(value, complete), typeof value === 'object' ? JSON.stringify(value) : value, home);
      }
      add('deployment.serving', local.serving.mode !== 'stopped' && (!deps.checkRemote || local.serving.healthy) ? 'complete' : 'incomplete', local.serving.mode, home);
    });
    if (answers.target === 'cloudflare') await read('deployment.create', async () => {
      const record = peekDeploymentRecord(home);
      if (record !== null && (!record.accountId || !record.workerName || !record.databaseName || !record.bucketName)) throw new Error('Cloudflare record is malformed; restore it before running myco setup again.');
      if (record && answers.accountId && record.accountId !== answers.accountId) throw new Error('Selected Cloudflare account does not match the Deployment record; keep its --account-id.');
      const complete = record?.databaseId && record.storeId && record.versionId && record.url;
      answers.url = observedUrl = record?.url;
      add('deployment.create', record === null ? 'absent' : complete ? 'complete' : 'incomplete', record === null ? 'No Cloudflare Deployment recorded.' : complete ? 'Cloudflare Deployment recorded.' : 'Cloudflare creation is incomplete.', answers.accountId ?? home);
      if (complete && deps.checkRemote && !deps.status) await read('deployment.owner', async () => {
        const linked = await cloudflareOwnerLinked({ ...deps.cloudflare, mycoHome: home, accountId: record.accountId });
        add('deployment.owner', linked ? 'complete' : 'incomplete', linked ? 'linked' : 'Owner linking remains.');
      });
      else add('deployment.owner', 'incomplete', 'Owner linking is not checked by status. Run myco setup --create cloudflare to check it with your operator login.', answers.accountId ?? home, true);
    });
  }
  const url = observedUrl;
  add('journey', answers.role && url ? 'complete' : 'absent', answers.role ?? 'Choose --create cloudflare|local, --join <address> or --runner <address>.', home);
  if ((!url || !answers.role) && !deps.status) return facts;
  await read('default', () => {
    const held = readDefaultDeployment(home, { strict: true });
    add('default', held === null ? 'absent' : 'complete', held?.serverUrl ?? 'No Default Deployment selected.', home, true);
  });
  if (deps.checkRemote && url && (answers.role !== 'create' || answers.target !== 'local' || facts.some(fact => fact.id === 'deployment.serving' && fact.state === 'complete'))) {
    await read('deployment.health', async () => {
      const healthy = await new ServerClient({ serverUrl: url, token: '' }, deps.fetch).health({ connectTimeoutMs: 2000, requestTimeoutMs: 2000 });
      add('deployment.health', healthy ? 'complete' : 'unavailable', healthy ? 'Deployment answers.' : 'Deployment unreachable or unhealthy.');
    });
    if (answers.role === 'join' || (answers.role === 'create' && answers.target === 'cloudflare')) await read('deployment.signin', async () => {
      const signin = await signInState(url, deps.fetch);
      add('deployment.signin', signin.kind === 'configured' ? 'complete' : signin.kind === 'absent' ? 'absent' : 'unavailable',
        signin.kind === 'configured' ? 'GitHub sign-in configured.' : signin.reason);
    });
  }
  if (((answers.role === 'join' || answers.role === 'create') && url) || (deps.status && fs.existsSync(provisionRecordPath(home)))) {
    await read('machine.agents', () => {
      if (facts.some((fact) => fact.id === 'legacy' && fact.state === 'incomplete')) { add('machine.agents', 'incomplete', 'deferred-legacy'); return; }
      const record = readProvisionRecord(home);
      if (record === null && fs.existsSync(provisionRecordPath(home))) throw new Error(`${provisionRecordPath(home)}: cannot read provision record`);
      const hooksUrl = deps.status && record !== null ? deploymentUrl(record.serverUrl) : url;
      if (hooksUrl === undefined) throw new Error('No Deployment address is available for agent hooks.');
      const same = record !== null && deploymentUrl(record.serverUrl) === hooksUrl;
      if ((answers.noAgents && (!deps.status || record === null)) || (same && record.agents.length === 0)) { add('machine.agents', 'complete', 'declined'); return; }
      const agents = (deps.agents ?? (() => detectMachineInstalledSymbionts().map((manifest) => manifest.name)))();
      if (agents.length === 0) { add('machine.agents', 'complete', 'none-installed'); return; }
      const current = same && record.version === getPluginVersion()
        && agents.every((agent) => record.agents.includes(agent) && memberHarnessCurrent(agent, home, hooksUrl, deps));
      add('machine.agents', current ? 'complete' : record === null ? 'absent' : 'incomplete', current ? 'current' : 'stale');
      if (deps.status && record !== null) facts[facts.length - 1].hooksDeployment = record.serverUrl;
    });
  }
  if (!url || !answers.role) return facts;
  if (answers.role === 'join' || answers.role === 'create') {
    add('runner.choice', answers.runWork === undefined ? 'absent' : 'complete', answers.runWork === undefined ? 'unasked' : answers.runWork ? 'run-work' : 'declined', url, deps.status && answers.runWork === undefined);
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
    const root = answers.root;
    await read('project', () => {
      if (!root) {
        const listing = listRegistryEntriesResult(home);
        if (!listing.readable || listing.unavailableEntries > 0) throw new Error('Repository bindings could not all be read.');
        const count = listing.entries.filter(entry => deploymentUrl(entry.serverUrl) === url).length;
        add('project', count > 0 ? 'complete' : 'absent', count > 0 ? `${count} ${count === 1 ? 'repository sends' : 'repositories send'} to ${url}` : 'Choose a repository with --root, and --project or --new.', url, answers.role === 'create');
        return;
      }
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
          `${readable ? `${facts.spool.unacknowledgedTotal} event(s) waiting to deliver` : 'Spool or acknowledgement unavailable'}; last delivery ${facts.spool.lastDeliveryAt === null ? 'unknown' : new Date(facts.spool.lastDeliveryAt).toISOString()}. Run myco member drain from this repository to retry delivery.`, entry.root, true, { waiting: readable ? facts.spool.unacknowledgedTotal : null });
        add('machine.latch', !facts.latchReadable ? 'unavailable' : facts.latch === null ? 'complete' : 'incomplete',
          !facts.latchReadable ? 'Offline latch unavailable.' : facts.latch === null ? 'Delivery is not held off.' : `Delivery held off; next probe ${new Date(facts.latch.nextProbeAt).toISOString()}. Run myco member drain from this repository.`, entry.root, true, facts.latch === null ? {} : { nextProbeAt: facts.latch.nextProbeAt });
        const refusals = facts.refusalHistory;
        add('machine.refusals', !refusals.readable ? 'unavailable' : refusals.unreadableLines > 0 || refusals.recent > 0 ? 'incomplete' : 'complete',
          `${refusals.readable ? `${refusals.total} refused event(s); newest ${observationInstant(refusals.latest)}; ${refusals.recent} in the last 7 days; ${refusals.unreadableLines} unreadable log lines` : 'Refusal log unavailable'}. Run myco logs from this repository.`, entry.root, true, { recentRefusals: refusals.recent, unreadableLines: refusals.unreadableLines });
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

/** Status derives journeys from membership and runner records, independent of saved progress. */
export async function observeSetupStatus(home: string, answers: SetupAnswers, deps: ObserveDeps = {}, selected = false): Promise<Observation[]> {
  const journeys: SetupAnswers[] = [];
  const failures: Observation[] = [];
  const unavailable = (id: string, detail: string): void => {
    failures.push({ id, scope: home, state: 'unavailable', detail });
  };
  const memberships = listDeploymentMembershipsResult(home);
  if (!memberships.readable || memberships.unavailableEntries > 0) unavailable('machine.signin', 'Deployment memberships could not all be read. Inspect the membership files with myco doctor.');
  const homeFact = (fact: Observation): Observation => fact.id === 'default'
    ? { ...fact, joinedDeployments: memberships.memberships.map(membership => deploymentUrl(membership.serverUrl)) } : fact;
  if (selected && answers.role && (answers.url || answers.role === 'create')) journeys.push(answers);
  else {
    try {
      const record = peekDeploymentRecord(home);
      if (record !== null) journeys.push({ role: 'create', target: 'cloudflare' });
    } catch (error) { unavailable('deployment.create', error instanceof Error ? error.message : String(error)); }
    try {
      if (fs.lstatSync(peekLocalPaths(home).root, { throwIfNoEntry: false }) !== undefined) journeys.push({ role: 'create', target: 'local' });
    } catch (error) { unavailable('deployment.create', error instanceof Error ? error.message : String(error)); }
    for (const membership of memberships.memberships) journeys.push({ role: 'join', url: deploymentUrl(membership.serverUrl) });
    const runners = listRunnerRecordsResult(home);
    for (const runner of runners.records) journeys.push({ role: 'runner', url: deploymentUrl(runner.serverUrl) });
    for (const error of runners.errors) unavailable('runner.enrollment', `Runner record could not be read: ${error}. Run myco runner status.`);
    if (answers.role && (answers.url || answers.role === 'create') && !journeys.some(journey => journey.role === answers.role && (answers.role === 'create' ? journey.target === answers.target : journey.url === answers.url))) journeys.push(answers);
  }
  if (journeys.length === 0) {
    const observed = await observeSetup(home, {}, { ...deps, status: true });
    return [...observed.filter(fact => failures.length === 0 || fact.id !== 'journey').map(homeFact), ...failures];
  }
  const facts: Observation[] = [];
  for (const journey of journeys) {
    const saved = journey.role === 'create'
      ? answers.role === 'create' && answers.target === journey.target ? answers : {}
      : answers.url === undefined || answers.url === journey.url ? answers : {};
    const scoped = { ...saved, ...journey, root: answers.root };
    const observed = await observeSetup(home, scoped, { ...deps, status: true });
    const address = journey.role === 'create' ? observed.find(fact => fact.id === 'machine.signin')?.scope : journey.url;
    for (const fact of observed) {
      const homeWide = ['legacy', 'default', 'machine.agents'].includes(fact.id);
      if (homeWide && facts.some(existing => existing.id === fact.id)) continue;
      if (facts.some(existing => existing.id === fact.id && existing.scope === fact.scope && existing.deployment === journey.url && fact.id.startsWith('runner.') && fact.id !== 'runner.choice')) continue;
      facts.push({ ...fact, ...(homeWide ? {} : { deployment: address }),
        ...(!selected && fact.id === 'project' && fact.detail.startsWith('bound-elsewhere:') ? { informational: true } : {}),
      });
    }
  }
  return [...facts.map(homeFact), ...failures];
}
