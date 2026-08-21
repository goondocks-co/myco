/**
 * The member registry: one private JSON entry per project root under
 * `<MYCO_HOME>/member/projects/<sha256(root)[0:16]>.json`. Entries are written
 * atomically under the registry lock and read fail-closed; lookup is by the
 * worktree-aware project root, exact match.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveMycoHome } from '../paths/home.js';
import { LifecycleLock, withFileLockSync, type AcquireResult } from '../utils/lifecycle-lock.js';
import { ensureMemberDir, ensurePrivateFile, memberRoot, readPrivateJson, reportSkippedPrivateFile, writePrivateFileAtomic } from './store.js';

export const REGISTRY_VERSION = 1;
const PROJECTS_DIRNAME = 'projects';
const REGISTRY_LOCK = '.lock';
const KEY_HEX_CHARS = 16;

export interface RegistryEntry {
  version: typeof REGISTRY_VERSION;
  projectId: string;
  serverUrl: string;
  token: string;
  tokenId?: string;
  expiresAt?: number;
  /** The server-announced instant the token's refresh window opens; absent until the first window answer. */
  refreshAfter?: number;
  /** The worktree-aware project root this entry is keyed on. */
  root: string;
  machineId: string;
  joinedAt: number;
  updatedAt: number;
}

export function projectsDir(mycoHome: string = resolveMycoHome()): string {
  return path.join(memberRoot(mycoHome), PROJECTS_DIRNAME);
}

export function registryKeyFor(root: string): string {
  return crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, KEY_HEX_CHARS);
}

export function registryEntryPath(root: string, mycoHome: string = resolveMycoHome()): string {
  return path.join(projectsDir(mycoHome), `${registryKeyFor(root)}.json`);
}

function registryLockPath(mycoHome: string): string {
  return path.join(projectsDir(mycoHome), REGISTRY_LOCK);
}

/** The registry directory with its modes and its lock file in place, before any lock is taken. */
function prepareRegistryDir(mycoHome: string): void {
  ensureMemberDir(projectsDir(mycoHome), mycoHome);
  ensurePrivateFile(registryLockPath(mycoHome));
}

function isEntry(value: unknown): value is RegistryEntry {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return e.version === REGISTRY_VERSION
    && typeof e.projectId === 'string' && e.projectId.length > 0
    && typeof e.serverUrl === 'string' && e.serverUrl.length > 0
    && typeof e.token === 'string' && e.token.length > 0
    && typeof e.root === 'string' && e.root.length > 0
    && typeof e.machineId === 'string';
}

/** The entry for `root`, or null when absent, loose-moded, malformed, or keyed on another root (one stderr line for the latter three). */
export function readRegistryEntry(root: string, mycoHome: string = resolveMycoHome()): RegistryEntry | null {
  const file = registryEntryPath(root, mycoHome);
  const read = readPrivateJson<RegistryEntry>(file);
  if (!read.ok) {
    if (read.reason !== 'missing') reportSkippedPrivateFile('registry entry', file, read);
    return null;
  }
  if (!isEntry(read.value)) {
    reportSkippedPrivateFile('registry entry', file, { reason: 'malformed', detail: 'not a registry entry' });
    return null;
  }
  if (path.resolve(read.value.root) !== path.resolve(root)) {
    reportSkippedPrivateFile('registry entry', file, { reason: 'malformed', detail: 'root mismatch' });
    return null;
  }
  return read.value;
}

/** Run `fn` holding the registry lock (blocking). */
export function withRegistryLock<T>(fn: () => T, mycoHome: string = resolveMycoHome()): T {
  prepareRegistryDir(mycoHome);
  return withFileLockSync(registryLockPath(mycoHome), fn);
}

/** Take the registry lock without blocking; the refresh path holds it across its dial. */
export function acquireRegistryLock(mycoHome: string = resolveMycoHome()): AcquireResult {
  prepareRegistryDir(mycoHome);
  return LifecycleLock.acquire(registryLockPath(mycoHome), { command: 'myco member registry' });
}

/** Write the entry atomically (tmp + rename, 0600). Callers that already hold the registry lock pass `locked: true`. */
export function writeRegistryEntry(entry: RegistryEntry, opts: { mycoHome?: string; locked?: boolean } = {}): void {
  const mycoHome = opts.mycoHome ?? resolveMycoHome();
  const write = () => {
    prepareRegistryDir(mycoHome);
    writePrivateFileAtomic(registryEntryPath(entry.root, mycoHome), JSON.stringify(entry, null, 2) + '\n');
  };
  if (opts.locked) write();
  else withRegistryLock(write, mycoHome);
}

/** Delete the entry for `root`; returns whether an entry file existed. */
export function removeRegistryEntry(root: string, mycoHome: string = resolveMycoHome()): boolean {
  return withRegistryLock(() => {
    const file = registryEntryPath(root, mycoHome);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
  }, mycoHome);
}

/** Every readable entry, fail-closed per file. */
export function listRegistryEntries(mycoHome: string = resolveMycoHome()): RegistryEntry[] {
  const dir = projectsDir(mycoHome);
  if (!fs.existsSync(dir)) return [];
  const entries: RegistryEntry[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    const read = readPrivateJson<RegistryEntry>(file);
    if (!read.ok) {
      reportSkippedPrivateFile('registry entry', file, read);
      continue;
    }
    if (!isEntry(read.value)) {
      reportSkippedPrivateFile('registry entry', file, { reason: 'malformed', detail: 'not a registry entry' });
      continue;
    }
    if (name !== `${registryKeyFor(read.value.root)}.json`) {
      reportSkippedPrivateFile('registry entry', file, { reason: 'malformed', detail: 'root mismatch' });
      continue;
    }
    entries.push(read.value);
  }
  return entries;
}
