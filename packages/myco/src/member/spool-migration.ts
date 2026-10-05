/** Moves capture written by project-only member spools into a pinned Deployment spool. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveMycoHome } from '../paths/home.js';
import { LifecycleLock, withFileLockSync } from '../utils/lifecycle-lock.js';
import { isProjectId, REFUSED_LOG_MAX_BYTES } from './constants.js';
import { CONTEXT_DIRNAME } from './context-cache.js';
import { listRegistryEntriesResult, deploymentUrl, type RegistryEntry } from './registry.js';
import { LEGACY_MIGRATION_FILE, memberRoutingIdentity, pinSpoolDestination, routedSpoolDir, ROUTING_FILE, sameRoutingIdentity, type MemberRoutingIdentity } from './routing.js';
import { bufferLockPath, emptySessionState, readMigrationSettledUnlocked, readSessionState, readSessionStateResultUnlocked, recordMigrationSettledUnlocked, writeSessionStateUnlocked, type SessionState } from './session-state.js';
import { MemberSpool, OFFLINE_LATCH_FILE, REFUSED_LOG_FILE, SPOOL_DIRNAME, WIRE_FIELDS, turnEndIdentity, type SpoolRecord } from './spool.js';
import { publishStagedBlob, readStagedBlob } from './staged-blobs.js';
import { assertMemberPathContained, ensureMemberDir, ensurePrivateFile, isPrivateMode, memberRoot, pathIsAbsent, readPrivateJson, writePrivateFileAtomic, type PrivateRead } from './store.js';

export { LEGACY_MIGRATION_FILE };
const MIGRATION_LOCK = '.migration.lock';
const ROUTING_HOLD_FILE = '.legacy-routing-hold.json';
const ASSIGNMENT_FILE = '.legacy-assignment.json';
const RECEIPT_SUFFIX = '.migration-receipt.json';
const SIDECAR_RECEIPT_FILE = '.legacy-sidecars.json';
const VERSION = 1;
export const LEGACY_SPOOL_RETIRE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const RETIRED_SPOOL_DIRNAME = 'retired-spool';
const RETIREMENT_FILE = '.legacy-retirement.json';

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
}

interface Marker extends LegacySpoolMigrationReport {
  version: typeof VERSION;
  state: 'copying' | 'held' | 'validated';
  at: number;
  sourceFingerprint?: string;
  destinationFingerprint?: string;
  sessionIds?: string[];
  sourceDir?: string;
  archiveDir?: string;
  sourceChangedAt?: number;
}

interface SessionReceipt {
  version: typeof VERSION;
  sourceCount: number;
  sourceHash: string;
  sourceStateHash: string;
  copied: number;
  eventIds: string[];
  marks: string[];
}

interface SidecarReceipt { version: typeof VERSION; files: Record<string, string> }

class MigrationHold extends Error {}

const sha = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

/** Project-only spool location used by member builds before Deployment routing. */
export function legacySpoolDir(projectId: string, mycoHome: string = resolveMycoHome()): string {
  if (!isProjectId(projectId)) throw new Error('Invalid legacy spool project id');
  const dir = path.join(memberRoot(mycoHome), SPOOL_DIRNAME, projectId);
  assertMemberPathContained(dir, mycoHome);
  return dir;
}

function markerPath(dir: string): string { return path.join(dir, LEGACY_MIGRATION_FILE); }
function routingHoldPath(dir: string): string { return path.join(dir, ROUTING_HOLD_FILE); }
function assignmentPath(dir: string): string { return path.join(dir, ASSIGNMENT_FILE); }
function receiptPath(dir: string, sessionId: string): string { return path.join(dir, `.${sessionId}${RECEIPT_SUFFIX}`); }
function sourceJournal(dir: string, sessionId: string): string { return path.join(dir, `${sessionId}.jsonl`); }

function readPinned(dir: string): MemberRoutingIdentity | null {
  const read = readPrivateJson<MemberRoutingIdentity>(path.join(dir, ROUTING_FILE));
  if (read.ok) {
    try { return memberRoutingIdentity(read.value); }
    catch { throw new MigrationHold('Legacy spool destination is invalid'); }
  }
  if (read.reason === 'missing') return null;
  throw new MigrationHold('Legacy spool destination is unreadable');
}

function readRoutingHold(dir: string): string | null {
  const read = readPrivateJson<{ version: number; reason: string }>(routingHoldPath(dir));
  if (read.ok) return typeof read.value?.reason === 'string' ? read.value.reason : 'Legacy routing hold is invalid';
  return read.reason === 'missing' ? null : 'Legacy routing hold is unreadable';
}

function holdRouting(dir: string, reason: string): void {
  if (readRoutingHold(dir) !== null) return;
  writePrivateFileAtomic(routingHoldPath(dir), `${JSON.stringify({ version: VERSION, reason, at: Date.now() })}\n`);
}

function readAssignment(dir: string): MemberRoutingIdentity | null {
  const read = readPrivateJson<{ version: number; route: MemberRoutingIdentity; at: number }>(assignmentPath(dir));
  if (!read.ok) {
    if (read.reason === 'missing') return null;
    throw new MigrationHold('Legacy spool assignment is unreadable');
  }
  if (read.value?.version !== VERSION || !Number.isFinite(read.value.at)) throw new MigrationHold('Legacy spool assignment is invalid');
  try { return memberRoutingIdentity(read.value.route); }
  catch { throw new MigrationHold('Legacy spool assignment is invalid'); }
}

