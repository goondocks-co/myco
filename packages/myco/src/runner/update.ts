/** Runner-owned release checks and an idle-only, durable binary handoff. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import semver from 'semver';
import { RELEASE_CHANNELS, type ReleaseChannel } from '../constants/update.js';
import { readInstallMarker, versionBinaryPath, versionsDir, type InstallMarker } from '../install/managed-binary.js';
import { placeExecutable, type ProgramProbe } from '../install/place-binary.js';
import { stageBinary, pruneVersions, DEFAULT_BINARY_UPDATE_DEPS, type StageBinaryDeps } from '../upgrade/apply-binary.js';
import { assetName, githubHeaders, mycoReleasesApiUrl, pickRelease, resolveAssetRefs, resolveTargetTriple, type AssetRefs, type GitHubRelease } from '../upgrade/release-assets.js';
import { installService, servicePathEnv, servicePaths, uninstallService, type ServiceOutcome, type ServiceSpec } from '../server/service.js';
import { LifecycleLock } from '../utils/lifecycle-lock.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

const UPDATE_FILE = 'update.json';
const UPDATE_LOCK = '.update.lock';
const UPDATE_OPERATION_LOCK = '.update-operation.lock';
const UPDATE_CLEANUP_LOCK = '.update-cleanup.lock';
const CHECK_MIN_MS = 6 * 60 * 60 * 1000;
const CHECK_JITTER_MS = 4 * 60 * 60 * 1000;
const FAILURE_BACKOFF_MS = 60 * 60 * 1000;
const MAX_FAILURE_BACKOFF_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RELEASE_PAGES = 3;
const PROBE_TIMEOUT_MS = 30_000;
const TX_STALE_MS = 10 * 60 * 1000;
const MAX_RESULT_REASON = 512;

export type RunnerUpdateResult = 'updated' | 'no_update' | 'refused' | 'rolled_back' | 'failed';
export interface RunnerUpdateReceipt {
  requestId?: string;
  fromVersion: string;
  toVersion: string;
  result: RunnerUpdateResult;
  reason?: string;
  at: number;
}
export interface RunnerUpdateContact {
  channel: ReleaseChannel | null;
  currentVersion: string;
  latestVersion: string | null;
  lastCheckAt: number | null;
  lastResult?: RunnerUpdateReceipt;
}
export interface RunnerUpdateRequest { id: string; requestedAt: number }
interface RunnerUpdateTransaction {
  id: string;
  serverUrl: string;
  fromVersion: string;
  toVersion: string;
  binaryPath: string;
  home: string;
  platform: NodeJS.Platform;
  localAppData?: string;
  serviceSpec: ServiceSpec;
  installMarker: InstallMarker;
  ownerPid: number;
  startedAt: number;
  recoveryAt?: number;
  requestId?: string;
  phase: 'waiting' | 'adopted' | 'healthy' | 'rollback';
  failureReason?: string;
  rollbackResult?: 'rolled_back' | 'failed';
}
interface RunnerUpdateState {
  version: 1;
  nextCheckAt: number;
  lastCheckAt: number | null;
  latestVersion: string | null;
  etag?: string;
  failures: number;
  failedVersions?: string[];
  requests?: Record<string, RunnerUpdateRequest & { manual?: true }>;
  lastResults?: Record<string, RunnerUpdateReceipt>;
  transaction?: RunnerUpdateTransaction;
  guardian?: ServiceSpec;
  cleanup?: { failedVersion: string; currentVersion: string; platform: NodeJS.Platform; localAppData?: string };
}

export interface RunnerUpdateOptions {
  home: string;
  serverUrl: string;
  binaryPath: string;
  currentVersion: string;
  serviceSpec: ServiceSpec;
  platform?: NodeJS.Platform;
  localAppData?: string;
  log: (line: string) => void;
  deps?: RunnerUpdateDeps;
}
export interface RunnerUpdateDeps {
  now?: () => number;
  random?: () => number;
  fetch?: typeof fetch;
  stage?: typeof stageBinary;
  stageDeps?: StageBinaryDeps;
  probe?: (file: string, version: string, platform: NodeJS.Platform) => ProgramProbe;
  installGuardian?: (spec: ServiceSpec, platform: NodeJS.Platform) => ServiceOutcome;
  removeGuardian?: (spec: ServiceSpec, platform: NodeJS.Platform) => void;
  /** Test transport for a guardian service stub that does not launch its command. */
  spawnHelper?: (binary: string, statePath: string) => Promise<void>;
  targetTriple?: typeof resolveTargetTriple;
  serviceInstalled?: (spec: ServiceSpec, platform: NodeJS.Platform) => boolean;
}

