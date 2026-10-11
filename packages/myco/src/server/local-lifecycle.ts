import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { isProcessAlive } from '@goondocks/myco-shared';
import { homedir } from 'node:os';
import { Database } from 'bun:sqlite';
import type { NativeSqlite } from '@myco-server-worker/platform/bun/native.js';
import { configureSqliteLibrary } from '@myco-server-worker/platform/bun/sqlite-library.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { readLockHolder } from '@myco/utils/lifecycle-lock.js';
import { createLocalDeployment, localSecretNames, localStorageKeysReady, LOCAL_STORAGE_KEYS_MISSING, LOCAL_DATABASE_MISSING, DEFAULT_LOCAL_RECORD, peekLocalPaths, readLocalRecord, assertRecordServable } from './local.js';
import { localOwnerState, localOwnerLinkExpiry, setupLocalOwner, type LocalOwnerLink, type OwnerState } from './local-owner.js';
import { registerGitHubApp, type RegisterOptions } from './github-app.js';
import { assertUnquotablePath, assertServiceTargetHome, defaultSpec, installService, startService, stopService, statusOfService, servicePaths, UNIT_NOT_HELD, type ServiceOptions, type ServiceSpec } from './service.js';

export interface LocalInspection {
  creation: 'absent' | { incomplete: ('record' | 'secrets' | 'schema')[] } | 'complete' | 'behind' | { unavailable: string };
  signIn: 'absent' | 'configured' | { unavailable: string };
  owner: OwnerState | { unavailable: string };
  ownerLinkExpiresAt?: number;
  serving: { mode: 'service' | 'foreground' | 'stopped'; pid: number | null; healthy: boolean };
}

export const LOCAL_HEALTH_TIMEOUT_MS = 2_000;
export const LOCAL_SERVICE_WAIT_MS = 30_000;
const HEALTH_POLL_MS = 500;

export interface LocalLifecycleDeps {
  native?: NativeSqlite;
  service?: ServiceOptions;
  binaryPath?: string;
  userHome?: string;
  fetchImpl?: typeof fetch;
  /** File-only observations omit health checks. */
  checkRemote?: boolean;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Consent for stopping the installed service during exclusive work. */
  confirmStop?: () => Promise<boolean>;
}

function specFor(home: string, deps: LocalLifecycleDeps): ServiceSpec {
  return defaultSpec(deps.binaryPath ?? process.execPath, deps.userHome ?? homedir(), deps.service?.platform ?? process.platform, home);
}

function cause(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /busy|locked/i.test(message) ? 'busy' : message;
}

async function healthy(url: string, deps: LocalLifecycleDeps): Promise<boolean> {
  const timeout = AbortSignal.timeout(LOCAL_HEALTH_TIMEOUT_MS);
  const signal = deps.signal === undefined ? timeout : AbortSignal.any([deps.signal, timeout]);
  try {
    const response = await (deps.fetchImpl ?? fetch)(`${url}/health`, { signal, redirect: 'error' });
    await response.body?.cancel();
    return response.ok;
  } catch {
    deps.signal?.throwIfAborted();
    return false;
  }
}