function legacyCounts(dir: string, mycoHome: string): Pick<LegacySpoolMigrationReport, 'sessions' | 'records'> {
  const source = new MemberSpool(null, { dir, mycoHome, initialize: false });
  const read = source.readSpool();
  if (!read.readable || read.sessions.some((session) => session.unacknowledged === null)) throw new MigrationHold('Legacy spool is unreadable');
  const sessions = new Set([...read.sessions.map((session) => session.sessionId), ...source.stateSessionIds(), ...source.transcriptBacklogIds()]);
  return { sessions: sessions.size, records: read.sessions.reduce((count, session) => count + session.unacknowledged!, 0) };
}

interface Sidecar { relative: string; raw: string; hash: string }

function present(file: string): boolean {
  try { fs.lstatSync(file); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && pathIsAbsent(file)) return false;
    throw new MigrationHold(`Legacy sidecar is unavailable: ${path.basename(file)}`);
  }
}

function readSidecar(file: string, mycoHome: string): string {
  assertMemberPathContained(file, mycoHome);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch { throw new MigrationHold(`Legacy sidecar is unavailable: ${path.basename(file)}`); }
  if (!stat.isFile() || !isPrivateMode(stat.mode)) throw new MigrationHold(`Legacy sidecar is not a private file: ${path.basename(file)}`);
  try { return fs.readFileSync(file, 'utf8'); }
  catch { throw new MigrationHold(`Legacy sidecar is unreadable: ${path.basename(file)}`); }
}

function validateSidecar(relative: string, raw: string): void {
  if (relative === REFUSED_LOG_FILE) {
    for (const line of raw.split('\n').filter(Boolean)) {
      try { if (JSON.parse(line) === null) throw new Error('invalid entry'); }
      catch { throw new MigrationHold('Legacy refusal log is unreadable'); }
    }
    return;
  }
  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid sidecar');
    value = parsed as Record<string, unknown>;
  } catch { throw new MigrationHold(`Legacy sidecar is malformed: ${relative}`); }
  if (relative === OFFLINE_LATCH_FILE) {
    if (['since', 'nextProbeAt', 'backoffMs'].some((field) => typeof value[field] !== 'number')) throw new MigrationHold('Legacy offline latch is malformed');
  } else if (value.version !== 1) throw new MigrationHold(`Legacy context cache is malformed: ${relative}`);
}

function scanSidecars(dir: string, mycoHome: string): { files: Sidecar[]; holds: string[]; ignored: string[] } {
  const names = [OFFLINE_LATCH_FILE, REFUSED_LOG_FILE];
  const context = path.join(dir, CONTEXT_DIRNAME);
  const holds: string[] = [];
  try {
    if (present(context)) {
      assertMemberPathContained(context, mycoHome);
      if (!fs.lstatSync(context).isDirectory()) throw new Error('not a directory');
      names.push(...fs.readdirSync(context).map((name) => path.join(CONTEXT_DIRNAME, name)));
    }
  } catch { holds.push('Legacy context directory is unreadable'); }
  const found: Sidecar[] = [];
  const ignored: string[] = [];
  for (const relative of names) {
    if (relative.endsWith('.tmp')) { ignored.push(relative); continue; }
    try {
      const file = path.join(dir, relative);
      if (!present(file)) continue;
      if (relative.startsWith(`${CONTEXT_DIRNAME}${path.sep}`) && !relative.endsWith('.json')) throw new MigrationHold(`Unexpected legacy context file: ${relative}`);
      const raw = readSidecar(file, mycoHome);
      validateSidecar(relative, raw);
      found.push({ relative, raw, hash: sha(raw) });
    } catch (error) { holds.push((error as Error).message); }
  }
  return { files: found, holds, ignored };
}

function sidecarReceiptAt(dir: string): SidecarReceipt | null {
  const read = readPrivateJson<SidecarReceipt>(path.join(dir, SIDECAR_RECEIPT_FILE));
  if (!read.ok) {
    if (read.reason === 'missing') return null;
    throw new MigrationHold('Legacy sidecar receipt is unreadable');
  }
  const receipt = read.value;
  if (receipt?.version !== VERSION || receipt.files === null || typeof receipt.files !== 'object' ||
      Object.values(receipt.files).some((hash) => typeof hash !== 'string')) throw new MigrationHold('Legacy sidecar receipt is invalid');
  return receipt;
}

function mergeRefusals(source: string, destination: string): string {
  const lines = destination.split('\n').filter(Boolean);
  const seen = new Set(lines);
  for (const line of source.split('\n').filter(Boolean)) {
    if (!seen.has(line)) { lines.push(line); seen.add(line); }
  }
  const merged = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  if (Buffer.byteLength(merged) > REFUSED_LOG_MAX_BYTES) throw new MigrationHold('Combined refusal log exceeds its cap');
  return merged;
}

