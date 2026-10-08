/**
 * The local runner record: the single writer of `<MYCO_HOME>/runner/d-<deployment-key>/runner.json`.
 *
 * A runner is identified by its own bearer, never by a member. One record is
 * held per Deployment: the runner's id and name, its current bearer and that
 * bearer's window, and at most one pending candidate. A candidate is written
 * here BEFORE it is sent to the Deployment, so a reply lost in transit leaves
 * the bearer on disk to be presented again.
 *
 * Every write goes through a `RunnerLock`, which only `withRunnerLock` can
 * make, and publishes atomically: a temp file in the same directory, fsynced,
 * renamed over the record. The directory is 0700 and the record 0600; a record
 * that is loose, unreadable or malformed is an error, never an absence.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveMycoHome } from '../paths/home.js';
import { deploymentKeyFor, deploymentUrl } from '../member/registry.js';
import { ensurePrivateFile, readPrivateJson, renameReplacing } from '../member/store.js';
import { LifecycleLock, type LockHolder } from '../utils/lifecycle-lock.js';

export const RUNNER_RECORD_VERSION = 1;
export const RUNNER_BEARER_PREFIX = 'mycorun_';
const RUNNER_BEARER_BYTES = 32;
const RUNNER_BEARER_PATTERN = /^mycorun_[A-Za-z0-9_-]{43}$/;
const RUNNER_DIRNAME = 'runner';
const DEPLOYMENT_DIR_PREFIX = 'd-';
const RECORD_FILENAME = 'runner.json';
const LOCK_FILENAME = '.lock';
const RUNNER_DIR_MODE = 0o700;
const RUNNER_FILE_MODE = 0o600;
const LOCK_COMMAND = 'myco runner';
const TEMP_SUFFIX_CHARS = 6;

/** A registration in flight: the candidate sent to start it and, once the Deployment answers, the device grant it is polled on. */
export interface PendingRegister {
  kind: 'register';
  candidate: string;
  deviceCode?: string;
  userCode?: string;
  /** Epoch milliseconds at which the device grant lapses. */
  deviceExpiresAt?: number;
  pollIntervalSeconds?: number;
  startedAt: number;
}

/** A rotation in flight: the successor sent to the Deployment and not yet known to have been taken. */
export interface PendingRotate {
  kind: 'rotate';
  candidate: string;
  predecessorTokenId?: string;
  startedAt: number;
}

export type RunnerPending = PendingRegister | PendingRotate;

export interface RunnerRecord {
  version: number;
  serverUrl: string;
  deploymentId?: string;
  runnerId?: string;
  name: string;
  token?: string;
  tokenId?: string;
  tokenExpiresAt?: number;
  refreshAfter?: number;
  pending?: RunnerPending;
}

/** A record that is on disk and cannot be trusted: loose mode, unreadable, malformed, or naming another Deployment. */
export class RunnerRecordError extends Error {
  constructor(readonly file: string, readonly problem: string) {
    super(`runner record ${file}: ${problem}`);
  }
}

/** `mycorun_` followed by 32 random bytes, base64url. */
export function newRunnerBearer(): string {
  return `${RUNNER_BEARER_PREFIX}${crypto.randomBytes(RUNNER_BEARER_BYTES).toString('base64url')}`;
}

export function isRunnerBearer(value: unknown): value is string {
  return typeof value === 'string' && RUNNER_BEARER_PATTERN.test(value);
}

export function runnerRoot(mycoHome: string = resolveMycoHome()): string {
  return path.join(mycoHome, RUNNER_DIRNAME);
}

/** Where the runner for the Deployment at `serverUrl` keeps its record, lock and working files. */
export function runnerDir(serverUrl: string, mycoHome: string = resolveMycoHome()): string {
  return path.join(runnerRoot(mycoHome), `${DEPLOYMENT_DIR_PREFIX}${deploymentKeyFor(serverUrl)}`);
}

export function runnerRecordPath(serverUrl: string, mycoHome: string = resolveMycoHome()): string {
  return path.join(runnerDir(serverUrl, mycoHome), RECORD_FILENAME);
}

function runnerLockPath(serverUrl: string, mycoHome: string): string {
  return path.join(runnerDir(serverUrl, mycoHome), LOCK_FILENAME);
}

