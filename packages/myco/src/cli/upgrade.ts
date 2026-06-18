/**
 * `myco upgrade` — user-facing binary-upgrade entry point.
 *
 * Drives the upgrade domain directly (no intent file / no daemon round-trip):
 *
 *   --check                Report-only: resolve the channel target, print
 *                          update/revert status, NEVER adopt.
 *
 *   myco upgrade           check → stage → initiateAdopt INLINE (foreground).
 *   myco upgrade --now     Identical to bare `myco upgrade`.
 *
 *   myco upgrade <version>
 *   myco upgrade --target-version <version>
 *                          Resolve refs for a SPECIFIC version (owned here,
 *                          NOT the daemon's resolveMycoBinaryUpdateRefsForVersion)
 *                          → stage → initiateAdopt INLINE. Task 9 will delete
 *                          the daemon copy.
 *
 *   --channel <stable|beta>
 *                          Persist the channel first, then resolve against it.
 *                          Switching to `stable` while running a beta adopts the
 *                          stable target (the beta→stable revert path).
 *
 * Dev-build guard: `myco upgrade` REFUSES on a dev/source checkout
 * (`isUpdateExempt()` → true). `--check` still reports.
 *
 * CLI path for adopt (via `initiateAdopt`):
 *   POSIX — inline orchestration (this process is not the image being replaced)
 *   win32 — re-execs via `resolveOrchestratorBinary` (temp copy of self)
 */

import { parseStrictFlags } from './args.js';
import {
  resolveMycoBinaryUpdateRefs,
  type MycoReleaseResolverDeps,
} from '../upgrade/release-resolver.js';
import {
  resolveAssetRefs,
  resolveTargetTriple,
  type GitHubRelease,
  type AssetRefs,
  type TargetTriple,
} from '../upgrade/release-assets.js';
import {
  stageBinary,
  DEFAULT_BINARY_UPDATE_DEPS,
  type StageBinaryDeps,
} from '../upgrade/apply-binary.js';
import { initiateAdopt, type InitiateAdoptOpts } from '../upgrade/adopt.js';
import { resolveMycoPackageCheck } from '../upgrade/checker.js';
import {
  readProjectReleaseChannel,
  writeProjectReleaseChannel,
  isUpdateExempt,
} from '../daemon/update-checker.js';
import { resolveMycoHome } from '../grove/paths.js';
import { managedBinaryPath } from '../install/managed-binary.js';
import { resolveGlobalDaemonPort } from '../daemon/service-state.js';
import { getPluginVersion } from '../version.js';
import { RELEASE_CHANNELS, type ReleaseChannel } from '../constants/update.js';

const USAGE = `Usage: myco upgrade [options] [<version>]

Upgrade the myco binary in-place (check → stage → adopt), without going
through the daemon's intent pipeline.

Arguments:
  <version>                    Upgrade to this exact version (e.g. 1.2.3)

Options:
  --now                        Upgrade immediately (identical to bare \`myco upgrade\`)
  --check                      Report available upgrades only — never adopt
  --target-version <version>   Upgrade to this exact version (flag form)
  --channel <stable|beta>      Switch channel, then upgrade on it
  -h, --help                   Show this help
`;

// ---------------------------------------------------------------------------
// Injectable deps (for testing — the real impls are the defaults)
// ---------------------------------------------------------------------------

