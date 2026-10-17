import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readBinaryVersion } from '@myco/runtime/binary-version.js';
import semver from 'semver';
import { isDevelopmentVersion, selectChannelRelease, isV2Version } from '../../scripts/release-policy.mjs';
import { installedBinaryPath, readLayeredPin } from '@myco/runtime/binary-resolution.js';
import { canonicalHomePath, defaultMycoHome, isDefaultMycoHome, resolveMycoHome } from '@myco/paths/home.js';
import { readInstallMarker } from '@myco/install/managed-binary.js';
import { automaticUpdatesEnabled } from '@myco/install/marker-reader.js';
import { placeExecutable, readyExecutable, ExecutableVerificationError } from '@myco/install/place-binary.js';
import type { atomicWriteFileSync } from '@myco/utils/atomic-write.js';
import { LifecycleLock, type LockHandle } from '@myco/utils/lifecycle-lock.js';
import { REPAIR_LOCK } from '@myco/member/keep-current-lock.js';
import { getPluginVersion } from '@myco/version.js';
import { stageBinary, createBinaryUpdateDeps, type StageBinaryDeps } from './apply-binary.js';
import { resolveMycoBinaryUpdateRefs, fetchMycoReleases } from './release-resolver.js';
import { resolveAssetRefs, resolveTargetTriple, type AssetRefs, type GitHubRelease, type TargetTriple } from './release-assets.js';
import { recordUpdateCheck, effectiveUpdateChannel } from './check-cache.js';
import { hasAdoptFailed, markAdoptFailed, clearAdoptFailed } from './adopt-failed.js';
import { updateBudget, type UpdateDeadline } from '@myco/upgrade/update-budget.js';
import type { ReleaseChannel } from '@myco/constants/update.js';

export const BINARY_UPDATE_WAIT_MS = 250;
export const BINARY_VERSION_TIMEOUT_MS = 30_000;
export const AUTOMATIC_DOWNLOAD_MIN_BUDGET_MS = 15_000;
const UPDATE_DIRECTORY_PREFIX = '.myco-update-';
const RETIRED_BINARY_PREFIX = '.myco-retired-';

type RetainedPrevious = { path: string; reason: string };

export type BinaryUpdateOutcome = (
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'already-current'; version: string; reason: string }
  | { kind: 'adopted'; version: string; previousVersion?: string }
  | { kind: 'rolled-back'; version: string; reason: string }
) & { warnings?: string[]; retainedPrevious?: RetainedPrevious[] };

export interface BinaryUpdateDeps extends UpdateDeadline {
  resolveRefs?: (channel: ReleaseChannel) => Promise<AssetRefs | null>;
  fetchReleases?: () => Promise<GitHubRelease[]>;
  stageBinary?: typeof stageBinary;
  stageDeps?: StageBinaryDeps;
  failureRecordWriter?: typeof atomicWriteFileSync;
  placeBinary?: typeof placeExecutable;
  probeVersion?: (binary: string) => string | Promise<string>;
  currentVersion?: string;
  home?: string;
  platform?: NodeJS.Platform;
  localAppData?: string;
  mycoBinary?: string;
  cwd?: string;
  targetTriple?: () => TargetTriple;
  fs?: Pick<typeof fs, 'linkSync' | 'renameSync' | 'rmSync'>;
}

/** The installed destination shared by replacement and post-update agent refresh. */
export function binaryUpdatePath(home: string, deps: BinaryUpdateDeps = {}): string {
  return deps.mycoBinary ?? installedBinaryPath(home, { platform: deps.platform, localAppData: deps.localAppData ?? process.env.LOCALAPPDATA });
}

export function admitsUpdate(target: string, current: string, channel: ReleaseChannel, allowOlder = false): boolean {
  if (!semver.valid(target) || !semver.valid(current) || !(allowOlder ? !semver.eq(target, current) : semver.gt(target, current)) || !isV2Version(target)) return false;
  return !isV2Version(current) || selectChannelRelease([{
    tag_name: `myco/v${target}`, prerelease: semver.prerelease(target) !== null, assets: [],
  }], channel, allowOlder ? {} : { currentVersion: current }) !== null;
}