function copySidecars(source: MemberSpool, target: MemberSpool): { holds: string[]; ignored: string[] } {
  const scanned = scanSidecars(source.dir, source.mycoHome);
  const holds = [...scanned.holds];
  let previous: SidecarReceipt | null = null;
  try { previous = sidecarReceiptAt(source.dir); }
  catch (error) { holds.push((error as Error).message); }
  const files = { ...previous?.files };
  for (const sidecar of scanned.files) {
    try {
      if (files[sidecar.relative] === sidecar.hash) continue;
      const destination = path.join(target.dir, sidecar.relative);
      const existing = present(destination) ? readSidecar(destination, target.mycoHome) : null;
      if (existing !== null) validateSidecar(sidecar.relative, existing);
      const next = sidecar.relative === REFUSED_LOG_FILE && existing !== null
        ? mergeRefusals(sidecar.raw, existing)
        : existing ?? sidecar.raw;
      if (existing !== next) {
        ensureMemberDir(path.dirname(destination), target.mycoHome);
        writePrivateFileAtomic(destination, next);
      }
      files[sidecar.relative] = sidecar.hash;
    } catch (error) {
      holds.push(`${sidecar.relative}: ${(error as Error).message}`);
    }
  }
  try { writePrivateFileAtomic(path.join(source.dir, SIDECAR_RECEIPT_FILE), `${JSON.stringify({ version: VERSION, files })}\n`); }
  catch (error) { holds.push(`Legacy sidecar receipt: ${(error as Error).message}`); }
  return { holds, ignored: scanned.ignored };
}

function uniqueDestination(projectId: string, mycoHome: string): MemberRoutingIdentity {
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

/** A user's explicit destination for legacy capture, recorded without erasing the earlier routing hold. */
export function assignLegacySpoolDestination(routeInput: MemberRoutingIdentity, mycoHome: string = resolveMycoHome()): LegacySpoolMigrationReport {
  const route = memberRoutingIdentity(routeInput);
  const dir = legacySpoolDir(route.projectId, mycoHome);
  const base = reportFor(route.projectId, route);
  if (!fs.existsSync(dir)) return base;
  ensurePrivateFile(path.join(dir, MIGRATION_LOCK));
  return withFileLockSync(path.join(dir, MIGRATION_LOCK), () => {
    let pinned: MemberRoutingIdentity | null = null;
    try {
      const counts = legacyCounts(dir, mycoHome);
      pinned = readPinned(dir);
      if (pinned !== null && !sameRoutingIdentity(pinned, route)) throw new MigrationHold('Legacy spool is pinned to another Deployment');
      const assigned = readAssignment(dir);
      if (assigned !== null && !sameRoutingIdentity(assigned, route)) throw new MigrationHold('Legacy spool was explicitly assigned to another Deployment');
      if (assigned === null) {
        writePrivateFileAtomic(assignmentPath(dir), `${JSON.stringify({ version: VERSION, route, at: Date.now() })}\n`);
      }
      if (pinned === null) pinSpoolDestination(dir, route);
      return { ...base, ...counts, status: 'assigned' as const };
    } catch (error) {
      if (!(error instanceof MigrationHold)) throw error;
      return { ...base, destination: pinned ?? route, status: 'held' as const, reason: error.message };
    }
  });
}

/** Confirm that a pre-mutation pin names the expected old binding. */
export function pinLegacySpoolDestination(entry: Pick<RegistryEntry, 'projectId' | 'serverUrl'>, mycoHome: string = resolveMycoHome()): LegacySpoolMigrationReport {
  const route = memberRoutingIdentity(entry);
  const report = pinLegacySpoolDestinationForProject(route.projectId, mycoHome);
  if (report.destination !== null && !sameRoutingIdentity(report.destination, route)) {
    return { ...report, status: 'held', reason: 'Legacy spool is pinned to another Deployment' };
  }
  return report;
}

function parseJournal(file: string): { records: SpoolRecord[]; raw: string } {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { records: [], raw: '' };
    throw error;
  }
  if (raw !== '' && !raw.endsWith('\n')) throw new MigrationHold(`Incomplete journal: ${path.basename(file)}`);
  const records = raw.split('\n').filter(Boolean).map((line) => {
    try {
      const record = JSON.parse(line) as SpoolRecord;
      if (typeof record.eventId !== 'string' || record.eventId === '') throw new Error('invalid event');
      return record;
    } catch { throw new MigrationHold(`Unreadable journal: ${path.basename(file)}`); }
  });
  return { records, raw };
}

function stateAt(dir: string, sessionId: string): SessionState {
  const read = readSessionStateResultUnlocked(dir, sessionId);
  if (read.ok) return read.state;
  if (read.reason === 'missing') return emptySessionState(0);
  throw new MigrationHold(`Unreadable session state: ${sessionId}`);
}

function receiptAt(dir: string, sessionId: string): SessionReceipt | null {
  const read = readPrivateJson<SessionReceipt>(receiptPath(dir, sessionId));
  if (!read.ok) {
    if (read.reason === 'missing') return null;
    throw new MigrationHold(`Migration receipt is unreadable: ${sessionId}`);
  }
  const receipt = read.value;
  if (receipt?.version !== VERSION || !Number.isSafeInteger(receipt.sourceCount) || receipt.sourceCount < 0 ||
      typeof receipt.sourceHash !== 'string' || typeof receipt.sourceStateHash !== 'string' ||
      !Number.isSafeInteger(receipt.copied) || receipt.copied < 0 ||
      !Array.isArray(receipt.eventIds) || receipt.eventIds.some((id) => typeof id !== 'string' || id === '') ||
      new Set(receipt.eventIds).size !== receipt.eventIds.length ||
      !Array.isArray(receipt.marks) || receipt.marks.some((mark) => typeof mark !== 'string')) {
    throw new MigrationHold(`Migration receipt is invalid: ${sessionId}`);
  }
  return receipt;
}