function statePath(home: string): string { return path.join(home, 'runner', UPDATE_FILE); }
function freshState(): RunnerUpdateState {
  return { version: 1, nextCheckAt: 0, lastCheckAt: null, latestVersion: null, failures: 0 };
}
function readState(home: string): RunnerUpdateState {
  const file = statePath(home);
  if (!fs.existsSync(file)) return freshState();
  const state = JSON.parse(fs.readFileSync(file, 'utf8')) as RunnerUpdateState;
  const tx = state?.transaction;
  const guardian = state?.guardian;
  const cleanup = state?.cleanup;
  const expectedLabel = runnerUpdateGuardianLabel(home);
  const expectedUnit = `myco-runner-update-${expectedLabel.slice(-16)}`;
  if (state?.version !== 1 || !Number.isFinite(state.nextCheckAt) || !Number.isFinite(state.failures)
    || !(state.lastCheckAt === null || Number.isFinite(state.lastCheckAt))
    || !(state.latestVersion === null || typeof state.latestVersion === 'string')
    || (tx !== undefined && (typeof tx.id !== 'string' || typeof tx.serverUrl !== 'string' ||
      typeof tx.fromVersion !== 'string' || typeof tx.toVersion !== 'string' ||
      typeof tx.binaryPath !== 'string' || !path.isAbsolute(tx.binaryPath) ||
      typeof tx.home !== 'string' || path.resolve(tx.home) !== path.resolve(home) ||
      !['waiting', 'adopted', 'healthy', 'rollback'].includes(tx.phase) || !Number.isSafeInteger(tx.ownerPid) || tx.ownerPid < 1 ||
      !Number.isFinite(tx.startedAt) || tx.serviceSpec?.binaryPath !== tx.binaryPath ||
      !RELEASE_CHANNELS.includes(tx.installMarker?.channel) || !['curl', 'npm'].includes(tx.installMarker?.source) ||
      typeof tx.installMarker?.bin !== 'string' || !path.isAbsolute(tx.installMarker.bin))) ||
    (cleanup !== undefined && (!semver.valid(cleanup.failedVersion) || !semver.valid(cleanup.currentVersion)
      || cleanup.failedVersion === cleanup.currentVersion || typeof cleanup.platform !== 'string'
      || (cleanup.localAppData !== undefined && typeof cleanup.localAppData !== 'string')
      || (guardian !== undefined && guardian.binaryPath !== versionBinaryPath(home, cleanup.platform, cleanup.failedVersion, cleanup.localAppData)))) ||
    (guardian !== undefined && (guardian.unit?.label !== expectedLabel || guardian.unit?.unitName !== expectedUnit ||
      guardian.unit?.args?.[0] !== 'runner' || guardian.unit?.args?.[1] !== '__apply-update' ||
      guardian.unit?.args?.[2] !== file || guardian.unit.args.length !== 3 ||
      typeof guardian.binaryPath !== 'string' || !path.isAbsolute(guardian.binaryPath)))) {
    throw new Error(`Invalid runner update record at ${file}`);
  }
  return state;
}
function safeReason(reason: string): string {
  return reason.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, MAX_RESULT_REASON);
}
function writeState(home: string, state: RunnerUpdateState): void {
  const file = statePath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (const result of Object.values(state.lastResults ?? {})) if (result.reason !== undefined) result.reason = safeReason(result.reason);
  if (state.transaction?.failureReason !== undefined) state.transaction.failureReason = safeReason(state.transaction.failureReason);
  atomicWriteFileSync(file, `${JSON.stringify(state)}\n`, { mode: 0o600, durable: true });
}
function withState<T>(home: string, change: (state: RunnerUpdateState) => T): T {
  const dir = path.dirname(statePath(home));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let held = LifecycleLock.acquire(path.join(dir, UPDATE_LOCK), { command: 'myco runner update' });
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let tries = 0; !held.acquired && tries < 20; tries++) {
    Atomics.wait(sleeper, 0, 0, 10);
    held = LifecycleLock.acquire(path.join(dir, UPDATE_LOCK), { command: 'myco runner update' });
  }
  if (!held.acquired) throw new Error('another runner update holds the machine binary');
  try {
    const state = readState(home);
    const result = change(state);
    writeState(home, state);
    return result;
  } finally { held.lock.release(); }
}

