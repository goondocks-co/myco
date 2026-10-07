/** `myco upgrade` resolves, verifies and adopts a binary within the selected channel. */

import semver from 'semver';
import { selectChannelRelease } from '../../scripts/release-policy.mjs';
import { parseStrictFlags } from './args.js';
import { resolveBinary } from '../runtime/binary-resolution.js';
import {
  resolveMycoBinaryUpdateRefs,
  fetchMycoReleases,
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
  adoptStaged,
  DEFAULT_BINARY_UPDATE_DEPS,
  type StageBinaryDeps,
} from '../upgrade/apply-binary.js';
import { initiateAdopt, type InitiateAdoptOpts } from '../upgrade/adopt.js';
import {
  readMaxStampedSchemaVersion,
  readSupportedSchemaVersion,
  rollbackWouldCrossSchemaGap,
  SchemaGapDowngradeError,
} from '../upgrade/schema-gap.js';
import { resolveMycoPackageCheck } from '../upgrade/checker.js';
import { readProjectReleaseChannel } from '../daemon/update-checker.js';
import { resolveMycoHome } from '../grove/paths.js';
import { readInstallMarker, managedBinaryPath } from '../install/managed-binary.js';
import { isMemberHome } from '../member/home-role.js';
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
  --channel <alpha|beta|stable>      Upgrade on this channel, this run only
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
  /** Place a verified member binary without a local daemon. */
  adoptStaged?: typeof adoptStaged;
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
  /** Inject the update-check function (for positive --check tests). */
  checkFn?: typeof resolveMycoPackageCheck;
  /** Resolve this machine's target triple (process.platform/arch by default). */
  targetTriple?: () => TargetTriple;
  /** Inject the vault-side schema scan (downgrade schema-gap guard). */
  readMaxStampedSchemaVersion?: typeof readMaxStampedSchemaVersion;
  /** Inject the target-binary supported-schema read (downgrade schema-gap guard). */
  readSupportedSchemaVersion?: typeof readSupportedSchemaVersion;
  /** Whether the home is a member's (`member/home-role.ts`). */
  isMemberHome?: (home: string) => boolean;
  /** Refresh a member home's agent setup with the adopted binary. */
  refreshMember?: (binary: string, home: string) => Promise<void>;
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
    console.error(`myco upgrade: --channel must be 'alpha', 'beta' or 'stable'; got '${channelArg}'`);
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

  // A channel named here is this run's: nothing is saved, so the next upgrade uses the machine's own again.
  if (channelArg) console.log(`Upgrading on the '${channelArg}' channel for this run; it is not saved.`);

  const currentVersion = deps.currentVersion ?? getPluginVersion();

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

  const isV2 = (semver.parse(currentVersion)?.major ?? 0) >= 2;
  if (isV2 && !selectChannelRelease([{ tag_name: `myco/v${refs.targetVersion}`, prerelease: semver.prerelease(refs.targetVersion) !== null, assets: [] }], channel, { currentVersion })) {
    console.log(`Channel target ${refs.targetVersion} is older or outside '${channel}'; staying put at ${currentVersion}.`);
    return;
  }

  console.log(`Upgrading myco ${currentVersion} → ${refs.targetVersion}…`);

  const home = deps.home ?? resolveMycoHome();
  const platform = deps.platform ?? (process.platform as NodeJS.Platform);
  const localAppData = deps.localAppData ?? process.env.LOCALAPPDATA;

  // Schema-gap guard: a target whose supported storage format is below any
  // local Grove's stamped version would refuse to start after the swap.
  // Refused BEFORE staging — the download is pointless.
  //
  // Two triggers:
  // - version-lower target (explicit version / channel switch past the
  //   no-downgrade rule): stamp unknown fails closed;
  // - KNOWN stamp below the vault, regardless of version direction —
  //   version order is not schema order when the running binary carries a
  //   dev version (`0.0.0-dev+…` compares below every release, so a real
  //   downgrade registers as forward). Unknown stamps stay allowed here:
  //   a genuinely newer release has no stamp until it first boots.
  {
    const semver = await import('semver');
    const readVaultSchema = deps.readMaxStampedSchemaVersion ?? readMaxStampedSchemaVersion;
    const readTargetSchema = deps.readSupportedSchemaVersion ?? readSupportedSchemaVersion;
    const versionLower = semver.valid(refs.targetVersion)
      && semver.valid(currentVersion)
      && semver.lt(refs.targetVersion, currentVersion);
    const targetSchema = readTargetSchema(home, platform, refs.targetVersion, localAppData);
    if (versionLower || targetSchema !== null) {
      const vaultSchema = readVaultSchema(home);
      const crossesGap = versionLower
        ? rollbackWouldCrossSchemaGap(vaultSchema, targetSchema)
        : vaultSchema !== null && targetSchema !== null && targetSchema < vaultSchema;
      if (crossesGap) {
        const refusal = new SchemaGapDowngradeError(refs.targetVersion, vaultSchema!, targetSchema);
        console.error(`myco upgrade: ${refusal.message}`);
        process.exit(1);
      }
    }
  }

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

  // Adopt the verified staged binary.
  console.log('  Adopting…');

  // Installed member binaries retain the destination recorded by their installer.
  const mycoBinary = deps.mycoBinary
    ?? (isV2 ? readInstallMarker(home, true)?.bin : undefined)
    ?? resolveBinary('managed-destination', { kind: 'machine' }, { mycoHome: home, platform, localAppData }).path;
  const projectRoot = deps.projectRoot ?? process.cwd();
  const daemonPort = deps.daemonPort ?? resolveGlobalDaemonPort();

  if (isV2) {
    if (platform === 'win32') throw new Error('Myco 2.0 member binary updates on Windows are not supported yet; the installed binary is unchanged.');
    await (deps.adoptStaged ?? adoptStaged)({ home, platform, localAppData, version: stageResult.version, destination: mycoBinary });
    console.log(`myco ${stageResult.version} is now active.`);
    if ((deps.isMemberHome ?? isMemberHome)(home)) await (deps.refreshMember ?? refreshMemberSetup)(mycoBinary, home);
    return;
  }

  // Resolve the restart-routing label at adopt time, keyed on the installed
  // unit (not pid-identity): the CLI never shares the daemon's pid, so a
  // pid-match would always miss and force an unsupervised direct spawn even on
  // a service-managed machine.
  const { getServiceManager } = await import('../service/manager.js');
  const { resolveRestartServiceLabel } = await import('../daemon/api/restart.js');
  const serviceManagedLabel = await resolveRestartServiceLabel(getServiceManager());

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
  // The adopted binary refreshes a member home's hooks, MCP entries and skill links.
  if ((deps.isMemberHome ?? isMemberHome)(home)) await (deps.refreshMember ?? refreshMemberSetup)(mycoBinary, home);
}

