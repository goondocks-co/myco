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
import { resolveMycoHome } from '../paths/home.js';
import type { OutboundEvent } from './envelope.js';
import { BLOBS_DIRNAME, MemberSpool, toWire, type TurnEndMark } from './spool.js';
import { readRegistryEntry } from './registry.js';
import { readSessionState, readSessionStateResult, type SessionState } from './session-state.js';
import { readStagedBlob } from './staged-blobs.js';
import { HELD_CAPTURE_TTL_MS } from '@goondocks/myco-shared/member-protocol';
import { withFileLockSync } from '../utils/lifecycle-lock.js';
import { ensureMemberDir, memberRoot, readPrivateJson, writePrivateFileAtomic } from './store.js';

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

class PendingPayloadUnavailable extends Error {
  constructor(event: OutboundEvent, status: string) {
    super(`pending capture ${event.envelope.eventId}: staged payload ${status} — kept with its receipts for retry`);
  }
}

/** Restage a complete batch, retaining its source and receipts whenever a payload cannot be verified. */
function restaged(events: readonly OutboundEvent[], into: MemberSpool, sessionId: string): OutboundEvent[] {
  const stage = into.stagerFor(sessionId);
  const kept: OutboundEvent[] = [];
  for (const event of events) {
    if (event.blobSource === undefined) { kept.push(event); continue; }
    const read = readStagedBlob(event.blobSource);
    if (read.status !== 'ready') throw new PendingPayloadUnavailable(event, read.status);
    kept.push({ envelope: event.envelope, blobSource: stage(read.bytes, event.blobSource.mediaType) });
  }
  return kept;
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
  return withPendingLock(repo.rootKey, opts.mycoHome, () => {
    const entry = readRegistryEntry(repo.root, opts.mycoHome);
    if (entry !== null) {
      // Connected while this hook ran, and perhaps not yet settled: the held capture goes first, so this lands after it.
      const project = new MemberSpool(entry.projectId, { mycoHome: opts.mycoHome });
      moveHeld(repo.rootKey, project, opts);
      try {
        project.appendAndRecord(sessionId, restaged(events, project, sessionId), record, opts.now);
        return 'project';
      } catch (err) {
        if (!(err instanceof PendingPayloadUnavailable)) throw err;
        process.stderr.write(`[myco] member: ${err.message}\n`);
      }
    }
    const dir = pendingDir(repo.rootKey, opts.mycoHome);
    ensureMemberDir(dir, opts.mycoHome);
    if (readMeta(dir) === null) {
      const meta: PendingMeta = { version: META_VERSION, root: repo.root, rootKey: repo.rootKey, createdAt: opts.now };
      writePrivateFileAtomic(path.join(dir, META_FILE), `${JSON.stringify(meta)}\n`);
      clearHeldEnd(repo.rootKey, opts.mycoHome);
    }
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
  return withPendingLock(repo.rootKey, opts.mycoHome, () => {
    const entry = readRegistryEntry(repo.root, opts.mycoHome);
    if (entry !== null) {
      const project = new MemberSpool(entry.projectId, { mycoHome: opts.mycoHome });
      moveHeld(repo.rootKey, project, opts);
      project.appendTurnEnd(sessionId, mark, record, opts.now);
      return 'project';
    }
    const dir = pendingDir(repo.rootKey, opts.mycoHome);
    ensureMemberDir(dir, opts.mycoHome);
    if (readMeta(dir) === null) {
      const meta: PendingMeta = { version: META_VERSION, root: repo.root, rootKey: repo.rootKey, createdAt: opts.now };
      writePrivateFileAtomic(path.join(dir, META_FILE), `${JSON.stringify(meta)}\n`);
      clearHeldEnd(repo.rootKey, opts.mycoHome);
    }
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
  const dir = pendingDir(rootKey, opts.mycoHome);
  const meta = readMeta(dir);
  let since: number;
  if (meta !== null) since = meta.createdAt;
  else {
    try { since = fs.statSync(dir).mtimeMs; } catch { return false; }
  }
  if (opts.now - since < PENDING_TTL_MS) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  if (meta !== null) recordHeldEnd(meta, 'expired', opts.mycoHome, opts.now);
  return true;
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
 * what was held. Each record keeps its envelope; its blob, where it carries one, is staged again under the project's
 * spool, so the drain reads it from there. Unavailable payloads keep the source journal and receipts for retry.
 * How many records moved.
 */
export function flushPending(rootKey: string, into: MemberSpool, opts: { mycoHome: string; now: number }): number {
  return withPendingLock(rootKey, opts.mycoHome, () => moveHeld(rootKey, into, opts));
}

/** The move itself; the caller holds the repository's pending lock. */
function moveHeld(rootKey: string, into: MemberSpool, opts: { mycoHome: string; now: number }): number {
  const dir = pendingDir(rootKey, opts.mycoHome);
  if (readMeta(dir) === null) return 0;
  const held = new MemberSpool(NO_PROJECT, { mycoHome: opts.mycoHome, dir, initialize: false });
  const prepared: Array<{ sessionId: string; events: OutboundEvent[]; state: SessionState }> = [];
  for (const sessionId of new Set([...held.sessionIds(), ...held.stateSessionIds()])) {
    // The journal moves in its order, then the turn-end marks no pass has consumed, each with the time its turn ended.
    const run: OutboundEvent[] = [];
    const journal = held.sessionIds().includes(sessionId) ? held.readRecordsOrNull(sessionId) : { readable: true as const, records: [] };
    if (!journal.readable) {
      process.stderr.write(`[myco] member: pending journal ${sessionId} unreadable — kept with its receipts for retry\n`);
      return 0;
    }
    for (const line of journal.records) {
      if (line === null) {
        process.stderr.write(`[myco] member: pending journal ${sessionId} contains a damaged record — kept for recovery\n`);
        return 0;
      }
      run.push({ envelope: toWire(line), ...(line._blobSource ? { blobSource: line._blobSource } : {}) });
    }
    const state = readSessionStateResult(dir, sessionId);
    if (!state.ok && state.reason !== 'missing') {
      process.stderr.write(`[myco] member: pending receipts ${sessionId} ${state.reason} — kept with their journal for retry\n`);
      return 0;
    }
    try { prepared.push({ sessionId, events: restaged(run, into, sessionId), state: state.ok ? state.state : readSessionState(dir, sessionId) }); }
    catch (err) {
      if (!(err instanceof PendingPayloadUnavailable)) throw err;
      process.stderr.write(`[myco] member: ${err.message}\n`);
      return 0;
    }
  }
  let moved = 0;
  for (const { sessionId, events, state } of prepared) {
    into.appendAndRecord(sessionId, events, undefined, opts.now, true);
    moved += events.length;
    into.appendMovedTurnEnds(sessionId, held.pendingTurnEnds(sessionId).map((pending) => pending.mark), opts.now);
    // The session's state moves with its journal, under the session's lock in the project's spool: its transcript
    // pointers, so the transcript ships; and its prompt map and prompt id, so nothing is minted twice.
    into.appendAndRecord(sessionId, [], (target) => mergeHeldState(target, state), opts.now);
  }
  clearHeldEnd(rootKey, opts.mycoHome);
  // Everything but the staged blobs goes now; a hook may be staging one as this runs, so they go with the TTL.
  for (const name of fs.readdirSync(dir)) if (name !== BLOBS_DIRNAME) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  removeEmpty(dir);
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
