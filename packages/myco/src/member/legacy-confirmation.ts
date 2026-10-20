import path from 'node:path';
import { LEGACY_HISTORY_MAX_EVENTS, LEGACY_HISTORY_PATH, type LegacyHistoryIdentities } from '@goondocks/myco-shared/member-protocol';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { completedLegacyDestination, completedLegacyVault, legacyMigrationState, readCutoverState, updateCutoverState, type LegacyMigrationState } from './legacy-migration.js';
import { LegacyMigrationUnreadable, legacyProjectNames, legacyRealpath, legacySources, legacyVaultProjectIds, legacyVaultStamp } from './legacy-sources.js';
import { readVaultContent } from './legacy-backup.js';
import { legacyContentSessionIds, legacyVaultCompletionIdentities, readLegacyVault } from './legacy-import.js';
import { deploymentKeyFor, deploymentUrl, listDeploymentMembershipsResult, listRegistryEntriesResult } from './registry.js';
import { ensureMemberDir, ensurePrivateFile, memberRoot } from './store.js';
import { classifyEventAnswer, ServerClient, type FetchLike, type Outcome } from './transport.js';

const CONFIRMATION_BUDGET_MS = 5000;
const DEPLOYMENT_IDENTITY_PATH = '/members/status';
export interface LegacyConfirmationDeps { fetch?: FetchLike; now?: () => number; homeDir?: string; homes?: readonly string[] }
type Confirmation = NonNullable<LegacyMigrationState['confirmation']>;
const CONFIRMATION_PRIORITY: readonly Confirmation[] = ['not-found', 'no-destination', 'project-missing', 'busy', 'pending', 'unavailable', 'update-required', 'sign-in-required', 'ambiguous'];
const preferredConfirmation = (left: Confirmation, right: Confirmation): Confirmation =>
  CONFIRMATION_PRIORITY.indexOf(left) >= CONFIRMATION_PRIORITY.indexOf(right) ? left : right;

type Proof = { state: 'confirmed'; eventIds: string[]; sporeIds: string[]; lineageIds: string[]; projectState?: 'active' | 'archived' | 'deleted' } | { state: Confirmation };

function proofBatches(source: LegacyHistoryIdentities): LegacyHistoryIdentities[] {
  const batches: LegacyHistoryIdentities[] = [];
  let batch: LegacyHistoryIdentities = { eventGroups: [], recordIds: [], sporeIds: [], lineageIds: [] };
  let size = 0;
  const add = (count: number, append: () => void) => {
    if (size + count > LEGACY_HISTORY_MAX_EVENTS) { batches.push(batch); batch = { eventGroups: [], recordIds: [], sporeIds: [], lineageIds: [] }; size = 0; }
    append(); size += count;
  };
  for (const group of source.eventGroups) add(group.length, () => batch.eventGroups.push(group));
  for (const id of source.recordIds ?? []) add(1, () => batch.recordIds!.push(id));
  for (const id of source.sporeIds ?? []) add(1, () => batch.sporeIds!.push(id));
  for (const id of source.lineageIds ?? []) add(1, () => batch.lineageIds!.push(id));
  if (size > 0) batches.push(batch);
  return batches;
}

const ids = (value: unknown): value is string[] => Array.isArray(value) && value.every(id => typeof id === 'string');

function confirmationFailure(answer: Exclude<Outcome, { class: 'acked' }>): Confirmation {
  if (answer.class === 'unauthorized') return 'sign-in-required';
  if (answer.class === 'slow' || answer.class === 'deferred') return 'pending';
  if (answer.class === 'refused') return (answer.serverCode ?? answer.code) === 'no_project' ? 'project-missing' : 'update-required';
  return ['route_missing', 'protocol'].includes(answer.class) ? 'update-required' : 'unavailable';
}

type EvidenceReader = (body: LegacyHistoryIdentities) => Promise<Outcome>;
type DeploymentIdentity = { state: 'known'; id: string } | { state: 'pending' | 'update-required' };

function membershipFailure(answer: Outcome): Confirmation | null {
  if (answer.class === 'unauthorized') return 'sign-in-required';
  if (answer.class === 'route_missing' || answer.class === 'protocol') return 'update-required';
  if (answer.class === 'retry' && answer.status === undefined) return 'unavailable';
  return null;
}

