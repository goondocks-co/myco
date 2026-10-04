/**
 * Capture held for a repository that has no project yet (#1547).
 *
 * The first hooks in a repository this machine joins by itself run before the join answers: the join runs apart from
 * them (`auto-join.ts`), so no hook waits on it. What those hooks capture is spooled under
 * `<MYCO_HOME>/member/pending/<deploymentKey>/<rootKey>/`, and moved into a project on that Deployment once the
 * repository joins, where the ordinary drain delivers it.
 *
 * A repository that never joins must not hold capture forever: a pending spool is bounded in records, and one whose
 * first record is older than `PENDING_TTL_MS` is discarded. Either end is recorded beside the spool (`HeldEnd`), so
 * the person is told, `myco member status` lists it, and the Deployment's "Needs you" row says it.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveMycoHome } from '../paths/home.js';
import type { OutboundEvent } from './envelope.js';
import { BLOBS_DIRNAME, MemberSpool, REFUSED_LOG_FILE, SPOOL_DIRNAME, toWire, type TurnEndMark } from './spool.js';
import { deploymentKeyFor, deploymentUrl, readRegistryEntry, readRegistryEntryResult } from './registry.js';
import { memberRoutingIdentity, sameRoutingIdentity, type MemberRoutingIdentity } from './routing.js';
import { pointersOf, readSessionState, readSessionStateResult, sessionStatePath, turnsFileOf, type SessionState } from './session-state.js';
import { isProjectId } from './constants.js';
import { CaptureLossLedger, recordSessionLoss } from './capture-loss.js';
import { HELD_CAPTURE_TTL_MS } from '@goondocks/myco-shared/member-protocol';
import { LifecycleLock, withFileLockSync } from '../utils/lifecycle-lock.js';
import { assertMemberPathContained, ensureMemberDir, memberRoot, pathIsAbsent, readPrivateJson, writePrivateFileAtomic } from './store.js';
import { admitMemberServerUrl } from './server-url.js';
import { adoptPendingTranscript } from './transcript-routing.js';

export const PENDING_DIRNAME = 'pending';
/** How long capture waits for its repository to join before it is discarded. */
export const PENDING_TTL_MS = HELD_CAPTURE_TTL_MS;
/** The most records one repository's pending spool holds; a hook past it spools nothing more. */
export const PENDING_MAX_RECORDS = 2000;
const META_FILE = 'pending.json';
const ASSIGNMENT_FILE = 'assignment.json';
const ASSIGNMENT_MARKER_FILE = 'legacy-assignment.json';
const META_VERSION = 2;
const ROOT_KEY = /^[0-9a-f]{16,64}$/;
const DEPLOYMENT_KEY = /^[0-9a-f]{16,64}$/;

/** What a pending spool says of itself: the repository it holds capture for, and when it began holding. */
export interface PendingMeta {
  version: number;
  root: string;
  rootKey: string;
  serverUrl?: string;
  createdAt: number;
  generation?: string;
}

/** That a repository's capture is held no more: its spool reached the cap, or its capture outlived the TTL. */
export interface HeldEnd {
  version: number;
  root: string;
  rootKey: string;
  serverUrl?: string;
  held: 'full' | 'expired';
  at: number;
}

/** One repository's held capture, as a report reads it. */
export interface PendingSummary {
  rootKey: string;
  root: string;
  serverUrl?: string;
  assignedTo?: MemberRoutingIdentity;
  createdAt: number;
  sessions: number;
  records: number;
}

interface LegacyAssignment extends MemberRoutingIdentity {
  rootKey: string;
  at: number;
}

export function pendingRoot(mycoHome: string = resolveMycoHome()): string {
  return path.join(memberRoot(mycoHome), PENDING_DIRNAME);
}

function normalizedServerUrl(serverUrl: string): string {
  if (!admitMemberServerUrl(serverUrl)) throw new Error('Invalid pending Deployment URL');
  return deploymentUrl(serverUrl);
}

export function pendingDir(rootKey: string, mycoHome: string = resolveMycoHome(), serverUrl?: string): string {
  if (!ROOT_KEY.test(rootKey)) throw new Error(`pendingDir: ${rootKey} is not a repository key`);
  return serverUrl === undefined
    ? path.join(pendingRoot(mycoHome), rootKey)
    : path.join(pendingRoot(mycoHome), deploymentKeyFor(normalizedServerUrl(serverUrl)), rootKey);
}

