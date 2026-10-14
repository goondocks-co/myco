import path from 'node:path';
import { LEGACY_HISTORY_MAX_EVENTS, LEGACY_HISTORY_PATH, type LegacyHistoryIdentities } from '@goondocks/myco-shared/member-protocol';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { legacyMigrationState, readCutoverState, updateCutoverState, type LegacyMigrationState } from './legacy-migration.js';
import { LegacyMigrationUnreadable, legacyRealpath, legacySources, legacyVaultProjectIds, legacyVaultStamp } from './legacy-sources.js';
import { readVaultContent } from './legacy-backup.js';
import { legacyVaultCompletionIdentities, readLegacyVault } from './legacy-import.js';
import { deploymentKeyFor, deploymentUrl, listDeploymentMembershipsResult, listRegistryEntriesResult } from './registry.js';
import { ensureMemberDir, ensurePrivateFile, memberRoot } from './store.js';
import { ServerClient, type FetchLike } from './transport.js';

const CONFIRMATION_BUDGET_MS = 5000;
export interface LegacyConfirmationDeps { fetch?: FetchLike; now?: () => number; homeDir?: string; homes?: readonly string[] }
type Confirmation = NonNullable<LegacyMigrationState['confirmation']>;
type Proof = { state: 'confirmed'; eventIds: string[]; sporeIds: string[]; lineageIds: string[] } | { state: Confirmation };

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

async function confirmHistory(client: ServerClient, source: LegacyHistoryIdentities, deadline: number): Promise<Proof> {
  const batches = proofBatches(source);
  if (batches.length === 0) return { state: 'not-found' };
  const confirmed = { eventIds: new Set<string>(), sporeIds: new Set<string>(), lineageIds: new Set<string>() };
  for (const batch of batches) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { state: 'unavailable' };
    const answer = await client.postPersisted(LEGACY_HISTORY_PATH, batch, { connectTimeoutMs: remaining, requestTimeoutMs: remaining });
    if (answer.class !== 'acked') return { state: answer.class === 'refused'
      ? (answer.serverCode ?? answer.code) === 'no_project' ? 'project-missing' : 'update-required'
      : ['route_missing', 'protocol', 'unauthorized'].includes(answer.class) ? 'update-required' : 'unavailable' };
    const eventIds = answer.body.eventIds;
    const recordIds = answer.body.recordIds ?? [];
    const sporeIds = answer.body.sporeIds ?? [];
    const lineageIds = answer.body.lineageIds ?? [];
    const ids = (value: unknown): value is string[] => Array.isArray(value) && value.every(id => typeof id === 'string');
    if (answer.body.confirmed !== true || !ids(eventIds) || !ids(recordIds) || !ids(sporeIds) || !ids(lineageIds)
      || !batch.eventGroups.every(group => group.some(id => eventIds.includes(id)))
      || !batch.recordIds!.every(id => recordIds.includes(id)) || !batch.sporeIds!.every(id => sporeIds.includes(id)) || !batch.lineageIds!.every(id => lineageIds.includes(id))) return { state: 'not-found' };
    for (const id of batch.eventGroups.flat().filter(id => eventIds.includes(id))) confirmed.eventIds.add(id);
    for (const id of batch.recordIds!) confirmed.eventIds.add(id);
    for (const id of batch.sporeIds!) confirmed.sporeIds.add(id);
    for (const id of batch.lineageIds!) confirmed.lineageIds.add(id);
  }
  return { state: 'confirmed', eventIds: [...confirmed.eventIds].sort(), sporeIds: [...confirmed.sporeIds].sort(), lineageIds: [...confirmed.lineageIds].sort() };
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
    return fresh.state === 'unmoved' || fresh.state === 'needs-destination' ? { ...fresh, confirmation: result.confirmation } : fresh;
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
  if (initial.state !== 'unmoved' && initial.state !== 'needs-destination') return initial;
  const state = readCutoverState(home);
  const { memberships, bindings } = confirmationRegistry(home);
  const sources = legacySources(home, { homeDir: deps.homeDir, homes: deps.homes });
  const deadline = Date.now() + CONFIRMATION_BUDGET_MS;
  let confirmation: Confirmation = 'not-found';
  for (const source of sources.vaults) {
    const prior = Object.entries(state.migrations ?? {}).find(([file]) => legacyRealpath(file) === source.path)?.[1];
    const ids = legacyVaultProjectIds(source.path);
    const candidates = ids.flatMap(projectId => {
      if (prior?.projects[projectId]?.destination !== undefined) return [];
      const routes = bindings.filter(binding => binding.projectId === projectId);
      const urls = new Set(routes.map(binding => deploymentUrl(binding.serverUrl)));
      if (urls.size !== 1) return [];
      const membership = memberships.find(member => urls.has(deploymentUrl(member.serverUrl)));
      return membership === undefined ? [] : [{ projectId, membership, root: routes[0]!.root }];
    });
    if (candidates.length === 0) continue;
    const content = readVaultContent(source.path);
    const backup = Object.entries(state.backups).find(([file]) => legacyRealpath(file) === source.path)?.[1];
    if (backup !== undefined && backup.digest !== content.digest) continue;
    const projects = readLegacyVault(source.path);
    for (const candidate of candidates) {
      const project = projects.find(project => project.projectId === candidate.projectId);
      if (project === undefined) continue;
      const identities = legacyVaultCompletionIdentities(project, candidate.membership.machineId, home);
      const client = new ServerClient({ ...candidate.membership, projectId: candidate.projectId }, deps.fetch);
      const proof = await confirmHistory(client, identities, deadline);
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
          if (membership?.machineId !== candidate.membership.machineId || routes.length === 0
            || routes.some(route => deploymentUrl(route.serverUrl) !== deploymentUrl(candidate.membership.serverUrl))) return false;
          const stamp = legacyVaultStamp(source.path);
          if (readVaultContent(source.path).digest !== content.digest) { confirmation = 'unavailable'; return false; }
          fresh.version = 2;
          fresh.migrations ??= {};
          const receipt = fresh.migrations[source.path] ?? { digest: content.digest, size: stamp.size, mtimeMs: stamp.mtimeMs, wal: stamp.wal, projects: Object.fromEntries(ids.map(id => [id, {}])) };
          if (receipt.digest !== content.digest || receipt.projects[candidate.projectId]?.destination !== undefined) return false;
          const at = (deps.now ?? Date.now)();
          receipt.projects[candidate.projectId] = { root: candidate.root,
            destination: { serverUrl: deploymentUrl(candidate.membership.serverUrl), key: deploymentKeyFor(candidate.membership.serverUrl) },
            vault: { state: 'complete', at },
            evidence: { kind: 'deployment', at, machineId: candidate.membership.machineId, eventIds: proof.eventIds, sporeIds: proof.sporeIds, lineageIds: proof.lineageIds } };
          fresh.migrations[source.path] = receipt;
          return true;
        });
      } finally { lease.lock.release(); }
    }
  }
  const observed = legacyMigrationState(home, deps);
  return observed.state === 'unmoved' || observed.state === 'needs-destination'
    ? { ...observed, confirmation } : observed;
}