/** The runner never repairs a signature: only the published signature may run. */
export function strictRunnerReleaseProbe(file: string, version: string, platform: NodeJS.Platform): ProgramProbe {
  if (platform === 'darwin') {
    const signed = spawnSync('codesign', ['--verify', '--strict', file], { cwd: path.dirname(file), encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
    if (signed.status !== 0) return { runs: false, detail: `macOS code signature verification failed: ${signed.error?.message ?? signed.stderr?.trim() ?? signed.status}` };
  }
  const ran = spawnSync(file, ['--version'], { cwd: path.dirname(file), encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  if (ran.status !== 0) return { runs: false, detail: `version probe failed: ${ran.error?.message ?? ran.stderr?.trim() ?? ran.status}` };
  const actual = ran.stdout.trim();
  return actual === version ? { runs: true } : { runs: false, detail: `version probe answered ${JSON.stringify(actual)}; expected ${version}` };
}

async function releases(channel: ReleaseChannel, currentVersion: string, etag: string | undefined, deps: RunnerUpdateDeps): Promise<{ refs: AssetRefs | null; etag?: string; unchanged: boolean }> {
  const fetchFn = deps.fetch ?? fetch;
  const triple = (deps.targetTriple ?? resolveTargetTriple)();
  const all: GitHubRelease[] = [];
  let firstEtag: string | undefined;
  for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
    const url = mycoReleasesApiUrl() + (page === 1 ? '' : `&page=${page}`);
    const response = await fetchFn(url, {
      headers: { ...githubHeaders(), ...(page === 1 && etag ? { 'If-None-Match': etag } : {}) },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (page === 1 && response.status === 304) return { refs: null, etag, unchanged: true };
    if (!response.ok) throw new Error(`GitHub releases responded with ${response.status}`);
    if (page === 1) firstEtag = response.headers.get('etag') ?? undefined;
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error('GitHub releases response must be an array');
    all.push(...batch as GitHubRelease[]);
    if (batch.length < 100) {
      const release = pickRelease(all, channel, { asset: assetName(triple), currentVersion, minimumMajor: 2 });
      return { refs: release === null ? null : resolveAssetRefs(release, triple), etag: firstEtag, unchanged: false };
    }
  }
  throw new Error(`GitHub release discovery exceeded ${MAX_RELEASE_PAGES} pages`);
}

/** One per-home OS unit watches a transaction and restarts its helper after process death. */
export function runnerUpdateGuardianLabel(home: string): string {
  return `co.goondocks.myco-runner-update.${crypto.createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 16)}`;
}
export function runnerUpdateGuardianSpec(tx: RunnerUpdateTransaction): ServiceSpec {
  const id = crypto.createHash('sha256').update(path.resolve(tx.home)).digest('hex').slice(0, 16);
  const binaryPath = versionBinaryPath(tx.home, tx.platform, tx.toVersion, tx.localAppData);
  return {
    unit: {
      label: runnerUpdateGuardianLabel(tx.home),
      unitName: `myco-runner-update-${id}`,
      description: 'Myco runner update guardian',
      args: ['runner', '__apply-update', statePath(tx.home)],
      logName: `runner-update-${id}`,
      restartDelaySeconds: 5,
    },
    binaryPath,
    home: tx.serviceSpec.home,
    pathEnv: servicePathEnv(binaryPath, tx.serviceSpec.home, tx.platform),
    logDir: path.join(tx.home, 'logs'),
    env: { MYCO_HOME: tx.home },
  };
}

/** Guardian removal precedes deletion of the verified but failed release slot. */
export function cleanupRunnerUpdateGuardian(home: string, platform: NodeJS.Platform, deps: {
  removeGuardian?: (spec: ServiceSpec, platform: NodeJS.Platform) => void;
  prune?: typeof pruneVersions;
} = {}): void {
  const held = LifecycleLock.acquire(path.join(home, 'runner', UPDATE_CLEANUP_LOCK), { command: 'myco runner update cleanup' });
  if (!held.acquired) throw new Error('runner update cleanup is already in progress');
  try {
  let state = readState(home);
  if (state.transaction !== undefined) return;
  if (state.guardian !== undefined) {
    if (state.guardian.unit.label !== runnerUpdateGuardianLabel(home)) throw new Error('runner update guardian belongs to another home');
    (deps.removeGuardian ?? ((spec, targetPlatform) => { uninstallService(spec, { platform: targetPlatform }); }))(state.guardian, platform);
    withState(home, next => { if (next.transaction === undefined) delete next.guardian; });
    state = readState(home);
  }
  const cleanup = state.cleanup;
  if (cleanup === undefined) return;
  if (state.guardian !== undefined) return;
  const failed = versionBinaryPath(home, cleanup.platform, cleanup.failedVersion, cleanup.localAppData);
  const root = versionsDir(home, cleanup.platform, cleanup.localAppData);
  const failedDir = path.dirname(failed);
  if (path.dirname(failedDir) !== root || path.basename(failedDir) !== cleanup.failedVersion) throw new Error('invalid runner update cleanup slot');
  fs.rmSync(failedDir, { recursive: true, force: true });
  (deps.prune ?? pruneVersions)(home, cleanup.platform, 2, cleanup.currentVersion, undefined, cleanup.localAppData);
  const retained = fs.existsSync(root) ? fs.readdirSync(root).filter(version =>
    semver.valid(version) !== null && fs.statSync(path.join(root, version)).isDirectory()) : [];
  if (fs.existsSync(failedDir) || retained.length > 2) throw new Error('runner update version cleanup is incomplete');
  withState(home, next => { if (next.transaction === undefined && next.guardian === undefined) delete next.cleanup; });
  } finally { held.lock.release(); }
}

export interface RunnerUpdateController {
  contactPayload(): RunnerUpdateContact;
  onContact(body: Record<string, unknown>): void;
  /** Called after this version starts; health is acknowledged only by authenticated contact. */
  startup(): void;
  acknowledgeHealthy(): void;
  queueManual(): void;
  check(): Promise<RunnerUpdateContact>;
  /** Called only between runs; hold blocks claims until the health transaction settles. */
  idle(): Promise<'continue' | 'restart' | 'hold'>;
}

export function createRunnerUpdateController(options: RunnerUpdateOptions): RunnerUpdateController {
  const { home, serverUrl, binaryPath, currentVersion, log } = options;
  if (path.resolve(binaryPath) !== path.resolve(options.serviceSpec.binaryPath)) throw new Error('runner update binary does not match service binary');
  const platform = options.platform ?? process.platform;
  const deps = options.deps ?? {};
  const now = deps.now ?? Date.now;
  const jitter = (): number => CHECK_MIN_MS + Math.floor((deps.random ?? Math.random)() * CHECK_JITTER_MS);
  const channel = (): ReleaseChannel | null => {
    let marker: ReturnType<typeof readInstallMarker>;
    try { marker = readInstallMarker(home, true); }
    catch (error) { log(`runner update unavailable: ${String(error)}`); return null; }
    if (marker === null || !RELEASE_CHANNELS.includes(marker.channel) || !semver.valid(currentVersion) || semver.major(currentVersion) < 2) return null;
    if (path.resolve(marker.bin) !== path.resolve(binaryPath)) {
      // The unit's actual program path is authoritative; the marker only selects the channel.
      log(`install marker names ${marker.bin}; runner service executes ${binaryPath}`);
    }
    return marker.channel;
  };
  const contactPayload = (): RunnerUpdateContact => {
    const releaseChannel = channel();
    const state = readState(home);
    return { channel: releaseChannel, currentVersion, latestVersion: state.latestVersion, lastCheckAt: state.lastCheckAt,
      ...(state.lastResults?.[serverUrl] === undefined ? {} : { lastResult: state.lastResults[serverUrl] }) };
  };
  const cleanupGuardian = (): boolean => {
    try { cleanupRunnerUpdateGuardian(home, platform, { removeGuardian: deps.removeGuardian }); return true; }
    catch (error) { log(`runner update guardian cleanup failed: ${String(error)}`); return false; }
  };
  const onContact = (body: Record<string, unknown>): void => {
    const raw = body.updateRequest;
    if (raw === undefined) return;
    if (raw === null) {
      withState(home, state => { if (state.requests?.[serverUrl]?.manual !== true) delete state.requests?.[serverUrl]; });
      return;
    }
    if (typeof raw !== 'object' || typeof (raw as RunnerUpdateRequest).id !== 'string' || !Number.isFinite((raw as RunnerUpdateRequest).requestedAt)) {
      throw new Error('Deployment sent an invalid runner update request');
    }
    const request = raw as RunnerUpdateRequest;
    withState(home, (state) => {
      if (state.lastResults?.[serverUrl]?.requestId === request.id ||
        (state.transaction?.serverUrl === serverUrl && state.transaction.requestId === request.id)) return;
      const queued = state.requests?.[serverUrl];
      if (queued?.id === request.id) return;
      if (queued === undefined || queued.requestedAt <= request.requestedAt) {
        (state.requests ??= {})[serverUrl] = request;
        state.nextCheckAt = 0;
      }
    });
  };
  const startup = (): void => {
    const state = readState(home);
    const tx = state.transaction;
    if (tx?.phase === 'adopted' && tx.toVersion === currentVersion) log(`runner update ${tx.id} awaiting authenticated contact`);
    if (tx === undefined) cleanupGuardian();
  };
  const acknowledgeHealthy = (): void => {
    withState(home, (state) => {
      const tx = state.transaction;
      if (tx?.phase === 'adopted' && tx.serverUrl === serverUrl && tx.binaryPath === binaryPath && tx.toVersion === currentVersion) tx.phase = 'healthy';
    });
  };
  const queueManual = (): void => {
    withState(home, (state) => { (state.requests ??= {})[serverUrl] = { id: crypto.randomUUID(), requestedAt: now(), manual: true }; state.nextCheckAt = 0; });
  };
  const check = async (): Promise<RunnerUpdateContact> => {
    const releaseChannel = channel();
    if (releaseChannel === null) return contactPayload();
    const checked = await releases(releaseChannel, currentVersion, undefined, deps);
    withState(home, (next) => {
      next.lastCheckAt = now(); next.nextCheckAt = now() + jitter(); next.failures = 0;
      if (!checked.unchanged) { next.latestVersion = checked.refs?.targetVersion ?? null; next.etag = checked.etag; }
    });
    return contactPayload();
  };
  const idle = async (): Promise<'continue' | 'restart' | 'hold'> => {
    const state = readState(home);
    if (state.transaction !== undefined) {
      const tx = state.transaction;
      if ((tx.phase === 'healthy' && tx.recoveryAt === undefined) || now() - (tx.recoveryAt ?? tx.startedAt) >= TX_STALE_MS) {
        try {
          withState(home, (next) => { if (next.transaction?.id === tx.id) next.transaction.recoveryAt = now(); });
          const guardian = readState(home).guardian;
          if (guardian === undefined) throw new Error('update guardian is absent');
          const outcome = (deps.installGuardian ?? ((spec, targetPlatform) => installService(spec, { platform: targetPlatform, keepRunning: true })))(guardian, platform);
          if (!outcome.loaded || !outcome.running) throw new Error(outcome.detail ?? 'update guardian is not running');
          log(`runner update ${tx.id} resumed its supervised health watcher`);
        } catch (error) { log(`runner update ${tx.id} recovery failed: ${String(error)}`); }
      }
      return 'hold';
    }
    if ((state.guardian !== undefined || state.cleanup !== undefined) && !cleanupGuardian()) return 'hold';
    const request = state.requests?.[serverUrl];
    if (now() < state.nextCheckAt) return 'continue';
    const releaseChannel = channel();
    if (releaseChannel === null) {
      withState(home, (next) => {
        next.nextCheckAt = now() + jitter();
        if (request) {
          (next.lastResults ??= {})[serverUrl] = { requestId: request.id, fromVersion: currentVersion,
            toVersion: currentVersion, result: 'refused', reason: 'runner has no installed 2.x release channel', at: now() };
          if (next.requests?.[serverUrl]?.id === request.id) delete next.requests[serverUrl];
        }
      });
      return 'continue';
    }
    if (!(deps.serviceInstalled ?? ((spec, targetPlatform) => fs.existsSync(servicePaths(spec, targetPlatform).unitFile)))(options.serviceSpec, platform)) {
      withState(home, (next) => {
        next.nextCheckAt = now() + jitter();
        if (request) {
          (next.lastResults ??= {})[serverUrl] = { requestId: request.id, fromVersion: currentVersion,
            toVersion: currentVersion, result: 'refused', reason: 'runner service is not installed', at: now() };
          if (next.requests?.[serverUrl]?.id === request.id) delete next.requests[serverUrl];
        }
      });
      return 'continue';
    }
    const operation = LifecycleLock.acquire(path.join(home, 'runner', UPDATE_OPERATION_LOCK), { command: 'myco runner update operation' });
    if (!operation.acquired) return 'hold';
    try {
    const active = readState(home);
    if (active.transaction !== undefined || active.guardian !== undefined || active.cleanup !== undefined) return 'hold';
    let refs: AssetRefs | null = null;
    try {
      const priorCandidate = state.latestVersion !== null && semver.valid(state.latestVersion) && semver.valid(currentVersion)
        && semver.gt(state.latestVersion, currentVersion);
      const found = await releases(releaseChannel, currentVersion, request || priorCandidate ? undefined : state.etag, deps);
      refs = found.refs;
      withState(home, (next) => {
        next.lastCheckAt = now(); next.nextCheckAt = now() + jitter(); next.failures = 0;
        if (!found.unchanged) { next.latestVersion = refs?.targetVersion ?? null; next.etag = found.etag; }
        if (refs === null && request !== undefined) {
          (next.lastResults ??= {})[serverUrl] = { requestId: request.id, fromVersion: currentVersion, toVersion: currentVersion, result: 'no_update', at: now() };
          if (next.requests?.[serverUrl]?.id === request.id) delete next.requests[serverUrl];
        }
      });
    } catch (error) {
      withState(home, (next) => {
        next.failures++;
        next.nextCheckAt = now() + Math.min(MAX_FAILURE_BACKOFF_MS, FAILURE_BACKOFF_MS * 2 ** Math.min(next.failures - 1, 5));
        if (request) {
          (next.lastResults ??= {})[serverUrl] = { requestId: request.id, fromVersion: currentVersion, toVersion: currentVersion, result: 'failed', reason: String(error), at: now() };
          if (next.requests?.[serverUrl]?.id === request.id) delete next.requests[serverUrl];
        }
      });
      log(`runner update check failed: ${error instanceof Error ? error.message : String(error)}`);
      return 'continue';
    }
    if (refs === null) return 'continue';
    if (!semver.valid(currentVersion) || !semver.valid(refs.targetVersion) || semver.major(refs.targetVersion) < 2 || !semver.gt(refs.targetVersion, currentVersion)) {
      if (request) withState(home, (next) => {
        (next.lastResults ??= {})[serverUrl] = { requestId: request.id, fromVersion: currentVersion, toVersion: refs.targetVersion, result: 'no_update', at: now() };
        if (next.requests?.[serverUrl]?.id === request.id) delete next.requests[serverUrl];
      });
      return 'continue';
    }
    if (readState(home).failedVersions?.includes(refs.targetVersion)) {
      if (request) withState(home, (next) => {
        (next.lastResults ??= {})[serverUrl] = { requestId: request.id, fromVersion: currentVersion, toVersion: refs.targetVersion,
          result: 'refused', reason: 'this release failed runner health verification', at: now() };
        if (next.requests?.[serverUrl]?.id === request.id) delete next.requests[serverUrl];
      });
      return 'continue';
    }
    const probe = deps.probe ?? strictRunnerReleaseProbe;
    const stage = await (deps.stage ?? stageBinary)({ refs, home, platform, localAppData: options.localAppData }, {
      ...(deps.stageDeps ?? DEFAULT_BINARY_UPDATE_DEPS), ready: (file) => probe(file, refs.targetVersion, platform),
    });
    if ('error' in stage) {
      withState(home, (next) => {
        (next.lastResults ??= {})[serverUrl] = { ...(request ? { requestId: request.id } : {}), fromVersion: currentVersion, toVersion: refs.targetVersion, result: 'refused', reason: stage.error, at: now() };
        next.nextCheckAt = now() + FAILURE_BACKOFF_MS;
        if (request && next.requests?.[serverUrl]?.id === request.id) delete next.requests[serverUrl];
      });
      log(`runner update staging failed: ${stage.error}`);
      return 'continue';
    }
    // The installed executable may live outside the canonical <home>/bin path.
    // Preserve its exact bytes in the previous slot before arranging its replacement.
    const previous = versionBinaryPath(home, platform, currentVersion, options.localAppData);
    fs.mkdirSync(path.dirname(previous), { recursive: true });
    try { placeExecutable(binaryPath, previous, { platform, ready: (file) => probe(file, currentVersion, platform) }); }
    catch (error) {
      withState(home, (next) => {
        (next.lastResults ??= {})[serverUrl] = { ...(request ? { requestId: request.id } : {}), fromVersion: currentVersion,
          toVersion: refs.targetVersion, result: 'refused', reason: `current binary backup failed: ${String(error)}`, at: now() };
        next.nextCheckAt = now() + FAILURE_BACKOFF_MS;
        if (request && next.requests?.[serverUrl]?.id === request.id) delete next.requests[serverUrl];
      });
      return 'continue';
    }
    const tx: RunnerUpdateTransaction = {
      id: crypto.randomUUID(), serverUrl, fromVersion: currentVersion, toVersion: refs.targetVersion, binaryPath, home, platform,
      ...(options.localAppData ? { localAppData: options.localAppData } : {}), serviceSpec: options.serviceSpec,
      installMarker: readInstallMarker(home, true)!,
      ownerPid: process.pid, startedAt: now(), ...(request ? { requestId: request.id } : {}), phase: 'waiting',
    };
    const guardian = runnerUpdateGuardianSpec(tx);
    withState(home, (next) => { if (next.transaction || next.guardian) throw new Error('runner update already in progress'); next.transaction = tx; next.guardian = guardian; if (request && next.requests?.[serverUrl]?.id === request.id) delete next.requests[serverUrl]; });
    try {
      const installed = (deps.installGuardian ?? ((spec, targetPlatform) => installService(spec, { platform: targetPlatform })))(guardian, platform);
      if (!installed.loaded || !installed.running) throw new Error(installed.detail ?? 'update guardian is not running');
      await deps.spawnHelper?.(guardian.binaryPath, statePath(home));
    }
    catch (error) {
      withState(home, (next) => { if (next.transaction?.id === tx.id) {
        delete next.transaction;
        next.cleanup = { failedVersion: tx.toVersion, currentVersion: tx.fromVersion, platform: tx.platform,
          ...(tx.localAppData ? { localAppData: tx.localAppData } : {}) };
      }
        (next.lastResults ??= {})[serverUrl] = { ...(request ? { requestId: request.id } : {}), fromVersion: currentVersion, toVersion: refs.targetVersion, result: 'failed', reason: `update guardian start failed: ${String(error)}`, at: now() }; });
      if (!cleanupGuardian()) return 'hold';
      return 'continue';
    }
    log(`runner update ${currentVersion} → ${refs.targetVersion} staged; handing service to the update helper`);
    return 'restart';
    } finally { operation.lock.release(); }
  };
  return { contactPayload, onContact, startup, acknowledgeHealthy, queueManual, check, idle };
}

export { readState as readRunnerUpdateState, statePath as runnerUpdateStatePath, withState as withRunnerUpdateState };
export type { RunnerUpdateState, RunnerUpdateTransaction };
