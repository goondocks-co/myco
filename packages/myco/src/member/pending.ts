/**
 * Capture held for a repository that has no project yet (#1547).
 *
 * The first hooks in a repository this machine joins by itself run before the join answers: the join runs apart from
 * them (`auto-join.ts`), so no hook waits on it. What those hooks capture is spooled here, one spool per repository at
 * `<MYCO_HOME>/member/pending/<rootKey>/`, and moved into the project's own spool once the repository joins, where the
 * ordinary drain delivers it.
 *
 * A repository that never joins must not hold capture forever: a pending spool is bounded in records, and one whose
 * first record is older than `PENDING_TTL_MS` is discarded. Either end is recorded beside the spool (`HeldEnd`), so
 * the person is told, `myco member status` lists it, and the Deployment's "Needs you" row says it.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveMycoHome } from '../paths/home.js';
import type { OutboundEvent } from './envelope.js';
import { BLOBS_DIRNAME, MemberSpool, REFUSED_LOG_FILE, SPOOL_DIRNAME, toWire, type TurnEndMark } from './spool.js';
import { readRegistryEntry, readRegistryEntryResult } from './registry.js';
import { readSessionState, readSessionStateResult, sessionStatePath, turnsFileOf, type SessionState } from './session-state.js';
import { isProjectId } from './constants.js';
import { CaptureLossLedger, recordSessionLoss } from './capture-loss.js';
import { HELD_CAPTURE_TTL_MS } from '@goondocks/myco-shared/member-protocol';
import { LifecycleLock, withFileLockSync } from '../utils/lifecycle-lock.js';
import { ensureMemberDir, memberRoot, pathIsAbsent, readPrivateJson, writePrivateFileAtomic } from './store.js';

export const PENDING_DIRNAME = 'pending';
/** How long capture waits for its repository to join before it is discarded. */
export const PENDING_TTL_MS = HELD_CAPTURE_TTL_MS;
/** The most records one repository's pending spool holds; a hook past it spools nothing more. */
export const PENDING_MAX_RECORDS = 2000;
const META_FILE = 'pending.json';
const META_VERSION = 1;
/** The project id a pending spool is built under: it names no project, and nothing it holds is drained from here. */
const NO_PROJECT = '';

/** What a pending spool says of itself: the repository it holds capture for, and when it began holding. */
export interface PendingMeta {
  version: number;
  root: string;
  rootKey: string;
  createdAt: number;
  generation?: string;
}

/** That a repository's capture is held no more: its spool reached the cap, or its capture outlived the TTL. */
export interface HeldEnd {
  version: number;
  root: string;
  rootKey: string;
  held: 'full' | 'expired';
  at: number;
}

/** One repository's held capture, as a report reads it. */
export interface PendingSummary {
  rootKey: string;
  root: string;
  createdAt: number;
  sessions: number;
  records: number;
}

export function pendingRoot(mycoHome: string = resolveMycoHome()): string {
  return path.join(memberRoot(mycoHome), PENDING_DIRNAME);
}

export function pendingDir(rootKey: string, mycoHome: string = resolveMycoHome()): string {
  if (!/^[0-9a-f]{16,64}$/.test(rootKey)) throw new Error(`pendingDir: ${rootKey} is not a repository key`);
  return path.join(pendingRoot(mycoHome), rootKey);
}

function readMeta(dir: string): PendingMeta | null {
  const read = readPrivateJson<PendingMeta>(path.join(dir, META_FILE));
  if (!read.ok) return null;
  const value = read.value;
  return value?.version === META_VERSION && typeof value.root === 'string' && typeof value.createdAt === 'number' ? value : null;
}

/** A pending obligation remains until its metadata is verifiably absent. */
export function hasPendingCapture(rootKey: string, mycoHome: string): boolean {
  const dir = pendingDir(rootKey, mycoHome);
  if (!pathIsAbsent(path.join(dir, META_FILE))) return true;
  try { return fs.readdirSync(dir).some((name) => name.endsWith('.jsonl') || name.endsWith('.state.json') || name.endsWith('.turns')); }
  catch { return !pathIsAbsent(dir); }
}

const endedPath = (rootKey: string, mycoHome: string): string => path.join(pendingRoot(mycoHome), `${rootKey}.ended.json`);

/** Where a repository's held capture ended, or null while it is held or was never held. */
export function readHeldEnd(rootKey: string, mycoHome: string): HeldEnd | null {
  const read = readPrivateJson<HeldEnd>(endedPath(rootKey, mycoHome));
  if (!read.ok) return null;
  const value = read.value;
  return value?.version === META_VERSION && (value.held === 'full' || value.held === 'expired') ? value : null;
}

