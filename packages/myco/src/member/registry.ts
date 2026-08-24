/**
 * The member registry, in two parts.
 *
 * A credential is Deployment-wide, so it is held once per Deployment rather than
 * once per project: `<MYCO_HOME>/member/deployments/<sha256(serverUrl)[0:16]>.json`
 * holds the MEMBERSHIP — the credential, the member, the machine — and
 * `<MYCO_HOME>/member/projects/<sha256(root)[0:16]>.json` holds a BINDING naming
 * the Project a root works in and the Deployment it belongs to.
 *
 * Keeping the credential in every project file would mean N copies of one secret
 * on a machine working in N projects, and rotation revokes the predecessor at the
 * successor's first use — so each copy rotating would revoke the others' token
 * out from under them. One membership is what makes rotation coherent.
 *
 * Callers see neither file. `readRegistryEntry` composes the two into the same
 * `RegistryEntry` they have always read, and `writeRegistryEntry` takes one back
 * apart, so the split is a property of the store rather than of its surface.
 *
 * Both files are written atomically under the registry lock and read fail-closed;
 * lookup is by the worktree-aware project root, exact match.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveMycoHome } from '../paths/home.js';
import { LifecycleLock, withFileLockSync, type AcquireResult } from '../utils/lifecycle-lock.js';
import { ensureMemberDir, ensurePrivateFile, memberRoot, readPrivateJson, reportSkippedPrivateFile, writePrivateFileAtomic } from './store.js';

export const REGISTRY_VERSION = 2;
const PROJECTS_DIRNAME = 'projects';
const DEPLOYMENTS_DIRNAME = 'deployments';
const REGISTRY_LOCK = '.lock';
const KEY_HEX_CHARS = 16;

/** A Deployment this machine holds a credential for. One per server URL, whatever number of projects are bound to it. */
export interface DeploymentMembership {
  version: number;
  serverUrl: string;
  token: string;
  tokenId?: string;
  memberId?: string;
  expiresAt?: number;
  /** The server-announced instant the token's refresh window opens; absent until the first window answer. */
  refreshAfter?: number;
  /** When the `route_missing` refresh diagnostic was last printed. */
  routeMissingNoticedAt?: number;
  /** Set once the server has refused this token's rotation terminally; nothing dials again until the membership is re-provisioned. */
  refreshTerminal?: boolean;
  machineId: string;
  joinedAt: number;
  updatedAt: number;
}

/** A project root and the Project it works in, on one Deployment. Holds no credential. */
export interface ProjectBinding {
  version: number;
  root: string;
  projectId: string;
  serverUrl: string;
  joinedAt: number;
  updatedAt: number;
}

/** The composed view: a binding and the membership it names, as one record. This is what every caller reads and writes. */
export interface RegistryEntry {
  version: number;
  projectId: string;
  serverUrl: string;
  token: string;
  tokenId?: string;
  expiresAt?: number;
  /** The server-announced instant the token's refresh window opens; absent until the first window answer. */
  refreshAfter?: number;
  /** When the `route_missing` refresh diagnostic was last printed. */
  routeMissingNoticedAt?: number;
  /** Set once the server has refused this token's rotation terminally; nothing dials again until the entry is re-provisioned. */
  refreshTerminal?: boolean;
  /** The worktree-aware project root this entry is keyed on. */
  root: string;
  machineId: string;
  joinedAt: number;
  updatedAt: number;
}

export function projectsDir(mycoHome: string = resolveMycoHome()): string {
  return path.join(memberRoot(mycoHome), PROJECTS_DIRNAME);
}

export function deploymentsDir(mycoHome: string = resolveMycoHome()): string {
  return path.join(memberRoot(mycoHome), DEPLOYMENTS_DIRNAME);
}

/** The key a Deployment is filed under: its server URL without a trailing slash. */
export function deploymentKeyFor(serverUrl: string): string {
  return crypto.createHash('sha256').update(serverUrl.replace(/\/+$/, '')).digest('hex').slice(0, KEY_HEX_CHARS);
}