/** Each bounded batch has its own budget, including on large vaults. */
function evidenceReader(client: ServerClient, failed?: (state: Confirmation) => void): EvidenceReader {
  return async body => {
    const answer = await client.postPersisted(LEGACY_HISTORY_PATH, body, { connectTimeoutMs: CONFIRMATION_BUDGET_MS, requestTimeoutMs: CONFIRMATION_BUDGET_MS, capped: true });
    const probe = body.projectState === true && body.eventGroups.length === 0
      && body.recordIds === undefined && body.sporeIds === undefined
      && body.lineageIds === undefined && body.sessions === undefined;
    const failure = answer.class === 'slow' && probe ? 'pending' : membershipFailure(answer);
    if (failure !== null) failed?.(failure);
    return answer;
  };
}

async function readDeploymentIdentity(client: ServerClient): Promise<DeploymentIdentity> {
  const answer = classifyEventAnswer(await client.request('POST', DEPLOYMENT_IDENTITY_PATH, { scope: 'deployment', body: '{}',
    budget: { connectTimeoutMs: CONFIRMATION_BUDGET_MS, requestTimeoutMs: CONFIRMATION_BUDGET_MS, capped: true } }));
  if (answer.class !== 'acked') return { state: 'pending' };
  return typeof answer.body.deploymentId === 'string' && answer.body.deploymentId.length > 0
    ? { state: 'known', id: answer.body.deploymentId } : { state: 'update-required' };
}

export function legacyDestinationEnd(client: ServerClient): Promise<'active' | 'project_archived' | 'project_deleted' | Confirmation> {
  return destinationEnd(evidenceReader(client));
}

async function destinationEnd(read: EvidenceReader): Promise<'active' | 'project_archived' | 'project_deleted' | Confirmation> {
  const answer = await read({ eventGroups: [], projectState: true });
  if (answer.class !== 'acked') {
    if (confirmationFailure(answer) === 'project-missing') return 'project_deleted';
    return confirmationFailure(answer);
  }
  return answer.body.projectState === 'archived' ? 'project_archived' : answer.body.projectState === 'deleted' ? 'project_deleted'
    : answer.body.projectState === 'active' ? 'active' : 'update-required';
}

async function transcriptSources(read: EvidenceReader, sessions: string[]): Promise<Set<string> | Confirmation> {
  const transcripts = new Set<string>();
  for (let start = 0; start < sessions.length; start += LEGACY_HISTORY_MAX_EVENTS) {
    const offered = sessions.slice(start, start + LEGACY_HISTORY_MAX_EVENTS);
    const answer = await read({ eventGroups: [], sessions: offered });
    if (answer.class !== 'acked') return confirmationFailure(answer);
    if (answer.body.confirmed === false) return 'not-found';
    const sources = answer.body.sources as { withTranscript?: unknown; vaultSourced?: unknown } | undefined;
    if (!sources || !ids(sources.withTranscript) || !ids(sources.vaultSourced)) return 'update-required';
    for (const id of offered) if (sources.withTranscript.includes(id) && !sources.vaultSourced.includes(id)) transcripts.add(id);
  }
  return transcripts;
}

async function confirmHistory(read: EvidenceReader, source: LegacyHistoryIdentities): Promise<Proof> {
  const batches = proofBatches(source);
  if (batches.length === 0) return { state: 'not-found' };
  const confirmed = { eventIds: new Set<string>(), sporeIds: new Set<string>(), lineageIds: new Set<string>() };
  let projectState: 'active' | 'archived' | 'deleted' | undefined;
  for (const batch of batches) {
    const answer = await read({ ...batch, projectState: true });
    if (answer.class !== 'acked') return { state: confirmationFailure(answer) };
    const eventIds = answer.body.eventIds;
    const recordIds = answer.body.recordIds ?? [];
    const sporeIds = answer.body.sporeIds ?? [];
    const lineageIds = answer.body.lineageIds ?? [];
    if (answer.body.confirmed !== true || !ids(eventIds) || !ids(recordIds) || !ids(sporeIds) || !ids(lineageIds)
      || !batch.eventGroups.every(group => group.some(id => eventIds.includes(id)))
      || !batch.recordIds!.every(id => recordIds.includes(id)) || !batch.sporeIds!.every(id => sporeIds.includes(id)) || !batch.lineageIds!.every(id => lineageIds.includes(id))) return { state: 'not-found' };
    if (answer.body.projectState === 'active' || answer.body.projectState === 'archived' || answer.body.projectState === 'deleted') projectState = answer.body.projectState;
    for (const id of batch.eventGroups.flat().filter(id => eventIds.includes(id))) confirmed.eventIds.add(id);
    for (const id of batch.recordIds!) confirmed.eventIds.add(id);
    for (const id of batch.sporeIds!) confirmed.sporeIds.add(id);
    for (const id of batch.lineageIds!) confirmed.lineageIds.add(id);
  }
  return { state: 'confirmed', eventIds: [...confirmed.eventIds].sort(), sporeIds: [...confirmed.sporeIds].sort(), lineageIds: [...confirmed.lineageIds].sort(), projectState };
}