export interface UpgradeDeps {
  /** Inject the channel-latest resolver so tests can avoid network calls. */
  resolveRefs?: (channel: ReleaseChannel, deps?: MycoReleaseResolverDeps) => Promise<AssetRefs | null>;
  /** Inject the fetch-all-releases call for the exact-version path. */
  fetchReleases?: () => Promise<GitHubRelease[]>;
  /** Inject the stage function. */
  stageBinary?: typeof stageBinary;
  /** Inject stage-level deps (download/hash). */
  stageDeps?: StageBinaryDeps;
  /** Inject initiateAdopt (for testing the adopt path). */
  initiateAdopt?: typeof initiateAdopt;
  /** Override the dev-build exemption check. */
  isDevBuild?: () => boolean;
  /** Override the current version. */
  currentVersion?: string;
  /** Override myco home dir. */
  home?: string;
  /** Override the running platform. */
  platform?: NodeJS.Platform;
  /** Override %LOCALAPPDATA% (win32 only). */
  localAppData?: string;
  /** Override the daemon port. */
  daemonPort?: number;
  /** Override the myco binary path (for adopt's restart fallback). */
  mycoBinary?: string;
  /** Override the project root (for adopt's restart cwd). */
  projectRoot?: string;
  /** Inject the channel-persist function (for testing side-effect ordering). */
  writeChannel?: typeof writeProjectReleaseChannel;
  /** Inject the update-check function (for positive --check tests). */
  checkFn?: typeof resolveMycoPackageCheck;
  /** Resolve this machine's target triple (process.platform/arch by default). */
  targetTriple?: () => TargetTriple;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function run(args: string[], deps: UpgradeDeps = {}): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }

  // `parseStrictFlags` rejects non-flag tokens, so strip out the positional
  // <version> argument first. We use a simple scan:
  //   - Value-taking flags (--target-version, --channel) consume the next token
  //     as their value (so `['--target-version', '1.1.0']` → value is '1.1.0').
  //   - Any remaining token that doesn't start with '-' is a positional.
  //
  // We rebuild the flag-only token list and collect the first positional.
  const VALUE_FLAGS = new Set(['--target-version', '--channel']);
  const flagOnlyArgs: string[] = [];
  let positionalVersion: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token.startsWith('-')) {
      flagOnlyArgs.push(token);
      if (VALUE_FLAGS.has(token)) {
        // Include the value token in flagOnlyArgs so the strict parser sees it.
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flagOnlyArgs.push(next);
          i++;
        }
      }
    } else if (positionalVersion === null) {
      positionalVersion = token;
    }
    // Extra positionals are ignored; the first one wins.
  }

  const parsed = parseStrictFlags('myco upgrade', flagOnlyArgs, [
    { name: '--now' },
    { name: '--check' },
    { name: '--target-version', value: 'required' },
    { name: '--channel', value: 'required' },
    { name: '--help', aliases: ['-h'] },
  ], USAGE);

  // --target-version wins over positional.
  const targetVersionArg = parsed.value('--target-version') ?? positionalVersion;

  // Semver gate for explicit version requests.
  const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  if (targetVersionArg && !SEMVER_RE.test(targetVersionArg)) {
    console.error(
      `myco upgrade: version must be a strict semver (e.g. 1.2.3); got '${targetVersionArg}'`,
    );
    process.exit(1);
  }

  // Validate channel arg.
  const channelArg = parsed.value('--channel');
  if (channelArg !== undefined && !RELEASE_CHANNELS.includes(channelArg as ReleaseChannel)) {
    console.error(`myco upgrade: --channel must be 'stable' or 'beta'; got '${channelArg}'`);
    process.exit(1);
  }

  const isCheck = parsed.has('--check');

  // Effective channel for this run (before any persist — reading the stored value).
  const channel: ReleaseChannel = (channelArg as ReleaseChannel | undefined) ?? readProjectReleaseChannel();

  // --check path: report only, never adopt, never persist. Dev builds may still report.
  if (isCheck) {
    await runCheck(channel, deps);
    return;
  }

  // Dev-build guard for upgrade (not check). Refuse before any side effects.
  const devBuildCheck = deps.isDevBuild ?? isUpdateExempt;
  if (devBuildCheck()) {
    console.error(
      'myco upgrade: running a dev build — upgrade is managed by your checkout, not the binary installer.',
    );
    process.exit(1);
  }

  // Persist channel change now that we are on the actual-upgrade path.
  // This keeps the side effect out of --check and dev-build-refused paths.
  if (channelArg) {
    const persistChannel = deps.writeChannel ?? writeProjectReleaseChannel;
    persistChannel(undefined, channelArg as ReleaseChannel);
    console.log(`Channel set to '${channelArg}'.`);
  }

  // Resolve the asset refs for the upgrade target.
  const refs = await resolveAssetRefsForTarget(targetVersionArg, channel, deps);
  if (!refs) {
    if (targetVersionArg) {
      console.error(`myco upgrade: no release found for version ${targetVersionArg}`);
      process.exit(1);
    } else {
      console.log('myco is already up to date.');
      process.exit(0);
    }
  }

  const currentVersion = deps.currentVersion ?? getPluginVersion();

  // No-downgrade rule, EXCEPT when the user explicitly switches channel or requests
  // a specific version — those are intentional version changes (incl. beta→stable revert).
  if (!targetVersionArg && !channelArg) {
    const semver = await import('semver');
    if (
      semver.valid(refs.targetVersion) &&
      semver.valid(currentVersion) &&
      !semver.gt(refs.targetVersion, currentVersion)
    ) {
      console.log(
        `myco is already at ${currentVersion} (channel target: ${refs.targetVersion}).`,
      );
      process.exit(0);
    }
  }

  console.log(`Upgrading myco ${currentVersion} → ${refs.targetVersion}…`);

  const home = deps.home ?? resolveMycoHome();
  const platform = deps.platform ?? (process.platform as NodeJS.Platform);
  const localAppData = deps.localAppData ?? process.env.LOCALAPPDATA;

  // Stage the binary (download → verify → stage under versions/<v>/).
  console.log('  Downloading and verifying…');
  const stageFn = deps.stageBinary ?? stageBinary;
  const stageDeps = deps.stageDeps ?? DEFAULT_BINARY_UPDATE_DEPS;
  const stageResult = await stageFn({ refs, home, platform, localAppData }, stageDeps);

  if ('error' in stageResult) {
    console.error(`myco upgrade: stage failed — ${stageResult.error}`);
    process.exit(1);
  }

  console.log(`  Staged ${stageResult.version} to ${stageResult.versionDir}`);

  // Adopt: copy staged binary → managed path, restart daemon, health-watch.
  console.log('  Adopting…');

  const mycoBinary = deps.mycoBinary ?? managedBinaryPath(home, platform, localAppData);
  const projectRoot = deps.projectRoot ?? process.cwd();
  const daemonPort = deps.daemonPort ?? resolveGlobalDaemonPort();

  // Resolve service-managed label at adopt time.
  const { getServiceManager } = await import('../service/manager.js');
  const { detectServiceManagedLabel } = await import('../daemon/api/restart.js');
  const serviceManagedLabel = await detectServiceManagedLabel(getServiceManager());

  const adoptOpts: InitiateAdoptOpts = {
    source: 'cli',
    targetVersion: stageResult.version,
    prevVersion: currentVersion,
    home,
    platform,
    localAppData,
    daemonPort,
    serviceManagedLabel,
    mycoBinary,
    projectRoot,
    maxHealthAttempts: 30,
    healthIntervalMs: 2000,
  };

  const adoptFn = deps.initiateAdopt ?? initiateAdopt;
  await adoptFn(adoptOpts);

  console.log(`myco ${stageResult.version} is now active.`);
}

