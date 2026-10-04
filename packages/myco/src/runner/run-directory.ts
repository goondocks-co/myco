import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { getMachineId } from '@myco/machine-id.js';

export const RUN_DIRECTORY_MANIFEST = '.myco-run.json';
const MANIFEST_VERSION = 1;
const PROCESS_NONCE = randomUUID();
/** Minimum age of an unmanifested allocation eligible for the startup credential sweep. */
export const LEGACY_RUN_DIRECTORY_AGE_MS = 24 * 60 * 60 * 1_000;
/** Configuration files that can carry a run or provider credential. */
const CREDENTIAL_FILES = ['mcp.json', 'codex-home/auth.json', 'codex-home/config.toml',
  'cursor-home/cli-config.json', 'cursor-home/acp-config.json'] as const;
const PENDING_DISCARDS = new Set<string>();

export type RunDirectoryIdentity =
  | { purpose: 'attempt'; runId: string; attemptId?: string; projectId: string; serverUrl: string }
  | { purpose: 'model-listing'; harnessId: string };

type RecordedIdentity =
  | { purpose: 'attempt'; runId: string; attemptId: string | null; projectId: string; deploymentKey: string }
  | { purpose: 'model-listing'; harnessId: string };

type RunDirectoryManifest = RecordedIdentity & {
  version: typeof MANIFEST_VERSION;
  directory: string;
  machineId: string;
  platform: NodeJS.Platform;
  pid: number;
  nonce: string;
  pendingStarts: string[];
  processGroups: number[];
};

const VALID_IDENTITY = /^[A-Za-z0-9._-]{1,128}$/;

function absent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function directoryAt(path: string): boolean {
  try { return fs.lstatSync(path).isDirectory(); }
  catch (error) { if (absent(error)) return false; throw error; }
}

function entryExists(path: string): boolean {
  try { fs.lstatSync(path); return true; }
  catch (error) { if (absent(error)) return false; throw error; }
}

function manifestAt(path: string): RunDirectoryManifest | null {
  const file = join(path, RUN_DIRECTORY_MANIFEST);
  let value: unknown;
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (absent(error) || error instanceof SyntaxError) return null;
    throw error;
  }
  if (typeof value !== 'object' || value === null) return null;
  const manifest = value as Record<string, unknown>;
  const validPid = (pid: unknown): pid is number => typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0;
  const identityValid = manifest.purpose === 'attempt'
    ? typeof manifest.runId === 'string' && VALID_IDENTITY.test(manifest.runId)
      && typeof manifest.projectId === 'string' && typeof manifest.deploymentKey === 'string'
      && (manifest.attemptId === null || typeof manifest.attemptId === 'string')
    : manifest.purpose === 'model-listing' && typeof manifest.harnessId === 'string' && VALID_IDENTITY.test(manifest.harnessId);
  if (manifest.version !== MANIFEST_VERSION || manifest.directory !== basename(path)
    || !identityValid || typeof manifest.machineId !== 'string' || manifest.machineId.length === 0
    || typeof manifest.platform !== 'string' || typeof manifest.nonce !== 'string' || !validPid(manifest.pid)
    || !Array.isArray(manifest.pendingStarts) || !manifest.pendingStarts.every((id) => typeof id === 'string')
    || !Array.isArray(manifest.processGroups) || !manifest.processGroups.every(validPid)) return null;
  return manifest as RunDirectoryManifest;
}

