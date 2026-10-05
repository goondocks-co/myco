import { withFileLockSync } from '../utils/lifecycle-lock.js';
import fs from 'node:fs';
import path from 'node:path';
import { isProjectId } from './constants.js';
import { deploymentKeyFor, deploymentUrl, listRegistryEntries, REGISTRY_VERSION, readDeploymentMembership, type RegistryEntry } from './registry.js';
import { assertMemberPathContained, ensurePrivateFile, memberRoot, readPrivateJson, writePrivateFileAtomic } from './store.js';

/** The immutable destination of a member's Project state. */
export interface MemberRoutingIdentity {
  serverUrl: string;
  projectId: string;
}

export const ROUTING_FILE = 'destination.json';
export const LEGACY_MIGRATION_FILE = '.legacy-migration.json';
export const ROUTED_SPOOL_PREFIX = 'd-';

export function isRoutedSpoolNamespace(name: string): boolean {
  return /^d-[0-9a-f]{16}$/.test(name);
}

export function memberRoutingIdentity(route: MemberRoutingIdentity): MemberRoutingIdentity {
  if (!isProjectId(route.projectId) || typeof route.serverUrl !== 'string' || route.serverUrl.length === 0) throw new Error('Invalid member routing identity');
  return { serverUrl: deploymentUrl(route.serverUrl), projectId: route.projectId };
}

export function routingKey(route: MemberRoutingIdentity): string {
  const identity = memberRoutingIdentity(route);
  return `${deploymentKeyFor(identity.serverUrl)}/${identity.projectId}`;
}

export function sameRoutingIdentity(left: MemberRoutingIdentity, right: MemberRoutingIdentity): boolean {
  return left.projectId === right.projectId && deploymentUrl(left.serverUrl) === deploymentUrl(right.serverUrl);
}

export function routedSpoolDir(route: MemberRoutingIdentity, mycoHome: string): string {
  const dir = path.join(memberRoot(mycoHome), 'spool', `${ROUTED_SPOOL_PREFIX}${routingKey(route)}`);
  return dir;
}

/** Persist the destination before buffered state can be written. */
export function pinSpoolDestination(dir: string, route: MemberRoutingIdentity): void {
  pinMemberDestination(path.join(dir, ROUTING_FILE), memberRoutingIdentity(route), sameRoutingIdentity, 'Member spool');
}

/** Read a destination's current membership without consulting its repository's current binding. */
export function liveRoutingEntry(entry: RegistryEntry, mycoHome: string): RegistryEntry {
  const membership = readDeploymentMembership(entry.serverUrl, mycoHome);
  return membership === null ? entry : { ...entry, ...membership, serverUrl: entry.serverUrl, projectId: entry.projectId, root: entry.root };
}

/** The membership for an immutable buffered destination, including one whose repository was rebound. */
export function routingEntry(route: MemberRoutingIdentity, mycoHome: string, bindings: readonly RegistryEntry[] = listRegistryEntries(mycoHome)): RegistryEntry | null {
  const identity = memberRoutingIdentity(route);
  const membership = readDeploymentMembership(identity.serverUrl, mycoHome);
  if (membership === null) return null;
  const binding = bindings.find((entry) => sameRoutingIdentity(entry, identity));
  return { ...membership, version: REGISTRY_VERSION, ...identity, root: binding?.root ?? '' };
}

export interface BufferedDestinationIssue {
  key: string;
  reason: 'store-unavailable' | 'destination-missing' | 'destination-unavailable' | 'destination-mismatch' | 'membership-unavailable';
}

/** Buffered destinations and the entries that must remain held locally. */
export function listSpoolDestinationsResult(mycoHome: string): { destinations: MemberRoutingIdentity[]; issues: BufferedDestinationIssue[] } {
  const root = path.join(memberRoot(mycoHome), 'spool');
  const issues: BufferedDestinationIssue[] = [];
  const names = (dir: string, key: string): string[] => {
    try { assertMemberPathContained(dir, mycoHome); return fs.readdirSync(dir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') issues.push({ key, reason: 'store-unavailable' });
      return [];
    }
  };
  const destinations: MemberRoutingIdentity[] = [];
  for (const deployment of names(root, 'spool').filter(isRoutedSpoolNamespace)) {
    for (const projectId of names(path.join(root, deployment), deployment).filter(isProjectId)) {
      const key = `${deployment.slice(ROUTED_SPOOL_PREFIX.length)}/${projectId}`;
      const dir = path.join(root, deployment, projectId);
      try {
        assertMemberPathContained(dir, mycoHome);
        const read = readPrivateJson<MemberRoutingIdentity>(path.join(dir, ROUTING_FILE));
        if (!read.ok) { issues.push({ key, reason: read.reason === 'missing' ? 'destination-missing' : 'destination-unavailable' }); continue; }
        const identity = memberRoutingIdentity(read.value);
        if (routedSpoolDir(identity, mycoHome) !== dir) { issues.push({ key, reason: 'destination-mismatch' }); continue; }
        destinations.push(identity);
      } catch { issues.push({ key, reason: 'destination-unavailable' }); }
    }
  }
  return { destinations, issues };
}

/** A delivery walk refuses incomplete destination metadata before any outbound request. */
export function listSpoolDestinations(mycoHome: string): MemberRoutingIdentity[] {
  const result = listSpoolDestinationsResult(mycoHome);
  assertCompleteDestinations(result.issues);
  return result.destinations;
}

/** A diagnostic walk reports unavailable destinations alongside readable bindings. */
export function listRoutingEntriesResult(mycoHome: string, bindings: readonly RegistryEntry[]): { entries: RegistryEntry[]; heldDestinations: BufferedDestinationIssue[] } {
  const entries = new Map(bindings.map((entry) => [routingKey(entry), entry]));
  const { destinations, issues } = listSpoolDestinationsResult(mycoHome);
  for (const route of destinations) {
    if (entries.has(routingKey(route))) continue;
    const entry = routingEntry(route, mycoHome, bindings);
    if (entry !== null) entries.set(routingKey(route), entry);
    else issues.push({ key: routingKey(route), reason: 'membership-unavailable' });
  }
  return { entries: [...entries.values()], heldDestinations: issues };
}

/** Buffered destinations survive repository rebindings and remain eligible for helper delivery. */
export function listRoutingEntries(mycoHome: string, bindings: readonly RegistryEntry[] = listRegistryEntries(mycoHome)): RegistryEntry[] {
  const result = listRoutingEntriesResult(mycoHome, bindings);
  assertCompleteDestinations(result.heldDestinations);
  return result.entries;
}

function assertCompleteDestinations(issues: readonly BufferedDestinationIssue[]): void {
  if (issues.length > 0) throw new Error(`Buffered destination is unavailable: ${issues.map((issue) => `${issue.key} (${issue.reason})`).join(', ')}`);
}

/** An immutable destination is checked and published under one per-file lease. */
export function pinMemberDestination<T>(file: string, destination: T, matches: (held: T, proposed: T) => boolean, label: string): void {
  const lock = `${file}.lock`;
  ensurePrivateFile(lock);
  withFileLockSync(lock, () => {
    const held = readPrivateJson<T>(file);
    if (held.ok) {
      if (!matches(held.value, destination)) throw new Error(`${label} destination mismatch`);
    } else if (held.reason === 'missing') writePrivateFileAtomic(file, `${JSON.stringify(destination)}\n`);
    else throw new Error(`${label} destination is unreadable`);
  });
}