export async function resolveAssetRefsForTarget(target: string | null, channel: ReleaseChannel, deps: BinaryUpdateDeps): Promise<AssetRefs | null> {
  if (target !== null) {
    const releases = await (deps.fetchReleases ?? fetchMycoReleases)();
    const release = releases.find(release => release.tag_name === `myco/v${target}`);
    return release === undefined ? null : resolveAssetRefs(release, (deps.targetTriple ?? resolveTargetTriple)());
  }
  return (deps.resolveRefs ?? (channel => resolveMycoBinaryUpdateRefs(channel, {
    fetchReleases: () => fetchMycoReleases(updateBudget(deps).fetch),
    targetTriple: deps.targetTriple ?? resolveTargetTriple,
  }, deps.currentVersion ?? getPluginVersion())))(channel);
}

const detail = (error: unknown): string => error instanceof Error ? error.message : String(error);

type BinaryFileOps = NonNullable<BinaryUpdateDeps['fs']>;

function renameBinary(source: string, destination: string, fileOps: BinaryFileOps): void {
  try { fileOps.renameSync(source, destination); }
  catch (error) { throw new Error(`rename ${source} to ${destination}: ${detail(error)}`); }
}

function keepPrevious(binary: string, previous: string, staging: string, platform: NodeJS.Platform, fileOps: BinaryFileOps): string | undefined {
  if (platform !== 'win32') {
    const next = path.join(staging, 'myco.prev');
    try { fileOps.linkSync(binary, next); }
    catch (error) { throw new Error(`link ${binary} to ${next}: ${detail(error)}`); }
    renameBinary(next, previous, fileOps);
    return undefined;
  }
  const retired = fs.existsSync(previous) ? path.join(path.dirname(binary), `${RETIRED_BINARY_PREFIX}${randomUUID()}.exe`) : undefined;
  if (retired !== undefined) renameBinary(previous, retired, fileOps);
  try { renameBinary(binary, previous, fileOps); }
  catch (error) {
    try { if (retired !== undefined) renameBinary(retired, previous, fileOps); }
    catch (restoreError) { throw new Error(`${detail(error)}; restore earlier backup failed: ${detail(restoreError)}`); }
    throw error;
  }
  return retired;
}

function removeLeftover(file: string, fileOps: BinaryFileOps, report: UpdateReport, recursive = false): void {
  try { fileOps.rmSync(file, { recursive, force: true }); }
  catch (error) { report.retainedPrevious.push({ path: file, reason: `remove ${file}: ${detail(error)}` }); }
}

function retirePrevious(retired: (string | undefined)[], fileOps: BinaryFileOps, report: UpdateReport): void {
  for (const file of retired) if (file !== undefined) removeLeftover(file, fileOps, report);
}

async function verifyVersion(binary: string, target: string, probe: (binary: string) => string | Promise<string>): Promise<void> {
  try {
    const version = await probe(binary);
    if (version !== target) throw new ExecutableVerificationError(`expected ${target}, received ${version}`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== undefined && code !== 'ETIMEDOUT') throw error;
    throw new ExecutableVerificationError(`check ${binary} --version: ${detail(error)}`);
  }
}

function sweepLeftovers(binary: string, fileOps: BinaryFileOps, report: UpdateReport): void {
  const directory = path.dirname(binary);
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!(entry.isDirectory() && entry.name.startsWith(UPDATE_DIRECTORY_PREFIX)) && !(entry.isFile() && entry.name.startsWith(RETIRED_BINARY_PREFIX))) continue;
    const file = path.join(directory, entry.name);
    removeLeftover(file, fileOps, report, entry.isDirectory());
  }
}

type BinaryUpdateOptions = { skipBinary?: boolean; targetVersion?: string | null; channel?: ReleaseChannel };
type UpdateReport = { warnings: string[]; retainedPrevious: RetainedPrevious[] };

function recordFailedVerification(home: string, platform: NodeJS.Platform, version: string, localAppData: string | undefined, report: UpdateReport, writeFile?: typeof atomicWriteFileSync): void {
  try { markAdoptFailed(home, platform, version, localAppData, writeFile); }
  catch (error) { report.warnings.push(`Could not record the failed version ${version}: ${detail(error)}`); }
}

