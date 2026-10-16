import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import semver from 'semver';
import { isDevelopmentVersion, selectChannelRelease, isV2Version } from '../../scripts/release-policy.mjs';
import { resolveBinary, readLayeredPin } from '@myco/runtime/binary-resolution.js';
import { canonicalHomePath, isDefaultMycoHome, resolveMycoHome } from '@myco/paths/home.js';
import { readInstallMarker } from '@myco/install/managed-binary.js';
import { placeExecutable, readyExecutable } from '@myco/install/place-binary.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { REPAIR_LOCK } from '@myco/member/keep-current-lock.js';
import { getPluginVersion } from '@myco/version.js';
import { stageBinary, DEFAULT_BINARY_UPDATE_DEPS, type StageBinaryDeps } from './apply-binary.js';
import { resolveMycoBinaryUpdateRefs, fetchMycoReleases } from './release-resolver.js';
import { resolveAssetRefs, resolveTargetTriple, type AssetRefs, type GitHubRelease, type TargetTriple } from './release-assets.js';
import { recordUpdateCheck, effectiveUpdateChannel } from './check-cache.js';
import { hasAdoptFailed, markAdoptFailed } from './adopt-failed.js';
import type { ReleaseChannel } from '@myco/constants/update.js';

export const BINARY_UPDATE_WAIT_MS = 250;
export const BINARY_VERSION_TIMEOUT_MS = 30_000;

type RetainedPrevious = { path: string; reason: string };

export type BinaryUpdateOutcome =
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'already-current'; version: string; reason: string }
  | { kind: 'adopted'; version: string; retainedPrevious?: RetainedPrevious }
  | { kind: 'rolled-back'; version: string; reason: string; retainedPrevious?: RetainedPrevious };

export interface BinaryUpdateDeps {
  resolveRefs?: (channel: ReleaseChannel) => Promise<AssetRefs | null>;
  fetchReleases?: () => Promise<GitHubRelease[]>;
  stageBinary?: typeof stageBinary;
  stageDeps?: StageBinaryDeps;
  placeBinary?: typeof placeExecutable;
  probeVersion?: (binary: string) => string;
  currentVersion?: string;
  home?: string;
  platform?: NodeJS.Platform;
  localAppData?: string;
  mycoBinary?: string;
  cwd?: string;
  targetTriple?: () => TargetTriple;
  fs?: Pick<typeof fs, 'linkSync' | 'renameSync' | 'rmSync'>;
}

export function admitsUpdate(target: string, current: string, channel: ReleaseChannel): boolean {
  if (!semver.valid(target) || !semver.valid(current) || !semver.gt(target, current) || !isV2Version(target)) return false;
  return !isV2Version(current) || selectChannelRelease([{
    tag_name: `myco/v${target}`, prerelease: semver.prerelease(target) !== null, assets: [],
  }], channel, { currentVersion: current }) !== null;
}

export async function resolveAssetRefsForTarget(target: string | null, channel: ReleaseChannel, deps: BinaryUpdateDeps): Promise<AssetRefs | null> {
  if (target !== null) {
    const releases = await (deps.fetchReleases ?? fetchMycoReleases)();
    const release = releases.find(release => release.tag_name === `myco/v${target}`);
    return release === undefined ? null : resolveAssetRefs(release, (deps.targetTriple ?? resolveTargetTriple)());
  }
  return (deps.resolveRefs ?? (channel => resolveMycoBinaryUpdateRefs(channel, undefined, deps.currentVersion ?? getPluginVersion())))(channel);
}

function probeVersion(binary: string): string {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: BINARY_VERSION_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? `version check exited ${result.status}${result.signal ? ` (${result.signal})` : ''}`);
  return result.stdout.trim();
}

const detail = (error: unknown): string => error instanceof Error ? error.message : String(error);

type BinaryFileOps = NonNullable<BinaryUpdateDeps['fs']>;

function keepPrevious(binary: string, previous: string, staging: string, platform: NodeJS.Platform, fileOps: BinaryFileOps): string | undefined {
  if (platform !== 'win32') {
    const next = path.join(staging, 'myco.prev');
    fileOps.linkSync(binary, next);
    fileOps.renameSync(next, previous);
    return undefined;
  }
  const retired = fs.existsSync(previous) ? path.join(path.dirname(binary), `.myco-retired-${randomUUID()}.exe`) : undefined;
  if (retired !== undefined) fileOps.renameSync(previous, retired);
  try { fileOps.renameSync(binary, previous); }
  catch (error) {
    if (retired !== undefined) fileOps.renameSync(retired, previous);
    throw error;
  }
  return retired;
}

function retirePrevious(retired: string | undefined, fileOps: BinaryFileOps): { retainedPrevious?: RetainedPrevious } {
  if (retired === undefined) return {};
  try { fileOps.rmSync(retired); return {}; }
  catch (error) {
    return { retainedPrevious: { path: retired, reason: detail(error) } };
  }
}

