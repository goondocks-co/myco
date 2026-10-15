import path from 'node:path';
import { LEGACY_HISTORY_MAX_EVENTS, LEGACY_HISTORY_PATH, type LegacyHistoryIdentities } from '@goondocks/myco-shared/member-protocol';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { completedLegacyDestination, completedLegacyVault, legacyMigrationState, readCutoverState, updateCutoverState, type LegacyMigrationState } from './legacy-migration.js';
import { LegacyMigrationUnreadable, legacyRealpath, legacySources, legacyVaultProjectIds, legacyVaultStamp } from './legacy-sources.js';
import { readVaultContent } from './legacy-backup.js';
import { legacyContentSessionIds, legacyVaultCompletionIdentities, readLegacyVault } from './legacy-import.js';
import { deploymentKeyFor, deploymentUrl, listDeploymentMembershipsResult, listRegistryEntriesResult } from './registry.js';
import { ensureMemberDir, ensurePrivateFile, memberRoot } from './store.js';
import { ServerClient, type FetchLike, type Outcome } from './transport.js';

const CONFIRMATION_BUDGET_MS = 5000;
export interface LegacyConfirmationDeps { fetch?: FetchLike; now?: () => number; homeDir?: string; homes?: readonly string[] }
type Confirmation = NonNullable<LegacyMigrationState['confirmation']>;
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

/** Each bounded batch has its own budget, including on large vaults. */
const readEvidence = (client: ServerClient, body: LegacyHistoryIdentities) =>
  client.postPersisted(LEGACY_HISTORY_PATH, body, { connectTimeoutMs: CONFIRMATION_BUDGET_MS, requestTimeoutMs: CONFIRMATION_BUDGET_MS, capped: true });

export async function legacyDestinationEnd(client: ServerClient): Promise<'active' | 'project_archived' | 'project_deleted' | Confirmation> {
  const answer = await readEvidence(client, { eventGroups: [], projectState: true });
  if (answer.class !== 'acked') {
    if (confirmationFailure(answer) === 'project-missing') return 'project_deleted';
    return confirmationFailure(answer);
  }
  return answer.body.projectState === 'archived' ? 'project_archived' : answer.body.projectState === 'deleted' ? 'project_deleted'
    : answer.body.projectState === 'active' ? 'active' : 'update-required';
}

async function transcriptSources(client: ServerClient, sessions: string[]): Promise<Set<string> | Confirmation> {
  const transcripts = new Set<string>();
  for (let start = 0; start < sessions.length; start += LEGACY_HISTORY_MAX_EVENTS) {
    const offered = sessions.slice(start, start + LEGACY_HISTORY_MAX_EVENTS);
    const answer = await readEvidence(client, { eventGroups: [], sessions: offered });
    if (answer.class !== 'acked') return confirmationFailure(answer);
    if (answer.body.confirmed === false) return 'not-found';
    const sources = answer.body.sources as { withTranscript?: unknown; vaultSourced?: unknown } | undefined;
    if (!sources || !ids(sources.withTranscript) || !ids(sources.vaultSourced)) return 'update-required';
    for (const id of offered) if (sources.withTranscript.includes(id) && !sources.vaultSourced.includes(id)) transcripts.add(id);
  }
  return transcripts;
}

