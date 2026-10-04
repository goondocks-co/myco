/**
 * Auto-join (#1547): a git repository this machine meets with no connection of its own joins the machine's default
 * Deployment by itself, the first time a hook runs in it.
 *
 * The hook never waits on the join. It decides from what is on disk alone, in this order:
 * - a repository the machine never captures (a temporary folder, an agent's or Myco's own home, the home folder, a
 *   folder with no git work tree) is left as it is, silently;
 * - any other spools what the hook captures into the repository's pending spool (`pending.ts`), until the join has
 *   found it outside the folders the machine captures (`capture.auto_join_roots`) and not told to connect from "Needs
 *   you" (`capture.connect_roots`), and the folders this machine last cached agree: the cache can be older than the
 *   Deployment's folders, which the join reads fresh.
 * Then, when the repository is due an attempt, the hook asks for one (`requestJoin`) and kicks the member helper's join
 * bucket (`JOIN_BUCKET`, `member/helper.ts`), started apart from the hook as every helper is. The helper asks the
 * Deployment, records what it answered, and on a join moves the pending capture into the project's spool and delivers
 * it. One helper holds the bucket at a time, and an attempt holds the repository's lock
 * (`takeRepositoryLock`, a `LifecycleLock` the system lets go of when its holder dies), so an attempt run by hand never
 * races it; a connection `myco member join` writes meanwhile is the one that stands (the registry lock).
 *
 * A repository that did not join, or lies outside the folders, is named to the person once per Deployment and session, in the answer
 * of a hook whose answer reaches the agent.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HELD_CAPTURE_TTL_DAYS, normalizeRemote, type HeldState, type UncapturedReason } from '@goondocks/myco-shared/member-protocol';
import { isSafeProjectRoot } from '../project-root.js';
import { HOOK_CONFIG } from '../hooks/hook-config.generated.js';
import { runGitAnswer } from '../utils/git.js';
import { LifecycleLock, type LockHandle } from '../utils/lifecycle-lock.js';
import { assertMemberPathContained, ensureMemberDir, memberRoot, readPrivateJson, writePrivateFileAtomic } from './store.js';
import { PENDING_MAX_RECORDS, type HeldEnd } from './pending.js';
import { machineAutoJoinLeaves } from './machine-settings.js';
import { isProjectId } from './constants.js';
import { deploymentKeyFor, deploymentUrl } from './registry.js';


export const AUTO_JOIN_DIRNAME = 'auto-join';
/**
 * How long after an attempt that did not join the next hook in the repository may try again: a repository connected
 * from "Needs you" joins at the first hook past it, and one still refused costs one request of a detached process.
 */
export const AUTO_JOIN_RETRY_MS = 2 * 60 * 1000;
/** How often a repository outside the folders is reported again while it keeps being met. */
export const UNCAPTURED_REPORT_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** How long a session's notice marker is kept: past it, the session is long over. */
const NOTICE_MARKER_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;
const STATE_VERSION = 1;
const SWEEP_MARKER = 'sweep.json';
const REQUESTS_DIRNAME = 'requests';
const IMPORTS_DIRNAME = 'imports';
const ROOT_KEY_PATTERN = /^[0-9a-f]{16,64}$/;
const DEPLOYMENT_KEY_PATTERN = /^[0-9a-f]{16,64}$/;

function scopedFile(bucket: string, rootKey: string, mycoHome: string, serverUrl?: string, projectId?: string): string {
  if (!ROOT_KEY_PATTERN.test(rootKey)) throw new Error('Invalid auto-join repository key');
  if (projectId !== undefined && !isProjectId(projectId)) throw new Error('Invalid auto-join project id');
  return path.join(autoJoinDir(mycoHome), bucket, ...(serverUrl === undefined ? [] : [deploymentKeyFor(serverUrl)]),
    ...(projectId === undefined ? [] : [projectId]), `${rootKey}.json`);
}

function scopedFiles(bucket: string, rootKey: string, mycoHome: string, projects = false): string[] {
  const base = path.join(autoJoinDir(mycoHome), bucket);
  let deployments: string[];
  try { deployments = fs.readdirSync(base).filter((name) => DEPLOYMENT_KEY_PATTERN.test(name)); } catch { return []; }
  const files: string[] = [];
  for (const deployment of deployments) {
    const dir = path.join(base, deployment);
    try { if (!fs.lstatSync(dir).isDirectory()) continue; } catch { continue; }
    if (!projects) { files.push(path.join(dir, `${rootKey}.json`)); continue; }
    let projectIds: string[];
    try { projectIds = fs.readdirSync(dir).filter(isProjectId); } catch { continue; }
    for (const projectId of projectIds) {
      try { if (fs.lstatSync(path.join(dir, projectId)).isDirectory()) files.push(path.join(dir, projectId, `${rootKey}.json`)); } catch { /* absent */ }
    }
  }
  for (const file of files) assertMemberPathContained(file, mycoHome);
  return files.sort((a, b) => a.length - b.length);
}

