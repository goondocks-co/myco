import { legacyTranscriptDestination } from './transcript-routing.js';
/**
 * Unacknowledged records remain in their active journal for delivery regardless
 * of age. Session state is retired only after its event journal has been
 * delivered and its transcript pointers have no bytes left to ship.
 *
 * Staged blob bytes are swept here too: the drain releases a record's bytes
 * when its high-water advances, and this sweep collects whatever a drain that
 * never finished left behind — but never bytes young enough that a live hook
 * could still commit a record naming them, or bytes whose journal cannot be
 * read to prove they are unreferenced.
 *
 * Archived quarantine journals are replayed through the live spool and cleaned
 * once their replay is accounted for. Plugin-written transcripts age here too.
 * They are the member's own store, written by a native plugin for an agent
 * whose runtime keeps no append-only transcript of its own. A store whose
 * manifest declares `retention: harness` belongs to the agent and is untouched.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BUFFER_QUARANTINE_DIRNAME } from './spool.js';
import { LifecycleLock } from '../utils/lifecycle-lock.js';
import { longestDeclaredHookTimeoutMs } from './budget.js';
import { CaptureLossLedger } from './capture-loss.js';
import { isProjectId, MEMBER_DIR_MODE, MEMBER_SESSION_STATE_RETENTION_MS, MEMBER_TRANSCRIPT_RETENTION_MS } from './constants.js';
import type { OutboundEvent } from './envelope.js';
import { resolveMycoHome } from '../paths/home.js';
import { BUNDLED_MANIFESTS } from '../symbionts/manifests.generated.js';
import { expandRoot } from '../symbionts/transcript-discovery.js';
import { pointerBehind, pointersOf, readSessionState, readSessionStateUnlocked, readSessionStateResultUnlocked, retireSessionFiles, updateSessionState, type TranscriptPointer } from './session-state.js';
import { BLOBS_DIRNAME, blobSourceOf, SPOOL_DIRNAME, WIRE_FIELDS, type MemberSpool, type SpoolRecord } from './spool.js';
import { readStagedBlob } from './staged-blobs.js';
import { assertMemberPathContained, ensurePrivateFile, memberRoot, pathIsAbsent, readPrivateJson, writePrivateFileAtomic } from './store.js';

export interface RetentionResult {
  /** State files of fully delivered sessions untouched past the retention window, removed after a drain that delivered everything. */
  prunedStates: number;
  /** Staged blob files deleted because no live spool record references them. */
  releasedBlobs: number;
  /** Plugin-written transcripts deleted because they aged past the member window. */
  prunedTranscripts: number;
}

interface ArchiveReplay {
  sessionId: string;
  replayedAt: number;
  eventIds: string[];
  lostRecords: number;
}

const ARCHIVE_REPLAY_SUFFIX = '.replayed.json';
const ARCHIVE_LEASE_FILE = '.quarantine-recovery.lock';
const archiveWarning = (file: string, why: string): void => {
  process.stderr.write(`[myco] member: archived journal ${file} could not be recovered: ${why}\n`);
};

function withArchiveLease(spool: MemberSpool, action: () => number): number {
  const file = path.join(spool.dir, ARCHIVE_LEASE_FILE);
  try {
    ensurePrivateFile(file);
    const lease = LifecycleLock.acquire(file, { command: 'myco member quarantine recovery' });
    if (!lease.acquired) return 0;
    try { return action(); }
    finally { lease.lock.release(); }
  } catch (error) {
    archiveWarning(file, error instanceof Error ? error.message : String(error));
    return 0;
  }
}

function archiveReplayOf(file: string): ArchiveReplay | null {
  const read = readPrivateJson<ArchiveReplay>(file);
  if (!read.ok) return null;
  const value = read.value;
  return value !== null && typeof value === 'object' && typeof value.sessionId === 'string'
    && typeof value.replayedAt === 'number' && Number.isFinite(value.replayedAt)
    && Array.isArray(value.eventIds) && value.eventIds.every((id) => typeof id === 'string')
    && Number.isSafeInteger(value.lostRecords) && value.lostRecords >= 0 ? value : null;
}