function mergeState(target: SessionState, source: SessionState): SessionState {
  const merged: SessionState = { ...source, ...target };
  merged.highWater = target.highWater;
  merged.markWater = target.markWater;
  merged.markGeneration = target.markGeneration;
  merged.prompts = { ...source.prompts, ...target.prompts };
  merged.siblings = { ...source.siblings, ...target.siblings };
  merged.continuations = { ...source.continuations, ...target.continuations };
  if (source.transcript !== undefined && target.transcript !== undefined && source.transcript.path !== target.transcript.path) merged.continuations[source.transcript.path] = source.transcript;
  merged.planHashes = { ...source.planHashes, ...target.planHashes };
  merged.planPaths = { ...source.planPaths, ...target.planPaths };
  merged.attachmentKeys = [...new Set([...source.attachmentKeys, ...target.attachmentKeys])];
  merged.delivered = [...new Set([...source.delivered, ...target.delivered])];
  merged.transcript = target.transcript ?? source.transcript;
  merged.promptId = target.promptId ?? source.promptId;
  merged.agent = target.agent ?? source.agent;
  merged.planTagCount = Math.max(source.planTagCount, target.planTagCount);
  merged.compactionOrdinal = Math.max(source.compactionOrdinal, target.compactionOrdinal);
  if (source.startSettled || target.startSettled) merged.startSettled = true;
  if (source.startedAt !== undefined || target.startedAt !== undefined) merged.startedAt = Math.min(source.startedAt ?? Infinity, target.startedAt ?? Infinity);
  if (source.lastAckAt !== undefined || target.lastAckAt !== undefined) merged.lastAckAt = Math.max(source.lastAckAt ?? 0, target.lastAckAt ?? 0);
  if (source.lastDeliveryAt !== undefined || target.lastDeliveryAt !== undefined) merged.lastDeliveryAt = Math.max(source.lastDeliveryAt ?? 0, target.lastDeliveryAt ?? 0);
  return merged;
}

function restage(record: SpoolRecord, source: MemberSpool, target: MemberSpool, sessionId: string, originDir: string, archiveDir: string): SpoolRecord {
  const blob = record._blobSource;
  if (blob === undefined) return record;
  const expected = path.join(source.blobsDirFor(sessionId), blob.sha256);
  const original = path.join(originDir, 'blobs', sessionId, blob.sha256);
  if (path.resolve(blob.path) !== path.resolve(expected) && path.resolve(blob.path) !== path.resolve(original)) throw new MigrationHold(`Blob path is outside legacy staging: ${sessionId}`);
  assertMemberPathContained(expected, source.mycoHome);
  const retained = { path: original, retiredPath: path.join(archiveDir, 'blobs', sessionId, blob.sha256) };
  assertMemberPathContained(original, source.mycoHome);
  assertMemberPathContained(retained.retiredPath, source.mycoHome);
  const read = readStagedBlob({ ...blob, path: expected, migrationSource: retained });
  if (read.status !== 'ready') {
    const owned = path.join(target.blobsDirFor(sessionId), blob.sha256);
    ensureMemberDir(path.dirname(owned), target.mycoHome);
    return { ...record, _blobSource: { ...blob, path: owned, migrationSource: retained } };
  }
  const staged = { ...blob, path: path.join(target.blobsDirFor(sessionId), blob.sha256) };
  delete staged.migrationSource;
  ensureMemberDir(path.dirname(staged.path), target.mycoHome);
  publishStagedBlob(staged, read.bytes);
  return { ...record, _blobSource: staged };
}

const wireOf = (record: SpoolRecord): string => JSON.stringify(WIRE_FIELDS.map((field) => record[field]));

