import fs from 'node:fs';
import path from 'node:path';
import { isProjectId } from './constants.js';
import { deploymentKeyFor, deploymentUrl, listRegistryEntries, REGISTRY_VERSION, readDeploymentMembership, type RegistryEntry } from './registry.js';
import { assertMemberPathContained, memberRoot, readPrivateJson, writePrivateFileAtomic } from './store.js';

/** The immutable destination of a member's Project state. */
export interface MemberRoutingIdentity {
  serverUrl: string;
  projectId: string;
}

export const ROUTING_FILE = 'destination.json';
export const LEGACY_MIGRATION_FILE = '.legacy-migration.json';

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
  const dir = path.join(memberRoot(mycoHome), 'spool', routingKey(route));
  return dir;
}

/** Persist the destination before buffered state can be written. */
export function pinSpoolDestination(dir: string, route: MemberRoutingIdentity): void {
  const identity = memberRoutingIdentity(route);
  const file = path.join(dir, ROUTING_FILE);
  const held = readPrivateJson<MemberRoutingIdentity>(file);
  if (held.ok) {
    if (!sameRoutingIdentity(held.value, identity)) throw new Error('Member spool destination mismatch');
    return;
  }
  if (held.reason !== 'missing') throw new Error('Member spool destination is unreadable');
  writePrivateFileAtomic(file, `${JSON.stringify(identity)}\n`);
}

/** Read a destination's current membership without consulting its repository's current binding. */
export function liveRoutingEntry(entry: RegistryEntry, mycoHome: string): RegistryEntry {
  const membership = readDeploymentMembership(entry.serverUrl, mycoHome);
  return membership === null ? entry : { ...entry, ...membership, serverUrl: entry.serverUrl, projectId: entry.projectId, root: entry.root };
}

/** The membership for an immutable buffered destination, including one whose repository was rebound. */
export function routingEntry(route: MemberRoutingIdentity, mycoHome: string): RegistryEntry | null {
  const identity = memberRoutingIdentity(route);
  const membership = readDeploymentMembership(identity.serverUrl, mycoHome);
  if (membership === null) return null;
  const binding = listRegistryEntries(mycoHome).find((entry) => sameRoutingIdentity(entry, identity));
  return { ...membership, version: REGISTRY_VERSION, ...identity, root: binding?.root ?? '' };
}

/** Buffered destinations survive repository rebindings and remain eligible for helper delivery. */
export function listSpoolDestinations(mycoHome: string): MemberRoutingIdentity[] {
  const root = path.join(memberRoot(mycoHome), 'spool');
  const names = (dir: string): string[] => {
    assertMemberPathContained(dir, mycoHome);
    try { return fs.readdirSync(dir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  };
  const found: MemberRoutingIdentity[] = [];
  for (const deployment of names(root).filter((name) => /^[0-9a-f]{16}$/.test(name))) {
    for (const projectId of names(path.join(root, deployment)).filter(isProjectId)) {
      const dir = path.join(root, deployment, projectId);
      assertMemberPathContained(dir, mycoHome);
      const read = readPrivateJson<MemberRoutingIdentity>(path.join(dir, ROUTING_FILE));
      if (!read.ok) throw new Error(`Buffered destination is unavailable: ${deployment}/${projectId} (${read.reason})`);
      const identity = memberRoutingIdentity(read.value);
      if (routedSpoolDir(identity, mycoHome) !== dir) throw new Error('Buffered destination does not match its directory');
      found.push(identity);
    }
  }
  return found;
}

export function listRoutingEntries(mycoHome: string): RegistryEntry[] {
  const entries = new Map(listRegistryEntries(mycoHome).map((entry) => [routingKey(entry), entry]));
  for (const route of listSpoolDestinations(mycoHome)) {
    if (entries.has(routingKey(route))) continue;
    const entry = routingEntry(route, mycoHome);
    if (entry !== null) entries.set(routingKey(route), entry);
  }
  return [...entries.values()];
}