export function deploymentPath(serverUrl: string, mycoHome: string = resolveMycoHome()): string {
  return path.join(deploymentsDir(mycoHome), `${deploymentKeyFor(serverUrl)}.json`);
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
  ensureMemberDir(deploymentsDir(mycoHome), mycoHome);
  ensurePrivateFile(registryLockPath(mycoHome));
}

/**
 * Whether `value` is an entry this build can read, at any version up to its own.
 *
 * This deliberately is NOT an equality check. Under an equality check, a version
 * bump makes every entry on disk fail it: `readRegistryEntry` returns null, the
 * hook finds no membership, capture goes silent, and `member status --all` shows
 * nothing at all — a machine that has simply not upgraded yet is indistinguishable
 * from one that never joined, and that is the reading which stops anyone looking
 * for an upgrade.
 *
 * An entry from a NEWER build is a different case and is refused by name: this
 * build cannot know what a later format means, and guessing at it is how a
 * downgrade quietly rewrites what the newer one wrote.
 */
function readableVersion(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;
  const version = (value as Record<string, unknown>).version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return null;
  return version;
}

function isEntry(value: unknown): value is RegistryEntry {
  const version = readableVersion(value);
  if (version === null || version > REGISTRY_VERSION) return false;
  const e = value as Record<string, unknown>;
  return typeof e.projectId === 'string' && e.projectId.length > 0
    && typeof e.serverUrl === 'string' && e.serverUrl.length > 0
    && typeof e.token === 'string' && e.token.length > 0
    && typeof e.root === 'string' && e.root.length > 0
    && typeof e.machineId === 'string';
}

/** A v2 binding on disk: a root, its Project, and the Deployment holding the credential. */
function isBinding(value: unknown): value is ProjectBinding {
  const version = readableVersion(value);
  if (version === null || version > REGISTRY_VERSION) return false;
  const b = value as Record<string, unknown>;
  return typeof b.root === 'string' && b.root.length > 0
    && typeof b.projectId === 'string' && b.projectId.length > 0
    && typeof b.serverUrl === 'string' && b.serverUrl.length > 0;
}

/** A v2 membership on disk: the credential this machine holds for one Deployment. */
function isMembership(value: unknown): value is DeploymentMembership {
  const version = readableVersion(value);
  if (version === null || version > REGISTRY_VERSION) return false;
  const m = value as Record<string, unknown>;
  return typeof m.serverUrl === 'string' && m.serverUrl.length > 0
    && typeof m.token === 'string' && m.token.length > 0
    && typeof m.machineId === 'string';
}

/** The membership for `serverUrl`, or null when absent or unreadable. */
export function readDeploymentMembership(serverUrl: string, mycoHome: string = resolveMycoHome()): DeploymentMembership | null {
  const file = deploymentPath(serverUrl, mycoHome);
  const read = readPrivateJson<DeploymentMembership>(file);
  if (!read.ok) {
    if (read.reason !== 'missing') reportSkippedPrivateFile('deployment membership', file, read);
    return null;
  }
  if (!isMembership(read.value)) {
    reportSkippedPrivateFile('deployment membership', file, { reason: 'malformed', detail: 'not a deployment membership' });
    return null;
  }
  return read.value;
}

/** A binding and its membership as one record; null when the membership is gone, which is a machine that has not joined this Deployment. */
function compose(binding: ProjectBinding, mycoHome: string): RegistryEntry | null {
  const membership = readDeploymentMembership(binding.serverUrl, mycoHome);
  if (membership === null) return null;
  return {
    version: REGISTRY_VERSION,
    projectId: binding.projectId,
    serverUrl: membership.serverUrl,
    token: membership.token,
    tokenId: membership.tokenId,
    expiresAt: membership.expiresAt,
    refreshAfter: membership.refreshAfter,
    routeMissingNoticedAt: membership.routeMissingNoticedAt,
    refreshTerminal: membership.refreshTerminal,
    root: binding.root,
    machineId: membership.machineId,
    joinedAt: binding.joinedAt,
    updatedAt: binding.updatedAt,
  };
}