function latestByRoute<T extends { rootKey: string; serverUrl?: string; projectId?: string; at: number }>(
  rows: readonly T[], includeProject: boolean,
): T[] {
  const latest = new Map<string, T>();
  for (const row of rows) {
    const key = `${row.serverUrl === undefined ? '' : deploymentUrl(row.serverUrl)}\0${includeProject ? row.projectId ?? '' : ''}\0${row.rootKey}`;
    if ((latest.get(key)?.at ?? -Infinity) <= row.at) latest.set(key, row);
  }
  return [...latest.values()].sort((a, b) => a.at - b.at);
}

function listedFiles(bucket: string, mycoHome: string, projects = false): string[] {
  const base = path.join(autoJoinDir(mycoHome), bucket);
  let names: string[];
  try { names = fs.readdirSync(base); } catch { return []; }
  const files: string[] = [];
  for (const name of names) {
    if (ROOT_KEY_PATTERN.test(name.slice(0, -'.json'.length)) && name.endsWith('.json')) {
      files.push(path.join(base, name));
      continue;
    }
    if (!DEPLOYMENT_KEY_PATTERN.test(name)) continue;
    const dir = path.join(base, name);
    let leaves: string[];
    try { if (!fs.lstatSync(dir).isDirectory()) continue; leaves = fs.readdirSync(dir); } catch { continue; }
    for (const leaf of leaves) {
      if (projects) {
        if (!isProjectId(leaf)) continue;
        let nested: string[];
        try { if (!fs.lstatSync(path.join(dir, leaf)).isDirectory()) continue; nested = fs.readdirSync(path.join(dir, leaf)); } catch { continue; }
        for (const file of nested) if (ROOT_KEY_PATTERN.test(file.slice(0, -'.json'.length)) && file.endsWith('.json')) files.push(path.join(dir, leaf, file));
      } else if (ROOT_KEY_PATTERN.test(leaf.slice(0, -'.json'.length)) && leaf.endsWith('.json')) files.push(path.join(dir, leaf));
    }
  }
  for (const file of files) assertMemberPathContained(file, mycoHome);
  return files.sort((a, b) => a.length - b.length);
}

/**
 * The member helper's bucket for repositories joining a project (`member/helper.ts`): its lock and marks live in the
 * auto-join folder. The `:` keeps it apart from every project id, which never holds one (`PROJECT_ID_PATTERN`).
 */
export const JOIN_BUCKET = ':auto-join';

/** A repository as auto-join names it: its root on this machine, the key derived from it, its folder name and its remote. */
export interface Repository {
  root: string;
  rootKey: string;
  label: string;
  remote: string | null;
}

/** Where a repository stands for auto-join on this machine. */
export type Placement = 'eligible' | 'connected' | 'outside_folders';

/** What the last attempt for a repository came to. */
export type AutoJoinOutcome = 'joined' | 'missed' | 'outside_folders' | 'unreachable';

export interface AutoJoinState {
  version: number;
  root: string;
  rootKey: string;
  label: string;
  outcome: AutoJoinOutcome;
  /** Why a repository did not join: the Deployment's reason, or the machine's own. */
  reason?: UncapturedReason;
  /** The Deployment's words for why, where it gave them. */
  detail?: string;
  projectId?: string;
  serverUrl: string;
  attemptAt: number;
  /** When the next attempt is due, after a miss: backed off while the same miss repeats under the same settings. */
  nextAttemptAt?: number;
  /** How many attempts in a row came to the same miss under the same settings. */
  repeats?: number;
  /** Where the settings the attempt read placed the repository, and what they told it to connect to: a hook whose cached settings disagree tries again at once. */
  placement?: Placement;
  connectTo?: string | null;
  /** When this machine last reported the repository for "Needs you", and the hold it reported then. */
  reportedAt?: number;
  reportedHeld?: HeldState;
}

