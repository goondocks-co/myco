import { withFileLockSync } from '../utils/lifecycle-lock.js';
import path from 'node:path';
import { defaultMembership } from './default-deployment.js';
import { resolveCredential, resolveMemberProjectRoot, type CredentialSource } from './credential.js';
import { rootKeyFor } from './auto-join.js';
import { deploymentKeyFor, deploymentUrl, listDeploymentMembershipsResult, listRegistryEntriesResult, readRegistryEntryResult } from './registry.js';
import { memberRoutingIdentity, pinMemberDestination, routingKey, sameRoutingIdentity, type MemberRoutingIdentity } from './routing.js';
import { assertMemberPathContained, ensureMemberDir, ensurePrivateFile, memberRoot, readPrivateJson, writePrivateFileAtomic } from './store.js';

const DESTINATION_FILE = 'destination.json';
const ADOPTION_FILE = 'project-adoption.json';
interface TranscriptDestination { serverUrl: string; projectId: string | null; rootKey?: string }

/** The binary owns the namespace of plugin-written transcripts and their writer claims. */
export function memberTranscriptRoutingKey(source: CredentialSource, cwd: string, mycoHome: string, env: NodeJS.ProcessEnv): string {
  const record = resolveCredential(source, { cwd, mycoHome, env, invokedBy: 'member routing-key', claimsUnconnected: () => source === 'registry' && defaultMembership(mycoHome) !== null });
  let destination: TranscriptDestination;
  let key: string;
  if (record !== null) {
    destination = memberRoutingIdentity(record);
    key = routingKey(record);
  } else {
    const membership = source === 'registry' ? defaultMembership(mycoHome) : null;
    if (readRegistryEntryResult(resolveMemberProjectRoot(cwd), mycoHome).status !== 'missing') throw new Error('Explicit Project binding is unavailable; transcript capture held');
    if (membership === null) throw new Error('No explicit Project binding or default Deployment membership for transcript capture');
    const rootKey = rootKeyFor(resolveMemberProjectRoot(cwd), mycoHome);
    destination = { serverUrl: deploymentUrl(membership.serverUrl), projectId: null, rootKey };
    key = `${deploymentKeyFor(destination.serverUrl)}/~pending-${rootKey}`;
  }
  const dir = path.join(memberRoot(mycoHome), 'transcripts', key);
  ensureMemberDir(dir, mycoHome);
  const file = path.join(dir, DESTINATION_FILE);
  pinMemberDestination(file, destination, (held, proposed) => JSON.stringify(held) === JSON.stringify(proposed), 'Plugin transcript');
  return key;
}

/** A member-owned transcript can be consumed only by its pinned Deployment and Project. */
export function assertMemberTranscriptDestination(file: string, route: MemberRoutingIdentity, mycoHome: string, pendingRootKey?: string): void {
  const root = path.join(memberRoot(mycoHome), 'transcripts');
  const relative = path.relative(root, path.resolve(file));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    if (isMemberOwnedTranscriptPath(file, mycoHome)) throw new TranscriptDestinationError('mismatch', 'Plugin transcript belongs to another member home');
    return;
  }
  assertMemberPathContained(file, mycoHome);
  const parts = relative.split(path.sep);
  if (!/^[0-9a-f]{16}$/.test(parts[0] ?? '')) {
    const lock = `${file}.routing.lock`;
    ensurePrivateFile(lock);
    withFileLockSync(lock, () => {
      const identity = legacyTranscriptDestination(file, mycoHome);
      if (identity === null) throw new TranscriptDestinationError('held', 'Legacy plugin transcript destination is ambiguous; capture held locally');
      if (!sameRoutingIdentity(identity, route)) throw new TranscriptDestinationError('mismatch', 'Legacy plugin transcript does not match the capture destination');
      const pinFile = `${file}.destination.json`;
      if (!readPrivateJson<MemberRoutingIdentity>(pinFile).ok) writePrivateFileAtomic(pinFile, `${JSON.stringify(identity)}\n`);
    });
    return;
  }
  const scope = path.join(root, parts[0]!, parts[1] ?? '');
  const read = readPrivateJson<TranscriptDestination>(path.join(scope, DESTINATION_FILE));
  if (!read.ok || typeof read.value?.serverUrl !== 'string') throw new TranscriptDestinationError('held', 'Plugin transcript destination is unavailable; capture held locally');
  const pinned = read.value;
  const matches = pinned.projectId === null
    ? typeof pinned.rootKey === 'string' && parts[1] === `~pending-${pinned.rootKey}` && deploymentUrl(pinned.serverUrl) === deploymentUrl(route.serverUrl) && (route.projectId !== '' || pinned.rootKey === pendingRootKey)
    : typeof pinned.projectId === 'string' && sameRoutingIdentity({ serverUrl: pinned.serverUrl, projectId: pinned.projectId }, route) && parts[1] === pinned.projectId;
  if (!matches || parts[0] !== deploymentKeyFor(pinned.serverUrl)) throw new TranscriptDestinationError('mismatch', 'Plugin transcript does not match the capture destination; held locally');
  if (pinned.projectId === null && route.projectId !== '') {
    const adoption = readPrivateJson<MemberRoutingIdentity>(path.join(scope, ADOPTION_FILE));
    if (!adoption.ok) throw new TranscriptDestinationError('held', 'Pending plugin transcript has no matching Project adoption; held locally');
    if (!sameRoutingIdentity(adoption.value, route)) throw new TranscriptDestinationError('mismatch', 'Pending plugin transcript has no matching Project adoption; held locally');
  }
}