/** Record that a repository's capture is held no more, keeping the first such record until the capture is held again. */
function recordHeldEnd(repo: { root: string; rootKey: string }, held: HeldEnd['held'], mycoHome: string, now: number): void {
  if (readHeldEnd(repo.rootKey, mycoHome)?.held === held) return;
  ensureMemberDir(pendingRoot(mycoHome), mycoHome);
  const end: HeldEnd = { version: META_VERSION, root: repo.root, rootKey: repo.rootKey, held, at: now };
  writePrivateFileAtomic(endedPath(repo.rootKey, mycoHome), `${JSON.stringify(end)}\n`);
}

function clearHeldEnd(rootKey: string, mycoHome: string): void {
  fs.rmSync(endedPath(rootKey, mycoHome), { force: true });
}

/** Establish a distinct pending hold before its first journal append. */
function ensurePendingMeta(repo: { root: string; rootKey: string }, opts: { mycoHome: string; now: number }, dir: string): void {
  if (readMeta(dir) !== null) return;
  const meta: PendingMeta = { version: META_VERSION, root: repo.root, rootKey: repo.rootKey, createdAt: opts.now, generation: crypto.randomUUID() };
  writePrivateFileAtomic(path.join(dir, META_FILE), `${JSON.stringify(meta)}\n`);
  clearHeldEnd(repo.rootKey, opts.mycoHome);
}

/** Every repository whose held capture ended, most recent first. */
export function listHeldEnds(mycoHome: string): HeldEnd[] {
  let names: string[];
  try { names = fs.readdirSync(pendingRoot(mycoHome)).filter((name) => /^[0-9a-f]{16,64}\.ended\.json$/.test(name)); } catch { return []; }
  return names.map((name) => readHeldEnd(name.slice(0, -'.ended.json'.length), mycoHome)).filter((end): end is HeldEnd => end !== null).sort((a, b) => b.at - a.at);
}

/**
 * The spool a repository's capture waits in, for a hook to stage blobs and read session state through; null where its
 * capture is past the record cap. Nothing is written here: `appendPending` writes, under the repository's lock.
 */
export function pendingSpool(repo: { root: string; rootKey: string }, opts: { mycoHome: string; now: number }): MemberSpool | null {
  expirePending(repo.rootKey, opts);
  ensureMemberDir(pendingRoot(opts.mycoHome), opts.mycoHome);
  // The directory, and no record: a hook's handler reads the session's state here before anything is appended.
  const spool = new MemberSpool(NO_PROJECT, { mycoHome: opts.mycoHome, dir: pendingDir(repo.rootKey, opts.mycoHome) });
  if (recordsIn(spool) < PENDING_MAX_RECORDS) return spool;
  recordHeldEnd(repo, 'full', opts.mycoHome, opts.now);
  return null;
}

function recordsIn(spool: MemberSpool): number {
  return spool.sessionIds().reduce((n, id) => n + spool.readRecords(id).length, 0);
}

/**
 * Hold a repository's lock while `fn` runs: the one lock a hook appending held capture and the join moving it take, so
 * every append lands either before the move, and moves with it, or after, and reads the connection the join wrote.
 */
export function withPendingLock<T>(rootKey: string, mycoHome: string, fn: () => T): T {
  ensureMemberDir(pendingRoot(mycoHome), mycoHome);
  return withFileLockSync(path.join(pendingRoot(mycoHome), `.${rootKey}.lock`), fn);
}

/** A failed held move remains retryable while the current hook continues into the live spool. */
export function attemptHeldMigrationForCapture(move: () => number): void {
  try { move(); }
  catch (err) { process.stderr.write(`[myco] member: held migration failed (${(err as Error).message}) — held capture retained for retry\n`); }
}

/** A joined repository sends new capture to its live spool even while an older held journal waits for recovery. */
function connectedSpool(repo: { root: string; rootKey: string }, opts: { mycoHome: string; now: number }): MemberSpool | null {
  const entry = readRegistryEntry(repo.root, opts.mycoHome);
  if (entry === null) return null;
  return new MemberSpool(entry.projectId, { mycoHome: opts.mycoHome });
}