function copySession(source: MemberSpool, target: MemberSpool, sessionId: string, originDir: string, archiveDir: string): { records: number; copied: number; receipt: SessionReceipt } {
  const sourceLock = bufferLockPath(source.dir, sessionId);
  const targetLock = bufferLockPath(target.dir, sessionId);
  ensurePrivateFile(sourceLock);
  ensurePrivateFile(targetLock);
  const sourceLeasePath = path.join(source.dir, `.${sessionId}.drain.lock`);
  const targetLeasePath = path.join(target.dir, `.${sessionId}.drain.lock`);
  ensurePrivateFile(sourceLeasePath);
  ensurePrivateFile(targetLeasePath);
  const sourceLease = LifecycleLock.acquire(sourceLeasePath, { command: 'myco member spool migration' });
  if (!sourceLease.acquired) throw new MigrationHold(`Legacy session is draining: ${sessionId}`);
  const targetLease = LifecycleLock.acquire(targetLeasePath, { command: 'myco member spool migration' });
  if (!targetLease.acquired) {
    sourceLease.lock.release();
    throw new MigrationHold(`Destination session is draining: ${sessionId}`);
  }
  try {
    return withFileLockSync(sourceLock, () => withFileLockSync(targetLock, () => {
      const sourceFile = sourceJournal(source.dir, sessionId);
      const targetFile = sourceJournal(target.dir, sessionId);
      const sourceRead = parseJournal(sourceFile);
      const sourceState = stateAt(source.dir, sessionId);
      if (sourceState.highWater > sourceRead.records.length) throw new MigrationHold(`Legacy high-water exceeds journal: ${sessionId}`);
      const targetRead = parseJournal(targetFile);
      if (new Set(sourceRead.records.map((record) => record.eventId)).size !== sourceRead.records.length) throw new MigrationHold(`Duplicate legacy event id: ${sessionId}`);
      if (new Set(targetRead.records.map((record) => record.eventId)).size !== targetRead.records.length) throw new MigrationHold(`Duplicate destination event id: ${sessionId}`);
      const targetState = stateAt(target.dir, sessionId);
      if (targetState.highWater > targetRead.records.length) throw new MigrationHold(`Destination high-water exceeds journal: ${sessionId}`);
      const settledRead = readMigrationSettledUnlocked(target.dir, sessionId);
      if (!settledRead.ok && settledRead.reason !== 'missing') throw new MigrationHold(`Migration settlement ledger is ${settledRead.reason}: ${sessionId}`);
      const settled = new Set(settledRead.ok ? settledRead.eventIds : []);
      const previous = receiptAt(source.dir, sessionId);
      if (previous !== null) {
        if (previous.sourceCount > sourceRead.records.length ||
            previous.sourceHash !== sha(sourceRead.raw.split('\n').slice(0, previous.sourceCount).filter(Boolean).map((line) => `${line}\n`).join(''))) {
          throw new MigrationHold(`Legacy journal changed after migration: ${sessionId}`);
        }
      }
      const byId = new Map(targetRead.records.map((record, index) => [record.eventId, index]));
      const sourceById = new Map(sourceRead.records.map((record) => [record.eventId, record]));
      const alreadySettled: string[] = [];
      for (const eventId of previous?.eventIds ?? []) {
        const sourceRecord = sourceById.get(eventId);
        if (sourceRecord === undefined) throw new MigrationHold(`Migration receipt names an absent legacy event: ${sessionId}`);
        const index = byId.get(eventId);
        if (index === undefined && !settled.has(eventId)) throw new MigrationHold(`Previously copied event lacks delivery evidence: ${sessionId}`);
        if (index !== undefined && wireOf(targetRead.records[index]!) !== wireOf(sourceRecord)) throw new MigrationHold(`Event id collision: ${sessionId}`);
        if (index !== undefined && index < targetState.highWater && !settled.has(eventId)) alreadySettled.push(eventId);
      }
      const pending = sourceRead.records.slice(Math.max(sourceState.highWater, previous?.sourceCount ?? 0));
      const additions: SpoolRecord[] = [];
      let taggedExisting = false;
      for (const record of pending) {
        if (settled.has(record.eventId)) continue;
        const index = byId.get(record.eventId);
        if (index !== undefined) {
          const held = targetRead.records[index]!;
          if (wireOf(held) !== wireOf(record)) throw new MigrationHold(`Event id collision: ${sessionId}`);
          if (index < targetState.highWater) alreadySettled.push(record.eventId);
          else if (held._legacyMigration !== 1) {
            targetRead.records[index] = { ...held, _legacyMigration: 1 };
            taggedExisting = true;
          }
          continue;
        }
        additions.push({ ...restage(record, source, target, sessionId, originDir, archiveDir), _legacyMigration: 1 });
        byId.set(record.eventId, targetRead.records.length + additions.length - 1);
      }
      if (taggedExisting || additions.length > 0) {
        const base = taggedExisting ? targetRead.records.map((record) => `${JSON.stringify(record)}\n`).join('') : targetRead.raw;
        writePrivateFileAtomic(targetFile, base + additions.map((record) => `${JSON.stringify(record)}\n`).join(''));
      }
      recordMigrationSettledUnlocked(target.dir, sessionId, alreadySettled);
      const sourceStateHash = sha(JSON.stringify(sourceState));
      if (previous === null || previous.sourceStateHash !== sourceStateHash) {
        writeSessionStateUnlocked(target.dir, sessionId, mergeState(targetState, sourceState));
      }
      const fresh = parseJournal(targetFile).records;
      const available = new Set(fresh.map((record) => record.eventId));
      if (pending.some((record) => !available.has(record.eventId) && !settled.has(record.eventId))) throw new MigrationHold(`Copied count mismatch: ${sessionId}`);
      const receipt: SessionReceipt = {
        version: VERSION, sourceCount: sourceRead.records.length, sourceHash: sha(sourceRead.raw), sourceStateHash,
        copied: (previous?.copied ?? 0) + pending.length,
        eventIds: [...new Set([...(previous?.eventIds ?? []), ...pending.map((record) => record.eventId)])],
        marks: previous?.marks ?? [],
      };
      return { records: Math.max(0, sourceRead.records.length - sourceState.highWater), copied: additions.length, receipt };
    }));
  } finally {
    targetLease.lock.release();
    sourceLease.lock.release();
  }
}

function reportFor(projectId: string, destination: MemberRoutingIdentity | null): LegacySpoolMigrationReport {
  return { status: 'absent', projectId, destination, sessions: 0, records: 0, copied: 0 };
}

function verifyReceipts(source: MemberSpool, sessions: ReadonlySet<string>): void {
  const current = new Set([...source.sessionIds(), ...source.stateSessionIds(), ...source.transcriptBacklogIds()]);
  if (current.size !== sessions.size || [...current].some((id) => !sessions.has(id))) throw new MigrationHold('Legacy spool changed during migration');
  for (const sessionId of sessions) {
    const pendingMarks = source.pendingTurnEnds(sessionId).map((entry) => turnEndIdentity(entry.mark));
    const lock = bufferLockPath(source.dir, sessionId);
    withFileLockSync(lock, () => {
      const receipt = receiptAt(source.dir, sessionId);
      const journal = parseJournal(sourceJournal(source.dir, sessionId));
      if (receipt === null || receipt.sourceCount !== journal.records.length || receipt.sourceHash !== sha(journal.raw) ||
          receipt.sourceStateHash !== sha(JSON.stringify(stateAt(source.dir, sessionId))) ||
          pendingMarks.some((mark) => !receipt.marks.includes(mark))) {
        throw new MigrationHold(`Migration receipt does not cover legacy capture: ${sessionId}`);
      }
    });
  }
}