const SALT_FILE = 'salt';
/** A salt as it is written: 32 random bytes, as hex. Anything else is one still being written, or one a crash cut short. */
const SALT_SHAPE = /^[0-9a-f]{64}$/;
/** How long a read waits for a salt another process is placing. */
const SALT_WAIT_MS = 500;

/**
 * This machine's salt for repository keys: random, made once, and never sent anywhere. A key derived from a path alone
 * would let anyone holding the Deployment's rows confirm a guessed path; salted per machine, it names a repository on
 * that machine and nothing more.
 *
 * It appears whole or not at all: it is written to a file of its own and linked into place, so a reader never sees a
 * part of one, and racing writers place one between them. A salt file that is not one whole salt (left by a crash of a
 * build that wrote in place) is never hashed with: it is waited on briefly, then replaced.
 */
export function machineSalt(mycoHome: string): string {
  const file = path.join(autoJoinDir(mycoHome), SALT_FILE);
  const read = (): string | null => {
    try {
      const salt = fs.readFileSync(file, 'utf-8').trim();
      return SALT_SHAPE.test(salt) ? salt : null;
    } catch {
      return null;
    }
  };
  const held = read();
  if (held !== null) return held;
  ensureMemberDir(autoJoinDir(mycoHome), mycoHome);
  const fresh = path.join(autoJoinDir(mycoHome), `.salt-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(fresh, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  try {
    try {
      fs.linkSync(fresh, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Another salt is in place, or a broken one: a whole one is used; a broken one is waited on, then replaced.
      const deadline = Date.now() + SALT_WAIT_MS;
      while (read() === null && Date.now() < deadline) { /* another process is placing it */ }
      if (read() === null) fs.renameSync(fresh, file);
    }
  } finally {
    fs.rmSync(fresh, { force: true });
  }
  const placed = read();
  if (placed === null) throw new Error(`machineSalt: ${file} holds no salt`);
  return placed;
}

/** A repository's key on this machine: its root, salted with this machine's salt, as hex. */
export function rootKeyFor(root: string, mycoHome: string): string {
  return crypto.createHash('sha256').update(`${machineSalt(mycoHome)}\0${real(root)}`).digest('hex').slice(0, 32);
}

export function autoJoinDir(mycoHome: string): string {
  return path.join(memberRoot(mycoHome), AUTO_JOIN_DIRNAME);
}

const statePath = (rootKey: string, mycoHome: string, serverUrl?: string): string => serverUrl === undefined
  ? path.join(autoJoinDir(mycoHome), `${rootKey}.json`)
  : scopedFile('states', rootKey, mycoHome, serverUrl);
const lockPath = (rootKey: string, mycoHome: string): string => path.join(autoJoinDir(mycoHome), `${rootKey}.lock`);

/**
 * The repository at `root`: its key and folder name, and the remote `origin` names, or the first remote it has, as one
 * name with no credentials, port or scheme in it (`normalizeRemote`). A remote that is not one is none.
 */
export function repositoryAt(root: string, mycoHome: string): Repository {
  const resolved = path.resolve(root);
  const read = (args: string[]): string | null => { try { return runGitAnswer(args, resolved) || null; } catch { return null; } };
  let remote = read(['remote', 'get-url', 'origin']);
  if (remote === null) {
    const first = read(['remote'])?.split('\n').map((name) => name.trim()).find((name) => name.length > 0);
    if (first !== undefined) remote = read(['remote', 'get-url', first]);
  }
  return { root: resolved, rootKey: rootKeyFor(resolved, mycoHome), label: path.basename(resolved), remote: remote === null ? null : normalizeRemote(remote) };
}

/** `target` with its links read, where it can be; as given where it cannot. */
function real(target: string): string {
  try { return fs.realpathSync(target); } catch { return path.resolve(target); }
}

/** Whether `child` is `parent` or lies beneath it. */
function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Whether the machine never captures the repository at `root` and never mentions it: no git work tree, the home
 * folder or the filesystem root, a temporary folder, an agent's own home, or a Myco home (where the worker's runs live).
 */
export function silentRepository(root: string, opts: { mycoHome: string; env?: NodeJS.ProcessEnv; home?: string }): boolean {
  const env = opts.env ?? process.env;
  if (!isSafeProjectRoot(root, env)) return true;
  const home = real(opts.home ?? os.homedir());
  const at = real(root);
  if (temporaryFolders(env).some((dir) => within(at, real(dir)))) return true;
  if (AGENT_HOMES.some((dir) => within(at, path.join(home, dir)))) return true;
  if (within(at, real(opts.mycoHome))) return true;
  // Every Myco home directly under the home folder: `~/.myco`, `~/.myco-dev`, and the like.
  const rel = path.relative(home, at);
  return !rel.startsWith('..') && !path.isAbsolute(rel) && rel.split(path.sep)[0]!.startsWith('.myco');
}

/**
 * The folders this machine treats as temporary: `MYCO_TEMPORARY_FOLDERS` (separated as `PATH` is) where it is set, and
 * the system's otherwise.
 */
export function temporaryFolders(env: NodeJS.ProcessEnv = process.env): string[] {
  const named = env.MYCO_TEMPORARY_FOLDERS;
  if (named !== undefined && named.length > 0) return named.split(path.delimiter).filter((dir) => dir.length > 0);
  return [os.tmpdir(), env.TMPDIR, '/tmp', '/private/tmp', '/var/folders', '/private/var/folders']
    .filter((dir): dir is string => typeof dir === 'string' && dir.length > 0);
}

/**
 * Every agent's own home under the home folder, from the agents' manifests: the first component of each configuration
 * folder, and of each folder its transcripts are found under.
 */
export const AGENT_HOMES: readonly string[] = [...new Set(Object.values(HOOK_CONFIG).flatMap((agent) => [
  agent.configDir.split('/')[0]!,
  ...(agent.transcriptDiscovery?.roots ?? []).filter((r) => r.startsWith('~/')).map((r) => r.slice(2).split('/')[0]!),
]))].filter((dir) => dir.startsWith('.'));

/**
 * A folder from the capture setting, as a path on this machine: `~/` or `~\` against the home folder on every platform,
 * an absolute one as is. A relative one names nothing.
 */
export function folderOf(entry: string, home: string): string | null {
  if (entry === '~') return home;
  if (entry.startsWith('~/') || entry.startsWith('~\\')) return path.join(home, entry.slice(2));
  return path.isAbsolute(entry) ? entry : null;
}

/** Where a repository stands: told to connect, under a folder the machine captures, or outside them. */
export function placeRepository(
  repo: Pick<Repository, 'root' | 'rootKey'>, leaves: { autoJoinRoots: readonly string[]; connectRoots: Readonly<Record<string, string>> }, opts: { home?: string } = {},
): Placement {
  if (Object.prototype.hasOwnProperty.call(leaves.connectRoots, repo.rootKey)) return 'connected';
  const home = opts.home ?? os.homedir();
  const at = real(repo.root);
  const under = leaves.autoJoinRoots
    .map((entry) => folderOf(entry, home))
    .some((folder) => folder !== null && within(at, real(folder)));
  return under ? 'eligible' : 'outside_folders';
}

function readStateFile(file: string): AutoJoinState | null {
  const read = readPrivateJson<AutoJoinState>(file);
  if (!read.ok) return null;
  const value = read.value;
  return value?.version === STATE_VERSION && typeof value.attemptAt === 'number' && typeof value.outcome === 'string'
    && typeof value.serverUrl === 'string' && ROOT_KEY_PATTERN.test(value.rootKey) ? value : null;
}

export function readAutoJoinState(rootKey: string, mycoHome: string, serverUrl?: string): AutoJoinState | null {
  if (serverUrl === undefined) {
    const legacy = readStateFile(statePath(rootKey, mycoHome));
    return legacy?.rootKey === rootKey ? legacy : null;
  }
  const scoped = readStateFile(statePath(rootKey, mycoHome, serverUrl));
  if (scoped !== null) return scoped.rootKey === rootKey && deploymentUrl(scoped.serverUrl) === deploymentUrl(serverUrl) ? scoped : null;
  const legacy = readStateFile(statePath(rootKey, mycoHome));
  return legacy !== null && legacy.rootKey === rootKey && deploymentUrl(legacy.serverUrl) === deploymentUrl(serverUrl) ? legacy : null;
}

export function writeAutoJoinState(state: Omit<AutoJoinState, 'version'>, mycoHome: string): void {
  const file = statePath(state.rootKey, mycoHome, state.serverUrl);
  ensureMemberDir(path.dirname(file), mycoHome);
  const record: AutoJoinState = { version: STATE_VERSION, ...state, serverUrl: deploymentUrl(state.serverUrl) };
  writePrivateFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
  const legacy = readStateFile(statePath(state.rootKey, mycoHome));
  if (legacy !== null && deploymentUrl(legacy.serverUrl) === record.serverUrl) fs.rmSync(statePath(state.rootKey, mycoHome), { force: true });
}

/** Forget what auto-join found of a repository, and the sessions it counted there. */
export function forgetAutoJoinState(rootKey: string, mycoHome: string): void {
  fs.rmSync(statePath(rootKey, mycoHome), { force: true });
  for (const file of scopedFiles('states', rootKey, mycoHome)) fs.rmSync(file, { force: true });
  fs.rmSync(seenPath(rootKey, mycoHome), { force: true });
  for (const file of scopedFiles('sessions', rootKey, mycoHome)) fs.rmSync(file, { force: true });
}

/** Every repository auto-join has tried, newest attempt first. */
export function listAutoJoinStates(mycoHome: string): AutoJoinState[] {
  let legacy: string[];
  try { legacy = fs.readdirSync(autoJoinDir(mycoHome)).filter((name) => /^[0-9a-f]{16,64}\.json$/.test(name)).map((name) => path.join(autoJoinDir(mycoHome), name)); } catch { legacy = []; }
  const byRoute = new Map<string, AutoJoinState>();
  for (const file of [...legacy, ...listedFiles('states', mycoHome)]) {
    const state = readStateFile(file);
    if (state !== null) byRoute.set(`${deploymentUrl(state.serverUrl)}\0${state.rootKey}`, state);
  }
  return [...byRoute.values()].sort((a, b) => b.attemptAt - a.attemptAt);
}

/** Whether a repository is due an attempt: never tried, or tried and not joined at least `AUTO_JOIN_RETRY_MS` ago. */
export function autoJoinDue(state: AutoJoinState | null, now: number): boolean {
  return state === null || (state.outcome !== 'joined' && now >= (state.nextAttemptAt ?? state.attemptAt + AUTO_JOIN_RETRY_MS));
}

/** The longest an attempt that keeps missing waits for the next. */
export const AUTO_JOIN_RETRY_MAX_MS = 60 * 60 * 1000;

/** When the attempt after a miss is due: `AUTO_JOIN_RETRY_MS`, doubling with each repeat of the same miss, to the cap. */
export function nextAttemptAfter(now: number, repeats: number): number {
  return now + Math.min(AUTO_JOIN_RETRY_MS * 2 ** Math.max(0, repeats - 1), AUTO_JOIN_RETRY_MAX_MS);
}

/** Whether the settings a hook holds now place a repository elsewhere than the last attempt found it. */
export function settingsMoved(state: AutoJoinState | null, placement: Placement, connectTo: string | null): boolean {
  if (state === null || state.outcome === 'joined' || state.placement === undefined) return false;
  return state.placement !== placement || (state.connectTo ?? null) !== connectTo;
}

/**
 * Take a repository's lock for one attempt, without waiting: null where another attempt (the helper's, `myco member
 * join`, one run by hand) holds it. A `LifecycleLock`: the system lets go of it when its holder dies, so a join that
 * crashed never holds the next off.
 */
export function takeRepositoryLock(rootKey: string, mycoHome: string): LockHandle | null {
  ensureMemberDir(autoJoinDir(mycoHome), mycoHome);
  const taken = LifecycleLock.acquire(lockPath(rootKey, mycoHome), { command: 'myco member auto-join' });
  return taken.acquired ? taken.lock : null;
}

export function sweepDone(mycoHome: string): boolean {
  return fs.existsSync(path.join(autoJoinDir(mycoHome), SWEEP_MARKER));
}

export function markSweepDone(mycoHome: string, now: number): void {
  ensureMemberDir(autoJoinDir(mycoHome), mycoHome);
  writePrivateFileAtomic(path.join(autoJoinDir(mycoHome), SWEEP_MARKER), `${JSON.stringify({ doneAt: now })}\n`);
}

/**
 * Where a repository stands for a join now, by the rule every caller applies (the hook that asks for one, and the
 * helper's pass that makes it): `left` while `myco member leave` holds it and "Needs you" has not connected it since;
 * `due` when never tried, past its backoff, or placed elsewhere by settings newer than the last attempt read; `waiting`
 * otherwise. A repository left and then connected from "Needs you" is no longer left.
 */
export function joinStanding(root: string, rootKey: string, serverUrl: string, mycoHome: string, now: number): {
  standing: 'left' | 'due' | 'waiting'; leaves: { autoJoinRoots: string[]; connectRoots: Record<string, string> }; state: AutoJoinState | null;
} {
  const leaves = machineAutoJoinLeaves(serverUrl, mycoHome);
  const connectTo = Object.prototype.hasOwnProperty.call(leaves.connectRoots, rootKey) ? leaves.connectRoots[rootKey]! : null;
  const state = readAutoJoinState(rootKey, mycoHome, serverUrl);
  if (isLeft(rootKey, mycoHome)) {
    if (connectTo === null) return { standing: 'left', leaves, state };
    clearLeft(rootKey, mycoHome);
  }
  const moved = settingsMoved(state, placeRepository({ root, rootKey }, leaves), connectTo);
  return { standing: moved || autoJoinDue(state, now) ? 'due' : 'waiting', leaves, state };
}

/** A repository a hook asked the helper to try joining, when, and for which Deployment. */
export interface JoinRequest { root: string; rootKey: string; at: number; serverUrl?: string }

const requestPath = (rootKey: string, mycoHome: string, serverUrl?: string): string => scopedFile(REQUESTS_DIRNAME, rootKey, mycoHome, serverUrl);

/** Ask the helper to try joining a repository, with the Deployment it was asked for: kept until an attempt is made, one per repository. */
export function requestJoin(root: string, rootKey: string, serverUrl: string, mycoHome: string, now: number): void {
  const file = requestPath(rootKey, mycoHome, serverUrl);
  ensureMemberDir(path.dirname(file), mycoHome);
  writePrivateFileAtomic(file, `${JSON.stringify({ root, rootKey, at: now, serverUrl: deploymentUrl(serverUrl) })}\n`);
}

/** Every repository waiting for an attempt, the oldest asked first. */
export function listJoinRequests(mycoHome: string): JoinRequest[] {
  const rows = listedFiles(REQUESTS_DIRNAME, mycoHome)
    .map((file) => ({ file, read: readPrivateJson<JoinRequest>(file) }))
    .flatMap(({ file, read }) => (read.ok && typeof read.value?.root === 'string' && ROOT_KEY_PATTERN.test(read.value.rootKey)
      && typeof read.value.at === 'number' && path.basename(file) === `${read.value.rootKey}.json`
      && (read.value.serverUrl === undefined || typeof read.value.serverUrl === 'string')
      && (path.dirname(file) === path.join(autoJoinDir(mycoHome), REQUESTS_DIRNAME)
        || (read.value.serverUrl !== undefined && path.basename(path.dirname(file)) === deploymentKeyFor(read.value.serverUrl))) ? [read.value] : []));
  return latestByRoute(rows, false);
}

/** Drop a repository's request, once an attempt was made for it: a request asked again meanwhile stays. */
export function clearJoinRequest(request: JoinRequest, mycoHome: string): void {
  for (const file of [requestPath(request.rootKey, mycoHome), ...(request.serverUrl === undefined ? [] : [requestPath(request.rootKey, mycoHome, request.serverUrl)])]) {
    const held = readPrivateJson<JoinRequest>(file);
    if (held.ok && typeof held.value?.at === 'number' && held.value.at <= request.at
      && (held.value.serverUrl === undefined ? request.serverUrl === undefined
        : request.serverUrl !== undefined && deploymentUrl(held.value.serverUrl) === deploymentUrl(request.serverUrl))) fs.rmSync(file, { force: true });
  }
}

/** Drop whatever request a repository holds: it was joined, or left, by other means. */
export function dropJoinRequest(rootKey: string, mycoHome: string, serverUrl?: string): void {
  if (serverUrl === undefined) {
    for (const file of [requestPath(rootKey, mycoHome), ...scopedFiles(REQUESTS_DIRNAME, rootKey, mycoHome)]) fs.rmSync(file, { force: true });
    return;
  }
  fs.rmSync(requestPath(rootKey, mycoHome, serverUrl), { force: true });
  const legacy = requestPath(rootKey, mycoHome);
  const held = readPrivateJson<JoinRequest>(legacy);
  if (held.ok && held.value?.serverUrl !== undefined && deploymentUrl(held.value.serverUrl) === deploymentUrl(serverUrl)) fs.rmSync(legacy, { force: true });
}

/** A joined repository's past sessions, still to bring: the helper's join pass brings them a step at a time. */
export interface PendingImport { root: string; rootKey: string; projectId: string; serverUrl: string; at: number }

const importPath = (rootKey: string, mycoHome: string, route?: Pick<PendingImport, 'serverUrl' | 'projectId'>): string =>
  scopedFile(IMPORTS_DIRNAME, rootKey, mycoHome, route?.serverUrl, route?.projectId);

export function queueImport(record: PendingImport, mycoHome: string): void {
  const file = importPath(record.rootKey, mycoHome, record);
  ensureMemberDir(path.dirname(file), mycoHome);
  writePrivateFileAtomic(file, `${JSON.stringify({ ...record, serverUrl: deploymentUrl(record.serverUrl) })}\n`);
}

/** Every joined repository whose past sessions are still to bring, the oldest joined first. */
export function listPendingImports(mycoHome: string): PendingImport[] {
  const rows = listedFiles(IMPORTS_DIRNAME, mycoHome, true)
    .map((file) => ({ file, read: readPrivateJson<PendingImport>(file) }))
    .flatMap(({ file, read }) => (read.ok && typeof read.value?.root === 'string' && ROOT_KEY_PATTERN.test(read.value.rootKey)
      && isProjectId(read.value.projectId) && typeof read.value.serverUrl === 'string' && typeof read.value.at === 'number'
      && path.basename(file) === `${read.value.rootKey}.json`
      && (path.dirname(file) === path.join(autoJoinDir(mycoHome), IMPORTS_DIRNAME)
        || (path.basename(path.dirname(file)) === read.value.projectId
          && path.basename(path.dirname(path.dirname(file))) === deploymentKeyFor(read.value.serverUrl))) ? [read.value] : []));
  return latestByRoute(rows, true);
}

export function clearPendingImport(rootKey: string, mycoHome: string, route?: Pick<PendingImport, 'serverUrl' | 'projectId'> & Partial<Pick<PendingImport, 'at'>>): void {
  if (route === undefined) {
    for (const file of [importPath(rootKey, mycoHome), ...scopedFiles(IMPORTS_DIRNAME, rootKey, mycoHome, true)]) fs.rmSync(file, { force: true });
    return;
  }
  const scoped = importPath(rootKey, mycoHome, route);
  const current = readPrivateJson<PendingImport>(scoped);
  if (current.ok && (route.at === undefined || current.value?.at === route.at)) fs.rmSync(scoped, { force: true });
  const legacy = importPath(rootKey, mycoHome);
  const held = readPrivateJson<PendingImport>(legacy);
  if (held.ok && held.value?.projectId === route.projectId && typeof held.value.serverUrl === 'string'
    && deploymentUrl(held.value.serverUrl) === deploymentUrl(route.serverUrl)
    && (route.at === undefined || held.value.at <= route.at)) fs.rmSync(legacy, { force: true });
}

const CONNECT_HINT = 'or run `myco member join` in it';

/**
 * What the person is told about a repository that is not captured, as the last attempt found it, or null where there is
 * nothing to tell: a repository that joined, or one whose attempt could not reach the Deployment and is tried again.
 * What is held of it is said too: held for the TTL, or held no more, past the cap or with age.
 */
export function notCapturedNotice(
  state: Pick<AutoJoinState, 'outcome' | 'reason' | 'serverUrl'>, autoJoinRoots: readonly string[], end: Pick<HeldEnd, 'held'> | null,
): string | null {
  const where = `"Needs you" on ${state.serverUrl}`;
  const held = end?.held === 'full'
    ? `What your agents do here is no longer held: this machine held the ${PENDING_MAX_RECORDS} events it keeps for a repository waiting to be connected.`
    : end?.held === 'expired'
      ? `What your agents did here more than ${HELD_CAPTURE_TTL_DAYS} days ago is no longer held; what they do from now on is held until it is connected.`
      : `What your agents do here is held on this machine for ${HELD_CAPTURE_TTL_DAYS} days and delivered once it is connected.`;
  if (state.outcome === 'outside_folders') {
    return `Myco is not capturing this repository yet: it is outside the folders this machine captures (${autoJoinRoots.join(', ') || 'none'}). Connect it from ${where}, ${CONNECT_HINT}. ${held}`;
  }
  if (state.outcome !== 'missed') return null;
  switch (state.reason) {
    case 'no_remote': return `Myco is not capturing this repository yet: it has no git remote, so Myco cannot tell which project it belongs to. Connect it from ${where}, ${CONNECT_HINT}. ${held}`;
    case 'auto_create_off': return `Myco is not capturing this repository yet: ${state.serverUrl} creates projects only on its dashboard. An admin can connect it from "Needs you", ${CONNECT_HINT} with --project <name>. ${held}`;
    case 'archived': return `Myco is not capturing this repository yet: the project it belongs to on ${state.serverUrl} is archived. Connect it to another from ${where}, ${CONNECT_HINT}. ${held}`;
    default: return `Myco is not capturing this repository yet: ${state.serverUrl} did not take it on. Connect it from ${where}, ${CONNECT_HINT}. ${held}`;
  }
}

/** The sessions that met a repository on one Deployment while it had no connection, by a hash of their id, and how many are not yet reported. */
interface SeenSessions { seen: string[]; unreported: number }
/** The most sessions a repository remembers having met. */
const SEEN_SESSIONS_MAX = 500;
const seenPath = (rootKey: string, mycoHome: string, serverUrl?: string): string => serverUrl === undefined
  ? path.join(autoJoinDir(mycoHome), `${rootKey}.sessions.json`)
  : scopedFile('sessions', rootKey, mycoHome, serverUrl);

function readSeen(rootKey: string, mycoHome: string, serverUrl?: string): SeenSessions {
  const read = readPrivateJson<SeenSessions>(seenPath(rootKey, mycoHome, serverUrl));
  return read.ok && Array.isArray(read.value?.seen) && typeof read.value.unreported === 'number' ? read.value : { seen: [], unreported: 0 };
}

/** Count a session that met the repository, once. A lost write costs a count, never the hook. */
export function recordSessionSeen(rootKey: string, sessionId: string, mycoHome: string, serverUrl?: string): void {
  try {
    const seen = readSeen(rootKey, mycoHome, serverUrl);
    const id = crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
    if (seen.seen.includes(id)) return;
    const file = seenPath(rootKey, mycoHome, serverUrl);
    ensureMemberDir(path.dirname(file), mycoHome);
    writePrivateFileAtomic(file, `${JSON.stringify({ seen: [...seen.seen, id].slice(-SEEN_SESSIONS_MAX), unreported: seen.unreported + 1 })}\n`);
  } catch {
    // Counted at the next session.
  }
}

/** How many sessions met the repository after its last report. */
export const unreportedSessions = (rootKey: string, mycoHome: string, serverUrl?: string): number => readSeen(rootKey, mycoHome, serverUrl).unreported;

/** Note that `count` sessions were reported. */
export function markSessionsReported(rootKey: string, count: number, mycoHome: string, serverUrl?: string): void {
  const seen = readSeen(rootKey, mycoHome, serverUrl);
  if (count <= 0 || seen.unreported === 0) return;
  writePrivateFileAtomic(seenPath(rootKey, mycoHome, serverUrl), `${JSON.stringify({ ...seen, unreported: Math.max(0, seen.unreported - count) })}\n`);
}

const leftPath = (rootKey: string, mycoHome: string): string => path.join(autoJoinDir(mycoHome), 'left', `${rootKey}.json`);

/**
 * Opt a repository out of auto-join, as `myco member leave` there does: its hooks capture nothing, hold nothing and say
 * nothing, until it is joined again, or connected again from "Needs you".
 */
export function markLeft(rootKey: string, mycoHome: string, now: number): void {
  ensureMemberDir(path.dirname(leftPath(rootKey, mycoHome)), mycoHome);
  writePrivateFileAtomic(leftPath(rootKey, mycoHome), `${JSON.stringify({ at: now })}\n`);
}

export const isLeft = (rootKey: string, mycoHome: string): boolean => fs.existsSync(leftPath(rootKey, mycoHome));

export function clearLeft(rootKey: string, mycoHome: string): void {
  fs.rmSync(leftPath(rootKey, mycoHome), { force: true });
}

/** Whether this session has not been told on this Deployment yet, marking it told. A marker that cannot be written tells it again next time. */
export function noticeOnce(sessionId: string, mycoHome: string, now: number, serverUrl?: string): boolean {
  const dir = path.join(autoJoinDir(mycoHome), 'noticed');
  const marker = path.join(dir, crypto.createHash('sha256').update(serverUrl === undefined ? sessionId : `${deploymentUrl(serverUrl)}\0${sessionId}`).digest('hex').slice(0, 32));
  if (fs.existsSync(marker)) return false;
  try {
    ensureMemberDir(dir, mycoHome);
    fs.writeFileSync(marker, '', { mode: 0o600 });
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try { if (now - fs.statSync(file).mtimeMs > NOTICE_MARKER_RETENTION_MS) fs.rmSync(file, { force: true }); } catch { /* gone */ }
    }
  } catch {
    // The person is told again at the next hook rather than never.
  }
  return true;
}