function archiveRecord(line: unknown): line is SpoolRecord {
  if (line === null || typeof line !== 'object') return false;
  const record = line as Partial<SpoolRecord>;
  return typeof record.sessionId === 'string' && record.sessionId !== ''
    && typeof record.eventId === 'string' && record.eventId !== '' && typeof record.kind === 'string'
    && record.payload !== null && typeof record.payload === 'object' && !Array.isArray(record.payload)
    && (record._blobSource === undefined || (typeof record._blobSource.path === 'string'
      && typeof record._blobSource.sha256 === 'string' && /^[a-f0-9]{64}$/.test(record._blobSource.sha256)
      && typeof record._blobSource.mediaType === 'string' && typeof record._blobSource.size === 'number'
      && Number.isSafeInteger(record._blobSource.size) && record._blobSource.size >= 0));
}

function archiveNames(spool: MemberSpool): string[] {
  const dir = path.join(spool.dir, BUFFER_QUARANTINE_DIRNAME);
  try {
    assertMemberPathContained(dir, spool.mycoHome);
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map((entry) => entry.name);
  } catch (error) {
    if (!pathIsAbsent(dir)) archiveWarning(dir, error instanceof Error ? error.message : String(error));
    return [];
  }
}

function replayMarkerNames(spool: MemberSpool): string[] {
  const dir = path.join(spool.dir, BUFFER_QUARANTINE_DIRNAME);
  try {
    assertMemberPathContained(dir, spool.mycoHome);
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(ARCHIVE_REPLAY_SUFFIX))
      .map((entry) => entry.name);
  } catch (error) {
    if (!pathIsAbsent(dir)) archiveWarning(dir, error instanceof Error ? error.message : String(error));
    return [];
  }
}

function liveArchiveRecords(spool: MemberSpool, sessionId: string): Array<SpoolRecord | null> | null {
  try {
    return spool.withSessionRecordsLock(sessionId, (read) => read.readable ? read.records : read.absent === true ? [] : null);
  } catch { return null; }
}

function readArchivedRecords(spool: MemberSpool, file: string): { records: SpoolRecord[]; damaged: string[] } {
  assertMemberPathContained(file, spool.mycoHome);
  const records: SpoolRecord[] = [];
  const damaged: string[] = [];
  const prefix = `${spool.projectId}:${path.basename(file)}`;
  for (const [index, line] of fs.readFileSync(file, 'utf8').split('\n').entries()) {
    if (line.trim() === '') continue;
    try {
      const record = JSON.parse(line) as unknown;
      if (archiveRecord(record)) records.push(record);
      else damaged.push(`${prefix}:${index}:${crypto.createHash('sha256').update(line).digest('hex')}`);
    } catch { damaged.push(`${prefix}:${index}:${crypto.createHash('sha256').update(line).digest('hex')}`); }
  }
  if (records.length === 0 && damaged.length === 0) damaged.push(`${prefix}:empty`);
  return { records, damaged };
}

function classifyArchivedRecords(spool: MemberSpool, file: string, base: string): { sessionId: string; records: SpoolRecord[]; damaged: string[] } {
  const read = readArchivedRecords(spool, file);
  const records: SpoolRecord[] = [];
  const damaged = [...read.damaged];
  const sessionId = read.records[0]?.sessionId ?? base;
  for (const record of read.records) {
    if (record.sessionId !== sessionId) { damaged.push(`${spool.projectId}:${base}:foreign-session:${record.eventId}`); continue; }
    const source = record._blobSource;
    if (source !== undefined) {
      try {
        const original = path.join(spool.blobsDirFor(sessionId), source.sha256);
        const legacy = path.join(spool.blobsDir, source.sha256);
        const pending = path.relative(path.join(memberRoot(spool.mycoHome), 'pending'), path.resolve(source.path)).split(path.sep);
        const pendingSource = pending.length === 4 && /^[a-f0-9]{16,64}$/.test(pending[0])
          && pending[1] === 'blobs' && pending[2] === sessionId && pending[3] === source.sha256;
        if (path.resolve(source.path) !== path.resolve(original) && path.resolve(source.path) !== path.resolve(legacy)
            && !pendingSource) throw new Error('unexpected staged path');
        assertMemberPathContained(source.path, spool.mycoHome);
        assertMemberPathContained(path.join(spool.dir, BUFFER_QUARANTINE_DIRNAME, 'blobs', base, source.sha256), spool.mycoHome);
      } catch { damaged.push(`${spool.projectId}:${base}:invalid-source:${record.eventId}`); continue; }
    }
    records.push(record);
  }
  return { sessionId, records, damaged };
}