/** Run the adopted binary's `member provision --refresh` for `home`, reporting its lines; a refresh that fails names the command to run by hand. */
async function refreshMemberSetup(binary: string, home: string): Promise<void> {
  const { spawnSync } = await import('node:child_process');
  const ran = spawnSync(binary, ['member', 'provision', '--refresh'], { env: { ...process.env, MYCO_HOME: home }, encoding: 'utf8', timeout: 120_000 });
  for (const line of `${ran.stdout ?? ''}`.split('\n').filter((l) => l.trim() !== '')) console.log(`  ${line}`);
  if (ran.status !== 0) console.error(`  Your agents' Myco setup was not refreshed${ran.stderr ? ` (${ran.stderr.trim().split('\n')[0]})` : ''}; run \`myco member provision --refresh\`.`);
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
  } else if (checkResult.staying_put) {
    console.log(`The newest eligible '${channel}' release is older than installed ${currentVersion}; staying put.`);
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

  const resolveRefsFn = deps.resolveRefs ?? ((ch: ReleaseChannel) => resolveMycoBinaryUpdateRefs(ch, undefined, deps.currentVersion ?? getPluginVersion()));
  return resolveRefsFn(channel);
}

async function defaultFetchReleases(): Promise<GitHubRelease[]> {
  return fetchMycoReleases();
}