/** Pending capture adopts one Project under the repository's pending lock before its state moves. */
export function adoptPendingTranscript(file: string, route: MemberRoutingIdentity, mycoHome: string, rootKey: string): void {
  const root = path.join(memberRoot(mycoHome), 'transcripts');
  const relative = path.relative(root, path.resolve(file));
  const parts = relative.split(path.sep);
  if (!/^[0-9a-f]{16}$/.test(parts[0] ?? '') || !/^~pending-[0-9a-f]{32}$/.test(parts[1] ?? '')) return;
  assertMemberTranscriptDestination(file, { ...route, projectId: '' }, mycoHome, rootKey);
  const adoptionFile = path.join(root, parts[0]!, parts[1]!, ADOPTION_FILE);
  pinMemberDestination(adoptionFile, memberRoutingIdentity(route), sameRoutingIdentity, 'Pending plugin transcript');
}

export class TranscriptDestinationError extends Error {
  constructor(readonly kind: 'mismatch' | 'held', message: string) { super(message); this.name = 'TranscriptDestinationError'; }
}

/** A legacy source has one immutable pin or one complete, unique current binding route. */
export function legacyTranscriptDestination(file: string, mycoHome: string): MemberRoutingIdentity | null {
  const pin = readPrivateJson<MemberRoutingIdentity>(`${file}.destination.json`);
  if (pin.ok) return memberRoutingIdentity(pin.value);
  const registry = listRegistryEntriesResult(mycoHome);
  const memberships = listDeploymentMembershipsResult(mycoHome);
  const routes = new Map(registry.entries.map((entry) => [routingKey(entry), memberRoutingIdentity(entry)]));
  return pin.reason === 'missing' && registry.readable && registry.unavailableEntries === 0 && memberships.readable && memberships.unavailableEntries === 0 && memberships.memberships.length === 1 && routes.size === 1
    ? [...routes.values()][0]! : null;
}

/** Whether a transcript belongs to the binary-managed raw capture store. */
export function isMemberOwnedTranscriptPath(file: string, mycoHome?: string): boolean {
  const relative = mycoHome === undefined ? '..' : path.relative(path.join(memberRoot(mycoHome), 'transcripts'), path.resolve(file));
  if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return true;
  const absolute = path.resolve(file);
  const marker = `${path.sep}member${path.sep}transcripts${path.sep}`;
  const boundary = absolute.lastIndexOf(marker);
  if (boundary < 0) return false;
  const home = absolute.slice(0, boundary) || path.parse(absolute).root;
  const parts = absolute.slice(boundary + marker.length).split(path.sep);
  const scope = path.join(home, 'member', 'transcripts', parts[0] ?? '', parts[1] ?? '');
  const destination = readPrivateJson<TranscriptDestination>(path.join(scope, DESTINATION_FILE));
  if (destination.ok && typeof destination.value?.serverUrl === 'string' && (typeof destination.value.projectId === 'string' || destination.value.projectId === null)) return true;
  const pin = readPrivateJson<MemberRoutingIdentity>(`${absolute}.destination.json`);
  if (pin.ok && typeof pin.value?.serverUrl === 'string' && typeof pin.value.projectId === 'string') return true;
  return listDeploymentMembershipsResult(home).memberships.length > 0;
}