/** Each command shares one confirmation attempt; later observations read the current local receipt. */
export function legacyConfirmationObserver() {
  const attempts = new Map<string, Promise<LegacyMigrationState>>();
  return async (home: string, deps: LegacyConfirmationDeps = {}): Promise<LegacyMigrationState> => {
    const key = JSON.stringify([home, deps.homeDir, deps.homes]);
    let attempt = attempts.get(key);
    if (attempt === undefined) { attempt = observeLegacyMigration(home, deps); attempts.set(key, attempt); }
    const result = await attempt;
    const fresh = legacyMigrationState(home, deps);
    return ['unmoved', 'needs-destination', 'partial', 'handover-pending'].includes(fresh.state) ? { ...fresh, confirmation: result.confirmation, confirmationProjects: result.confirmationProjects } : fresh;
  };
}

function confirmationRegistry(home: string) {
  const members = listDeploymentMembershipsResult(home);
  const routes = listRegistryEntriesResult(home);
  if (!members.readable || members.unavailableEntries > 0 || !routes.readable || routes.unavailableEntries > 0) {
    throw new LegacyMigrationUnreadable(memberRoot(home), 'memberships or Project routes could not all be read');
  }
  return { memberships: members.memberships, bindings: routes.entries };
}

/** Confirm an earlier move from source identities; a completed receipt needs no network. */
export async function observeLegacyMigration(home: string, deps: LegacyConfirmationDeps = {}): Promise<LegacyMigrationState> {
  const initial = legacyMigrationState(home, deps);
  if (!['unmoved', 'needs-destination', 'partial', 'handover-pending'].includes(initial.state)) return initial;
  const state = readCutoverState(home);
  const { memberships, bindings } = confirmationRegistry(home);
  const sources = legacySources(home, { homeDir: deps.homeDir, homes: deps.homes });
  const results = new Map<string, { projectId: string; confirmation: Confirmation }>();
  const failures = new Map<string, Confirmation>();
  const identities = new Map<string, DeploymentIdentity>();
  const names = legacyProjectNames(sources.vaults.flatMap(source => legacyVaultProjectIds(source.path).map(projectId => ({
    vault: source.path, projectId, root: state.migrations?.[source.path]?.projects[projectId]?.root,
  }))));
  const report = (vault: string, projectId: string, confirmation: Confirmation) => {
    const key = JSON.stringify([vault, projectId]);
    results.set(key, { projectId, confirmation: preferredConfirmation(results.get(key)?.confirmation ?? 'not-found', confirmation) });
  };
  for (const source of sources.vaults) {
    const prior = Object.entries(state.migrations ?? {}).find(([file]) => legacyRealpath(file) === source.path)?.[1];
    const ids = legacyVaultProjectIds(source.path);
    const candidates = ids.flatMap(projectId => {
      const previous = prior?.projects[projectId];
      if (previous?.destination !== undefined && (!prior || completedLegacyDestination(prior, previous) !== null
        || !('serverUrl' in previous.destination) || !completedLegacyVault(previous.vault))) return [];
      const routes = bindings.filter(binding => binding.projectId === projectId);
      const urls = new Set(previous?.destination && 'serverUrl' in previous.destination
        ? [deploymentUrl(previous.destination.serverUrl)] : routes.map(binding => deploymentUrl(binding.serverUrl)));
      const fallback = urls.size !== 1;
      if (previous === undefined && urls.size === 0) return [];
      const eligible = memberships.filter(member => urls.size === 0 || urls.has(deploymentUrl(member.serverUrl)))
        .sort((left, right) => Number(routes.some(route => deploymentUrl(route.serverUrl) === deploymentUrl(right.serverUrl)))
          - Number(routes.some(route => deploymentUrl(route.serverUrl) === deploymentUrl(left.serverUrl)))
          || deploymentUrl(left.serverUrl).localeCompare(deploymentUrl(right.serverUrl)));
      if (eligible.length === 0) { report(source.path, projectId, urls.size > 0 ? 'sign-in-required' : 'no-destination'); return []; }
      return [{ projectId, routes, fallback, eligible }];
    });
    if (candidates.length === 0) continue;
    const content = readVaultContent(source.path);
    const backup = Object.entries(state.backups).find(([file]) => legacyRealpath(file) === source.path)?.[1];
    if (backup !== undefined && backup.digest !== content.digest) continue;
    let projects: ReturnType<typeof readLegacyVault> | undefined;
    for (const choice of candidates) {
      const confirmed: Array<{ deploymentId: string; membership: typeof memberships[number]; proof: Extract<Proof, { eventIds: string[] }>; endedBy: 'project_archived' | 'project_deleted' | null; ignoredLineage: number }> = [];
      let failure: Confirmation | undefined;
      const recordFailure = (state: Confirmation) => {
        failure = preferredConfirmation(failure ?? 'not-found', state);
      };
      let identityFailure: Confirmation | undefined;
      let asked = false;
      for (const membership of choice.eligible) {
        const url = deploymentUrl(membership.serverUrl);
        const cachedFailure = failures.get(url);
        if (cachedFailure !== undefined) { recordFailure(cachedFailure); continue; }
        const previous = prior?.projects[choice.projectId];
        const candidate = { projectId: choice.projectId, membership };
        const client = new ServerClient({ ...candidate.membership, projectId: candidate.projectId }, deps.fetch);
        const read = evidenceReader(client, state => failures.set(url, state));
        if (choice.fallback) {
          const destination = await destinationEnd(read);
          if (destination === 'project_deleted' || destination === 'project-missing') continue;
          if (destination !== 'active' && destination !== 'project_archived') { recordFailure(destination); continue; }
        }
        const project = (projects ??= readLegacyVault(source.path)).find(project => project.projectId === candidate.projectId);
        if (project === undefined) continue;
        asked = true;
        let endedBy: 'project_archived' | 'project_deleted' | null = null;
        let proof: Proof;
        let ignoredLineage = previous?.evidence?.ignoredLineage ?? 0;
        if (completedLegacyVault(previous?.vault) && !choice.fallback) {
          const destination = await destinationEnd(read);
          if (destination === 'active') continue;
          if (destination !== 'project_archived' && destination !== 'project_deleted') { recordFailure(destination); continue; }
          endedBy = destination;
          proof = { state: 'confirmed', eventIds: [], sporeIds: [], lineageIds: [] };
        } else {
          const transcripts = await transcriptSources(read, legacyContentSessionIds(project, candidate.membership.machineId));
          if (typeof transcripts === 'string') { recordFailure(transcripts); continue; }
          const identities = legacyVaultCompletionIdentities(project, candidate.membership.machineId, transcripts);
          ignoredLineage = identities.ignoredLineage;
          proof = await confirmHistory(read, identities);
          if (proof.state === 'confirmed') endedBy = proof.projectState === 'archived' ? 'project_archived' : proof.projectState === 'deleted' ? 'project_deleted' : null;
        }
        if (proof.state !== 'confirmed') { recordFailure(proof.state); continue; }
        let deploymentId = url;
        if (choice.fallback) {
          const identity = identities.get(url) ?? await readDeploymentIdentity(client);
          identities.set(url, identity);
          if (identity.state !== 'known') {
            identityFailure = preferredConfirmation(identityFailure ?? 'not-found', identity.state);
            continue;
          }
          deploymentId = identity.id;
        }
        confirmed.push({ deploymentId, membership, proof, endedBy, ignoredLineage });
      }
      const destinations = [...new Map([...confirmed].reverse().map(candidate => [candidate.deploymentId, candidate])).values()];
      if (destinations.length !== 1 || identityFailure !== undefined) {
        report(source.path, choice.projectId, destinations.length > 1 ? 'ambiguous' : identityFailure ?? failure ?? (asked || prior?.projects[choice.projectId] === undefined ? 'not-found' : 'no-destination'));
        continue;
      }
      const { membership: provenMembership, proof, endedBy, ignoredLineage } = destinations[0]!;
      const candidate = { projectId: choice.projectId, membership: provenMembership };
      const previous = prior?.projects[candidate.projectId];
      ensureMemberDir(memberRoot(home), home);
      const lockFile = path.join(memberRoot(home), 'cutover.lock');
      ensurePrivateFile(lockFile);
      const lease = LifecycleLock.acquire(lockFile);
      if (!lease.acquired) { report(source.path, candidate.projectId, 'busy'); continue; }
      try {
        updateCutoverState(home, fresh => {
          const registry = confirmationRegistry(home);
          const membership = registry.memberships.find(member => deploymentUrl(member.serverUrl) === deploymentUrl(candidate.membership.serverUrl));
          const routes = registry.bindings.filter(binding => binding.projectId === candidate.projectId);
          const existing = fresh.migrations?.[source.path]?.projects[candidate.projectId];
          const recorded = existing?.destination && 'serverUrl' in existing.destination ? existing.destination.serverUrl : null;
          const differentRoute = routes.some(route => deploymentUrl(route.serverUrl) !== deploymentUrl(candidate.membership.serverUrl)
            && ((recorded === null && !choice.fallback) || !choice.routes.some(priorRoute => priorRoute.root === route.root && deploymentUrl(priorRoute.serverUrl) === deploymentUrl(route.serverUrl))));
          const newMembership = choice.fallback && registry.memberships.some(member =>
            (choice.routes.length === 0 || choice.routes.some(route => deploymentUrl(route.serverUrl) === deploymentUrl(member.serverUrl)))
            && !choice.eligible.some(priorMember => deploymentUrl(priorMember.serverUrl) === deploymentUrl(member.serverUrl) && priorMember.machineId === member.machineId));
          if (membership?.machineId !== candidate.membership.machineId || differentRoute || newMembership || (recorded === null
            ? !choice.fallback && routes.length === 0
            : deploymentUrl(recorded) !== deploymentUrl(candidate.membership.serverUrl))) { report(source.path, candidate.projectId, 'pending'); return false; }
          const stamp = legacyVaultStamp(source.path);
          if (readVaultContent(source.path).digest !== content.digest) { report(source.path, candidate.projectId, 'unavailable'); return false; }
          fresh.version = 2;
          fresh.migrations ??= {};
          const receipt = fresh.migrations[source.path] ?? { digest: content.digest, size: stamp.size, mtimeMs: stamp.mtimeMs, wal: stamp.wal, projects: Object.fromEntries(ids.map(id => [id, {}])) };
          if (receipt.digest !== content.digest || (receipt.projects[candidate.projectId]?.destination !== undefined && (!endedBy || !completedLegacyVault(receipt.projects[candidate.projectId]?.vault)))) return false;
          const at = (deps.now ?? Date.now)();
          const routedRoot = routes.find(route => deploymentUrl(route.serverUrl) === deploymentUrl(candidate.membership.serverUrl))?.root ?? null;
          receipt.projects[candidate.projectId] = { ...receipt.projects[candidate.projectId], root: choice.fallback ? routedRoot : previous?.root ?? routedRoot,
            destination: { serverUrl: deploymentUrl(candidate.membership.serverUrl), key: deploymentKeyFor(candidate.membership.serverUrl) },
            vault: { state: 'complete', at },
            ...(endedBy === null ? {} : { transcripts: { state: 'none' as const, at, endedBy } }),
            ...(completedLegacyVault(previous?.vault) && !choice.fallback ? {} : { evidence: { kind: 'deployment', at, machineId: candidate.membership.machineId, eventIds: proof.eventIds, sporeIds: proof.sporeIds, lineageIds: proof.lineageIds, ...(ignoredLineage > 0 ? { ignoredLineage } : {}) } }) };
          fresh.migrations[source.path] = receipt;
          return true;
        });
      } finally { lease.lock.release(); }
    }
  }
  const observed = legacyMigrationState(home, deps);
  return ['unmoved', 'needs-destination', 'partial', 'handover-pending'].includes(observed.state)
    ? { ...observed, confirmation: [...results.values()].reduce((result, project) => preferredConfirmation(result, project.confirmation), 'not-found' as Confirmation),
      confirmationProjects: [...results.values()].map(project => ({ name: names.get(project.projectId)!, confirmation: project.confirmation })) } : observed;
}