/** Read creation, identity and serving state without taking a lease or reconciling the layout. */
export async function inspectLocal(home: string, deps: LocalLifecycleDeps = {}): Promise<LocalInspection> {
  home = path.resolve(home);
  const paths = peekLocalPaths(home);
  const result: LocalInspection = {
    creation: 'absent', signIn: 'absent', owner: 'none',
    serving: { mode: 'stopped', pid: null, healthy: false },
  };
  const incomplete: ('record' | 'secrets' | 'schema')[] = [];
  let url: string | undefined;
  let behind = false;
  try {
    const root = fs.lstatSync(paths.root, { throwIfNoEntry: false });
    if (root !== undefined && !root.isDirectory()) throw new Error('local Deployment volume must be a directory, not a symlink');
    if (!fs.existsSync(paths.recordFile)) incomplete.push('record');
    else {
      const record = readLocalRecord(paths);
      assertRecordServable(record);
      url = `http://127.0.0.1:${record.port}`;
    }
    const names = localSecretNames(paths);
    if (fs.existsSync(paths.recordFile) && !fs.existsSync(paths.databasePath)) throw new Error(LOCAL_DATABASE_MISSING);
    if (!localStorageKeysReady(paths)) {
      if (fs.existsSync(paths.databasePath)) throw new Error(LOCAL_STORAGE_KEYS_MISSING);
      incomplete.push('secrets');
    }
    result.signIn = names.has('GITHUB_CLIENT_ID') && names.has('GITHUB_CLIENT_SECRET') ? 'configured' : 'absent';
    if (!fs.existsSync(paths.databasePath)) incomplete.push('schema');
    else {
      configureSqliteLibrary(deps.native);
      const sqlite = new Database(paths.databasePath, { readonly: true });
      try {
        const meta = (key: string) => (sqlite.query('SELECT value FROM schema_meta WHERE key = ?').get(key) as { value: string } | null)?.value;
        const version = Number(meta('version'));
        if (version > SERVER_SCHEMA_VERSION) throw new Error("this Myco is older than the server's data; update Myco");
        if (!meta('deployment_id') || !Number.isSafeInteger(version) || version < 1) incomplete.push('schema');
        else if (version < SERVER_SCHEMA_VERSION) behind = true;
        else {
          result.owner = localOwnerState(sqlite);
          if (result.owner === 'pending-link') result.ownerLinkExpiresAt = localOwnerLinkExpiry(sqlite);
        }
      } catch (error) {
        if (/no such table|no such column/i.test(cause(error))) incomplete.push('schema');
        else throw error;
      } finally { sqlite.close(); }
    }
    result.creation = root === undefined ? 'absent' : incomplete.length > 0 ? { incomplete } : behind ? 'behind' : 'complete';
  } catch (error) {
    const unavailable = { unavailable: cause(error) };
    result.creation = unavailable;
    result.signIn = unavailable;
    result.owner = unavailable;
  }
  const spec = specFor(home, deps);
  try { assertServiceTargetHome(spec, deps.service); }
  catch (error) { result.creation = { unavailable: cause(error) }; return result; }
  const service = statusOfService(spec, { ...deps.service, includePid: true });
  if (service.detail !== undefined && service.detail !== UNIT_NOT_HELD && service.installed && !service.loaded) {
    result.creation = { unavailable: service.detail };
  }
  const holder = liveServeHolder(paths.root);
  result.serving = holder !== null
    ? { mode: holder.pid === service.pid ? 'service' : 'foreground', pid: holder.pid, healthy: false }
    : { mode: service.running ? 'service' : 'stopped', pid: service.pid ?? null, healthy: false };
  if (holder !== null && url !== undefined && deps.checkRemote !== false) result.serving.healthy = await healthy(url, deps);
  return result;
}

export interface LocalPreparePlan {
  retryCommand: string;
  port: number;
  signIn: RegisterOptions | 'skip';
  owner: 'mint' | 'skip';
  serve: 'service' | 'terminal';
}

export interface LocalPrepareDeps extends LocalLifecycleDeps {
  native: NativeSqlite;
  registerSignIn?: typeof registerGitHubApp;
  /** Explicit fresh-link recovery may replace a still-pending link. */
  renewOwnerLink?: boolean;
  terminalInstruction?: string;
}

async function pause(deps: LocalLifecycleDeps, ms: number): Promise<void> {
  deps.signal?.throwIfAborted();
  if (deps.sleep !== undefined) await deps.sleep(ms);
  else await delay(ms, undefined, { signal: deps.signal });
  deps.signal?.throwIfAborted();
}

async function waitForHealth(url: string, spec: ServiceSpec, terminal: boolean, deps: LocalLifecycleDeps): Promise<void> {
  const now = deps.now ?? Date.now;
  const deadline = now() + LOCAL_SERVICE_WAIT_MS;
  while (true) {
    const answered = await healthy(url, deps);
    const holder = liveServeHolder(peekLocalPaths(spec.env.MYCO_HOME!).root);
    if (answered && holder !== null && (terminal || holder.pid === statusOfService(spec, { ...deps.service, includePid: true }).pid)) return;
    if (!terminal && now() >= deadline) {
      throw new Error(`Your Myco did not answer at ${url}; data was kept. Check ${servicePaths(spec, deps.service?.platform).errLog}`);
    }
    await pause(deps, HEALTH_POLL_MS);
  }
}