function readMeta(dir: string): PendingMeta | null {
  const file = path.join(dir, META_FILE);
  const read = readPrivateJson<PendingMeta>(file);
  if (!read.ok) {
    if (read.reason === 'missing') return null;
    throw new Error(`Pending capture metadata unavailable (${read.reason}${read.detail ? `: ${read.detail}` : ''}): ${file}`);
  }
  const value = read.value;
  const invalid = (): never => { throw new Error(`Pending capture metadata invalid: ${file}`); };
  if (value === null || typeof value.root !== 'string' || !ROOT_KEY.test(value.rootKey) || typeof value.createdAt !== 'number') return invalid();
  if (value.version === 1 && value.serverUrl === undefined && path.basename(dir) === value.rootKey && path.basename(path.dirname(dir)) === PENDING_DIRNAME) return value;
  if (value.version !== META_VERSION || typeof value.serverUrl !== 'string') return invalid();
  const valid = path.basename(dir) === value.rootKey && path.basename(path.dirname(dir)) === deploymentKeyFor(value.serverUrl)
    && path.basename(path.dirname(path.dirname(dir))) === PENDING_DIRNAME
    && value.serverUrl === normalizedServerUrl(value.serverUrl);
  return valid ? value : invalid();
}

function readDirectory(dir: string): string[] | null {
  try { return fs.readdirSync(dir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && pathIsAbsent(dir)) return null;
    throw error;
  }
}

function lstatEntry(file: string): fs.Stats | null {
  try { return fs.lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && pathIsAbsent(file)) return null;
    throw error;
  }
}

function readLegacyAssignment(file: string): LegacyAssignment | null {
  const read = readPrivateJson<LegacyAssignment>(file);
  if (!read.ok) {
    if (read.reason === 'missing') return null;
    throw new Error(`Legacy pending assignment unavailable (${read.reason}${read.detail ? `: ${read.detail}` : ''}): ${file}`);
  }
  const value = read.value;
  if (value === null || !ROOT_KEY.test(value.rootKey) || typeof value.at !== 'number'
    || typeof value.serverUrl !== 'string' || typeof value.projectId !== 'string') throw new Error(`Legacy pending assignment invalid: ${file}`);
  const route = memberRoutingIdentity(value);
  if (route.serverUrl !== value.serverUrl) throw new Error(`Legacy pending assignment invalid: ${file}`);
  return value;
}

/** A pending obligation remains until its metadata is verifiably absent. */
export function hasPendingCapture(rootKey: string, mycoHome: string, serverUrl?: string): boolean {
  const dir = pendingDir(rootKey, mycoHome, serverUrl);
  return hasPendingCaptureAt(dir, mycoHome);
}

function hasPendingCaptureAt(dir: string, mycoHome: string): boolean {
  assertMemberPathContained(dir, mycoHome);
  if (!pathIsAbsent(path.join(dir, META_FILE))) return true;
  try { return fs.readdirSync(dir).some((name) => name.endsWith('.jsonl') || name.endsWith('.state.json') || name.endsWith('.turns')); }
  catch { return !pathIsAbsent(dir); }
}

const endedPath = (rootKey: string, mycoHome: string, serverUrl?: string): string => `${pendingDir(rootKey, mycoHome, serverUrl)}.ended.json`;

/** Where a repository's held capture ended, or null while it is held or was never held. */
export function readHeldEnd(rootKey: string, mycoHome: string, serverUrl?: string): HeldEnd | null {
  const file = endedPath(rootKey, mycoHome, serverUrl);
  const read = readPrivateJson<HeldEnd>(file);
  if (!read.ok) {
    if (read.reason === 'missing') return null;
    throw new Error(`Pending capture end unavailable (${read.reason}${read.detail ? `: ${read.detail}` : ''}): ${file}`);
  }
  const value = read.value;
  if (value?.held !== 'full' && value?.held !== 'expired') throw new Error(`Pending capture end invalid: ${file}`);
  if (value.rootKey !== rootKey || typeof value.root !== 'string' || typeof value.at !== 'number') throw new Error(`Pending capture end invalid: ${file}`);
  if (serverUrl === undefined) {
    if (value.version !== 1 || value.serverUrl !== undefined) throw new Error(`Pending capture end invalid: ${file}`);
  } else if (value.version !== META_VERSION || value.serverUrl !== normalizedServerUrl(serverUrl)) throw new Error(`Pending capture end invalid: ${file}`);
  return value;
}

/** Record that a repository's capture is held no more, keeping the first such record until the capture is held again. */
function recordHeldEnd(repo: { root: string; rootKey: string; serverUrl?: string }, held: HeldEnd['held'], mycoHome: string, now: number): void {
  if (readHeldEnd(repo.rootKey, mycoHome, repo.serverUrl)?.held === held) return;
  const file = endedPath(repo.rootKey, mycoHome, repo.serverUrl);
  ensureMemberDir(path.dirname(file), mycoHome);
  const end: HeldEnd = { version: repo.serverUrl === undefined ? 1 : META_VERSION, root: repo.root, rootKey: repo.rootKey,
    ...(repo.serverUrl === undefined ? {} : { serverUrl: normalizedServerUrl(repo.serverUrl) }), held, at: now };
  writePrivateFileAtomic(file, `${JSON.stringify(end)}\n`);
}

