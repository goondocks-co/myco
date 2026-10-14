import path from 'node:path';
import { LEGACY_HISTORY_MAX_EVENTS, LEGACY_HISTORY_PATH } from '@goondocks/myco-shared/member-protocol';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { legacyMigrationState, readCutoverState, updateCutoverState, type LegacyMigrationState } from './legacy-migration.js';
import { LegacyMigrationUnreadable, legacyRealpath, legacySources, legacyVaultProjectIds, legacyVaultStamp } from './legacy-sources.js';
import { readVaultContent } from './legacy-backup.js';
import { legacyHistoryCompletionGroups, readLegacyVault } from './legacy-import.js';
import { deploymentKeyFor, deploymentUrl, listDeploymentMembershipsResult, listRegistryEntriesResult } from './registry.js';
import { ensureMemberDir, ensurePrivateFile, memberRoot } from './store.js';
import { ServerClient, type FetchLike } from './transport.js';

const CONFIRMATION_BUDGET_MS = 5000;
const COMPLETION_ALTERNATIVES = 2;
const GROUPS_PER_REQUEST = Math.floor(LEGACY_HISTORY_MAX_EVENTS / COMPLETION_ALTERNATIVES);
export interface LegacyConfirmationDeps { fetch?: FetchLike; now?: () => number; homeDir?: string; homes?: readonly string[] }

async function confirmHistory(client: ServerClient, groups: string[][], deadline: number): Promise<{ state: 'confirmed'; eventIds: string[] } | { state: 'unavailable' | 'not-found' }> {
  if (groups.length === 0) return { state: 'not-found' };
  const confirmed = new Set<string>();
  for (let start = 0; start < groups.length; start += GROUPS_PER_REQUEST) {
    const eventGroups = groups.slice(start, start + GROUPS_PER_REQUEST);
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { state: 'unavailable' };
    const answer = await client.postPersisted(LEGACY_HISTORY_PATH, { eventGroups }, { connectTimeoutMs: remaining, requestTimeoutMs: remaining });
    if (answer.class !== 'acked') return { state: 'unavailable' };
    const eventIds = answer.body.eventIds;
    if (answer.body.confirmed !== true || !Array.isArray(eventIds) || !eventIds.every((id): id is string => typeof id === 'string')
      || !eventGroups.every(group => group.some(id => eventIds.includes(id)))) return { state: 'not-found' };
    for (const id of eventGroups.flat().filter(id => eventIds.includes(id))) confirmed.add(id);
  }
  return { state: 'confirmed', eventIds: [...confirmed].sort() };
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
  const initial = legacyMigrationState(home);
  if (initial.state !== 'unmoved' && initial.state !== 'needs-destination') return initial;
  const state = readCutoverState(home);
  const { memberships, bindings } = confirmationRegistry(home);
  const sources = legacySources(home, { homeDir: deps.homeDir, homes: deps.homes });
  const deadline = Date.now() + CONFIRMATION_BUDGET_MS;
  let unavailable = false;
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
      const eventGroups = legacyHistoryCompletionGroups(project, candidate.membership.machineId, home);
      const client = new ServerClient({ ...candidate.membership, projectId: candidate.projectId }, deps.fetch);
      const proof = await confirmHistory(client, eventGroups, deadline);
      if (proof.state !== 'confirmed') { unavailable ||= proof.state === 'unavailable'; continue; }
      ensureMemberDir(memberRoot(home), home);
      const lockFile = path.join(memberRoot(home), 'cutover.lock');
      ensurePrivateFile(lockFile);
      const lease = LifecycleLock.acquire(lockFile);
      if (!lease.acquired) { unavailable = true; continue; }
      try {
        updateCutoverState(home, fresh => {
          const registry = confirmationRegistry(home);
          const membership = registry.memberships.find(member => deploymentUrl(member.serverUrl) === deploymentUrl(candidate.membership.serverUrl));
          const routes = registry.bindings.filter(binding => binding.projectId === candidate.projectId);
          if (membership?.machineId !== candidate.membership.machineId || routes.length === 0
            || routes.some(route => deploymentUrl(route.serverUrl) !== deploymentUrl(candidate.membership.serverUrl))) return false;
          const stamp = legacyVaultStamp(source.path);
          if (readVaultContent(source.path).digest !== content.digest) { unavailable = true; return false; }
          fresh.version = 2;
          fresh.migrations ??= {};
          const receipt = fresh.migrations[source.path] ?? { digest: content.digest, size: stamp.size, mtimeMs: stamp.mtimeMs, wal: stamp.wal, projects: Object.fromEntries(ids.map(id => [id, {}])) };
          if (receipt.digest !== content.digest || receipt.projects[candidate.projectId]?.destination !== undefined) return false;
          const at = (deps.now ?? Date.now)();
          receipt.projects[candidate.projectId] = { root: candidate.root,
            destination: { serverUrl: deploymentUrl(candidate.membership.serverUrl), key: deploymentKeyFor(candidate.membership.serverUrl) },
            vault: { state: 'complete', at }, transcripts: { state: 'complete', at },
            evidence: { kind: 'deployment', at, machineId: candidate.membership.machineId, eventIds: proof.eventIds } };
          fresh.migrations[source.path] = receipt;
          return true;
        });
      } finally { lease.lock.release(); }
    }
  }
  const observed = legacyMigrationState(home);
  return observed.state === 'unmoved' || observed.state === 'needs-destination'
    ? { ...observed, confirmation: unavailable ? 'unavailable' : 'not-found' } : observed;
}