async function performBinaryUpdate(
  caller: 'manual' | 'automatic',
  options: BinaryUpdateOptions,
  deps: BinaryUpdateDeps,
  report: UpdateReport,
): Promise<BinaryUpdateOutcome> {
  const budget = updateBudget(deps);
  const home = deps.home ?? resolveMycoHome();
  const platform = deps.platform ?? process.platform;
  const localAppData = deps.localAppData ?? process.env.LOCALAPPDATA;
  const runningVersion = deps.currentVersion ?? getPluginVersion();
  if (caller === 'automatic' && !automaticUpdatesEnabled(home)) return { kind: 'skipped', reason: 'automatic updates are turned off' };
  if (options.skipBinary) return { kind: 'skipped', reason: '--skip-binary requested' };
  if (isDevelopmentVersion(runningVersion)) return { kind: 'skipped', reason: 'development build' };
  if (caller === 'automatic' && !isDefaultMycoHome(home)) return { kind: 'skipped', reason: 'this is not the default Myco home' };
  const leases: LockHandle[] = [];
  try {
    const lockHomes = [...new Set([defaultMycoHome(), home].map(canonicalHomePath))];
    for (const lockHome of lockHomes) {
      const lease = LifecycleLock.acquire(path.join(lockHome, 'member', REPAIR_LOCK), { wait: true, timeoutMs: Math.min(BINARY_UPDATE_WAIT_MS, budget.remaining()), command: 'myco update binary' });
      if (!lease.acquired) return { kind: caller === 'manual' ? 'failed' : 'skipped', reason: 'an update is running' };
      leases.push(lease.lock);
    }
    const binary = binaryUpdatePath(home, deps);
    const fileOps = deps.fs ?? fs;
    sweepLeftovers(binary, fileOps, report);
    const pin = readLayeredPin({ kind: 'walk-up', from: deps.cwd ?? process.cwd() }, { mycoHome: home, platform });
    if (pin !== null && canonicalHomePath(pin.pin) !== canonicalHomePath(binary)) return { kind: 'skipped', reason: `runtime pin selects another binary: ${pin.pin}` };
    const probe = async (binary: string): Promise<string> => {
      budget.remaining();
      try { return await (deps.probeVersion ?? (file => readBinaryVersion(file, Math.min(BINARY_VERSION_TIMEOUT_MS, budget.remaining()))))(binary); }
      finally { budget.remaining(); }
    };
    const current = fs.existsSync(binary) ? await probe(binary) : runningVersion;
    if (isDevelopmentVersion(current)) return { kind: 'skipped', reason: 'development build' };
    if (!semver.valid(current)) throw new Error(`installed binary reported an invalid version: ${current}`);
    const channel = options.channel ?? effectiveUpdateChannel(home);
    const target = options.targetVersion ?? null;
    const refs = await resolveAssetRefsForTarget(target, channel, { ...deps, currentVersion: current });
    if (target === null) recordUpdateCheck(home, channel, current, refs?.targetVersion ?? current);
    if (refs === null) return target !== null
      ? { kind: 'failed', reason: `no release found for version ${target}` }
      : { kind: 'already-current', version: current, reason: 'no newer eligible release' };
    if (!admitsUpdate(refs.targetVersion, current, channel, caller === 'manual' && target !== null)) return { kind: 'already-current', version: current, reason: `channel target ${refs.targetVersion} is older or outside '${channel}'; staying put` };
    const failedBefore = hasAdoptFailed(home, platform, refs.targetVersion, localAppData);
    if (failedBefore && !(caller === 'manual' && target !== null)) return { kind: 'skipped', reason: `version ${refs.targetVersion} failed an earlier update; retry with myco update ${refs.targetVersion}` };
    if (caller === 'automatic' && budget.remaining() < AUTOMATIC_DOWNLOAD_MIN_BUDGET_MS) return { kind: 'skipped', reason: 'not enough time remains to download an update' };
    budget.remaining();
    const staged = await (deps.stageBinary ?? stageBinary)({ refs, home, platform, localAppData }, deps.stageDeps ?? { ...createBinaryUpdateDeps({ fetch: budget.fetch }), ready: file => readyExecutable(file, platform, budget.run) });
    budget.remaining();
    if ('error' in staged) {
      if (staged.verificationFailed) recordFailedVerification(home, platform, refs.targetVersion, localAppData, report, deps.failureRecordWriter);
      return { kind: 'failed', reason: staged.error };
    }
    budget.remaining();
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    const staging = fs.mkdtempSync(path.join(path.dirname(binary), UPDATE_DIRECTORY_PREFIX));
    const candidate = path.join(staging, path.basename(binary));
    const previous = path.join(path.dirname(binary), platform === 'win32' ? 'myco.prev.exe' : 'myco.prev');
    try {
      try {
        (deps.placeBinary ?? placeExecutable)(path.join(staged.versionDir, platform === 'win32' ? 'myco.exe' : 'myco'), candidate, {
          platform, ready: file => readyExecutable(file, platform, budget.run),
        });
        await verifyVersion(candidate, refs.targetVersion, probe);
      } catch (error) {
        if (error instanceof ExecutableVerificationError) recordFailedVerification(home, platform, refs.targetVersion, localAppData, report, deps.failureRecordWriter);
        return { kind: 'failed', reason: `prepare downloaded version: ${detail(error)}` };
      }
      budget.remaining();
      const hadLive = fs.existsSync(binary);
      const retired = hadLive ? keepPrevious(binary, previous, staging, platform, fileOps) : undefined;
      let swapped = false;
      let operation = `rename ${candidate} to ${binary}`;
      try {
        fileOps.renameSync(candidate, binary);
        swapped = true;
        operation = `verify installed version at ${binary}`;
        await verifyVersion(binary, refs.targetVersion, probe);
      } catch (error) {
        const verificationFailed = error instanceof ExecutableVerificationError;
        let failedLive: string | undefined;
        let restoreOperation = '';
        try {
          if (platform === 'win32' && swapped) {
            const retiredFailed = path.join(path.dirname(binary), `${RETIRED_BINARY_PREFIX}${randomUUID()}.exe`);
            restoreOperation = `rename failed executable ${binary} to ${retiredFailed}`;
            fileOps.renameSync(binary, retiredFailed);
            failedLive = retiredFailed;
          }
          if (hadLive) {
            restoreOperation = `rename ${previous} to ${binary}`;
            fileOps.renameSync(previous, binary);
          } else if (platform !== 'win32') {
            restoreOperation = `remove failed executable ${binary}`;
            fileOps.rmSync(binary, { force: true });
          }
        } catch (restoreError) {
          if (verificationFailed) recordFailedVerification(home, platform, refs.targetVersion, localAppData, report, deps.failureRecordWriter);
          for (const file of [retired, failedLive]) if (file !== undefined) report.retainedPrevious.push({ path: file, reason: 'kept after failed recovery' });
          const recovery = fs.existsSync(binary) ? '' : ` No ${path.basename(binary)} is at ${binary}. Recovery: move "${previous}" "${binary}".`;
          return { kind: 'failed', reason: `${operation} failed (${detail(error)}); ${restoreOperation} failed (${detail(restoreError)}).${recovery}` };
        }
        if (verificationFailed) recordFailedVerification(home, platform, refs.targetVersion, localAppData, report, deps.failureRecordWriter);
        const reason = `${operation} failed: ${detail(error)}`;
        retirePrevious([retired, failedLive], fileOps, report);
        return hadLive && verificationFailed ? { kind: 'rolled-back', version: current, reason }
          : { kind: 'failed', reason };
      }
      try { clearAdoptFailed(home, platform, refs.targetVersion, localAppData, deps.failureRecordWriter); }
      catch (error) { report.warnings.push(`Updated to ${refs.targetVersion}, but could not clear its failure records: ${detail(error)}`); }
      retirePrevious([retired], fileOps, report);
      return { kind: 'adopted', version: refs.targetVersion, previousVersion: current };
    } finally { removeLeftover(staging, fileOps, report, true); }
  } catch (error) {
    return { kind: 'failed', reason: detail(error) };
  } finally { for (const lease of leases.reverse()) lease.release(); }
}

/** Guards and verifies one binary replacement, releasing the lease before returning. */
export async function updateBinary(caller: 'manual' | 'automatic', options: BinaryUpdateOptions = {}, deps: BinaryUpdateDeps = {}): Promise<BinaryUpdateOutcome> {
  const report: UpdateReport = { warnings: [], retainedPrevious: [] };
  const outcome = await performBinaryUpdate(caller, options, deps, report);
  return { ...outcome, ...(report.retainedPrevious.length > 0 ? { retainedPrevious: report.retainedPrevious } : {}), ...(report.warnings.length > 0 ? { warnings: report.warnings } : {}) };
}