const isString = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function parsePending(file: string, value: unknown): RunnerPending {
  if (value === null || typeof value !== 'object') throw new RunnerRecordError(file, 'pending is not an object');
  const pending = value as Record<string, unknown>;
  if (!isRunnerBearer(pending.candidate)) throw new RunnerRecordError(file, 'pending candidate is not a runner bearer');
  if (!isTime(pending.startedAt)) throw new RunnerRecordError(file, 'pending startedAt is not a time');
  if (pending.kind === 'rotate') {
    if (pending.predecessorTokenId !== undefined && !isString(pending.predecessorTokenId)) throw new RunnerRecordError(file, 'pending predecessorTokenId is not a string');
    return pending as unknown as PendingRotate;
  }
  if (pending.kind !== 'register') throw new RunnerRecordError(file, 'pending kind is neither register nor rotate');
  for (const field of ['deviceCode', 'userCode'] as const) {
    if (pending[field] !== undefined && !isString(pending[field])) throw new RunnerRecordError(file, `pending ${field} is not a string`);
  }
  for (const field of ['deviceExpiresAt', 'pollIntervalSeconds'] as const) {
    if (pending[field] !== undefined && !isTime(pending[field])) throw new RunnerRecordError(file, `pending ${field} is not a number`);
  }
  return pending as unknown as PendingRegister;
}

function parseRecord(file: string, value: unknown, serverUrl?: string): RunnerRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new RunnerRecordError(file, 'not an object');
  const record = value as Record<string, unknown>;
  if (record.version !== RUNNER_RECORD_VERSION) throw new RunnerRecordError(file, `version ${String(record.version)} is not ${RUNNER_RECORD_VERSION}`);
  if (!isString(record.serverUrl)) throw new RunnerRecordError(file, 'serverUrl is not a string');
  if (serverUrl !== undefined && deploymentUrl(record.serverUrl) !== deploymentUrl(serverUrl)) throw new RunnerRecordError(file, 'names another Deployment');
  if (!isString(record.name)) throw new RunnerRecordError(file, 'name is not a string');
  for (const field of ['deploymentId', 'runnerId', 'tokenId'] as const) {
    if (record[field] !== undefined && !isString(record[field])) throw new RunnerRecordError(file, `${field} is not a string`);
  }
  for (const field of ['tokenExpiresAt', 'refreshAfter'] as const) {
    if (record[field] !== undefined && !isTime(record[field])) throw new RunnerRecordError(file, `${field} is not a time`);
  }
  if (record.token !== undefined && !isRunnerBearer(record.token)) throw new RunnerRecordError(file, 'token is not a runner bearer');
  return { ...(record as unknown as RunnerRecord), ...(record.pending === undefined ? {} : { pending: parsePending(file, record.pending) }) };
}

function readRecordFile(file: string, serverUrl?: string): RunnerRecord | null {
  const read = readPrivateJson<unknown>(file);
  if (!read.ok) {
    if (read.reason === 'missing') return null;
    throw new RunnerRecordError(file, `${read.reason}${read.detail === undefined ? '' : ` (${read.detail})`}`);
  }
  return parseRecord(file, read.value, serverUrl);
}

/** The record for the Deployment at `serverUrl`, or null where none is held. Throws a `RunnerRecordError` for a record that is there and cannot be trusted. */
export function readRunnerRecord(serverUrl: string, mycoHome: string = resolveMycoHome()): RunnerRecord | null {
  return readRecordFile(runnerRecordPath(serverUrl, mycoHome), serverUrl);
}

/** Every record this home holds, in directory order. */
export function listRunnerRecords(mycoHome: string = resolveMycoHome()): RunnerRecord[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(runnerRoot(mycoHome));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.startsWith(DEPLOYMENT_DIR_PREFIX))
    .sort()
    .flatMap((entry) => {
      const record = readRecordFile(path.join(runnerRoot(mycoHome), entry, RECORD_FILENAME));
      return record === null ? [] : [record];
    });
}