// ---------------------------------------------------------------------------
// --check path
// ---------------------------------------------------------------------------

async function runCheck(channel: ReleaseChannel, deps: UpgradeDeps): Promise<void> {
  const currentVersion = deps.currentVersion ?? getPluginVersion();
  console.log(`Checking for updates on the '${channel}' channel…`);

  const checkFn = deps.checkFn ?? resolveMycoPackageCheck;
  let checkResult: Awaited<ReturnType<typeof resolveMycoPackageCheck>>;
  try {
    checkResult = await checkFn(
      currentVersion,
      channel,
      // installed_version: use current as proxy (CLI doesn't track the npm install path
      // separately from the running binary)
      currentVersion,
    );
  } catch (err) {
    console.error(
      `myco upgrade --check: failed to fetch releases — ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  if (checkResult.update_available) {
    console.log(`Update available: ${currentVersion} → ${checkResult.latest_version}`);
    console.log(`Run \`myco upgrade\` to apply.`);
  } else if (checkResult.revert_available) {
    console.log(
      `Stable revert available: ${currentVersion} → ${checkResult.latest_stable} (switch from beta to stable)`,
    );
    console.log(`Run \`myco upgrade --channel stable\` to revert.`);
  } else {
    console.log(`myco ${currentVersion} is up to date on the '${channel}' channel.`);
    if (checkResult.latest_version) {
      console.log(`  Latest: ${checkResult.latest_version}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Asset ref resolution: channel-latest vs. exact-version
// ---------------------------------------------------------------------------

/**
 * Resolve asset refs for either a specific version or the channel-latest target.
 *
 * SPECIFIC VERSION (owned by cli/upgrade.ts):
 *   Fetch all releases, find the one tagged `myco/v<version>` exactly, resolve
 *   refs for this machine's target triple. This is the same logic as
 *   `resolveMycoBinaryUpdateRefsForVersion` in the daemon's release-resolver.ts —
 *   living here so Task 9 can delete the daemon copy.
 *
 * CHANNEL LATEST:
 *   Delegate to `resolveMycoBinaryUpdateRefs` (channel resolver).
 */
async function resolveAssetRefsForTarget(
  targetVersionArg: string | null,
  channel: ReleaseChannel,
  deps: UpgradeDeps,
): Promise<AssetRefs | null> {
  if (targetVersionArg) {
    const fetchReleasesFn = deps.fetchReleases ?? defaultFetchReleases;
    const releases = await fetchReleasesFn();
    const release = releases.find((r) => r.tag_name === `myco/v${targetVersionArg}`);
    if (!release) return null;
    const triple = deps.targetTriple ? deps.targetTriple() : resolveTargetTriple();
    return resolveAssetRefs(release, triple);
  }

  const resolveRefsFn = deps.resolveRefs ?? resolveMycoBinaryUpdateRefs;
  return resolveRefsFn(channel);
}

async function defaultFetchReleases(): Promise<GitHubRelease[]> {
  const { mycoReleasesApiUrl, githubHeaders } = await import('../upgrade/release-assets.js');
  const res = await fetch(mycoReleasesApiUrl(), {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`GitHub releases responded with ${res.status}`);
  }
  return (await res.json()) as GitHubRelease[];
}