/** One composed entry taken apart into the two files it is stored as. */
function decompose(entry: RegistryEntry): { membership: DeploymentMembership; binding: ProjectBinding } {
  return {
    membership: {
      version: REGISTRY_VERSION,
      serverUrl: entry.serverUrl,
      token: entry.token,
      tokenId: entry.tokenId,
      expiresAt: entry.expiresAt,
      refreshAfter: entry.refreshAfter,
      routeMissingNoticedAt: entry.routeMissingNoticedAt,
      refreshTerminal: entry.refreshTerminal,
      machineId: entry.machineId,
      joinedAt: entry.joinedAt,
      updatedAt: entry.updatedAt,
    },
    binding: {
      version: REGISTRY_VERSION,
      root: entry.root,
      projectId: entry.projectId,
      serverUrl: entry.serverUrl,
      joinedAt: entry.joinedAt,
      updatedAt: entry.updatedAt,
    },
  };
}

/**
 * Upgrades every v1 entry on disk to the split layout, in place, under the
 * registry lock.
 *
 * A v1 entry carries its own credential, so the upgrade lifts that into a
 * membership keyed by server URL and leaves the project file holding only the
 * binding. Several v1 entries on one Deployment each carry a credential of their
 * own — one per project, which is what v1 meant — and they consolidate into one
 * membership; the most recently updated wins, and the consolidation is reported
 * rather than done silently.
 *
 * Memberships are written before bindings. An upgrade interrupted between the two
 * leaves the project files still at v1, so the next read runs it again from the
 * start; running twice changes nothing.
 */
export function migrateRegistry(mycoHome: string = resolveMycoHome()): { upgraded: number; consolidated: number } {
  const dir = projectsDir(mycoHome);
  if (!fs.existsSync(dir)) return { upgraded: 0, consolidated: 0 };
  return withRegistryLock(() => {
    const legacy: Array<{ file: string; entry: RegistryEntry }> = [];
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      const read = readPrivateJson<RegistryEntry>(file);
      if (!read.ok || readableVersion(read.value) !== 1 || !isEntry(read.value)) continue;
      legacy.push({ file, entry: read.value });
    }
    if (legacy.length === 0) return { upgraded: 0, consolidated: 0 };

    const byDeployment = new Map<string, RegistryEntry>();
    for (const { entry } of legacy) {
      const key = deploymentKeyFor(entry.serverUrl);
      const held = byDeployment.get(key);
      if (held === undefined || entry.updatedAt > held.updatedAt) byDeployment.set(key, entry);
    }
    for (const entry of byDeployment.values()) {
      const { membership } = decompose(entry);
      writePrivateFileAtomic(deploymentPath(entry.serverUrl, mycoHome), `${JSON.stringify(membership, null, 2)}\n`);
    }
    for (const { file, entry } of legacy) {
      const { binding } = decompose(entry);
      writePrivateFileAtomic(file, `${JSON.stringify(binding, null, 2)}\n`);
    }
    const consolidated = legacy.length - byDeployment.size;
    if (consolidated > 0) {
      process.stderr.write(`myco: consolidated ${legacy.length} project credentials into ${byDeployment.size} deployment membership(s); a credential is now held once per deployment\n`);
    }
    return { upgraded: legacy.length, consolidated };
  }, mycoHome);
}

/** The entry for `root`, or null when absent, loose-moded, malformed, keyed on another root, or naming a Deployment this machine holds no membership for (one stderr line for the latter four). */
export function readRegistryEntry(root: string, mycoHome: string = resolveMycoHome()): RegistryEntry | null {
  return readEntryAt(root, mycoHome, true);
}