/** Whether the record holds a registered runner's bearer, as opposed to a registration still in flight. */
export function isLiveRunner(record: RunnerRecord | null): record is RunnerRecord & { token: string; runnerId: string } {
  return record !== null && record.token !== undefined && record.runnerId !== undefined;
}

declare const HELD: unique symbol;

/** Proof that this process holds the runner lock for one Deployment; only `withRunnerLock` makes one. */
export interface RunnerLock {
  readonly [HELD]: true;
  readonly serverUrl: string;
  readonly mycoHome: string;
}

export type RunnerLockResult<T> = { held: true; value: T } | { held: false; holder: LockHolder | null };

function ensureRunnerDir(serverUrl: string, mycoHome: string): string {
  const dir = runnerDir(serverUrl, mycoHome);
  fs.mkdirSync(dir, { recursive: true, mode: RUNNER_DIR_MODE });
  for (const level of [runnerRoot(mycoHome), dir]) fs.chmodSync(level, RUNNER_DIR_MODE);
  return dir;
}

/**
 * Run `fn` holding this Deployment's runner lock, or report who holds it.
 * The lock is taken without waiting and held across `fn`, dials included, so
 * two local processes never stage or send different candidates at once.
 */
export async function withRunnerLock<T>(
  serverUrl: string,
  fn: (lock: RunnerLock) => Promise<T> | T,
  mycoHome: string = resolveMycoHome(),
): Promise<RunnerLockResult<T>> {
  ensureRunnerDir(serverUrl, mycoHome);
  const lockPath = runnerLockPath(serverUrl, mycoHome);
  ensurePrivateFile(lockPath);
  const attempt = LifecycleLock.acquire(lockPath, { command: LOCK_COMMAND });
  if (!attempt.acquired) return { held: false, holder: attempt.holder };
  try {
    return { held: true, value: await fn({ serverUrl, mycoHome } as RunnerLock) };
  } finally {
    attempt.lock.release();
  }
}

function syncDirectory(dir: string): void {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Publish `record` atomically, replacing the one held. */
export function publishRunnerRecord(lock: RunnerLock, record: RunnerRecord): void {
  if (deploymentUrl(record.serverUrl) !== deploymentUrl(lock.serverUrl)) {
    throw new Error(`publishRunnerRecord: record names ${record.serverUrl}, the lock is for ${lock.serverUrl}`);
  }
  const dir = ensureRunnerDir(lock.serverUrl, lock.mycoHome);
  const file = runnerRecordPath(lock.serverUrl, lock.mycoHome);
  const temp = `${file}.${process.pid}.${crypto.randomBytes(TEMP_SUFFIX_CHARS).toString('hex')}.tmp`;
  const fd = fs.openSync(temp, 'wx', RUNNER_FILE_MODE);
  try {
    try {
      fs.writeSync(fd, `${JSON.stringify({ ...record, version: RUNNER_RECORD_VERSION }, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameReplacing(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  syncDirectory(dir);
}

/**
 * Write `pending` onto the record before anything is sent. Where no record is
 * held, one is begun under `name`; where one is held its own name stands.
 */
export function stagePending(lock: RunnerLock, pending: RunnerPending, name: string): RunnerRecord {
  const held = readRunnerRecord(lock.serverUrl, lock.mycoHome);
  const staged: RunnerRecord = { ...(held ?? { version: RUNNER_RECORD_VERSION, serverUrl: deploymentUrl(lock.serverUrl), name }), pending };
  publishRunnerRecord(lock, staged);
  return staged;
}

/** Remove the record outright, bearer included. */
export function removeRunnerRecord(lock: RunnerLock): void {
  fs.rmSync(runnerRecordPath(lock.serverUrl, lock.mycoHome), { force: true });
  syncDirectory(runnerDir(lock.serverUrl, lock.mycoHome));
}

/** Drop the pending candidate. A record that never held a bearer has nothing else to keep and is removed. */
export function clearPending(lock: RunnerLock): RunnerRecord | null {
  const held = readRunnerRecord(lock.serverUrl, lock.mycoHome);
  if (held === null) return null;
  if (held.token === undefined) {
    removeRunnerRecord(lock);
    return null;
  }
  const kept: RunnerRecord = { ...held };
  delete kept.pending;
  publishRunnerRecord(lock, kept);
  return kept;
}