/** Guards and verifies one binary replacement, releasing the lease before returning. */
export async function updateBinary(
  caller: 'manual' | 'automatic',
  options: { skipBinary?: boolean; targetVersion?: string | null; channel?: ReleaseChannel } = {},
  deps: BinaryUpdateDeps = {},
): Promise<BinaryUpdateOutcome> {
  const home = deps.home ?? resolveMycoHome();
  const platform = deps.platform ?? process.platform;
  const localAppData = deps.localAppData ?? process.env.LOCALAPPDATA;
  const runningVersion = deps.currentVersion ?? getPluginVersion();
  let lease: ReturnType<typeof LifecycleLock.acquire> | undefined;
  try {
    lease = LifecycleLock.acquire(path.join(home, 'member', REPAIR_LOCK), { wait: true, timeoutMs: BINARY_UPDATE_WAIT_MS, command: 'myco update binary' });
    if (!lease.acquired) return { kind: caller === 'manual' ? 'failed' : 'skipped', reason: 'an update is running' };
    if (options.skipBinary) return { kind: 'skipped', reason: '--skip-binary requested' };
    if (isDevelopmentVersion(runningVersion)) return { kind: 'skipped', reason: 'development build' };
    if (caller === 'automatic' && !isDefaultMycoHome(home)) return { kind: 'skipped', reason: 'this is not the default Myco home' };
    const binary = deps.mycoBinary ?? readInstallMarker(home, true)?.bin
      ?? resolveBinary('managed-destination', { kind: 'machine' }, { mycoHome: home, platform, localAppData }).path;
    const pin = readLayeredPin({ kind: 'walk-up', from: deps.cwd ?? process.cwd() }, { mycoHome: home, platform });
    if (pin !== null && canonicalHomePath(pin.pin) !== canonicalHomePath(binary)) return { kind: 'skipped', reason: `runtime pin selects another binary: ${pin.pin}` };
    const probe = deps.probeVersion ?? probeVersion;
    const current = fs.existsSync(binary) ? probe(binary) : runningVersion;
    if (!semver.valid(current)) throw new Error(`installed binary reported an invalid version: ${current}`);
    const channel = options.channel ?? effectiveUpdateChannel(home);
    const target = options.targetVersion ?? null;
    const refs = await resolveAssetRefsForTarget(target, channel, { ...deps, currentVersion: current });
    if (target === null) recordUpdateCheck(home, channel, current, refs?.targetVersion ?? current);
    if (refs === null) return target !== null
      ? { kind: 'failed', reason: `no release found for version ${target}` }
      : { kind: 'already-current', version: current, reason: 'no newer eligible release' };
    if (!admitsUpdate(refs.targetVersion, current, channel)) return { kind: 'already-current', version: current, reason: `channel target ${refs.targetVersion} is older or outside '${channel}'; staying put` };
    if (hasAdoptFailed(home, platform, refs.targetVersion, localAppData)) return { kind: 'skipped', reason: `version ${refs.targetVersion} failed an earlier update` };
    const staged = await (deps.stageBinary ?? stageBinary)({ refs, home, platform, localAppData }, deps.stageDeps ?? DEFAULT_BINARY_UPDATE_DEPS);
    if ('error' in staged) {
      if (staged.verificationFailed) markAdoptFailed(home, platform, refs.targetVersion, localAppData);
      return { kind: 'failed', reason: staged.error };
    }
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    const staging = fs.mkdtempSync(path.join(path.dirname(binary), '.myco-update-'));
    const candidate = path.join(staging, path.basename(binary));
    const previous = path.join(path.dirname(binary), platform === 'win32' ? 'myco.prev.exe' : 'myco.prev');
    const fileOps = deps.fs ?? fs;
    try {
      try {
        (deps.placeBinary ?? placeExecutable)(path.join(staged.versionDir, platform === 'win32' ? 'myco.exe' : 'myco'), candidate, {
          platform, ready: file => readyExecutable(file, platform),
        });
        const version = probe(candidate);
        if (version !== refs.targetVersion) throw new Error(`expected ${refs.targetVersion}, received ${version}`);
      } catch (error) {
        markAdoptFailed(home, platform, refs.targetVersion, localAppData);
        return { kind: 'failed', reason: `downloaded version could not be verified: ${detail(error)}` };
      }
      const hadLive = fs.existsSync(binary);
      const retired = hadLive ? keepPrevious(binary, previous, staging, platform, fileOps) : undefined;
      try {
        fileOps.renameSync(candidate, binary);
        const version = probe(binary);
        if (version !== refs.targetVersion) throw new Error(`expected ${refs.targetVersion}, received ${version}`);
      } catch (error) {
        try {
          if (hadLive) {
            if (platform === 'win32') fileOps.rmSync(binary, { force: true });
            fileOps.renameSync(previous, binary);
          } else fileOps.rmSync(binary, { force: true });
        } catch (restoreError) {
          markAdoptFailed(home, platform, refs.targetVersion, localAppData);
          return { kind: 'failed', reason: `replacement failed (${detail(error)}); could not restore ${previous} (${detail(restoreError)})` };
        }
        markAdoptFailed(home, platform, refs.targetVersion, localAppData);
        return hadLive ? { kind: 'rolled-back', version: current, reason: detail(error), ...retirePrevious(retired, fileOps) }
          : { kind: 'failed', reason: `installed version could not be verified: ${detail(error)}` };
      }
      return { kind: 'adopted', version: refs.targetVersion, ...retirePrevious(retired, fileOps) };
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  } catch (error) {
    return { kind: 'failed', reason: detail(error) };
  } finally { if (lease?.acquired) lease.lock.release(); }
}