function clearHeldEnd(rootKey: string, mycoHome: string, serverUrl?: string): void {
  fs.rmSync(endedPath(rootKey, mycoHome, serverUrl), { force: true });
}

/** Every repository whose held capture ended, most recent first. */
export function listHeldEnds(mycoHome: string): HeldEnd[] {
  return pendingLocations(mycoHome, true)
    .filter(({ rootKey, serverUrl, dir }) => dir === pendingDir(rootKey, mycoHome, serverUrl))
    .map(({ rootKey, serverUrl }) => readHeldEnd(rootKey, mycoHome, serverUrl))
    .filter((end): end is HeldEnd => end !== null).sort((a, b) => b.at - a.at);
}

function pendingLocations(mycoHome: string, ended = false): Array<{ rootKey: string; serverUrl?: string; dir: string }> {
  const root = pendingRoot(mycoHome);
  const names = readDirectory(root);
  if (names === null) return [];
  const suffix = ended ? '.ended.json' : '';
  const locations: Array<{ rootKey: string; serverUrl?: string; dir: string }> = [];
  for (const name of names) {
    const key = suffix ? name.endsWith(suffix) ? name.slice(0, -suffix.length) : '' : name;
    if (ended && ROOT_KEY.test(key)) {
      locations.push({ rootKey: key, dir: path.join(root, key) });
      continue;
    }
    if (!DEPLOYMENT_KEY.test(name)) continue;
    const directory = path.join(root, name);
    const parent = lstatEntry(directory);
    if (parent === null) continue;
    if (!parent.isDirectory()) throw new Error(`Pending capture directory unavailable: ${directory}`);
    if (!ended && readMeta(directory)?.version === 1) {
      locations.push({ rootKey: name, dir: directory });
      continue;
    }
    const nested = readDirectory(directory);
    if (nested === null) continue;
    let foundNested = false;
    for (const leaf of nested) {
      if (ended && !leaf.endsWith(suffix)) continue;
      const rootKey = suffix ? leaf.endsWith(suffix) ? leaf.slice(0, -suffix.length) : '' : leaf;
      if (!ROOT_KEY.test(rootKey)) continue;
      const file = path.join(directory, leaf);
      if (!ended) {
        const entry = lstatEntry(file);
        if (entry === null) continue;
        if (!entry.isDirectory()) throw new Error(`Pending capture directory unavailable: ${file}`);
      }
      foundNested = true;
      if (ended) {
        const read = readPrivateJson<HeldEnd>(file);
        if (!read.ok) {
          if (read.reason === 'missing') continue;
          throw new Error(`Pending capture end unavailable (${read.reason}${read.detail ? `: ${read.detail}` : ''}): ${file}`);
        }
        const serverUrl = read.value?.serverUrl;
        if (typeof serverUrl !== 'string' || deploymentKeyFor(serverUrl) !== name || serverUrl !== normalizedServerUrl(serverUrl)) {
          throw new Error(`Pending capture end invalid: ${file}`);
        }
        locations.push({ rootKey, dir: path.join(directory, rootKey), serverUrl });
      } else {
        const meta = readMeta(file);
        locations.push({ rootKey, dir: file, ...(meta === null ? {} : { serverUrl: meta.serverUrl }) });
      }
    }
    if (!ended && !foundNested && nested.some((leaf) => !leaf.endsWith('.ended.json'))) locations.push({ rootKey: name, dir: directory });
  }
  return locations;
}

function pendingPathsFor(rootKey: string, mycoHome: string): string[] {
  const root = pendingRoot(mycoHome);
  const names = readDirectory(root);
  if (names === null) return [];
  const dirs: string[] = [];
  const add = (dir: string): void => {
    const entry = lstatEntry(dir);
    if (entry === null) return;
    if (!entry.isDirectory()) throw new Error(`Pending capture directory unavailable: ${dir}`);
    dirs.push(dir);
  };
  add(path.join(root, rootKey));
  for (const name of names) if (DEPLOYMENT_KEY.test(name)) {
    const parent = path.join(root, name);
    const entry = lstatEntry(parent);
    if (entry === null) continue;
    if (!entry.isDirectory()) throw new Error(`Pending capture directory unavailable: ${parent}`);
    add(path.join(parent, rootKey));
  }
  return [...new Set(dirs)];
}

/**
 * The spool a repository's capture waits in, for a hook to stage blobs and read session state through; null where its
 * capture is past the record cap. Nothing is written here: `appendPending` writes, under the repository's lock.
 */