/** Replay quarantine journals through ordinary delivery while retaining each archive until its replay is acknowledged. */
export function recoverArchivedQuarantine(spool: MemberSpool, now: number = Date.now(), canRecover: () => boolean = () => true): number {
  if (!canRecover()) return 0;
  if (archiveNames(spool).length === 0) return 0;
  return withArchiveLease(spool, () => recoverArchivedQuarantineUnlocked(spool, now, canRecover));
}

function recoverArchivedQuarantineUnlocked(spool: MemberSpool, now: number, canRecover: () => boolean): number {
  const dir = path.join(spool.dir, BUFFER_QUARANTINE_DIRNAME);
  let recovered = 0;
  for (const name of archiveNames(spool)) {
    if (!canRecover()) break;
    const base = name.slice(0, -'.jsonl'.length);
    const file = path.join(dir, name);
    const markerFile = path.join(dir, `${base}${ARCHIVE_REPLAY_SUFFIX}`);
    try {
      const { sessionId, records, damaged } = classifyArchivedRecords(spool, file, base);
      if (damaged.length > 0) archiveWarning(file, `${damaged.length} damaged record(s) counted as capture loss`);
      const marker = archiveReplayOf(markerFile);
      const eventIds = records.map((record) => record.eventId);
      if (marker?.sessionId === sessionId && eventIds.length === marker.eventIds.length
          && eventIds.every((id, i) => id === marker.eventIds[i]) && marker.lostRecords === damaged.length) {
        const live = liveArchiveRecords(spool, sessionId);
        if (live !== null && eventIds.every((id) => live.some((record) => record?.eventId === id))) continue;
        if (live !== null) {
          const state = readSessionState(spool.dir, sessionId);
          if ((state.lastAccountedAt ?? state.lastAckAt ?? 0) >= marker.replayedAt
              && eventIds.every((id) => !live.some((record) => record?.eventId === id))) continue;
        }
      }
      const events: OutboundEvent[] = records.map((record) => {
        const envelope = Object.fromEntries(WIRE_FIELDS.map((field) => [field, record[field]])) as unknown as OutboundEvent['envelope'];
        const original = record._blobSource;
        if (original === undefined) return { envelope };
        const candidate = { ...original, path: path.join(dir, 'blobs', base, original.sha256) };
        const archiveBytes = readStagedBlob(candidate);
        if (archiveBytes.status === 'ready') return { envelope, blobSource: spool.stagerFor(sessionId)(archiveBytes.bytes, original.mediaType) };
        const originalBytes = readStagedBlob(original);
        if (originalBytes.status === 'ready') return { envelope, blobSource: spool.stagerFor(sessionId)(originalBytes.bytes, original.mediaType) };
        return { envelope, blobSource: archiveBytes.status === 'missing' ? original : candidate };
      });
      if (events.length > 0 && !spool.prependRecovered(sessionId, events, now)) continue;
      new CaptureLossLedger(spool.dir).record(damaged.map((key) => ({ key, kind: 'record', at: now })));
      writePrivateFileAtomic(markerFile, JSON.stringify({ sessionId, replayedAt: now, eventIds, lostRecords: damaged.length } satisfies ArchiveReplay));
      recovered += 1;
    } catch (error) {
      archiveWarning(file, error instanceof Error ? error.message : String(error));
    }
  }
  return recovered;
}

/** Delete only archives whose replayed records have all passed the live journal's acknowledgement mark. */
export function cleanAcknowledgedQuarantine(spool: MemberSpool): number {
  if (replayMarkerNames(spool).length === 0) return 0;
  return withArchiveLease(spool, () => cleanAcknowledgedQuarantineUnlocked(spool));
}