function writeManifest(path: string, manifest: RunDirectoryManifest): void {
  const temporary = join(path, `${RUN_DIRECTORY_MANIFEST}.${randomUUID()}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(manifest), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, join(path, RUN_DIRECTORY_MANIFEST));
}

function ownedManifest(path: string): RunDirectoryManifest {
  const manifest = manifestAt(path);
  if (manifest === null || manifest.machineId !== getMachineId() || manifest.pid !== process.pid || manifest.nonce !== PROCESS_NONCE) {
    throw new Error('Run directory belongs to another owner.');
  }
  return manifest;
}

/** Only ESRCH proves absence; permission refusals and unsupported probes retain ownership. */
function provenDead(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

function groupsDead(manifest: RunDirectoryManifest): boolean {
  return manifest.pendingStarts.length === 0 && manifest.platform === process.platform
    && manifest.processGroups.every((pid) => provenDead(process.platform === 'win32' ? pid : -pid));
}

/** Credential paths are traversed only through actual directories, never home symlinks. */
function credentialAt(path: string, file: string): string | null {
  const parts = file.split('/');
  let parent = path;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    if (!directoryAt(parent)) return null;
  }
  return join(parent, parts.at(-1)!);
}

/** Delete a credential or truncate a locked private regular file; linked login targets are never rewritten. */
function scrubCredential(path: string): void {
  let entry: fs.Stats;
  try { entry = fs.lstatSync(path); }
  catch (error) { if (absent(error)) return; throw error; }
  if (!entry.isFile() && !entry.isSymbolicLink()) return;
  try { fs.unlinkSync(path); }
  catch (error) {
    if (absent(error)) return;
    const current = fs.lstatSync(path);
    if (!entry.isFile() || !current.isFile()) throw error;
    const fd = fs.openSync(path, fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== current.dev || opened.ino !== current.ino) throw error;
      fs.ftruncateSync(fd, 0);
    } finally { fs.closeSync(fd); }
  }
}

/** Every known credential is scrubbed before any unrelated allocation content is removed. */
function scrubCredentials(path: string): void {
  const failures: unknown[] = [];
  for (const file of CREDENTIAL_FILES) {
    try {
      const at = credentialAt(path, file);
      if (at !== null) scrubCredential(at);
    } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Run credential cleanup failed.');
}

/** The manifest remains until every allocation entry is removed. Symlink targets are never traversed. */
function removeDirectory(path: string): void {
  const manifest = manifestAt(path);
  scrubCredentials(path);
  const failures: unknown[] = [];
  for (const entry of fs.readdirSync(path)) {
    if (entry === RUN_DIRECTORY_MANIFEST) continue;
    try { fs.rmSync(join(path, entry), { recursive: true, force: true }); }
    catch (error) { failures.push(error); }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Run directory cleanup failed.');
  fs.unlinkSync(join(path, RUN_DIRECTORY_MANIFEST));
  try { fs.rmdirSync(path); }
  catch (error) {
    if (manifest !== null && directoryAt(path)) writeManifest(path, manifest);
    throw error;
  }
}

/** Allocate ownership before any run credential or harness configuration is written. */
export function allocateRunDirectory(root: string, identity: RunDirectoryIdentity): string {
  const id = identity.purpose === 'attempt' ? identity.runId : identity.harnessId;
  if (!VALID_IDENTITY.test(id)) throw new Error('Invalid run directory identity.');
  const recorded: RecordedIdentity = identity.purpose === 'attempt'
    ? { purpose: identity.purpose, runId: identity.runId, attemptId: identity.attemptId ?? null,
      projectId: identity.projectId, deploymentKey: createHash('sha256').update(identity.serverUrl).digest('hex') }
    : identity;
  const prefix = identity.purpose === 'attempt' ? id : `models-${id}`;
  const path = fs.mkdtempSync(join(root, `${prefix}-`));
  try {
    fs.chmodSync(path, 0o700);
    writeManifest(path, {
      ...recorded, version: MANIFEST_VERSION, directory: basename(path),
      machineId: getMachineId(), platform: process.platform, pid: process.pid, nonce: PROCESS_NONCE, pendingStarts: [], processGroups: [],
    });
  } catch (error) {
    fs.rmSync(path, { recursive: true, force: true });
    throw error;
  }
  return path;
}

/** Dispose only this process's allocation after every registered harness group has stopped. */
export function discardOwnedRunDirectory(path: string): void {
  if (!directoryAt(path)) {
    if (fs.existsSync(path)) throw new Error('Run directory is not an owned directory.');
    return;
  }
  const manifest = ownedManifest(path);
  if (!groupsDead(manifest)) {
    PENDING_DISCARDS.add(resolve(path));
    throw new Error('Run directory still has a harness owner.');
  }
  try { removeDirectory(path); PENDING_DISCARDS.delete(resolve(path)); }
  catch (error) { PENDING_DISCARDS.add(resolve(path)); throw error; }
}

/** Retry this worker's refused disposals after registered owners become absent. No timers are registered. */
export function retryPendingRunDirectoryDiscards(): { recovered: number; preserved: number } {
  let recovered = 0;
  let preserved = 0;
  for (const path of PENDING_DISCARDS) {
    if (!directoryAt(path)) { PENDING_DISCARDS.delete(path); continue; }
    const manifest = ownedManifest(path);
    if (!groupsDead(manifest)) { preserved += 1; continue; }
    discardOwnedRunDirectory(path);
    recovered += 1;
  }
  return { recovered, preserved };
}

/** Sweep old unmanifested homes once at worker startup; unknown contents and linked directories are retained. */
function sweepLegacyRunDirectory(path: string, now: number): boolean {
  if (entryExists(join(path, RUN_DIRECTORY_MANIFEST)) || now - fs.lstatSync(path).mtimeMs < LEGACY_RUN_DIRECTORY_AGE_MS) return false;
  if (!CREDENTIAL_FILES.some((file) => {
    const at = credentialAt(path, file);
    return at !== null && entryExists(at);
  })) return false;
  scrubCredentials(path);
  const parents = new Set(CREDENTIAL_FILES.map((file) => dirname(join(path, file))).filter((parent) => parent !== path));
  for (const parent of parents) {
    if (!directoryAt(parent)) continue;
    try { fs.rmdirSync(parent); }
    catch (error) { if (!absent(error) && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error; }
  }
  try { fs.rmdirSync(path); return true; }
  catch (error) { if (absent(error)) return true; if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY') return false; throw error; }
}

/** Record launch intent before spawning; an interrupted registration cannot prove the absence of a harness. */
export function beginRunProcess(path: string): { started: (pid: number) => void; cancelled: () => void } | null {
  if (!directoryAt(path)) return null;
  if (!entryExists(join(path, RUN_DIRECTORY_MANIFEST))) return null;
  const initial = ownedManifest(path);
  const id = randomUUID();
  initial.pendingStarts.push(id);
  writeManifest(path, initial);
  const finish = (pid?: number): void => {
    if (pid !== undefined && (!Number.isSafeInteger(pid) || pid <= 0)) throw new Error('Invalid harness process identity.');
    const manifest = ownedManifest(path);
    if (!manifest.pendingStarts.includes(id)) throw new Error('Run directory launch ownership changed.');
    if (pid !== undefined) manifest.processGroups.push(pid);
    manifest.pendingStarts = manifest.pendingStarts.filter((pending) => pending !== id);
    writeManifest(path, manifest);
  };
  return { started: (pid) => finish(pid), cancelled: () => finish() };
}

/** Reclaim only valid local allocations whose worker and all recorded harness groups are proven absent. */
export function recoverAbandonedRunDirectories(root: string): { recovered: number; preserved: number } {
  if (!directoryAt(root)) return { recovered: 0, preserved: 0 };
  let recovered = retryPendingRunDirectoryDiscards().recovered;
  let preserved = 0;
  const now = Date.now();
  for (const entry of fs.readdirSync(root)) {
    const path = join(root, entry);
    if (!directoryAt(path)) { preserved += 1; continue; }
    const manifest = manifestAt(path);
    if (manifest === null) {
      if (sweepLegacyRunDirectory(path, now)) recovered += 1;
      else preserved += 1;
      continue;
    }
    if (manifest.machineId !== getMachineId() || !provenDead(manifest.pid) || !groupsDead(manifest)) {
      preserved += 1;
      continue;
    }
    try { removeDirectory(path); recovered += 1; }
    catch (error) { if (!absent(error)) throw error; }
  }
  return { recovered, preserved };
}