export function pendingSpool(repo: { root: string; rootKey: string; serverUrl?: string }, opts: { mycoHome: string; now: number }): MemberSpool | null {
  // Stage and append use the same pinned destination even if the default changes between them.
  return withPendingLock(repo.rootKey, opts.mycoHome, () => {
    expireOne(repo.rootKey, { ...opts, serverUrl: repo.serverUrl });
    ensurePendingMeta(repo, opts);
    const spool = new MemberSpool(null, { mycoHome: opts.mycoHome, dir: pendingDir(repo.rootKey, opts.mycoHome, repo.serverUrl) });
    if (recordsIn(spool) < PENDING_MAX_RECORDS) return spool;
    recordHeldEnd(repo, 'full', opts.mycoHome, opts.now);
    return null;
  });
}

function ensurePendingMeta(repo: { root: string; rootKey: string; serverUrl?: string }, opts: { mycoHome: string; now: number }): string {
  const dir = pendingDir(repo.rootKey, opts.mycoHome, repo.serverUrl);
  ensureMemberDir(dir, opts.mycoHome);
  const held = readPrivateJson<PendingMeta>(path.join(dir, META_FILE));
  if (held.ok) {
    const meta = readMeta(dir);
    if (meta === null || meta.root !== repo.root || meta.rootKey !== repo.rootKey || meta.serverUrl !== (repo.serverUrl === undefined ? undefined : normalizedServerUrl(repo.serverUrl))) {
      throw new Error('Pending capture destination mismatch');
    }
    return dir;
  }
  if (held.reason !== 'missing') throw new Error('Pending capture metadata is unreadable');
  const meta: PendingMeta = { version: repo.serverUrl === undefined ? 1 : META_VERSION, root: repo.root, rootKey: repo.rootKey,
    ...(repo.serverUrl === undefined ? {} : { serverUrl: normalizedServerUrl(repo.serverUrl) }), createdAt: opts.now,
    generation: crypto.randomUUID() };
  writePrivateFileAtomic(path.join(dir, META_FILE), `${JSON.stringify(meta)}\n`);
  clearHeldEnd(repo.rootKey, opts.mycoHome, repo.serverUrl);
  return dir;
}

