/** Legacy Project-only spool pinning and retired-spool discovery, kept separate from full migration. */
import fs from 'node:fs';
import path from 'node:path';
import { resolveMycoHome } from '../paths/home.js';
import { withFileLockSync } from '../utils/lifecycle-lock.js';
import { isProjectId } from './constants.js';
import { deploymentUrl, listRegistryEntriesResult } from './registry.js';
import { memberRoutingIdentity, pinSpoolDestination, ROUTING_FILE, sameRoutingIdentity, type MemberRoutingIdentity } from './routing.js';
import { MemberSpool, SPOOL_DIRNAME } from './spool.js';
import { assertMemberPathContained, ensurePrivateFile, memberRoot, pathIsAbsent, readPrivateJson, writePrivateFileAtomic } from './store.js';

export const MIGRATION_LOCK = '.migration.lock';
export const ROUTING_HOLD_FILE = '.legacy-routing-hold.json';
export const ASSIGNMENT_FILE = '.legacy-assignment.json';
export const LEGACY_MIGRATION_VERSION = 1;
export const LEGACY_SPOOL_RETIRE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export const RETIRED_SPOOL_DIRNAME = 'retired-spool';

export interface LegacySpoolMigrationReport {
  status: 'absent' | 'held' | 'pinned' | 'assigned' | 'migrated';
  projectId: string;
  destination: MemberRoutingIdentity | null;
  reason?: string;
  sessions: number;
  records: number;
  copied: number;
  sidecarHolds?: string[];
  ignoredSidecars?: string[];
  /** Legacy context asks, render markers and session answer caches not carried into the destination. */
  contextSkipped?: number;
}

export class MigrationHold extends Error {}

export function reportFor(projectId: string, destination: MemberRoutingIdentity | null): LegacySpoolMigrationReport {
  return { status: 'absent', projectId, destination, sessions: 0, records: 0, copied: 0, contextSkipped: 0 };
}

/** Project-only spool location used by member builds before Deployment routing. */
export function legacySpoolDir(projectId: string, mycoHome: string = resolveMycoHome()): string {
  if (!isProjectId(projectId)) throw new Error('Invalid legacy spool project id');
  const dir = path.join(memberRoot(mycoHome), SPOOL_DIRNAME, projectId);
  assertMemberPathContained(dir, mycoHome);
  return dir;
}

export function routingHoldPath(dir: string): string { return path.join(dir, ROUTING_HOLD_FILE); }
export function assignmentPath(dir: string): string { return path.join(dir, ASSIGNMENT_FILE); }

export function readPinned(dir: string): MemberRoutingIdentity | null {
  const read = readPrivateJson<MemberRoutingIdentity>(path.join(dir, ROUTING_FILE));
  if (read.ok) {
    try { return memberRoutingIdentity(read.value); }
    catch { throw new MigrationHold('Legacy spool destination is invalid'); }
  }
  if (read.reason === 'missing') return null;
  throw new MigrationHold('Legacy spool destination is unreadable');
}

export function readRoutingHold(dir: string): string | null {
  const read = readPrivateJson<{ version: number; reason: string }>(routingHoldPath(dir));
  if (read.ok) return typeof read.value?.reason === 'string' ? read.value.reason : 'Legacy routing hold is invalid';
  return read.reason === 'missing' ? null : 'Legacy routing hold is unreadable';
}

export function holdRouting(dir: string, reason: string): void {
  if (readRoutingHold(dir) !== null) return;
  writePrivateFileAtomic(routingHoldPath(dir), `${JSON.stringify({ version: LEGACY_MIGRATION_VERSION, reason, at: Date.now() })}\n`);
}

export function readAssignment(dir: string): MemberRoutingIdentity | null {
  const read = readPrivateJson<{ version: number; route: MemberRoutingIdentity; at: number }>(assignmentPath(dir));
  if (!read.ok) {
    if (read.reason === 'missing') return null;
    throw new MigrationHold('Legacy spool assignment is unreadable');
  }
  if (read.value?.version !== LEGACY_MIGRATION_VERSION || !Number.isFinite(read.value.at)) throw new MigrationHold('Legacy spool assignment is invalid');
  try { return memberRoutingIdentity(read.value.route); }
  catch { throw new MigrationHold('Legacy spool assignment is invalid'); }
}

export function uniqueDestination(projectId: string, mycoHome: string): MemberRoutingIdentity {
  const registry = listRegistryEntriesResult(mycoHome);
  if (!registry.readable || registry.unavailableEntries !== 0) throw new MigrationHold('Registry bindings are unavailable');
  const matches = registry.entries.filter((entry) => entry.projectId === projectId);
  const urls = new Set(matches.map((entry) => deploymentUrl(entry.serverUrl)));
  if (urls.size !== 1) throw new MigrationHold('Legacy spool has no unique Deployment binding');
  try { return memberRoutingIdentity({ projectId, serverUrl: [...urls][0]! }); }
  catch { throw new MigrationHold('Legacy spool binding has an invalid Deployment URL'); }
}

/** Pin an existing Project-only spool before any binding for its Project changes. */
export function pinLegacySpoolDestinationForProject(projectId: string, mycoHome: string = resolveMycoHome()): LegacySpoolMigrationReport {
  const dir = legacySpoolDir(projectId, mycoHome);
  const base: LegacySpoolMigrationReport = reportFor(projectId, null);
  if (!fs.existsSync(dir)) return base;
  ensurePrivateFile(path.join(dir, MIGRATION_LOCK));
  return withFileLockSync(path.join(dir, MIGRATION_LOCK), () => {
    try {
      const assigned = readAssignment(dir);
      const hold = readRoutingHold(dir);
      const pinned = readPinned(dir);
      if (assigned !== null && pinned !== null && !sameRoutingIdentity(assigned, pinned)) throw new MigrationHold('Legacy spool assignment conflicts with its pinned Deployment');
      if (assigned === null && hold !== null) throw new MigrationHold(hold);
      const destination = assigned ?? pinned ?? uniqueDestination(projectId, mycoHome);
      if (pinned === null) pinSpoolDestination(dir, destination);
      new MemberSpool(destination, { mycoHome });
      return { ...base, status: assigned === null ? 'pinned' as const : 'assigned' as const, destination };
    } catch (error) {
      if (!(error instanceof MigrationHold)) throw error;
      holdRouting(dir, error.message);
      return { ...base, status: 'held' as const, reason: error.message };
    }
  });
}

/** Retired journals remain discoverable for writers holding an already-open file descriptor. */
export function listRetiredLegacySpoolDirs(mycoHome: string = resolveMycoHome()): string[] {
  const root = path.join(memberRoot(mycoHome), RETIRED_SPOOL_DIRNAME);
  if (pathIsAbsent(root)) return [];
  assertMemberPathContained(root, mycoHome);
  const dirs: string[] = [];
  for (const projectId of fs.readdirSync(root).sort()) {
    if (!isProjectId(projectId)) throw new Error('Retired legacy spool has an invalid Project');
    const projectDir = path.join(root, projectId);
    assertMemberPathContained(projectDir, mycoHome);
    if (!fs.lstatSync(projectDir).isDirectory()) throw new Error('Retired legacy spool Project is not a directory');
    for (const name of fs.readdirSync(projectDir).sort()) {
      const dir = path.join(projectDir, name);
      assertMemberPathContained(dir, mycoHome);
      if (!fs.lstatSync(dir).isDirectory()) throw new Error('Retired legacy spool is not a directory');
      dirs.push(dir);
    }
  }
  return dirs;
}