function cleanAcknowledgedQuarantineUnlocked(spool: MemberSpool): number {
  const dir = path.join(spool.dir, BUFFER_QUARANTINE_DIRNAME);
  let cleaned = 0;
  for (const name of replayMarkerNames(spool)) {
    const base = name.slice(0, -ARCHIVE_REPLAY_SUFFIX.length);
    const file = path.join(dir, `${base}.jsonl`);
    const markerFile = path.join(dir, name);
    const marker = archiveReplayOf(markerFile);
    if (marker === null) continue;
    try {
      assertMemberPathContained(file, spool.mycoHome);
      const blobDir = path.join(dir, 'blobs', base);
      assertMemberPathContained(blobDir, spool.mycoHome);
      if (!pathIsAbsent(file)) {
        const archived = classifyArchivedRecords(spool, file, base);
        if (archived.damaged.length !== marker.lostRecords || archived.records.length !== marker.eventIds.length
            || archived.records.some((record, index) => record.eventId !== marker.eventIds[index])) continue;
      }
      if (marker.eventIds.length > 0) {
        const live = liveArchiveRecords(spool, marker.sessionId);
        if (live === null) continue;
        const state = readSessionState(spool.dir, marker.sessionId);
        if ((state.lastAccountedAt ?? state.lastAckAt ?? 0) < marker.replayedAt) continue;
        if (live.some((record, index) => index >= state.highWater && marker.eventIds.includes(record?.eventId ?? ''))) continue;
      }
      if (!pathIsAbsent(file)) fs.unlinkSync(file);
      fs.rmSync(blobDir, { recursive: true, force: true });
      fs.unlinkSync(markerFile);
      cleaned += 1;
    } catch (error) {
      archiveWarning(file, error instanceof Error ? error.message : String(error));
    }
  }
  try { fs.rmdirSync(path.join(dir, 'blobs')); } catch { /* archives or other files remain */ }
  try { fs.rmdirSync(dir); } catch { /* archives or other files remain */ }
  return cleaned;
}

/**
 * The transcript roots the member owns, from the manifests that declare it.
 *
 * A store is pruned here only when its manifest says `retention: member` —
 * the agent whose plugin wrote it. Every other store belongs to its harness
 * and holds the user's own history, which this pass must never delete; the
 * declaration is what makes that a checkable boundary rather than a property
 * of where the loop happens to look.
 */
export function memberOwnedTranscriptRoots(env: NodeJS.ProcessEnv = process.env, mycoHome?: string): string[] {
  const roots: string[] = [];
  for (const manifest of BUNDLED_MANIFESTS) {
    const discovery = manifest.capture?.transcriptDiscovery;
    if (!discovery || discovery.retention !== 'member') continue;
    for (const root of discovery.roots) roots.push(expandRoot(root, env, mycoHome));
  }
  return roots;
}

/**
 * Delete plugin-written transcripts past the member's window.
 *
 * Age is the file's mtime: these files are append-only for the life of a
 * session, so a still-running session keeps bumping it and cannot be pruned
 * out from under itself.
 */