function appendJoined(repo: { root: string; rootKey: string }, opts: { mycoHome: string; now: number }, append: (spool: MemberSpool) => void): boolean {
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
  repo: { root: string; rootKey: string }, sessionId: string, events: readonly OutboundEvent[], record: ((state: SessionState) => void) | undefined,
  opts: { mycoHome: string; now: number },
): 'pending' | 'project' | 'full' {
  const write = (spool: MemberSpool) => spool.appendAndRecord(sessionId, events, record, opts.now);
  if (appendJoined(repo, opts, write)) return 'project';
  return withPendingLock(repo.rootKey, opts.mycoHome, () => {
    if (appendJoined(repo, opts, write)) return 'project';
    const dir = pendingDir(repo.rootKey, opts.mycoHome);
    ensureMemberDir(dir, opts.mycoHome);
    ensurePendingMeta(repo, opts, dir);
    const spool = new MemberSpool(NO_PROJECT, { mycoHome: opts.mycoHome, dir });
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
  repo: { root: string; rootKey: string }, sessionId: string, mark: { slot: TurnEndMark['slot']; transcriptId: string; atSize: number },
  record: ((state: SessionState) => void) | undefined, opts: { mycoHome: string; now: number },
): 'pending' | 'project' | 'full' {
  const write = (spool: MemberSpool) => spool.appendTurnEnd(sessionId, mark, record, opts.now);
  if (appendJoined(repo, opts, write)) return 'project';
  return withPendingLock(repo.rootKey, opts.mycoHome, () => {
    if (appendJoined(repo, opts, write)) return 'project';
    const dir = pendingDir(repo.rootKey, opts.mycoHome);
    ensureMemberDir(dir, opts.mycoHome);
    ensurePendingMeta(repo, opts, dir);
    const spool = new MemberSpool(NO_PROJECT, { mycoHome: opts.mycoHome, dir });
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
export function expirePending(rootKey: string, opts: { mycoHome: string; now: number }): boolean {
  return withPendingLock(rootKey, opts.mycoHome, () => expirePendingUnlocked(rootKey, opts));
}

function expirePendingUnlocked(rootKey: string, opts: { mycoHome: string; now: number }): boolean {
  const dir = pendingDir(rootKey, opts.mycoHome);
  const meta = readMeta(dir);
  let since: number;
  if (meta !== null) {
    if (readRegistryEntryResult(meta.root, opts.mycoHome).status !== 'missing') return false;
    since = meta.createdAt;
  }
  else {
    if (hasPendingCapture(rootKey, opts.mycoHome)) return false;
    try { since = fs.statSync(dir).mtimeMs; } catch { return false; }
  }
  if (opts.now - since < PENDING_TTL_MS) return false;
  if (liveReferencesPending(rootKey, opts.mycoHome)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  if (meta !== null) recordHeldEnd(meta, 'expired', opts.mycoHome, opts.now);
  return true;
}

/** Keep pending staged bytes while any live journal still needs them. */
function liveReferencesPending(rootKey: string, mycoHome: string): boolean {
  const sourceDir = path.resolve(pendingDir(rootKey, mycoHome), BLOBS_DIRNAME);
  const spoolRoot = path.join(memberRoot(mycoHome), SPOOL_DIRNAME);
  let projectIds: string[];
  try { projectIds = fs.readdirSync(spoolRoot).filter(isProjectId); }
  catch { return !pathIsAbsent(spoolRoot); }
  for (const projectId of projectIds) {
    const live = new MemberSpool(projectId, { mycoHome, initialize: false });
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
        if (file !== undefined && path.relative(sourceDir, path.resolve(file)).split(path.sep)[0] !== '..' && !path.isAbsolute(path.relative(sourceDir, path.resolve(file)))) return true;
      }
    }
  }
  return false;
}

/** Discard everything held for a repository, under its lock: `myco member leave` opted it out. */
export function discardPending(rootKey: string, mycoHome: string): void {
  withPendingLock(rootKey, mycoHome, () => {
    fs.rmSync(pendingDir(rootKey, mycoHome), { recursive: true, force: true });
    clearHeldEnd(rootKey, mycoHome);
  });
}

/** Every repository whose capture is waiting, oldest first; expired ones are discarded on the way. */
export function listPending(opts: { mycoHome: string; now: number }): PendingSummary[] {
  let keys: string[];
  try {
    keys = fs.readdirSync(pendingRoot(opts.mycoHome)).filter((name) => /^[0-9a-f]{16,64}$/.test(name));
  } catch {
    return [];
  }
  const found: PendingSummary[] = [];
  for (const rootKey of keys) {
    if (expirePending(rootKey, opts)) continue;
    const dir = pendingDir(rootKey, opts.mycoHome);
    const meta = readMeta(dir);
    if (meta === null) continue;
    const spool = new MemberSpool(NO_PROJECT, { mycoHome: opts.mycoHome, dir, initialize: false });
    const sessions = spool.sessionIds();
    found.push({ rootKey, root: meta.root, createdAt: meta.createdAt, sessions: sessions.length, records: sessions.reduce((n, id) => n + spool.readRecords(id).length, 0) });
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
  const dir = pendingDir(rootKey, opts.mycoHome);
  const meta = readMeta(dir);
  if (meta === null) return 0;
  const held = new MemberSpool(NO_PROJECT, { mycoHome: opts.mycoHome, dir, initialize: false });
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
  clearHeldEnd(rootKey, opts.mycoHome);
  // Everything but the staged blobs goes now; a hook may be staging one as this runs, so they go with the TTL.
  for (const name of fs.readdirSync(dir)) if (name !== BLOBS_DIRNAME) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  if (!liveReferencesPending(rootKey, opts.mycoHome)) removeEmpty(dir);
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
  target.transcript ??= held.transcript;
  target.siblings = { ...held.siblings, ...target.siblings };
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