/** Assign legacy held capture to one explicit Project route, leaving its original spool and receipt in place. */
export function assignLegacyPending(
  rootKey: string, route: MemberRoutingIdentity, opts: { mycoHome: string; now: number },
): boolean {
  const identity = memberRoutingIdentity(route);
  return withPendingLock(rootKey, opts.mycoHome, () => {
    const source = pendingDir(rootKey, opts.mycoHome);
    assertMemberPathContained(source, opts.mycoHome);
    const meta = readMeta(source);
    if (meta === null) {
      const entries = readDirectory(source);
      if (entries === null || entries.length === 0) return false;
      throw new Error(`Legacy pending capture metadata missing while capture remains held: ${source}`);
    }
    if (meta.version !== 1 || meta.rootKey !== rootKey) throw new Error('Legacy pending capture has no assignable source');
    const receiptFile = path.join(source, ASSIGNMENT_FILE);
    const receipt = readLegacyAssignment(receiptFile);
    if (receipt !== null) {
      if (receipt.rootKey !== rootKey || !sameRoutingIdentity(receipt, identity)) throw new Error('Legacy pending capture is assigned to another destination');
      return false;
    }

    const destination = pendingDir(rootKey, opts.mycoHome, identity.serverUrl);
    assertMemberPathContained(destination, opts.mycoHome);
    const markerFile = path.join(destination, ASSIGNMENT_MARKER_FILE);
    if (lstatEntry(destination) !== null) {
      const marker = readLegacyAssignment(markerFile);
      if (marker === null || marker.rootKey !== rootKey || !sameRoutingIdentity(marker, identity)) {
        throw new Error('Pending destination already holds unrelated capture');
      }
      const copied = readMeta(destination);
      if (copied === null || copied.root !== meta.root || copied.createdAt !== meta.createdAt) throw new Error('Pending assignment copy is incomplete');
    } else {
      const parent = path.dirname(destination);
      ensureMemberDir(parent, opts.mycoHome);
      const temporary = path.join(parent, `.assign-${rootKey}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
      try {
        fs.cpSync(source, temporary, { recursive: true, force: false, errorOnExist: true });
        const pinned: PendingMeta = { version: META_VERSION, root: meta.root, rootKey, serverUrl: identity.serverUrl, createdAt: meta.createdAt };
        writePrivateFileAtomic(path.join(temporary, META_FILE), `${JSON.stringify(pinned)}\n`);
        const marker: LegacyAssignment = { ...identity, rootKey, at: opts.now };
        writePrivateFileAtomic(path.join(temporary, ASSIGNMENT_MARKER_FILE), `${JSON.stringify(marker)}\n`);
        fs.renameSync(temporary, destination);
      } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
      }
    }
    const assigned: LegacyAssignment = { ...identity, rootKey, at: opts.now };
    writePrivateFileAtomic(receiptFile, `${JSON.stringify(assigned)}\n`);
    return true;
  });
}

function recordsIn(spool: MemberSpool): number {
  return spool.sessionIds().reduce((n, id) => n + spool.readRecords(id).length, 0);
}

/**
 * Hold a repository's lock while `fn` runs: the one lock a hook appending held capture and the join moving it take, so
 * every append lands either before the move, and moves with it, or after, and reads the connection the join wrote.
 */
export function withPendingLock<T>(rootKey: string, mycoHome: string, fn: () => T): T {
  if (!ROOT_KEY.test(rootKey)) throw new Error(`withPendingLock: ${rootKey} is not a repository key`);
  ensureMemberDir(pendingRoot(mycoHome), mycoHome);
  return withFileLockSync(path.join(pendingRoot(mycoHome), `.${rootKey}.lock`), fn);
}

/** A failed held move remains retryable while the current hook continues into the live spool. */
export function attemptHeldMigrationForCapture(move: () => number): void {
  try { move(); }
  catch (err) { process.stderr.write(`[myco] member: held migration failed (${(err as Error).message}) — held capture retained for retry\n`); }
}

/** A joined repository sends new capture to its live spool even while an older held journal waits for recovery. */
function connectedSpool(repo: { root: string; rootKey: string; serverUrl?: string }, opts: { mycoHome: string; now: number }): MemberSpool | null {
  const entry = readRegistryEntry(repo.root, opts.mycoHome);
  if (entry === null || repo.serverUrl === undefined || deploymentUrl(entry.serverUrl) !== normalizedServerUrl(repo.serverUrl)) return null;
  return new MemberSpool(entry, { mycoHome: opts.mycoHome });
}

function appendJoined(repo: { root: string; rootKey: string; serverUrl?: string }, opts: { mycoHome: string; now: number }, append: (spool: MemberSpool) => void): boolean {
  const project = connectedSpool(repo, opts);
  if (project === null) return false;
  append(project);
  return true;
}

/**
 * Append a hook's capture for a repository that had no connection when the hook began: into the pending spool, or,
 * where the join connected the repository meanwhile, into the project's own spool. Where the capture lands, or `full`
 * where the pending spool is past its cap.
 */
export function appendPending(
  repo: { root: string; rootKey: string; serverUrl?: string }, sessionId: string, events: readonly OutboundEvent[], record: ((state: SessionState) => void) | undefined,
  opts: { mycoHome: string; now: number },
): 'pending' | 'project' | 'full' {
  const write = (spool: MemberSpool) => spool.appendAndRecord(sessionId, events, record, opts.now);
  if (appendJoined(repo, opts, write)) return 'project';
  return withPendingLock(repo.rootKey, opts.mycoHome, () => {
    if (appendJoined(repo, opts, write)) return 'project';
    const dir = ensurePendingMeta(repo, opts);
    const spool = new MemberSpool(null, { mycoHome: opts.mycoHome, dir });
    if (recordsIn(spool) >= PENDING_MAX_RECORDS) {
      recordHeldEnd(repo, 'full', opts.mycoHome, opts.now);
      return 'full';
    }
    spool.appendAndRecord(sessionId, events, record, opts.now);
    return 'pending';
  });
}

/**
 * Append a turn-end mark for a repository that had no connection when the hook began, as `appendPending` does events:
 * under the repository's lock, into the pending spool, or into the project's spool after the held capture, once the join
 * has connected it. Held marks sit in the pending spool's marks file for the session (`.<session>.turns`).
 */
export function appendPendingTurnEnd(
  repo: { root: string; rootKey: string; serverUrl?: string }, sessionId: string, mark: { slot: TurnEndMark['slot']; transcriptId: string; atSize: number },
  record: ((state: SessionState) => void) | undefined, opts: { mycoHome: string; now: number },
): 'pending' | 'project' | 'full' {
  const write = (spool: MemberSpool) => spool.appendTurnEnd(sessionId, mark, record, opts.now);
  if (appendJoined(repo, opts, write)) return 'project';
  return withPendingLock(repo.rootKey, opts.mycoHome, () => {
    if (appendJoined(repo, opts, write)) return 'project';
    const dir = ensurePendingMeta(repo, opts);
    const spool = new MemberSpool(null, { mycoHome: opts.mycoHome, dir });
    if (recordsIn(spool) >= PENDING_MAX_RECORDS) {
      recordHeldEnd(repo, 'full', opts.mycoHome, opts.now);
      return 'full';
    }
    spool.appendTurnEnd(sessionId, mark, record, opts.now);
    return 'pending';
  });
}

/**
 * Discard a repository's held capture once its first record is older than the TTL, and the leftovers of one already
 * moved (blobs a hook staged as the move ran) once they are as old. Whether anything was discarded.
 */
export function expirePending(rootKey: string, opts: { mycoHome: string; now: number; serverUrl?: string }): boolean {
  return withPendingLock(rootKey, opts.mycoHome, () => {
    if (opts.serverUrl === undefined) {
      return pendingPathsFor(rootKey, opts.mycoHome).map((dir) => expirePath(dir, opts)).some(Boolean);
    }
    return expireOne(rootKey, opts);
  });
}

function expireOne(rootKey: string, opts: { mycoHome: string; now: number; serverUrl?: string }): boolean {
  return expirePath(pendingDir(rootKey, opts.mycoHome, opts.serverUrl), opts);
}

function expirePath(dir: string, opts: { mycoHome: string; now: number }): boolean {
  assertMemberPathContained(dir, opts.mycoHome);
  // A repository-only legacy directory names no provable Deployment and remains held until explicit disposal.
  if (path.dirname(dir) === pendingRoot(opts.mycoHome)) return false;
  if (readLegacyAssignment(path.join(dir, ASSIGNMENT_MARKER_FILE)) !== null) return false;
  const meta = readMeta(dir);
  let since: number;
  if (meta !== null) {
    if (readRegistryEntryResult(meta.root, opts.mycoHome).status !== 'missing') return false;
    since = meta.createdAt;
  }
  else {
    if (hasPendingCaptureAt(dir, opts.mycoHome)) return false;
    const entries = readDirectory(dir);
    if (entries === null) return false;
    if (entries.some((entry) => entry !== BLOBS_DIRNAME)) throw new Error(`Pending capture metadata missing while capture remains held: ${dir}`);
    const stat = lstatEntry(dir);
    if (stat === null) return false;
    since = stat.mtimeMs;
  }
  if (opts.now - since < PENDING_TTL_MS) return false;
  if (liveReferencesPending(dir, opts.mycoHome)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  if (meta !== null) recordHeldEnd(meta, 'expired', opts.mycoHome, opts.now);
  return true;
}

/** Keep pending staged bytes while any live journal still needs them. */
function liveReferencesPending(pendingPath: string, mycoHome: string): boolean {
  const sourceDir = path.resolve(pendingPath, BLOBS_DIRNAME);
  const spoolRoot = path.join(memberRoot(mycoHome), SPOOL_DIRNAME);
  let names: string[];
  try { names = fs.readdirSync(spoolRoot); }
  catch { return !pathIsAbsent(spoolRoot); }
  const spoolDirs: string[] = [];
  for (const name of names) {
    const child = path.join(spoolRoot, name);
    if (isProjectId(name)) {
      spoolDirs.push(child);
    } else if (DEPLOYMENT_KEY.test(name)) {
      assertMemberPathContained(child, mycoHome);
      try { spoolDirs.push(...fs.readdirSync(child).filter(isProjectId).map((projectId) => path.join(child, projectId))); }
      catch { return true; }
    }
  }
  for (const dir of spoolDirs) {
    assertMemberPathContained(dir, mycoHome);
    const live = new MemberSpool(null, { mycoHome, dir, initialize: false });
    let sessions: string[];
    try { sessions = fs.readdirSync(live.dir).filter((name) => name.endsWith('.jsonl') && name !== REFUSED_LOG_FILE).map((name) => name.slice(0, -'.jsonl'.length)); }
    catch { if (pathIsAbsent(live.dir)) continue; return true; }
    for (const sessionId of sessions) {
      const journal = live.readRecordsOrNull(sessionId);
      if (!journal.readable) return true;
      const ack = readSessionStateResult(live.dir, sessionId);
      if (!ack.ok && ack.reason !== 'missing') return true;
      const first = ack.ok ? ack.state.highWater : 0;
      for (const record of journal.records.slice(first)) {
        const file = record?._blobSource?.path;
        if (file !== undefined) {
          const relative = path.relative(sourceDir, path.resolve(file));
          if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return true;
        }
      }
    }
  }
  return false;
}

/** Discard everything held for a repository, under its lock: `myco member leave` opted it out. */
export function discardPending(rootKey: string, mycoHome: string): void {
  withPendingLock(rootKey, mycoHome, () => {
    for (const dir of pendingPathsFor(rootKey, mycoHome)) {
      assertMemberPathContained(dir, mycoHome);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const root = pendingRoot(mycoHome);
    fs.rmSync(endedPath(rootKey, mycoHome), { force: true });
    for (const name of fs.readdirSync(root)) if (DEPLOYMENT_KEY.test(name)) {
      const parent = path.join(root, name);
      const entry = lstatEntry(parent);
      if (entry === null) continue;
      if (!entry.isDirectory()) throw new Error(`Pending capture directory unavailable: ${parent}`);
      const file = path.join(parent, `${rootKey}.ended.json`);
      assertMemberPathContained(file, mycoHome);
      fs.rmSync(file, { force: true });
    }
  });
}

/** Every repository whose capture is waiting, oldest first; expired ones are discarded on the way. */
export function listPending(opts: { mycoHome: string; now: number }): PendingSummary[] {
  const found: PendingSummary[] = [];
  for (const { rootKey, serverUrl, dir } of pendingLocations(opts.mycoHome)) {
    withPendingLock(rootKey, opts.mycoHome, () => {
      if (expirePath(dir, opts)) return;
      const meta = readMeta(dir);
      if (meta === null) {
        const entries = readDirectory(dir);
        if (entries === null || (path.dirname(dir) !== pendingRoot(opts.mycoHome) && entries.every((entry) => entry === BLOBS_DIRNAME))) return;
        throw new Error(`Pending capture metadata missing while capture remains held: ${dir}`);
      }
      const spool = new MemberSpool(null, { mycoHome: opts.mycoHome, dir, initialize: false });
      const sessions = spool.sessionIds();
      const assigned = serverUrl === undefined ? readLegacyAssignment(path.join(dir, ASSIGNMENT_FILE)) : null;
      found.push({ rootKey, root: meta.root, ...(serverUrl === undefined ? {} : { serverUrl }), createdAt: meta.createdAt,
        ...(assigned === null ? {} : { assignedTo: { serverUrl: assigned.serverUrl, projectId: assigned.projectId } }),
        sessions: sessions.length, records: sessions.reduce((n, id) => n + spool.readRecords(id).length, 0) });
    });
  }
  return found.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Move a repository's held capture into the spool of the project it joined, under the repository's lock, and discard
 * what was held. Each record keeps its envelope and its original staged source. The live drain decides how to retry or account for
 * unavailable bytes, and pending retention protects those bytes until the live record is acknowledged.
 * How many records moved.
 */
export function flushPending(rootKey: string, into: MemberSpool, opts: { mycoHome: string; now: number; deadline?: number }): number {
  if (Date.now() >= (opts.deadline ?? Number.POSITIVE_INFINITY)) return 0;
  ensureMemberDir(pendingRoot(opts.mycoHome), opts.mycoHome);
  const taken = LifecycleLock.acquire(path.join(pendingRoot(opts.mycoHome), `.${rootKey}.lock`), { command: 'myco member held migration' });
  if (!taken.acquired) return 0;
  try { return moveHeld(rootKey, into, opts); }
  finally { taken.lock.release(); }
}

/** The move itself; the caller holds the repository's pending lock. */
function moveHeld(rootKey: string, into: MemberSpool, opts: { mycoHome: string; now: number; deadline?: number }): number {
  const route = into.routing;
  if (route === null) throw new Error('Pending capture requires a destination');
  const dir = pendingDir(rootKey, opts.mycoHome, route.serverUrl);
  const meta = readMeta(dir);
  if (meta === null || meta.serverUrl !== normalizedServerUrl(route.serverUrl)) return 0;
  const marker = readLegacyAssignment(path.join(dir, ASSIGNMENT_MARKER_FILE));
  if (marker !== null) {
    const receipt = readLegacyAssignment(path.join(pendingDir(rootKey, opts.mycoHome), ASSIGNMENT_FILE));
    if (receipt === null || marker.rootKey !== rootKey || receipt.rootKey !== rootKey
      || !sameRoutingIdentity(marker, route) || !sameRoutingIdentity(receipt, route)) return 0;
  }
  const held = new MemberSpool(null, { mycoHome: opts.mycoHome, dir, initialize: false });
  let moved = 0;
  let blocked = false;
  const journalSessions = new Set(held.sessionIds());
  for (const sessionId of new Set([...journalSessions, ...held.stateSessionIds()])) {
    if (Date.now() >= (opts.deadline ?? Number.POSITIVE_INFINITY)) {
      blocked = true;
      break;
    }
    // The journal moves in its order, then the turn-end marks no pass has consumed, each with the time its turn ended.
    const run: OutboundEvent[] = [];
    const journal = journalSessions.has(sessionId) ? held.readRecordsOrNull(sessionId) : { readable: true as const, records: [] };
    if (!journal.readable) {
      process.stderr.write(`[myco] member: pending journal ${sessionId} unreadable — kept with its receipts for retry\n`);
      blocked = true;
      continue;
    }
    const damaged: number[] = [];
    for (const [index, line] of journal.records.entries()) {
      if (line === null) {
        damaged.push(index);
        continue;
      }
      run.push({ envelope: toWire(line), ...(line._blobSource ? { blobSource: line._blobSource } : {}) });
    }
    let damagedKeys: string[] = [];
    if (damaged.length > 0) {
      let raw: string;
      try { raw = fs.readFileSync(path.join(dir, `${sessionId}.jsonl`), 'utf8'); }
      catch {
        process.stderr.write(`[myco] member: pending journal ${sessionId} unreadable — kept with its receipts for retry\n`);
        blocked = true;
        continue;
      }
      const lines = raw.split('\n').filter((line) => line.trim() !== '');
      damagedKeys = damaged.map((index) => crypto.createHash('sha256').update(`${rootKey}\0${sessionId}\0${index}\0${lines[index] ?? ''}`).digest('hex'));
      process.stderr.write(`[myco] member: pending journal ${sessionId} contains ${damaged.length} damaged record(s) — counted as capture loss\n`);
    }
    const state = readSessionStateResult(dir, sessionId);
    if (!state.ok && state.reason !== 'missing') {
      process.stderr.write(`[myco] member: pending receipts ${sessionId} ${state.reason} — kept with their journal for retry\n`);
      blocked = true;
      continue;
    }
    const heldState = state.ok ? state.state : readSessionState(dir, sessionId);
    try {
      for (const pointer of pointersOf(heldState)) adoptPendingTranscript(pointer.path, route, opts.mycoHome, rootKey);
    } catch (err) {
      process.stderr.write(`[myco] member: pending transcript ${sessionId} unavailable (${(err as Error).message}) — kept for retry\n`);
      blocked = true;
      continue;
    }
    if (run.length > 0 && !into.prependRecovered(sessionId, run, opts.now)) {
      blocked = true;
      continue;
    }
    moved += run.length;
    into.appendMovedTurnEnds(sessionId, held.pendingTurnEnds(sessionId).map((pending) => pending.mark), opts.now);
    // The session's state moves with its journal, under the session's lock in the project's spool: its transcript
    // pointers, so the transcript ships; and its prompt map and prompt id, so nothing is minted twice.
    into.appendAndRecord(sessionId, [], (target) => {
      mergeHeldState(target, heldState);
      for (const key of damagedKeys) recordSessionLoss(target, key, 'record', opts.now);
    }, opts.now);
    for (const file of [path.join(dir, `${sessionId}.jsonl`), sessionStatePath(dir, sessionId), turnsFileOf(dir, sessionId)]) {
      fs.rmSync(file, { force: true });
    }
  }
  if (blocked) return moved;
  try { new CaptureLossLedger(into.dir).transferFrom(dir, `${rootKey}:${meta.generation ?? meta.createdAt}`); }
  catch (err) {
    process.stderr.write(`[myco] member: pending capture loss counts could not move (${(err as Error).message}) — kept for retry\n`);
    return moved;
  }
  clearHeldEnd(rootKey, opts.mycoHome, route.serverUrl);
  // Everything but the staged blobs goes now; a hook may be staging one as this runs, so they go with the TTL.
  for (const name of fs.readdirSync(dir)) if (name !== BLOBS_DIRNAME) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  if (!liveReferencesPending(dir, opts.mycoHome)) removeEmpty(dir);
  return moved;
}

/** Remove `dir` and every directory under it that holds no file. */
function removeEmpty(dir: string): void {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    const child = path.join(dir, name);
    try { if (fs.statSync(child).isDirectory()) removeEmpty(child); } catch { /* gone */ }
  }
  try { fs.rmdirSync(dir); } catch { /* holds a file */ }
}

/**
 * `held` folded into `target`, the state the project's spool holds for the same session: what the project's spool
 * recorded stands, and what only the held state recorded is added.
 */
export function mergeHeldState(target: SessionState, held: SessionState): void {
  if (held.transcript !== undefined && target.transcript !== undefined && held.transcript.path !== target.transcript.path) {
    (target.continuations ??= {})[held.transcript.path] = held.transcript;
  }
  target.transcript ??= held.transcript;
  target.siblings = { ...held.siblings, ...target.siblings };
  target.continuations = { ...held.continuations, ...target.continuations };
  target.prompts = { ...held.prompts, ...target.prompts };
  target.promptId ??= held.promptId;
  target.planHashes = { ...held.planHashes, ...target.planHashes };
  target.planPaths = { ...held.planPaths, ...target.planPaths };
  target.planTagCount = Math.max(target.planTagCount, held.planTagCount);
  target.attachmentKeys = [...new Set([...held.attachmentKeys, ...target.attachmentKeys])];
  target.delivered = [...new Set([...held.delivered, ...target.delivered])];
  target.compactionOrdinal = Math.max(target.compactionOrdinal, held.compactionOrdinal);
  target.agent ??= held.agent;
  if (held.startedAt !== undefined) target.startedAt = Math.min(target.startedAt ?? held.startedAt, held.startedAt);
}