export function prunePluginTranscripts(
  now: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
  mycoHome?: string,
): number {
  let pruned = 0;
  const home = mycoHome ?? resolveMycoHome({ env });
  let behind: Set<string> | undefined;
  // A claim names the instance that speaks for a session. It outlives nothing:
  // once past the window no runtime holds it and no transcript needs it.
  const filesUnder = (root: string, suffix: string): string[] => {
    assertMemberPathContained(root, home);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && pathIsAbsent(root)) return [];
      throw error;
    }
    return entries.flatMap((entry) => {
      const file = path.join(root, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Member transcript store contains a symbolic link: ${file}`);
      return entry.isDirectory() ? filesUnder(file, suffix) : entry.isFile() && entry.name.endsWith(suffix) ? [file] : [];
    });
  };
  const claims = path.join(home, 'member', 'claims');
  for (const file of filesUnder(claims, '.lock')) {
    if (now - fs.statSync(file).mtimeMs >= MEMBER_TRANSCRIPT_RETENTION_MS) fs.unlinkSync(file);
  }
  for (const file of new Set(memberOwnedTranscriptRoots(env, mycoHome).flatMap((root) => filesUnder(root, '.jsonl')))) {
    let stat: fs.Stats;
    try { stat = fs.statSync(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && pathIsAbsent(file)) continue;
      throw error;
    }
    if (now - stat.mtimeMs < MEMBER_TRANSCRIPT_RETENTION_MS) continue;
    if ((behind ??= behindTranscriptPaths(home)).has(path.resolve(file))) continue;
    const relative = path.relative(path.join(memberRoot(home), 'transcripts'), file).split(path.sep);
    if (/^[0-9a-f]{16}$/.test(relative[0] ?? '') && relative[1]?.startsWith('~pending-')) continue;
    if (!/^[0-9a-f]{16}$/.test(relative[0] ?? '') && legacyTranscriptDestination(file, home) === null) continue;
    try { fs.unlinkSync(file); pruned += 1; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !pathIsAbsent(file)) throw error;
    }
  }
  return pruned;
}

/**
 * Every transcript a session of this home still has bytes to ship from: the files named by a pointer, of any project's
 * session, that is behind its file. Read without the session locks: a pointer that moves while this runs only keeps a
 * file one pass longer.
 */
export function behindTranscriptPaths(mycoHome: string): Set<string> {
  const files = new Set<string>();
  const spoolRoot = path.join(memberRoot(mycoHome), SPOOL_DIRNAME);
  const readDir = (dir: string, allowMissing = false): fs.Dirent[] => {
    assertMemberPathContained(dir, mycoHome);
    try { return fs.readdirSync(dir, { withFileTypes: true }); }
    catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT' && pathIsAbsent(dir)) return [];
      throw error;
    }
  };
  const directories: string[] = [];
  for (const entry of readDir(spoolRoot, true)) {
    if (!isProjectId(entry.name)) continue;
    const dir = path.join(spoolRoot, entry.name);
    if (!entry.isDirectory()) throw new Error(`Spool directory is unavailable: ${dir}`);
    directories.push(dir);
    if (!/^[0-9a-f]{16}$/.test(entry.name)) continue;
    for (const child of readDir(dir)) {
      if (child.isDirectory() && isProjectId(child.name)) directories.push(path.join(dir, child.name));
    }
  }
  const pointerBehindForPrune = (pointer: TranscriptPointer): boolean => {
    if (typeof pointer?.path !== 'string' || pointer.path === '' ||
        !Number.isSafeInteger(pointer.nextOffset) || pointer.nextOffset < 0 ||
        (pointer.refused !== undefined && typeof pointer.refused !== 'string')) {
      throw new Error('Spool transcript pointer is invalid');
    }
    if (pointer.refused !== undefined) return false;
    try { return fs.statSync(pointer.path).size > pointer.nextOffset; }
    catch { return true; }
  };
  for (const dir of directories) {
    const names = readDir(dir);
    for (const name of names) {
      if (!name.name.endsWith(STATE_SUFFIX)) continue;
      if (!name.isFile()) throw new Error(`Spool session state is unavailable: ${path.join(dir, name.name)}`);
      const sessionId = name.name.slice(0, -STATE_SUFFIX.length);
      const read = readSessionStateResultUnlocked(dir, sessionId);
      if (!read.ok) throw new Error(`Spool session state is ${read.reason}: ${path.join(dir, name.name)}`);
      for (const pointer of pointersOf(read.state)) {
        if (pointerBehindForPrune(pointer)) files.add(path.resolve(pointer.path));
      }
    }
  }
  return files;
}

const STATE_SUFFIX = '.state.json';

/**
 * Delete staged blob bytes nothing references, and the staging dir of a session
 * whose spool is gone.
 *
 * "Nothing references" is only knowable for bytes no live hook could still
 * name. A hook stages during its parse and commits the record — and the
 * receipt that stops it being derived again — later; retention runs from a
 * DIFFERENT session's probing hook and sees neither. Deleting a file staged
 * seconds ago therefore destroys what a hook in another session is about to
 * reference, and its receipt makes that permanent. Anything younger than the
 * longest timeout a hook can declare is left alone: past that the harness has
 * killed whoever staged it, so "unreferenced" is a fact rather than a race.
 */
export function sweepStagedBlobs(spool: MemberSpool, _sessionIds: readonly string[], now: number = Date.now()): number {
  let released = 0;
  let staged: fs.Dirent[];
  try {
    staged = fs.readdirSync(spool.blobsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const settled = now - longestDeclaredHookTimeoutMs();
  const reclaim = (file: string): void => {
    try {
      if (fs.statSync(file).mtimeMs > settled) return;
      fs.unlinkSync(file);
      released += 1;
    } catch { /* already gone */ }
  };
  for (const entry of staged) {
    // Bytes a project-wide-dir build staged sit directly under `blobs/`; no
    // record of this build names them by that path, so they are reclaimable.
    if (!entry.isDirectory()) {
      reclaim(path.join(spool.blobsDir, entry.name));
      continue;
    }
    const dir = spool.blobsDirFor(entry.name);
    try {
      spool.withSessionRecordsLock(entry.name, (read) => {
        if (!read.readable && read.absent !== true) return;
        if (read.readable && read.records.includes(null)) return;
        let files: string[];
        try { files = fs.readdirSync(dir); } catch { return; }
        const referenced = new Set<string>();
        if (read.readable) {
          for (const record of read.records) {
            const source = blobSourceOf(record);
            if (source) referenced.add(source.sha256);
          }
        }
        for (const file of files) {
          if (referenced.has(file)) continue;
          reclaim(path.join(dir, file));
        }
        if (referenced.size === 0) {
          try { fs.rmdirSync(dir); } catch { /* not empty, or still in use */ }
        }
      });
    } catch {
      process.stderr.write(`[myco] member: staged bytes for session ${entry.name} could not be checked — kept for a later sweep\n`);
    }
  }
  return released;
}

/**
 * Remove the state files of sessions whose spool is fully delivered and gone,
 * untouched for the retention window. Only after a drain that delivered
 * everything: a state whose spool still holds records, whose transcripts are
 * still in the backlog, or whose session was written to inside the window, is
 * a live session's and stays. The session's staging directory goes with it
 * when nothing is left in it.
 */
export function pruneDeliveredSessionState(spool: MemberSpool, now: number = Date.now()): number {
  let pruned = 0;
  const live = new Set(spool.sessionIds());
  for (const sessionId of spool.stateSessionIds()) {
    if (live.has(sessionId) || spool.hasTranscriptBacklog(sessionId)) continue;
    const state = readSessionState(spool.dir, sessionId);
    if (state.highWater > 0 || now - state.updatedAt < MEMBER_SESSION_STATE_RETENTION_MS) continue;
    // The pointers themselves, not only the mark: a mark cleared while another hook set it again must not cost the bytes.
    if (pointersOf(state).some(pointerBehind)) continue;
    // Read again under the session's lock: a hook that wrote to the session since the check above keeps it.
    const retired = retireSessionFiles(spool.dir, sessionId, (current) =>
      current.highWater === 0 && now - current.updatedAt >= MEMBER_SESSION_STATE_RETENTION_MS && !pointersOf(current).some(pointerBehind));
    if (!retired) continue;
    try { fs.rmdirSync(spool.blobsDirFor(sessionId)); } catch { /* absent, or still holding bytes the blob sweep owns */ }
    pruned += 1;
  }
  return pruned;
}

export interface RetentionOptions {
  /** The caller's own session was delivered in full this pass: the state of sessions long since delivered may go. */
  delivered?: boolean;
}

/** Retain active event journals, release unreferenced staged bytes, and retire fully delivered session state. */
export function applySpoolRetention(spool: MemberSpool, now: number = Date.now(), opts: RetentionOptions = {}): RetentionResult {
  const result: RetentionResult = { prunedStates: 0, releasedBlobs: 0, prunedTranscripts: 0 };
  cleanAcknowledgedQuarantine(spool);
  result.releasedBlobs = sweepStagedBlobs(spool, spool.sessionIds(), now);
  if (opts.delivered === true) result.prunedStates = pruneDeliveredSessionState(spool, now);
  // The spool's OWN home: a hook resolving a project pin must not age the
  // claims and transcripts of whatever home the process's environment names.
  result.prunedTranscripts = prunePluginTranscripts(now, process.env, spool.mycoHome);
  return result;
}