/** File identities invalidate a validated migration without reading retained journal bytes. */
function spoolFingerprint(dir: string): string {
  const entries: string[] = [];
  const walk = (at: string, relative: string): void => {
    for (const name of fs.readdirSync(at).sort()) {
      if (name === LEGACY_MIGRATION_FILE || name.endsWith('.lock') || name.endsWith('.tmp')) continue;
      const file = path.join(at, name);
      const key = path.join(relative, name);
      const stat = fs.lstatSync(file);
      entries.push(JSON.stringify([key, stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs]));
      if (stat.isDirectory()) {
        if (key === CONTEXT_DIRNAME) {
          try { walk(file, key); }
          catch (error) { entries.push(JSON.stringify([key, 'unreadable', (error as NodeJS.ErrnoException).code])); }
        } else walk(file, key);
      }
    }
  };
  walk(dir, '');
  return sha(entries.join('\n'));
}

function validatedMarker(read: PrivateRead<Marker>, route: MemberRoutingIdentity): Marker | null {
  if (!read.ok) return null;
  const marker = read.value;
  if (marker?.version !== VERSION || marker.state !== 'validated' || marker.status !== 'migrated' ||
      marker.destination === null || !sameRoutingIdentity(marker.destination, route) ||
      typeof marker.sourceFingerprint !== 'string' || typeof marker.destinationFingerprint !== 'string' ||
      typeof marker.sourceDir !== 'string' || typeof marker.archiveDir !== 'string' ||
      !Number.isFinite(marker.at) || !Array.isArray(marker.sessionIds) ||
      marker.sessionIds.some((id) => typeof id !== 'string')) return null;
  return marker;
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

function retireLegacySpool(source: MemberSpool, marker: Marker, now: number): void {
  if (source.dir !== marker.sourceDir || marker.sessionIds?.length === 0 || now - (marker.sourceChangedAt ?? marker.at) < LEGACY_SPOOL_RETIRE_GRACE_MS) return;
  const leases: Array<{ release(): void }> = [];
  try {
    for (const sessionId of marker.sessionIds ?? []) {
      for (const file of [path.join(source.dir, `.${sessionId}.drain.lock`), bufferLockPath(source.dir, sessionId)]) {
        ensurePrivateFile(file);
        const lease = LifecycleLock.acquire(file, { command: 'myco member spool retirement' });
        if (!lease.acquired) return;
        leases.push(lease.lock);
      }
    }
    if (marker.sourceFingerprint !== spoolFingerprint(source.dir)) return;
    const archive = marker.archiveDir!;
    assertMemberPathContained(archive, source.mycoHome);
    ensureMemberDir(path.dirname(archive), source.mycoHome);
    // The route is durable before the move, including a crash before the replacement directory is written.
    const retirement = `${JSON.stringify({ version: VERSION, originDir: source.dir, archiveDir: archive, route: marker.destination })}\n`;
    writePrivateFileAtomic(path.join(source.dir, RETIREMENT_FILE), retirement);
    fs.renameSync(source.dir, archive);
    ensureMemberDir(source.dir, source.mycoHome);
    pinSpoolDestination(source.dir, marker.destination!);
    writePrivateFileAtomic(path.join(source.dir, RETIREMENT_FILE), retirement);
  } finally { for (const lease of leases.reverse()) lease.release(); }

}

/** Copy retained capture under the migration and drain leases; validation permits a stat-only no-op. */
function migrateSource(route: MemberRoutingIdentity, mycoHome: string, dir: string, now: number): LegacySpoolMigrationReport {
  const report = reportFor(route.projectId, route);
  ensurePrivateFile(path.join(dir, MIGRATION_LOCK));
  return withFileLockSync(path.join(dir, MIGRATION_LOCK), () => {
    let target: MemberSpool | null = null;
    let sourcePinned = false;
    let releaseHelper: (() => void) | null = null;
    try {
      const assigned = readAssignment(dir);
      const hold = readRoutingHold(dir);
      if (hold !== null && assigned === null) throw new MigrationHold(hold);
      if (assigned !== null && !sameRoutingIdentity(assigned, route)) throw new MigrationHold('Legacy spool was explicitly assigned to another Deployment');
      const pinned = readPinned(dir);
      sourcePinned = pinned !== null;
      if (assigned !== null && pinned !== null && !sameRoutingIdentity(assigned, pinned)) throw new MigrationHold('Legacy spool assignment conflicts with its pinned Deployment');
      if (pinned === null) {
        const unique = assigned ?? uniqueDestination(route.projectId, mycoHome);
        pinSpoolDestination(dir, unique);
        sourcePinned = true;
        if (!sameRoutingIdentity(unique, route)) throw new MigrationHold('Legacy spool is pinned to another Deployment');
      } else if (!sameRoutingIdentity(pinned, route)) throw new MigrationHold('Legacy spool is pinned to another Deployment');
      const source = new MemberSpool(null, { dir, mycoHome, initialize: false });
      const helperLock = path.join(dir, 'helper.lock');
      ensurePrivateFile(helperLock);
      const helperLease = LifecycleLock.acquire(helperLock, { command: 'myco member spool migration' });
      if (!helperLease.acquired) throw new MigrationHold('Legacy helper is still active');
      releaseHelper = () => helperLease.lock.release();
      target = new MemberSpool(route, { mycoHome });
      if (fs.realpathSync(dir) === fs.realpathSync(target.dir)) throw new MigrationHold('Legacy spool aliases its destination');
      const previous = readPrivateJson<Marker>(markerPath(dir));
      if (!previous.ok && previous.reason !== 'missing') throw new MigrationHold('Source migration marker is unreadable');
      const destinationMarker = readPrivateJson<Marker>(markerPath(target.dir));
      if (!destinationMarker.ok && destinationMarker.reason !== 'missing') throw new MigrationHold('Destination migration marker is unreadable');
      const validated = validatedMarker(previous, route);
      const sourceUnchanged = validated !== null && validated.sourceFingerprint === spoolFingerprint(dir);
      if (validated !== null && sourceUnchanged && destinationMarker.ok && destinationMarker.value?.state === 'validated' && validated.destinationFingerprint === spoolFingerprint(target.dir)) {
        retireLegacySpool(source, validated, now);
        return { ...report, status: 'migrated', sessions: validated.sessions, records: validated.records, sidecarHolds: validated.sidecarHolds, ignoredSidecars: validated.ignoredSidecars };
      }
      const sourceDir = previous.ok && typeof previous.value.sourceDir === 'string' ? previous.value.sourceDir : dir;
      const archiveDir = previous.ok && typeof previous.value.archiveDir === 'string' ? previous.value.archiveDir : path.join(memberRoot(mycoHome), RETIRED_SPOOL_DIRNAME, route.projectId, crypto.randomUUID());
      assertMemberPathContained(sourceDir, mycoHome);
      assertMemberPathContained(archiveDir, mycoHome);
      const sourceChangedAt = sourceUnchanged && validated !== null ? validated.sourceChangedAt ?? validated.at : now;
      const sessionIds = new Set([...source.sessionIds(), ...source.stateSessionIds(), ...source.transcriptBacklogIds()]);
      const marker = (state: Marker['state'], reason?: string, sourceFingerprint?: string): Marker => {
        const value: Marker = { ...report, version: VERSION, state, status: state === 'validated' ? 'migrated' : 'held', ...(reason ? { reason } : {}), at: now, sourceDir, archiveDir, sourceChangedAt, sessionIds: [...sessionIds] };
        if (state === 'validated') { value.sourceFingerprint = sourceFingerprint; value.destinationFingerprint = spoolFingerprint(target!.dir); }
        const bytes = `${JSON.stringify(value)}\n`;
        writePrivateFileAtomic(markerPath(dir), bytes);
        writePrivateFileAtomic(markerPath(target!.dir), bytes);
        return value;
      };
      marker('copying');
      for (const sessionId of sessionIds) {
        const moved = copySession(source, target, sessionId, sourceDir, archiveDir);
        report.sessions += 1;
        report.records += moved.records;
        report.copied += moved.copied;
        const alreadyMarked = new Set(moved.receipt.marks);
        const marks = source.pendingTurnEnds(sessionId).map((entry) => entry.mark)
          .filter((mark) => !alreadyMarked.has(turnEndIdentity(mark)));
        if (marks.length > 0) target.appendMovedTurnEnds(sessionId, marks);
        moved.receipt.marks.push(...marks.map(turnEndIdentity));
        const state = readSessionState(target.dir, sessionId);
        if (source.hasTranscriptBacklog(sessionId) || state.transcript !== undefined || Object.keys(state.siblings).length > 0) target.markTranscriptBacklog(sessionId);
        writePrivateFileAtomic(receiptPath(source.dir, sessionId), `${JSON.stringify(moved.receipt)}\n`);
      }
      const sidecars = copySidecars(source, target);
      report.sidecarHolds = sidecars.holds;
      report.ignoredSidecars = sidecars.ignored;
      const verifiedSourceFingerprint = spoolFingerprint(dir);
      verifyReceipts(source, sessionIds);
      if (verifiedSourceFingerprint !== spoolFingerprint(dir)) throw new MigrationHold('Legacy spool changed during validation');
      report.status = 'migrated';
      const validatedState = marker('validated', undefined, verifiedSourceFingerprint);
      retireLegacySpool(source, validatedState, now);
      return report;
    } catch (error) {
      if (target === null && error instanceof MigrationHold && !sourcePinned) holdRouting(dir, error.message);
      if (target !== null) {
        const held: Marker = { ...report, version: VERSION, state: 'held', status: 'held', reason: (error as Error).message, at: now };
        writePrivateFileAtomic(markerPath(target.dir), `${JSON.stringify(held)}\n`);
      }
      if (!(error instanceof MigrationHold)) throw error;
      return { ...report, status: 'held', reason: error.message };
    } finally { releaseHelper?.(); }
  });
}

/** Migrate active and retired generations without deleting source capture. */
export function migrateLegacySpool(routeInput: MemberRoutingIdentity, mycoHome: string = resolveMycoHome(), now: number = Date.now()): LegacySpoolMigrationReport {
  const route = memberRoutingIdentity(routeInput);
  const dir = legacySpoolDir(route.projectId, mycoHome);
  const retired = listRetiredLegacySpoolDirs(mycoHome).filter((source) => path.basename(path.dirname(source)) === route.projectId);
  // Retired routing remains authoritative for old writers recreating the Project-only directory.
  if (retired.length > 0) {
    try {
      const pinned = readPinned(retired[0]!);
      if (pinned === null || retired.some((source) => { const other = readPinned(source); return other === null || !sameRoutingIdentity(other, pinned); })) throw new MigrationHold('Retired legacy spool destinations conflict');
      if (pathIsAbsent(dir)) ensureMemberDir(dir, mycoHome);
      if (readPinned(dir) === null) pinSpoolDestination(dir, pinned);
    } catch (error) {
      if (!(error instanceof MigrationHold)) throw error;
      return { ...reportFor(route.projectId, route), status: 'held', reason: error.message };
    }
  }
  const sources = [...retired, ...(pathIsAbsent(dir) ? [] : [dir])];
  const result = reportFor(route.projectId, route);
  for (const source of sources) {
    const moved = migrateSource(route, mycoHome, source, now);
    result.sessions += moved.sessions; result.records += moved.records; result.copied += moved.copied;
    result.sidecarHolds = [...(result.sidecarHolds ?? []), ...(moved.sidecarHolds ?? [])];
    result.ignoredSidecars = [...(result.ignoredSidecars ?? []), ...(moved.ignoredSidecars ?? [])];
    if (moved.status === 'held') return { ...result, status: 'held', reason: moved.reason };
    result.status = moved.status;
  }
  return result;
}

/** Legacy direct children of the spool root for status diagnostics. */
export function listLegacySpools(mycoHome: string = resolveMycoHome()): LegacySpoolMigrationReport[] {
  const root = path.join(memberRoot(mycoHome), SPOOL_DIRNAME);
  let names: string[];
  try { names = fs.readdirSync(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names.filter((name) => {
    if (!isProjectId(name)) return false;
    const dir = path.join(root, name);
    try {
      if (!fs.lstatSync(dir).isDirectory()) return true;
      return fs.readdirSync(dir).some((child) => child === ROUTING_FILE || child === ROUTING_HOLD_FILE || child === ASSIGNMENT_FILE ||
        child === CONTEXT_DIRNAME || child === OFFLINE_LATCH_FILE || child === 'blobs' || child.endsWith('.jsonl') || child.endsWith('.state.json') || child.endsWith('.turns'));
    } catch { return true; }
  }).sort().map((projectId) => {
    let dir: string;
    try {
      dir = legacySpoolDir(projectId, mycoHome);
      if (!fs.lstatSync(dir).isDirectory()) throw new Error('not a directory');
    } catch { return { ...reportFor(projectId, null), status: 'held' as const, reason: 'Legacy spool is unreadable' }; }
    let destination: MemberRoutingIdentity | null = null;
    try { destination = readPinned(dir); }
    catch (error) { return { ...reportFor(projectId, null), status: 'held' as const, reason: (error as Error).message }; }
    const hold = readRoutingHold(dir);
    const source = new MemberSpool(null, { dir, mycoHome, initialize: false });
    const sessions = source.readSpool();
    let sidecarError: string | null = null;
    let sidecarHolds: string[] = [];
    let ignoredSidecars: string[] = [];
    try { const scanned = scanSidecars(dir, mycoHome); sidecarHolds = scanned.holds; ignoredSidecars = scanned.ignored; }
    catch (error) { sidecarError = (error as Error).message; }
    let marker: PrivateRead<Marker> | null = null;
    try { marker = destination === null ? null : readPrivateJson<Marker>(markerPath(routedSpoolDir(destination, mycoHome))); }
    catch { sidecarError ??= 'Migration marker is unavailable'; }
    let assigned: MemberRoutingIdentity | null = null;
    let assignmentError: string | null = null;
    try { assigned = readAssignment(dir); }
    catch (error) { assignmentError = (error as Error).message; }
    const markerState = marker?.ok && marker.value?.version === VERSION &&
      ['copying', 'held', 'validated'].includes(marker.value.state) ? marker.value.state : null;
    const markerError = marker !== null && (marker.ok ? markerState === null : marker.reason !== 'missing');
    const spoolReadable = sessions.readable && sessions.sessions.every((session) => session.unacknowledged !== null);
    let status: LegacySpoolMigrationReport['status'] = 'held';
    let reason: string | undefined;
    if (!spoolReadable) reason = 'Legacy spool is unreadable';
    else if (sidecarError !== null) reason = sidecarError;
    else if (assignmentError !== null) reason = assignmentError;
    else if (hold !== null && assigned === null) reason = hold;
    else if (markerError) reason = 'Migration marker is unreadable';
    else if (markerState === 'validated') status = 'migrated';
    else if (markerState === 'copying') reason = 'Legacy spool migration is copying';
    else if (markerState === 'held') reason = marker && marker.ok ? marker.value.reason : 'Legacy spool migration is held';
    else if (assigned !== null) status = 'assigned';
    else if (destination !== null) status = 'pinned';
    else reason = 'Legacy spool has no pinned Deployment';
    const knownSessions = new Set([...sessions.sessions.map((session) => session.sessionId), ...source.stateSessionIds(), ...source.transcriptBacklogIds()]);
    return { ...reportFor(projectId, destination), status, ...(reason === undefined ? {} : { reason }),
      sessions: knownSessions.size, ignoredSidecars, sidecarHolds: [...new Set([...sidecarHolds, ...(marker?.ok ? marker.value.sidecarHolds ?? [] : [])])],
      records: sessions.sessions.reduce((n, session) => n + (session.unacknowledged ?? 0), 0) };
  });
}