/** The read itself. `mayUpgrade` is false on the retry after an upgrade, so a v1 file the upgrade declines to touch cannot loop. */
function readEntryAt(root: string, mycoHome: string, mayUpgrade = false): RegistryEntry | null {
  const file = registryEntryPath(root, mycoHome);
  const read = readPrivateJson<RegistryEntry>(file);
  if (!read.ok) {
    if (read.reason !== 'missing') reportSkippedPrivateFile('registry entry', file, read);
    return null;
  }
  // An entry still at v1 is upgraded on the spot rather than skipped: the alternative
  // is a hook that finds no membership and captures nothing, which reads as "never
  // joined". Upgrading is idempotent, so concurrent hooks racing it is not a problem.
  //
  // The re-read is a single retry, never recursion. A v1 file the upgrade declines to
  // touch — malformed, or missing a field it needs — would otherwise be re-read and
  // re-upgraded forever, and this runs inside a hook: the loop would not end until the
  // harness killed the hook, on every hook, with nothing captured and no error said.
  if (readableVersion(read.value) === 1) {
    if (!mayUpgrade || migrateRegistry(mycoHome).upgraded === 0) {
      reportSkippedPrivateFile('registry entry', file, { reason: 'malformed', detail: 'not upgradable from v1' });
      return null;
    }
    return readEntryAt(root, mycoHome);
  }
  if (!isBinding(read.value)) {
    reportSkippedPrivateFile('registry entry', file, { reason: 'malformed', detail: 'not a registry entry' });
    return null;
  }
  if (path.resolve(read.value.root) !== path.resolve(root)) {
    reportSkippedPrivateFile('registry entry', file, { reason: 'malformed', detail: 'root mismatch' });
    return null;
  }
  const composed = compose(read.value, mycoHome);
  if (composed === null) {
    reportSkippedPrivateFile('registry entry', file, { reason: 'malformed', detail: `no membership for ${read.value.serverUrl}` });
    return null;
  }
  return composed;
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

/**
 * Write the entry atomically (tmp + rename, 0600) as its two parts. Callers that
 * already hold the registry lock pass `locked: true`.
 *
 * The membership lands first. A write interrupted between the two leaves a
 * credential no binding names yet — inert, and replaced by the next write — where
 * the other order leaves a binding pointing at a credential that is not there,
 * which is a root that cannot capture.
 *
 * Rotation goes through here, so a rotated token reaches every project bound to
 * that Deployment at once: they read one membership, not a copy each.
 */
export function writeRegistryEntry(entry: RegistryEntry, opts: { mycoHome?: string; locked?: boolean } = {}): void {
  const mycoHome = opts.mycoHome ?? resolveMycoHome();
  const write = () => {
    prepareRegistryDir(mycoHome);
    const { membership, binding } = decompose(entry);
    writePrivateFileAtomic(deploymentPath(entry.serverUrl, mycoHome), `${JSON.stringify(membership, null, 2)}\n`);
    writePrivateFileAtomic(registryEntryPath(entry.root, mycoHome), `${JSON.stringify(binding, null, 2)}\n`);
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

/** Every readable entry, fail-closed per file. Upgrades v1 entries first, so a machine that has not run since the split lists its memberships rather than nothing. */
export function listRegistryEntries(mycoHome: string = resolveMycoHome()): RegistryEntry[] {
  const dir = projectsDir(mycoHome);
  if (!fs.existsSync(dir)) return [];
  migrateRegistry(mycoHome);
  const entries: RegistryEntry[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    const read = readPrivateJson<ProjectBinding>(file);
    if (!read.ok) {
      reportSkippedPrivateFile('registry entry', file, read);
      continue;
    }
    if (!isBinding(read.value)) {
      reportSkippedPrivateFile('registry entry', file, { reason: 'malformed', detail: 'not a registry entry' });
      continue;
    }
    if (name !== `${registryKeyFor(read.value.root)}.json`) {
      reportSkippedPrivateFile('registry entry', file, { reason: 'malformed', detail: 'root mismatch' });
      continue;
    }
    const composed = compose(read.value, mycoHome);
    if (composed === null) {
      reportSkippedPrivateFile('registry entry', file, { reason: 'malformed', detail: `no membership for ${read.value.serverUrl}` });
      continue;
    }
    entries.push(composed);
  }
  return entries;
}