/** Complete stopped-volume work before serving; restore the installed service even when that work fails. */
export async function prepareLocal(home: string, plan: LocalPreparePlan, deps: LocalPrepareDeps): Promise<{ ownerLink: LocalOwnerLink | null; url: string }> {
  home = path.resolve(home);
  deps.signal?.throwIfAborted();
  if (plan.serve === 'service' && (deps.service?.platform ?? process.platform) === 'linux') assertUnquotablePath(home, 'home');
  assertRecordServable({ ...DEFAULT_LOCAL_RECORD, port: plan.port });
  const before = await inspectLocal(home, { ...deps, checkRemote: false });
  for (const state of [before.creation, before.signIn, before.owner]) {
    if (typeof state === 'object' && 'unavailable' in state) throw new Error(`native Deployment unavailable: ${state.unavailable}`);
  }
  if (before.creation === 'behind') throw new Error('native Deployment data needs update; run myco server update --target local before setup');
  const paths = peekLocalPaths(home);
  const record = fs.existsSync(paths.recordFile) ? readLocalRecord(paths) : { ...DEFAULT_LOCAL_RECORD, port: plan.port };
  if (record.port !== plan.port) throw new Error(`native Deployment uses port ${record.port}; keep that port in the setup plan`);
  const create = before.creation !== 'complete';
  const signIn = plan.signIn !== 'skip' && before.signIn === 'absent';
  const pendingLive = before.owner === 'pending-link' && (before.ownerLinkExpiresAt ?? 0) > (deps.now ?? Date.now)();
  const mint = plan.owner === 'mint' && before.owner !== 'linked' && (!pendingLive || deps.renewOwnerLink === true);
  const exclusive = create || signIn || mint;
  if ((exclusive || plan.serve === 'service') && before.serving.mode === 'foreground') {
    throw new Error(`Your Myco is running in another terminal (process ${before.serving.pid}). Stop it there with Ctrl-C, then rerun ${plan.retryCommand}.`);
  }
  const spec = specFor(home, deps);
  const service = before.serving.mode === 'service' || plan.serve === 'service';
  const restoreService = before.serving.mode === 'service';
  if (exclusive && before.serving.mode === 'service' && !await deps.confirmStop?.()) {
    throw new Error('This stops your Myco for a moment; consent is required before continuing.');
  }
  let ownerLink: LocalOwnerLink | null = null;
  let failed: unknown;
  let workFailed = false;
  const url = `http://127.0.0.1:${record.port}`;
  try {
    if (exclusive && before.serving.mode === 'service') {
      stopService(spec, deps.service);
      const deadline = (deps.now ?? Date.now)() + LOCAL_SERVICE_WAIT_MS;
      while (liveServeHolder(paths.root) !== null) {
        if ((deps.now ?? Date.now)() >= deadline) throw new Error('native service did not release its volume; wait for it to stop before setup');
        await pause(deps, HEALTH_POLL_MS);
      }
    }
    if (create) createLocalDeployment(record, deps.native, paths);
    if (signIn && plan.signIn !== 'skip') {
      await (deps.registerSignIn ?? registerGitHubApp)({ ...plan.signIn, url: record.origin ?? url, target: { kind: 'local', paths } });
    }
    if (mint) ownerLink = await setupLocalOwner(paths, deps.native);
  } catch (error) { failed = error; workFailed = true; }
  finally {
    try {
      const shouldServe = workFailed ? restoreService : service;
      if (shouldServe) {
        const current = statusOfService(spec, deps.service);
        const started = workFailed || current.installed ? startService(spec, deps.service) : installService(spec, deps.service);
        if (!started.running) throw new Error(`Your Myco could not start: ${started.detail ?? 'service not running'}. Check ${servicePaths(spec, deps.service?.platform).errLog}`);
      } else if (!workFailed) deps.log?.(deps.terminalInstruction ?? 'In another terminal, run: myco server run --target local');
      if (!workFailed || shouldServe) await waitForHealth(url, spec, !shouldServe, deps);
    } catch (error) {
      if (workFailed) throw new AggregateError([failed, error], `native preparation failed (${cause(failed)}) and serving could not be restored (${cause(error)})`);
      throw error;
    }
  }
  if (workFailed) throw failed;
  return { ownerLink, url };
}

/** A fresh link requires the terminal's owner to stop and restart their own server. */
export async function recoverLocalOwnerLink(home: string, plan: LocalPreparePlan, deps: LocalPrepareDeps) {
  home = path.resolve(home);
  const state = await inspectLocal(home, { ...deps, checkRemote: false });
  if (state.serving.mode === 'foreground') {
    deps.log?.('Stop your Myco (Ctrl-C in its terminal); setup makes a fresh link.');
    while (liveServeHolder(peekLocalPaths(home).root) !== null) await pause(deps, HEALTH_POLL_MS);
  }
  return prepareLocal(home, { ...plan, owner: 'mint' }, { ...deps, renewOwnerLink: true,
    terminalInstruction: 'Start it again: myco server run --target local' });
}

function liveServeHolder(root: string) {
  const holder = readLockHolder(`${root}.serve.lock`);
  if (holder === null || !Number.isSafeInteger(holder.pid) || holder.pid < 1 || !isProcessAlive(holder.pid)) return null;
  const birth = processStartedAt(holder.pid);
  return birth !== null && birth > holder.startedAt * 1_000 + PROCESS_START_PRECISION_MS ? null : holder;
}

const PROCESS_START_PRECISION_MS = 1_000;

/** A process born after the recorded lease cannot be that lease's owner. */
function processStartedAt(pid: number): number | null {
  if (pid === process.pid) return Date.now() - process.uptime() * 1_000;
  const probe = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`], { encoding: 'utf8', timeout: LOCAL_HEALTH_TIMEOUT_MS })
    : spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: LOCAL_HEALTH_TIMEOUT_MS, env: { ...process.env, LC_ALL: 'C' } });
  const value = Date.parse(probe.stdout?.trim() ?? '');
  return probe.status === 0 && Number.isFinite(value) ? value : null;
}
