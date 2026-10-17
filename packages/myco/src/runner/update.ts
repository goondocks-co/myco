/** Runner-owned release checks and an idle-only, durable binary handoff. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import semver from 'semver';
import { isDevelopmentVersion } from '../../scripts/release-policy.mjs';
import { RELEASE_CHANNELS, type ReleaseChannel } from '../constants/update.js';
import { readInstallMarker, versionBinaryPath, versionsDir, type InstallMarker } from '../install/managed-binary.js';
import { acquireInstallationLease, recoverInterruptedBinaryPublication, assertSourceAdoptionAllowed, validateSourceIntent } from '../install/adoption.js';
import { validInstallMarker } from '../install/marker-reader.js';
import { placeExecutable, type ProgramProbe } from '../install/place-binary.js';
import { stageBinary, pruneVersions, DEFAULT_BINARY_UPDATE_DEPS, type StageBinaryDeps } from '../upgrade/apply-binary.js';
import { assetName, githubHeaders, mycoReleasesApiUrl, pickRelease, resolveAssetRefs, resolveTargetTriple, type AssetRefs, type GitHubRelease } from '../upgrade/release-assets.js';
import { installService, servicePathEnv, servicePaths, uninstallService, type ServiceOutcome, type ServiceSpec } from '../server/service.js';
import { LifecycleLock } from '../utils/lifecycle-lock.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { recordUpdateCheck } from '../upgrade/check-cache.js';
import { sanitizeRunnerUpdateReason, type RunnerUpdateResult as UpdateReceipt, type RunnerUpdateReport } from '@goondocks/myco-shared/runner-update';

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
const TX_DEADLINE_MS = 3 * 60 * 1000;
const GUARDIAN_RECOVERY_MS = 30_000;
const MAX_GUARDIAN_RECOVERIES = 2;
const BLOCK_EXPIRY_MS = 24 * 60 * 60 * 1000;
const MAX_VERSION_ATTEMPTS = 20;
const CANDIDATE_SLOT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type RunnerUpdateResult = UpdateReceipt['result'];
export type RunnerUpdateReceipt = UpdateReceipt;
export type RunnerUpdateContact = RunnerUpdateReport;
export interface RunnerUpdateSelection { channel?: ReleaseChannel; targetVersion?: string }
export interface RunnerLocalArtifactInput { binaryPath: string; version: string; checkout: string; commit: string }
export interface RunnerLocalCandidate extends RunnerLocalArtifactInput { kind: 'local'; sha256: string; slot: string; platform: NodeJS.Platform }
export interface RunnerUpdateRequest extends RunnerUpdateSelection { id: string; requestedAt: number; clearBlock?: boolean }
type QueuedRunnerUpdate = RunnerUpdateRequest & { manual?: true; localCandidate?: RunnerLocalCandidate };
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
  localCandidate?: RunnerLocalCandidate;
  ownerPid: number;
  startedAt: number;
  deadlineAt?: number;
  recoveryAt?: number;
  recoveryAttempts?: number;
  requestId?: string;
  attemptId?: string;
  startedPid?: number;
  contactAt?: number;
  firstClaimAt?: number;
  completedClaimAt?: number;
  startAttempts?: number;
  healthRefusal?: string;
  phase: 'waiting' | 'placing' | 'adopted' | 'healthy' | 'probation' | 'rollback';
  failureReason?: string;
  rollbackResult?: 'rolled_back' | 'failed';
}
interface RunnerUpdateState {
  version: 1;
  nextCheckAt: number;
  lastCheckAt: number | null;
  latestVersion: string | null;
  etag?: string;
  releaseChannel?: ReleaseChannel;
  retiredCandidates?: RunnerLocalCandidate[];
  runtimeCapabilities?: Record<string, { pid: number; lockStartedAt: number; localArtifacts: true }>;
  failures: number;
  failedVersions?: string[];
  blockedVersions?: Record<string, { until: number; reason: string }>;
  attempts?: Record<string, { id: string; failures: number; nextRetryAt: number }>;
  candidate?: { channel: ReleaseChannel; refs: AssetRefs };
  metadataFailure?: { at: number; reason: string };
  cleanupFailures?: number;
  nextCleanupAt?: number;
  cleanupReason?: string;
  requests?: Record<string, QueuedRunnerUpdate>;
  lastResults?: Record<string, RunnerUpdateReceipt>;
  transaction?: RunnerUpdateTransaction;
  guardian?: ServiceSpec;
  cleanup?: { failedVersion?: string; currentVersion: string; previousVersion?: string; platform: NodeJS.Platform; localAppData?: string;
    serverUrl?: string; fromVersion?: string; toVersion?: string; attemptId?: string; localCandidate?: RunnerLocalCandidate };
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
  prune?: typeof pruneVersions;
  statePublisher?: typeof atomicWriteFileSync;
}

function statePath(home: string): string { return path.join(home, 'runner', UPDATE_FILE); }
function freshState(): RunnerUpdateState {
  return { version: 1, nextCheckAt: 0, lastCheckAt: null, latestVersion: null, failures: 0 };
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const entriesMatch = (value: unknown, valid: (entry: Record<string, unknown>) => boolean): boolean =>
  record(value) && Object.values(value).every(entry => record(entry) && valid(entry));
function localCandidatePath(home: string, candidate: RunnerLocalCandidate, platform: NodeJS.Platform): string {
  return path.join(home, 'runner', 'candidates', candidate.slot, platform === 'win32' ? 'myco.exe' : 'myco');
}
function validLocalCandidate(value: unknown, home: string, platform: NodeJS.Platform): value is RunnerLocalCandidate {
  if (!record(value) || value.kind !== 'local' || !['darwin', 'linux', 'win32'].includes(platform) || value.platform !== platform || typeof value.version !== 'string' || !semver.valid(value.version)
    || typeof value.checkout !== 'string' || typeof value.commit !== 'string'
    || typeof value.sha256 !== 'string' || value.sha256.length !== 64 || !/^[a-f0-9]{64}$/.test(value.sha256)
    || typeof value.slot !== 'string' || CANDIDATE_SLOT.exec(value.slot)?.[0] !== value.slot) return false;
  try { validateSourceIntent(value.checkout, value.commit, value.version); } catch { return false; }
  return value.binaryPath === localCandidatePath(home, value as unknown as RunnerLocalCandidate, platform);
}
function retireCandidate(state: RunnerUpdateState, candidate: RunnerLocalCandidate): void {
  if (!state.retiredCandidates?.some(retired => retired.slot === candidate.slot)) (state.retiredCandidates ??= []).push(candidate);
}
function endRequest(state: RunnerUpdateState, url: string, id?: string): void {
  const request = state.requests?.[url];
  if (request === undefined || (id !== undefined && request.id !== id)) return;
  if (request.localCandidate) retireCandidate(state, request.localCandidate);
  delete state.requests![url];
}
function removeLocalCandidate(home: string, state: RunnerUpdateState, candidate: RunnerLocalCandidate, owner: 'retired' | 'cleanup'): void {
  if (!validLocalCandidate(candidate, home, candidate.platform)) throw new Error('invalid runner local candidate path');
  if (state.transaction?.localCandidate?.slot === candidate.slot
    || Object.values(state.requests ?? {}).some(request => request.localCandidate?.slot === candidate.slot)
    || (owner !== 'cleanup' && state.cleanup?.localCandidate?.slot === candidate.slot)) {
    throw new Error('retired runner candidate is still in use');
  }
  fs.rmSync(path.dirname(localCandidatePath(home, candidate, candidate.platform)), { recursive: true, force: true });
}
function sweepLocalCandidates(home: string): void {
  const held = LifecycleLock.acquire(path.join(home, 'runner', UPDATE_OPERATION_LOCK), { command: 'myco runner candidate cleanup' });
  if (!held.acquired) return;
  try {
    const state = decodeState(home);
    if (state.metadataFailure) throw new Error('runner update metadata requires recovery before candidate cleanup');
    const referenced = new Set([
      ...Object.values(state.requests ?? {}).flatMap(request => request.localCandidate ? [request.localCandidate.slot] : []),
      ...(state.transaction?.localCandidate ? [state.transaction.localCandidate.slot] : []),
      ...(state.cleanup?.localCandidate ? [state.cleanup.localCandidate.slot] : []),
      ...(state.retiredCandidates ?? []).map(candidate => candidate.slot),
    ]);
    const root = path.join(home, 'runner', 'candidates');
    if (!fs.existsSync(root)) return;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || CANDIDATE_SLOT.exec(entry.name)?.[0] !== entry.name || referenced.has(entry.name)) continue;
      fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
    }
  } finally { held.lock.release(); }
}
export function probeRunnerLocalCandidate(candidate: RunnerLocalCandidate, file: string, probe: () => ProgramProbe): ProgramProbe {
  assertRunnerLocalCandidate(candidate, file);
  const ready = probe();
  if (ready.runs) assertRunnerLocalCandidate(candidate, file);
  return ready;
}
export function assertRunnerLocalCandidate(candidate: RunnerLocalCandidate, file = candidate.binaryPath): void {
  if (crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== candidate.sha256) {
    throw new Error('queued local runner candidate digest changed');
  }
}
function decodeState(home: string): RunnerUpdateState {
  const file = statePath(home);
  if (!fs.existsSync(file)) {
    const directory = path.dirname(file);
    if (fs.existsSync(directory) && fs.readdirSync(directory).some(name => name.startsWith(`${UPDATE_FILE}.quarantine-`))) {
      throw new Error(`Runner update metadata recovery is incomplete at ${file}`);
    }
    return freshState();
  }
  const state = JSON.parse(fs.readFileSync(file, 'utf8')) as RunnerUpdateState;
  const tx = state?.transaction;
  const guardian = state?.guardian;
  const cleanup = state?.cleanup;
  const expectedLabel = runnerUpdateGuardianLabel(home);
  const expectedUnit = `myco-runner-update-${expectedLabel.slice(-16)}`;
  if (state?.version !== 1 || !Number.isFinite(state.nextCheckAt) || !Number.isFinite(state.failures)
    || !(state.lastCheckAt === null || Number.isFinite(state.lastCheckAt))
    || !(state.latestVersion === null || typeof state.latestVersion === 'string')
    || (state.etag !== undefined && typeof state.etag !== 'string')
    || (state.releaseChannel !== undefined && !RELEASE_CHANNELS.includes(state.releaseChannel))
    || (state.retiredCandidates !== undefined && (!Array.isArray(state.retiredCandidates)
      || state.retiredCandidates.some(candidate => !validLocalCandidate(candidate, home, candidate?.platform))))
    || (state.runtimeCapabilities !== undefined && !entriesMatch(state.runtimeCapabilities, entry =>
      Number.isSafeInteger(entry.pid) && typeof entry.pid === 'number' && entry.pid > 0
      && finite(entry.lockStartedAt) && entry.lockStartedAt > 0 && entry.localArtifacts === true))
    || (state.attempts !== undefined && !entriesMatch(state.attempts, entry => typeof entry.id === 'string' && finite(entry.failures) && finite(entry.nextRetryAt)))
    || (state.blockedVersions !== undefined && !entriesMatch(state.blockedVersions, entry => finite(entry.until) && typeof entry.reason === 'string'))
    || (state.cleanupFailures !== undefined && !finite(state.cleanupFailures))
    || (state.nextCleanupAt !== undefined && !finite(state.nextCleanupAt))
    || (state.cleanupReason !== undefined && typeof state.cleanupReason !== 'string')
    || (state.metadataFailure !== undefined && (!record(state.metadataFailure) || !finite(state.metadataFailure.at) || typeof state.metadataFailure.reason !== 'string'))
    || (state.candidate !== undefined && (!record(state.candidate) || !RELEASE_CHANNELS.includes(state.candidate.channel)
      || !record(state.candidate.refs) || typeof state.candidate.refs.targetVersion !== 'string'
      || typeof state.candidate.refs.assetUrl !== 'string' || typeof state.candidate.refs.sha256sumsUrl !== 'string'
      || typeof state.candidate.refs.assetName !== 'string'))
    || (tx !== undefined && (typeof tx.id !== 'string' || typeof tx.serverUrl !== 'string' ||
      typeof tx.fromVersion !== 'string' || typeof tx.toVersion !== 'string' ||
      typeof tx.binaryPath !== 'string' || !path.isAbsolute(tx.binaryPath) ||
      typeof tx.home !== 'string' || path.resolve(tx.home) !== path.resolve(home) ||
      !['waiting', 'placing', 'adopted', 'healthy', 'probation', 'rollback'].includes(tx.phase) || !Number.isSafeInteger(tx.ownerPid) || tx.ownerPid < 1 ||
      !Number.isFinite(tx.startedAt) || tx.serviceSpec?.binaryPath !== tx.binaryPath ||
      !validInstallMarker(tx.installMarker)
      || (tx.localCandidate !== undefined && (!validLocalCandidate(tx.localCandidate, home, tx.platform) || tx.localCandidate.version !== tx.toVersion)))) ||
    (cleanup !== undefined && ((cleanup.failedVersion !== undefined && !semver.valid(cleanup.failedVersion)) || !semver.valid(cleanup.currentVersion)
      || cleanup.failedVersion === cleanup.currentVersion || typeof cleanup.platform !== 'string'
      || (cleanup.localAppData !== undefined && typeof cleanup.localAppData !== 'string')
      || (cleanup.previousVersion !== undefined && !semver.valid(cleanup.previousVersion))
      || (cleanup.localCandidate !== undefined && !validLocalCandidate(cleanup.localCandidate, home, cleanup.platform)))) ||
    (guardian !== undefined && (guardian.unit?.label !== expectedLabel || guardian.unit?.unitName !== expectedUnit ||
      guardian.unit?.args?.[0] !== 'runner' || guardian.unit?.args?.[1] !== '__apply-update' ||
      guardian.unit?.args?.[2] !== file || guardian.unit.args.length !== 3 ||
      guardian.binaryPath !== runnerUpdateGuardianBinary(home, tx?.platform ?? cleanup?.platform ?? process.platform)))
    || (state.requests !== undefined && (typeof state.requests !== 'object' || state.requests === null || Object.values(state.requests).some(request =>
      typeof request?.id !== 'string' || !Number.isFinite(request.requestedAt)
      || (request.channel !== undefined && !RELEASE_CHANNELS.includes(request.channel))
      || (request.targetVersion !== undefined && !semver.valid(request.targetVersion))
      || (request.localCandidate !== undefined && (request.manual !== true || !validLocalCandidate(request.localCandidate, home, request.localCandidate.platform))))))
    || (state.lastResults !== undefined && (typeof state.lastResults !== 'object' || state.lastResults === null || Object.values(state.lastResults).some(result =>
      typeof result?.fromVersion !== 'string' || typeof result.toVersion !== 'string' || !Number.isFinite(result.at)
      || !['updated', 'no_update', 'refused', 'rolled_back', 'failed'].includes(result.result)
      || (result.reason !== undefined && typeof result.reason !== 'string'))))) {
    throw new Error(`Invalid runner update record at ${file}`);
  }
  return state;
}
function recoverState(home: string): RunnerUpdateState {
  try { return decodeState(home); }
  catch (error) {
    const reason = sanitizeRunnerUpdateReason(`runner update metadata is unreadable: ${String(error)}`);
    const file = statePath(home);
    try { fs.renameSync(file, `${file}.quarantine-${Date.now()}-${crypto.randomUUID()}`); }
    catch (quarantineError) { console.warn(`runner update metadata quarantine failed: ${sanitizeRunnerUpdateReason(String(quarantineError))}`); }
    console.warn(reason);
    return { ...freshState(), nextCheckAt: Date.now() + FAILURE_BACKOFF_MS, metadataFailure: { at: Date.now(), reason } };
  }
}
function readState(home: string): RunnerUpdateState {
  try { return decodeState(home); }
  catch { return withState(home, state => state); }
}
function writeState(home: string, state: RunnerUpdateState, publisher = atomicWriteFileSync): void {
  const file = statePath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (const result of Object.values(state.lastResults ?? {})) if (result.reason !== undefined) result.reason = sanitizeRunnerUpdateReason(result.reason);
  if (state.transaction?.failureReason !== undefined) state.transaction.failureReason = sanitizeRunnerUpdateReason(state.transaction.failureReason);
  publisher(file, `${JSON.stringify(state)}\n`, { mode: 0o600, durable: true });
}
function withState<T>(home: string, change: (state: RunnerUpdateState) => T, publisher = atomicWriteFileSync): T {
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
    const state = recoverState(home);
    const result = change(state);
    writeState(home, state, publisher);
    return result;
  } finally { held.lock.release(); }
}

/** Candidate admission requires a valid signature; ad hoc signatures are accepted. */
export function strictRunnerReleaseProbe(file: string, version: string, platform: NodeJS.Platform): ProgramProbe {
  if (platform === 'darwin') {
    const signed = spawnSync('codesign', ['--verify', '--strict', file], { cwd: path.dirname(file), encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
    if (signed.status !== 0) return { runs: false, detail: `macOS code signature verification failed: ${signed.error?.message ?? signed.stderr?.trim() ?? signed.status}` };
  }
  return runnerCurrentReleaseProbe(file, version, platform);
}

/** A trusted current executable is launch-probed without requiring a new signature. */
export function runnerCurrentReleaseProbe(file: string, version: string, _platform: NodeJS.Platform): ProgramProbe {
  const ran = spawnSync(file, ['--version'], { cwd: path.dirname(file), encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  if (ran.status !== 0) return { runs: false, detail: `version probe failed: ${ran.error?.message ?? ran.stderr?.trim() ?? ran.status}` };
  const actual = ran.stdout.trim();
  return actual === version ? { runs: true } : { runs: false, detail: `version probe answered ${JSON.stringify(actual)}; expected ${version}` };
}

export function blockRunnerUpdateVersion(state: RunnerUpdateState, version: string, reason: string, now: number): void {
  (state.blockedVersions ??= {})[version] = { until: now + BLOCK_EXPIRY_MS, reason: sanitizeRunnerUpdateReason(reason) };
  state.blockedVersions = Object.fromEntries(Object.entries(state.blockedVersions).filter(([, value]) => value.until > now).slice(-MAX_VERSION_ATTEMPTS));
}

async function releases(channel: ReleaseChannel, currentVersion: string, etag: string | undefined, deps: RunnerUpdateDeps, targetVersion?: string): Promise<{ refs: AssetRefs | null; etag?: string; unchanged: boolean }> {
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
      const eligible = targetVersion === undefined ? all : all.filter(release => release.tag_name === `myco/v${targetVersion}`);
      const release = pickRelease(eligible, channel, { asset: assetName(triple), currentVersion, minimumMajor: 2 });
      return { refs: release === null ? null : resolveAssetRefs(release, triple), etag: firstEtag, unchanged: false };
    }
  }
  throw new Error(`GitHub release discovery exceeded ${MAX_RELEASE_PAGES} pages`);
}

/** One per-home OS unit runs a bounded handoff from a verified executable. */
export function runnerUpdateGuardianLabel(home: string): string {
  return `co.goondocks.myco-runner-update.${crypto.createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 16)}`;
}
export function runnerUpdateGuardianSpec(tx: RunnerUpdateTransaction): ServiceSpec {
  const id = crypto.createHash('sha256').update(path.resolve(tx.home)).digest('hex').slice(0, 16);
  const binaryPath = runnerUpdateGuardianBinary(tx.home, tx.platform);
  return {
    unit: {
      label: runnerUpdateGuardianLabel(tx.home),
      unitName: `myco-runner-update-${id}`,
      description: 'Myco runner update guardian',
      args: ['runner', '__apply-update', statePath(tx.home)],
      logName: `runner-update-${id}`,
      restartDelaySeconds: 60,
      restart: 'never',
    },
    binaryPath,
    home: tx.serviceSpec.home,
    pathEnv: servicePathEnv(binaryPath, tx.serviceSpec.home, tx.platform),
    logDir: path.join(tx.home, 'logs'),
    env: { MYCO_HOME: tx.home },
  };
}

function runnerUpdateGuardianBinary(home: string, platform: NodeJS.Platform): string {
  return path.join(home, 'runner', 'guardian', platform === 'win32' ? 'myco.exe' : 'myco');
}

/** Guardian removal precedes deletion of the verified but failed release slot. */
export function cleanupRunnerUpdateGuardian(home: string, platform: NodeJS.Platform, deps: {
  removeGuardian?: (spec: ServiceSpec, platform: NodeJS.Platform) => void;
  prune?: typeof pruneVersions;
} = {}): 'complete' | 'deferred' {
  const held = LifecycleLock.acquire(path.join(home, 'runner', UPDATE_CLEANUP_LOCK), { command: 'myco runner update cleanup' });
  if (!held.acquired) return 'deferred';
  try {
  let state = decodeState(home);
  if (state.metadataFailure) return 'deferred';
  if (state.transaction !== undefined) return 'deferred';
  const hasGuardianWork = state.guardian !== undefined || state.cleanup !== undefined;
  if (state.guardian !== undefined) {
    if (state.guardian.unit.label !== runnerUpdateGuardianLabel(home)) throw new Error('runner update guardian belongs to another home');
    (deps.removeGuardian ?? ((spec, targetPlatform) => { uninstallService(spec, { platform: targetPlatform }); }))(state.guardian, platform);
    withState(home, next => { if (next.transaction === undefined) delete next.guardian; });
    state = decodeState(home);
  }
  for (const retired of state.retiredCandidates ?? []) {
    withState(home, next => {
      removeLocalCandidate(home, next, retired, 'retired');
      next.retiredCandidates = next.retiredCandidates?.filter(candidate => candidate.slot !== retired.slot);
      if (next.retiredCandidates?.length === 0) delete next.retiredCandidates;
    });
  }
  sweepLocalCandidates(home);
  if (!hasGuardianWork) return 'complete';
  const cleanup = state.cleanup;
  fs.rmSync(runnerUpdateGuardianBinary(home, platform), { force: true });
  if (cleanup === undefined) return 'complete';
  if (state.guardian !== undefined) return 'deferred';
  const root = versionsDir(home, cleanup.platform, cleanup.localAppData);
  let failedDir: string | undefined;
  if (cleanup.failedVersion !== undefined) {
    failedDir = path.dirname(versionBinaryPath(home, cleanup.platform, cleanup.failedVersion, cleanup.localAppData));
    if (path.dirname(failedDir) !== root || path.basename(failedDir) !== cleanup.failedVersion) throw new Error('invalid runner update cleanup slot');
    fs.rmSync(failedDir, { recursive: true, force: true });
  }
  if (cleanup.localCandidate) removeLocalCandidate(home, decodeState(home), cleanup.localCandidate, 'cleanup');
  (deps.prune ?? pruneVersions)(home, cleanup.platform, 2, cleanup.currentVersion, cleanup.previousVersion, cleanup.localAppData);
  const retained = fs.existsSync(root) ? fs.readdirSync(root).filter(version =>
    semver.valid(version) !== null && fs.statSync(path.join(root, version)).isDirectory()) : [];
  if ((failedDir !== undefined && fs.existsSync(failedDir)) || retained.length > 2) throw new Error('runner update version cleanup is incomplete');
  withState(home, next => { if (next.transaction === undefined && next.guardian === undefined) { delete next.cleanup; delete next.cleanupReason; delete next.nextCleanupAt; next.cleanupFailures = 0; } });
  return 'complete';
  } finally { held.lock.release(); }
}

export interface RunnerUpdateController {
  contactPayload(): RunnerUpdateContact;
  onContact(body: Record<string, unknown>): void;
  /** Called after this version starts; health is acknowledged only by authenticated contact. */
  startup(): void;
  acknowledgeHealthy(): void;
  recordClaim(completed?: boolean): void;
  recordHealthRefusal(reason: string): void;
  recordRuntimeCapability(holder: { pid: number; startedAt: number }): void;
  queueManual(selection?: RunnerUpdateSelection): void;
  queueLocal(input: RunnerLocalArtifactInput): void;
  check(selection?: RunnerUpdateSelection): Promise<RunnerUpdateContact>;
  /** Called only between runs; the from-version program holds claims for its bounded handoff. */
  idle(): Promise<'continue' | 'restart' | 'hold'>;
}

export function createRunnerUpdateController(options: RunnerUpdateOptions): RunnerUpdateController {
  const { home, serverUrl, binaryPath, currentVersion, log } = options;
  if (path.resolve(binaryPath) !== path.resolve(options.serviceSpec.binaryPath)) throw new Error('runner update binary does not match service binary');
  const platform = options.platform ?? process.platform;
  const deps = options.deps ?? {};
  const changeState = <T>(change: (state: RunnerUpdateState) => T): T => withState(home, change, deps.statePublisher);
  const now = deps.now ?? Date.now;
  const jitter = (): number => CHECK_MIN_MS + Math.floor((deps.random ?? Math.random)() * CHECK_JITTER_MS);
  const backoff = (failures: number): number => Math.min(MAX_FAILURE_BACKOFF_MS, FAILURE_BACKOFF_MS * 2 ** Math.min(Math.max(failures - 1, 0), 5));
  let fault: RunnerUpdateReceipt | undefined;
  let reportedMetadataAt: number | undefined;
  const channel = (explicit = false): ReleaseChannel | null => {
    try {
      const marker = readInstallMarker(home, true);
      if (marker === null || !RELEASE_CHANNELS.includes(marker.channel) || !semver.valid(currentVersion)
        || (!explicit && (marker.source === 'checkout' || semver.major(currentVersion) < 2))) return null;
      return marker.channel;
    } catch (error) { log('runner update channel unavailable: ' + sanitizeRunnerUpdateReason(String(error))); return null; }
  };
  const read = (): RunnerUpdateState => {
    const state = readState(home);
    if (state.metadataFailure && reportedMetadataAt !== state.metadataFailure.at) {
      log(state.metadataFailure.reason);
      reportedMetadataAt = state.metadataFailure.at;
    }
    return state;
  };
  const fail = (error: unknown): void => {
    const reason = sanitizeRunnerUpdateReason('runner update failed: ' + String(error));
    fault = { fromVersion: currentVersion, toVersion: currentVersion, result: 'failed', reason, at: now() };
    log(reason);
    try { changeState(state => { (state.lastResults ??= {})[serverUrl] = fault!; state.nextCheckAt = now() + FAILURE_BACKOFF_MS; }); fault = undefined; }
    catch (writeError) { log('runner update failure could not be persisted: ' + sanitizeRunnerUpdateReason(String(writeError))); }
  };
  const guard = <A extends unknown[], R>(operation: (...args: A) => R, fallback: () => R): ((...args: A) => R) =>
    (...args) => {
      try {
        const result = operation(...args);
        if (result instanceof Promise) return result.catch((error: unknown) => { fail(error); return fallback(); }) as R;
        return result;
      } catch (error) { fail(error); return fallback(); }
    };
  const report = (state: RunnerUpdateState, result: RunnerUpdateResult, toVersion: string, reason?: string, request?: RunnerUpdateRequest, attemptId?: string): void => {
    (state.lastResults ??= {})[serverUrl] = {
      fromVersion: currentVersion, toVersion, result, at: now(),
      ...(reason === undefined ? {} : { reason: sanitizeRunnerUpdateReason(reason) }),
      ...(request === undefined ? {} : { requestId: request.id }), ...(attemptId === undefined ? {} : { attemptId }),
    };
    if (request) endRequest(state, serverUrl, request.id);
  };
  const payload = (state: RunnerUpdateState): RunnerUpdateContact => {
    const blocked = state.latestVersion === null ? undefined : state.blockedVersions?.[state.latestVersion];
    if (fault && (state.lastResults?.[serverUrl]?.at ?? -1) >= fault.at) fault = undefined;
    const result = fault ?? state.lastResults?.[serverUrl] ?? (state.metadataFailure ? {
      fromVersion: currentVersion, toVersion: currentVersion, result: 'failed' as const, reason: state.metadataFailure.reason, at: state.metadataFailure.at,
    } : undefined);
    const tx = state.transaction;
    const updateState: RunnerUpdateContact['updateState'] = tx ? {
      phase: tx.phase === 'probation' || tx.phase === 'healthy' ? 'probation' : 'updating', since: tx.startedAt,
      ...(tx.phase === 'waiting' ? { reason: 'Waiting for the bounded service handoff' } : {}),
    } : state.cleanupReason ? { phase: 'cleanup_pending', since: result?.at ?? now(), reason: state.cleanupReason } : undefined;
    return { channel: channel(), currentVersion, latestVersion: state.latestVersion, lastCheckAt: state.lastCheckAt,
      ...(result === undefined ? {} : { lastResult: { ...result, ...(result.reason === undefined ? {} : { reason: sanitizeRunnerUpdateReason(result.reason) }) } }),
      ...(blocked && blocked.until > now() ? { blockedVersion: { version: state.latestVersion!, ...blocked } } : {}),
      ...(updateState === undefined ? {} : { updateState }),
    };
  };
  const contactPayload = (): RunnerUpdateContact => payload(read());
  const cleanupGuardian = (installationHeld = false): boolean => {
    const installation = installationHeld ? null : acquireInstallationLease(home, { command: 'myco runner update cleanup' });
    if (installation?.acquired === false) return false;
    try {
    const state = read();
    const candidateRoot = path.join(home, 'runner', 'candidates');
    const hasSlots = fs.existsSync(candidateRoot) && fs.readdirSync(candidateRoot).length > 0;
    if (state.guardian === undefined && state.cleanup === undefined && !state.retiredCandidates?.length && !hasSlots) return true;
    if (state.transaction !== undefined || now() < (state.nextCleanupAt ?? 0)) return false;
    try {
      return cleanupRunnerUpdateGuardian(home, platform, { removeGuardian: deps.removeGuardian, prune: deps.prune }) === 'complete';
    } catch (error) {
      const reason = sanitizeRunnerUpdateReason('runner update cleanup failed: ' + String(error));
      log(reason);
      changeState(next => {
        next.cleanupFailures = (next.cleanupFailures ?? 0) + 1;
        next.nextCleanupAt = now() + backoff(next.cleanupFailures);
        next.cleanupReason = reason;
        const cleanup = next.cleanup;
        const targetUrl = cleanup?.serverUrl ?? serverUrl;
        (next.lastResults ??= {})[targetUrl] = { fromVersion: cleanup?.fromVersion ?? currentVersion,
          toVersion: cleanup?.toVersion ?? currentVersion, result: 'failed', reason, at: now(),
          ...(cleanup?.attemptId ? { attemptId: cleanup.attemptId } : {}) };
      });
      return false;
    }
    } finally { if (installation?.acquired) installation.release(); }
  };
  const clearBlocks = (state: RunnerUpdateState): void => {
    delete state.blockedVersions;
    delete state.failedVersions;
    delete state.attempts;
  };
  const ownsTransaction = (tx: RunnerUpdateTransaction | undefined): tx is RunnerUpdateTransaction =>
    tx !== undefined && tx.serverUrl === serverUrl && tx.toVersion === currentVersion && tx.binaryPath === binaryPath;
  const schedule = (state: RunnerUpdateState, at: number, request?: RunnerUpdateRequest): void => {
    const pending = state.requests?.[serverUrl];
    state.nextCheckAt = pending && pending.id !== request?.id ? 0 : at;
  };
  const onContact = (body: Record<string, unknown>): void => {
    const raw = body.updateRequest;
    if (raw === undefined) return;
    if (raw === null) { changeState(state => { if (state.requests?.[serverUrl]?.manual !== true) endRequest(state, serverUrl); }); return; }
    if (typeof raw !== 'object' || typeof (raw as RunnerUpdateRequest).id !== 'string' || !Number.isFinite((raw as RunnerUpdateRequest).requestedAt)) throw new Error('Deployment sent an invalid runner update request');
    const sent = raw as RunnerUpdateRequest;
    const request: RunnerUpdateRequest = { id: sent.id, requestedAt: sent.requestedAt,
      ...(sent.channel === undefined ? {} : { channel: sent.channel }),
      ...(sent.targetVersion === undefined ? {} : { targetVersion: sent.targetVersion }),
      ...(sent.clearBlock === undefined ? {} : { clearBlock: sent.clearBlock }) };
    changeState(state => {
      if (state.lastResults?.[serverUrl]?.requestId === request.id || (state.transaction?.serverUrl === serverUrl && state.transaction.requestId === request.id)) return;
      const queued = state.requests?.[serverUrl];
      if (queued?.id === request.id) return;
      if (queued?.manual !== true && (queued === undefined || queued.requestedAt <= request.requestedAt)) {
        endRequest(state, serverUrl);
        (state.requests ??= {})[serverUrl] = request;
        state.nextCheckAt = 0;
      }
    });
  };
  const startup = (): void => {
    read();
    changeState(state => {
      const tx = state.transaction;
      if (ownsTransaction(tx)) {
        if (tx.startedPid !== process.pid) tx.startAttempts = (tx.startAttempts ?? 0) + 1;
        tx.startedPid = process.pid;
        if ((tx.startAttempts ?? 0) > 2 && tx.completedClaimAt === undefined) tx.healthRefusal = 'updated runner repeatedly restarted before completing a claim';
      }
    });
    cleanupGuardian();
  };
  const acknowledgeHealthy = (): void => {
    changeState(state => {
      const tx = state.transaction;
      if (ownsTransaction(tx) && ['adopted', 'probation', 'healthy'].includes(tx.phase)) {
        tx.phase = 'probation'; tx.startedPid = process.pid; tx.contactAt ??= now();
      }
    });
  };
  const recordClaim = (completed = false): void => {
    changeState(state => {
      const tx = state.transaction;
      if (ownsTransaction(tx)) {
        tx.firstClaimAt ??= now();
        if (completed) tx.completedClaimAt = now();
      }
    });
  };
  const recordHealthRefusal = (reason: string): void => {
    changeState(state => { const tx = state.transaction;
      if (ownsTransaction(tx)) tx.healthRefusal = sanitizeRunnerUpdateReason(reason);
    });
  };
  const recordRuntimeCapability = (holder: { pid: number; startedAt: number }): void => {
    if (holder.pid !== process.pid || !finite(holder.startedAt) || holder.startedAt <= 0) {
      throw new Error('runner update capability requires this process to hold the runner instance lock');
    }
    const previous = read().runtimeCapabilities?.[serverUrl];
    if (previous?.pid === holder.pid && previous.lockStartedAt === holder.startedAt) return;
    changeState(state => {
      (state.runtimeCapabilities ??= {})[serverUrl] = { pid: holder.pid, lockStartedAt: holder.startedAt, localArtifacts: true };
    });
  };
  const queueManual = (selection: RunnerUpdateSelection = {}): void => {
    changeState(state => {
      endRequest(state, serverUrl);
      (state.requests ??= {})[serverUrl] = { id: crypto.randomUUID(), requestedAt: now(), manual: true, clearBlock: true, ...selection };
      state.nextCheckAt = 0;
    });
  };
  const queueLocal = (input: RunnerLocalArtifactInput): void => {
    validateSourceIntent(input.checkout, input.commit, input.version);
    const installation = acquireInstallationLease(home, { command: 'myco runner local update' });
    if (!installation.acquired) throw new Error('Myco is already updating on this machine. Try again when it finishes.');
    try {
    const admitted = decodeState(home);
    if (admitted.metadataFailure) throw new Error('runner update metadata requires recovery before binary adoption');
    recoverInterruptedBinaryPublication(home, binaryPath, platform);
    assertSourceAdoptionAllowed(home, binaryPath);
    const held = LifecycleLock.acquire(path.join(home, 'runner', UPDATE_OPERATION_LOCK), { command: 'myco runner local update' });
    if (!held.acquired) throw new Error('Another runner update is in progress. Try again when it finishes.');
    try {
      const state = decodeState(home);
      if (state.transaction || state.guardian || state.cleanup) throw new Error('runner update already in progress');
      if (input.version === currentVersion) throw new Error('This build is already installed. Build Myco again before installing another source build.');
      const probe = deps.probe ?? strictRunnerReleaseProbe;
      const ready = probe(input.binaryPath, input.version, platform);
      if (!ready.runs) throw new Error(ready.detail);
      const candidate: RunnerLocalCandidate = { ...input, kind: 'local', platform, slot: crypto.randomUUID(),
        sha256: crypto.createHash('sha256').update(fs.readFileSync(input.binaryPath)).digest('hex') };
      candidate.binaryPath = localCandidatePath(home, candidate, platform);
      fs.mkdirSync(path.dirname(candidate.binaryPath), { recursive: true, mode: 0o700 });
      placeExecutable(input.binaryPath, candidate.binaryPath, { platform,
        ready: file => probeRunnerLocalCandidate(candidate, file, () => probe(file, input.version, platform)),
      });
      changeState(next => {
        if (next.transaction || next.guardian || next.cleanup || next.metadataFailure) throw new Error('runner update already in progress');
        if (next.requests?.[serverUrl]?.id !== state.requests?.[serverUrl]?.id) {
          throw new Error('Another update was requested while preparing this build. Retry if you still want to install it.');
        }
        endRequest(next, serverUrl);
        (next.requests ??= {})[serverUrl] = { id: crypto.randomUUID(), requestedAt: now(), manual: true,
          clearBlock: true, targetVersion: candidate.version, localCandidate: candidate };
        next.nextCheckAt = 0;
      });
    } finally { held.lock.release(); }
    } finally { installation.release(); }
  };
  const check = async (selection: RunnerUpdateSelection = {}): Promise<RunnerUpdateContact> => {
    const releaseChannel = selection.channel ?? channel(true);
    if (releaseChannel === null) return contactPayload();
    const checked = await releases(releaseChannel, currentVersion, undefined, deps, selection.targetVersion);
    return { ...contactPayload(), channel: releaseChannel, latestVersion: checked.refs?.targetVersion ?? null, lastCheckAt: now() };
  };
  const abandon = (tx: RunnerUpdateTransaction, reason: string, retainedVersion = tx.fromVersion): boolean => {
    if (tx.phase !== 'waiting') return false;
    const installation = acquireInstallationLease(home, { command: 'myco runner cancel unplaced update' });
    if (!installation.acquired) return false;
    let abandoned = false;
    try {
      const observed = decodeState(home).transaction;
      if (observed?.id !== tx.id || observed.phase !== 'waiting') return false;
      if (!runnerCurrentReleaseProbe(binaryPath, retainedVersion, platform).runs) return false;
      abandoned = changeState(state => {
        if (state.transaction?.id !== tx.id || state.transaction.phase !== 'waiting') return false;
        (state.lastResults ??= {})[tx.serverUrl] = { fromVersion: tx.fromVersion, toVersion: tx.toVersion, result: 'failed', reason,
          at: now(), ...(tx.requestId ? { requestId: tx.requestId } : {}), ...(tx.attemptId ? { attemptId: tx.attemptId } : {}) };
        if (retainedVersion === tx.fromVersion) blockRunnerUpdateVersion(state, tx.toVersion, reason, now());
        state.cleanup = { failedVersion: tx.toVersion, currentVersion: retainedVersion, platform: tx.platform,
          ...(retainedVersion === tx.fromVersion ? {} : { previousVersion: tx.fromVersion }),
          serverUrl: tx.serverUrl, fromVersion: tx.fromVersion, toVersion: tx.toVersion, attemptId: tx.attemptId,
          ...(tx.localCandidate ? { localCandidate: tx.localCandidate } : {}),
          ...(tx.localAppData ? { localAppData: tx.localAppData } : {}) };
        delete state.transaction;
        return true;
      });
    } finally { installation.release(); }
    if (abandoned) cleanupGuardian();
    return abandoned;
  };
  const recoverGuardian = (tx: RunnerUpdateTransaction): void => {
    if (now() - (tx.recoveryAt ?? tx.startedAt) < GUARDIAN_RECOVERY_MS) return;
    if ((tx.recoveryAttempts ?? 0) >= MAX_GUARDIAN_RECOVERIES) return;
    changeState(state => { if (state.transaction?.id === tx.id) { state.transaction.recoveryAt = now(); state.transaction.recoveryAttempts = (state.transaction.recoveryAttempts ?? 0) + 1; } });
    try {
      const guardian = read().guardian;
      if (!guardian) throw new Error('update guardian is absent');
      const outcome = (deps.installGuardian ?? ((spec, targetPlatform) => installService(spec, { platform: targetPlatform, keepRunning: true })))(guardian, platform);
      if (!outcome.loaded || !outcome.running) throw new Error(outcome.detail ?? 'update guardian is not running');
    } catch (error) { log('runner update watcher recovery failed: ' + sanitizeRunnerUpdateReason(String(error))); }
  };
  const idle = async (): Promise<'continue' | 'restart' | 'hold'> => {
    const state = decodeState(home);
    if (state.metadataFailure) return 'continue';
    if (state.transaction) {
      const tx = state.transaction;
      if (tx.binaryPath !== binaryPath) return 'continue';
      if (!semver.valid(currentVersion)) return 'continue';
      if (currentVersion !== tx.fromVersion && currentVersion !== tx.toVersion) {
        if (!abandon(tx, 'runner update handoff superseded by installed version ' + currentVersion, currentVersion)) recoverGuardian(tx);
        return 'continue';
      }
      if (currentVersion === tx.fromVersion && (now() >= (tx.deadlineAt ?? tx.startedAt + TX_DEADLINE_MS)
        || (tx.recoveryAttempts ?? 0) >= MAX_GUARDIAN_RECOVERIES)) {
        if (abandon(tx, 'runner update handoff exceeded its bounded deadline')) return 'continue';
      }
      recoverGuardian(tx);
      return currentVersion === tx.toVersion ? 'continue' : 'hold';
    }
    const installation = acquireInstallationLease(home, { command: 'myco runner update installation' });
    if (!installation.acquired) return 'continue';
    let installationReleased = false;
    try {
    const admitted = decodeState(home);
    if (admitted.transaction || admitted.metadataFailure) return 'continue';
    recoverInterruptedBinaryPublication(home, binaryPath, platform);
    if (!cleanupGuardian(true)) return 'continue';
    const request = state.requests?.[serverUrl];
    if (now() < state.nextCheckAt) return 'continue';
    const recordedChannel = channel();
    const localCandidate = request?.localCandidate;
    if (request?.manual !== true && (readInstallMarker(home, true)?.source === 'checkout' || isDevelopmentVersion(currentVersion))) {
      changeState(next => { schedule(next, now() + jitter(), request); if (request) report(next, 'refused', currentVersion,
        'automatic updates skipped: this is a source build', request); });
      return 'continue';
    }
    const releaseChannel = request?.channel ?? channel(request?.manual === true);
    const recordsAutomaticCandidate = request?.targetVersion === undefined && releaseChannel === recordedChannel;
    const installed = releaseChannel !== null && (deps.serviceInstalled ?? ((spec, targetPlatform) => fs.existsSync(servicePaths(spec, targetPlatform).unitFile)))(options.serviceSpec, platform);
    if (releaseChannel === null || !installed) {
      changeState(next => { schedule(next, now() + jitter(), request); if (request) report(next, 'refused', currentVersion,
        releaseChannel === null ? 'runner has no installed 2.x release channel' : 'runner service is not installed', request); });
      cleanupGuardian(true);
      return 'continue';
    }
    const held = LifecycleLock.acquire(path.join(home, 'runner', UPDATE_OPERATION_LOCK), { command: 'myco runner update operation' });
    if (!held.acquired) return 'continue';
    try {
      const active = decodeState(home);
      if (active.metadataFailure || active.transaction || active.guardian || active.cleanup || active.requests?.[serverUrl]?.id !== request?.id) return 'continue';
      const current = runnerCurrentReleaseProbe(binaryPath, currentVersion, platform);
      if (!current.runs) {
        changeState(next => {
          report(next, 'refused', localCandidate?.version ?? currentVersion, 'installed runner changed before handoff: ' + current.detail, request);
          schedule(next, now() + jitter(), request);
        });
        return 'continue';
      }
      if (localCandidate?.version === currentVersion) {
        const retired = changeState(next => {
          if (next.requests?.[serverUrl]?.id !== request?.id) return false;
          report(next, 'no_update', currentVersion, undefined, request);
          schedule(next, now() + jitter(), request);
          return true;
        });
        if (retired) cleanupGuardian(true);
        return 'continue';
      }
      if (request?.clearBlock) changeState(clearBlocks);
      let refs: AssetRefs | null = null;
      if (!localCandidate) try {
        const cached = state.candidate?.channel === releaseChannel ? state.candidate.refs : null;
        const etag = recordsAutomaticCandidate && state.releaseChannel === releaseChannel && !request?.clearBlock ? state.etag : undefined;
        const found = await releases(releaseChannel, currentVersion, etag, deps, request?.targetVersion);
        refs = found.unchanged ? cached : found.refs;
        changeState(next => {
          next.lastCheckAt = now(); schedule(next, now() + jitter(), request); next.failures = 0;
          if (recordsAutomaticCandidate) next.releaseChannel = releaseChannel;
          if (recordsAutomaticCandidate && !found.unchanged) {
            next.latestVersion = refs?.targetVersion ?? null; next.etag = found.etag;
            if (refs) next.candidate = { channel: releaseChannel, refs }; else delete next.candidate;
          }
          if (refs === null && request) report(next, 'no_update', currentVersion, undefined, request);
        });
        if (recordsAutomaticCandidate) {
          try { recordUpdateCheck(home, releaseChannel, currentVersion, refs?.targetVersion ?? currentVersion); }
          catch (error) { log(`runner update notice cache could not be saved: ${sanitizeRunnerUpdateReason(String(error))}`); }
        }
      } catch (error) {
        changeState(next => { next.failures++; schedule(next, now() + backoff(next.failures), request); report(next, 'failed', currentVersion, String(error), request); });
        return 'continue';
      }
      if (!localCandidate && refs === null) return 'continue';
      if (!localCandidate && (!semver.valid(currentVersion) || !semver.valid(refs!.targetVersion) || semver.major(refs!.targetVersion) < 2 || !semver.gt(refs!.targetVersion, currentVersion))) {
        if (request) changeState(next => report(next, 'no_update', refs!.targetVersion, undefined, request));
        return 'continue';
      }
      const version = localCandidate?.version ?? refs!.targetVersion;
      const blocked = read().blockedVersions?.[version];
      if (blocked && blocked.until > now()) {
        changeState(next => { schedule(next, Math.min(blocked.until, now() + jitter()), request); if (request) report(next, 'refused', version, blocked.reason, request); });
        return 'continue';
      }
      let attempt = read().attempts?.[version];
      if (attempt && now() < attempt.nextRetryAt) {
        changeState(next => { schedule(next, attempt!.nextRetryAt, request); });
        return 'continue';
      }
      if (!attempt) {
        attempt = { id: crypto.randomUUID(), failures: 0, nextRetryAt: 0 };
        changeState(next => { (next.attempts ??= {})[version] = attempt!; next.attempts = Object.fromEntries(Object.entries(next.attempts).slice(-MAX_VERSION_ATTEMPTS)); });
      }
      const refuse = (reason: string): void => changeState(next => {
        const retry = (next.attempts ??= {})[version] ?? attempt!;
        retry.failures++; retry.nextRetryAt = now() + backoff(retry.failures); next.attempts[version] = retry;
        schedule(next, retry.nextRetryAt, request); report(next, 'refused', version, reason, request, retry.id);
      });
      const probe = deps.probe ?? strictRunnerReleaseProbe;
      if (localCandidate) {
        try {
          assertSourceAdoptionAllowed(home, binaryPath);
          const ready = probeRunnerLocalCandidate(localCandidate, localCandidate.binaryPath,
            () => probe(localCandidate.binaryPath, version, platform));
          if (!ready.runs) { refuse(ready.detail); return 'continue'; }
        } catch (error) { refuse(error instanceof Error ? error.message : String(error)); return 'continue'; }
      }
      const staged = localCandidate ? { stagedPath: localCandidate.binaryPath } : await (deps.stage ?? stageBinary)({ refs: refs!, home, platform, localAppData: options.localAppData }, {
        ...(deps.stageDeps ?? DEFAULT_BINARY_UPDATE_DEPS), ready: file => probe(file, version, platform),
      });
      if ('error' in staged) { refuse(staged.error); return 'continue'; }
      const live = runnerCurrentReleaseProbe(binaryPath, currentVersion, platform);
      if (!live.runs) { refuse('installed runner changed before handoff: ' + live.detail); return 'continue'; }
      const previous = versionBinaryPath(home, platform, currentVersion, options.localAppData);
      const guardianPath = runnerUpdateGuardianBinary(home, platform);
      fs.mkdirSync(path.dirname(previous), { recursive: true });
      fs.mkdirSync(path.dirname(guardianPath), { recursive: true });
      try {
        placeExecutable(binaryPath, previous, { platform, ready: file => runnerCurrentReleaseProbe(file, currentVersion, platform) });
        placeExecutable(localCandidate?.binaryPath ?? binaryPath, guardianPath, { platform, ready: file => {
          if (!localCandidate) return runnerCurrentReleaseProbe(file, currentVersion, platform);
          return probeRunnerLocalCandidate(localCandidate, file, () => probe(file, version, platform));
        } });
      } catch (error) { refuse('trusted current binary backup failed: ' + String(error)); return 'continue'; }
      const tx: RunnerUpdateTransaction = {
        id: crypto.randomUUID(), attemptId: attempt.id, serverUrl, fromVersion: currentVersion, toVersion: version,
        binaryPath, home, platform, ...(options.localAppData ? { localAppData: options.localAppData } : {}),
        serviceSpec: options.serviceSpec, ...(localCandidate ? { localCandidate } : {}), installMarker: readInstallMarker(home, true)!, ownerPid: process.pid, startedAt: now(),
        deadlineAt: now() + TX_DEADLINE_MS, recoveryAttempts: 0, ...(request ? { requestId: request.id } : {}), phase: 'waiting',
      };
      const guardian = runnerUpdateGuardianSpec(tx);
      changeState(next => { if (next.transaction || next.guardian || next.cleanup) throw new Error('runner update already in progress');
        next.transaction = tx; next.guardian = guardian;
        if (request && next.requests?.[serverUrl]?.id === request.id) delete next.requests[serverUrl];
      });
      installation.release();
      installationReleased = true;
      try {
        const installedGuardian = (deps.installGuardian ?? ((spec, targetPlatform) => installService(spec, { platform: targetPlatform })))(guardian, platform);
        if (!installedGuardian.loaded || !installedGuardian.running) throw new Error(installedGuardian.detail ?? 'update guardian is not running');
        await deps.spawnHelper?.(guardian.binaryPath, statePath(home));
      } catch (error) { abandon(tx, 'update guardian start failed: ' + sanitizeRunnerUpdateReason(String(error))); return 'continue'; }
      log('runner update ' + currentVersion + ' → ' + version + ' staged; handing service to the trusted update helper');
      return 'restart';
    } finally { held.lock.release(); if (!installationReleased) cleanupGuardian(true); }
    } finally { if (!installationReleased) installation.release(); }
  };
  return {
    contactPayload: guard(contactPayload, () => payload(freshState())),
    onContact: guard(onContact, () => undefined), startup: guard(startup, () => undefined),
    acknowledgeHealthy: guard(acknowledgeHealthy, () => undefined), recordClaim: guard(recordClaim, () => undefined),
    recordHealthRefusal: guard(recordHealthRefusal, () => undefined), recordRuntimeCapability: guard(recordRuntimeCapability, () => undefined), queueManual, queueLocal,
    check, idle: guard(idle, async () => 'continue' as const),
  };
}

export { decodeState as readRunnerUpdateStateStrict, readState as readRunnerUpdateState, statePath as runnerUpdateStatePath, withState as withRunnerUpdateState };
export type { RunnerUpdateState, RunnerUpdateTransaction };