async function confirmHistory(client: ServerClient, source: LegacyHistoryIdentities): Promise<Proof> {
  const batches = proofBatches(source);
  if (batches.length === 0) return { state: 'not-found' };
  const confirmed = { eventIds: new Set<string>(), sporeIds: new Set<string>(), lineageIds: new Set<string>() };
  let projectState: 'active' | 'archived' | 'deleted' | undefined;
  for (const batch of batches) {
    const answer = await readEvidence(client, { ...batch, projectState: true });
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
    return ['unmoved', 'needs-destination', 'partial', 'handover-pending'].includes(fresh.state) ? { ...fresh, confirmation: result.confirmation } : fresh;
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

/** Confirm an earlier move from source identities at its bound Deployment; a completed receipt needs no network. */
export async function observeLegacyMigration(home: string, deps: LegacyConfirmationDeps = {}): Promise<LegacyMigrationState> {
  const initial = legacyMigrationState(home, deps);
  if (!['unmoved', 'needs-destination', 'partial', 'handover-pending'].includes(initial.state)) return initial;
  const state = readCutoverState(home);
  const { memberships, bindings } = confirmationRegistry(home);
  const sources = legacySources(home, { homeDir: deps.homeDir, homes: deps.homes });
  let confirmation: Confirmation = 'not-found';
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
      if (urls.size !== 1) return [];
      const membership = memberships.find(member => urls.has(deploymentUrl(member.serverUrl)));
      if (membership === undefined) { confirmation = 'sign-in-required'; return []; }
      return [{ projectId, membership, root: previous?.root ?? routes[0]?.root ?? null }];
    });
    if (candidates.length === 0) continue;
    const content = readVaultContent(source.path);
    const backup = Object.entries(state.backups).find(([file]) => legacyRealpath(file) === source.path)?.[1];
    if (backup !== undefined && backup.digest !== content.digest) continue;
    const projects = readLegacyVault(source.path);
    for (const candidate of candidates) {
      const project = projects.find(project => project.projectId === candidate.projectId);
      if (project === undefined) continue;
      const client = new ServerClient({ ...candidate.membership, projectId: candidate.projectId }, deps.fetch);
      const previous = prior?.projects[candidate.projectId];
      let endedBy: 'project_archived' | 'project_deleted' | null = null;
      let proof: Proof;
      let ignoredLineage = previous?.evidence?.ignoredLineage ?? 0;
      if (completedLegacyVault(previous?.vault)) {
        const destination = await legacyDestinationEnd(client);
        if (destination === 'active') continue;
        if (destination !== 'project_archived' && destination !== 'project_deleted') { confirmation = destination; continue; }
        endedBy = destination;
        proof = { state: 'confirmed', eventIds: [], sporeIds: [], lineageIds: [] };
      } else {
        const transcripts = await transcriptSources(client, legacyContentSessionIds(project, candidate.membership.machineId, home));
        if (typeof transcripts === 'string') { confirmation = transcripts; continue; }
        const identities = legacyVaultCompletionIdentities(project, candidate.membership.machineId, home, transcripts);
        ignoredLineage = identities.ignoredLineage;
        proof = await confirmHistory(client, identities);
        if (proof.state === 'confirmed') endedBy = proof.projectState === 'archived' ? 'project_archived' : proof.projectState === 'deleted' ? 'project_deleted' : null;
      }
      if (proof.state !== 'confirmed') { if (proof.state !== 'not-found') confirmation = proof.state; continue; }
      ensureMemberDir(memberRoot(home), home);
      const lockFile = path.join(memberRoot(home), 'cutover.lock');
      ensurePrivateFile(lockFile);
      const lease = LifecycleLock.acquire(lockFile);
      if (!lease.acquired) { confirmation = 'busy'; continue; }
      try {
        updateCutoverState(home, fresh => {
          const registry = confirmationRegistry(home);
          const membership = registry.memberships.find(member => deploymentUrl(member.serverUrl) === deploymentUrl(candidate.membership.serverUrl));
          const routes = registry.bindings.filter(binding => binding.projectId === candidate.projectId);
          const existing = fresh.migrations?.[source.path]?.projects[candidate.projectId];
          const recorded = existing?.destination && 'serverUrl' in existing.destination ? existing.destination.serverUrl : null;
          if (membership?.machineId !== candidate.membership.machineId || (recorded === null
            ? routes.length === 0 || routes.some(route => deploymentUrl(route.serverUrl) !== deploymentUrl(candidate.membership.serverUrl))
            : deploymentUrl(recorded) !== deploymentUrl(candidate.membership.serverUrl))) return false;
          const stamp = legacyVaultStamp(source.path);
          if (readVaultContent(source.path).digest !== content.digest) { confirmation = 'unavailable'; return false; }
          fresh.version = 2;
          fresh.migrations ??= {};
          const receipt = fresh.migrations[source.path] ?? { digest: content.digest, size: stamp.size, mtimeMs: stamp.mtimeMs, wal: stamp.wal, projects: Object.fromEntries(ids.map(id => [id, {}])) };
          if (receipt.digest !== content.digest || (receipt.projects[candidate.projectId]?.destination !== undefined && (!endedBy || !completedLegacyVault(receipt.projects[candidate.projectId]?.vault)))) return false;
          const at = (deps.now ?? Date.now)();
          receipt.projects[candidate.projectId] = { ...receipt.projects[candidate.projectId], root: candidate.root,
            destination: { serverUrl: deploymentUrl(candidate.membership.serverUrl), key: deploymentKeyFor(candidate.membership.serverUrl) },
            vault: { state: 'complete', at },
            ...(endedBy === null ? {} : { transcripts: { state: 'none' as const, at, endedBy } }),
            ...(completedLegacyVault(previous?.vault) ? {} : { evidence: { kind: 'deployment', at, machineId: candidate.membership.machineId, eventIds: proof.eventIds, sporeIds: proof.sporeIds, lineageIds: proof.lineageIds, ...(ignoredLineage > 0 ? { ignoredLineage } : {}) } }) };
          fresh.migrations[source.path] = receipt;
          return true;
        });
      } finally { lease.lock.release(); }
    }
  }
  const observed = legacyMigrationState(home, deps);
  return ['unmoved', 'needs-destination', 'partial', 'handover-pending'].includes(observed.state)
    ? { ...observed, confirmation } : observed;
}
