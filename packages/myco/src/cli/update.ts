/** `myco update` resolves, verifies and adopts a binary within the selected channel. */

import semver from 'semver';
import { selectChannelRelease, isV2Version } from '../../scripts/release-policy.mjs';
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
  SchemaGapDowngradeError,
} from '../upgrade/schema-gap.js';
import { resolveMycoPackageCheck } from '../upgrade/checker.js';
import { resolveMycoHome } from '../grove/paths.js';
import { readInstallMarker } from '../install/managed-binary.js';
import { refreshMemberSetup } from '../member/refresh-setup.js';
import { readRunnerUpdateState } from '../runner/update.js';
import { isMemberHome } from '../member/home-role.js';
import { resolveGlobalDaemonPort } from '../daemon/service-state.js';
import { getPluginVersion } from '../version.js';
import { listRunnerRecords, isLiveRunner } from '../runner/runner-registry.js';
import { recordUpdateCheck, effectiveUpdateChannel } from '../upgrade/check-cache.js';
import { workerServiceInstalled } from '../runner/service.js';
import { executorServiceTarget } from './worker-service.js';
import { RELEASE_CHANNELS, type ReleaseChannel } from '../constants/update.js';

export const UPDATE_HELP = `Usage: myco update [options] [<version>]

Update this machine's Myco within its recorded release channel, then refresh
member agent setup. Runners update only between runs. Never downgrades.

Alias: myco upgrade

Arguments:
  <version>                    Update to this exact version (e.g. 2.0.0-alpha.3)

Options:
  --now                        Update immediately (identical to bare \`myco update\`)
  --check                      Report available updates only — never adopt
  --target-version <version>   Update to this exact version (flag form)
  --channel <alpha|beta|stable>      Update on this channel, this run only
  -h, --help                   Show this help
`;

export { effectiveUpdateChannel } from '../upgrade/check-cache.js';

function admitsUpdate(target: string, current: string, channel: ReleaseChannel): boolean {
  if (!semver.valid(target) || !semver.valid(current) || !semver.gt(target, current)) return false;
  return !isV2Version(current) || selectChannelRelease([{
    tag_name: `myco/v${target}`, prerelease: semver.prerelease(target) !== null, assets: [],
  }], channel, { currentVersion: current }) !== null;
}

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
  runnerRecords?: typeof listRunnerRecords;
  runRunner?: typeof import('./runner.js').run;
  runnerServiceInstalled?: (serverUrl: string, home: string) => boolean;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function run(args: string[], deps: UpgradeDeps = {}): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(UPDATE_HELP);
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
    else {
      console.error('myco update: name at most one version');
      process.exit(1);
    }
  }

  const parsed = parseStrictFlags('myco update', flagOnlyArgs, [
    { name: '--now' },
    { name: '--check' },
    { name: '--target-version', value: 'required' },
    { name: '--channel', value: 'required' },
    { name: '--help', aliases: ['-h'] },
  ], UPDATE_HELP);

  // --target-version wins over positional.
  const targetVersionArg = parsed.value('--target-version') ?? positionalVersion;

  // Semver gate for explicit version requests.
  const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
  if (targetVersionArg && !SEMVER_RE.test(targetVersionArg)) {
    console.error(
      `myco update: version must be a strict semver (e.g. 1.2.3); got '${targetVersionArg}'`,
    );
    process.exit(1);
  }

  // Validate channel arg.
  const channelArg = parsed.value('--channel');
  if (channelArg !== undefined && !RELEASE_CHANNELS.includes(channelArg as ReleaseChannel)) {
    console.error(`myco update: --channel must be 'alpha', 'beta' or 'stable'; got '${channelArg}'`);
    process.exit(1);
  }

  const isCheck = parsed.has('--check');
  const home = deps.home ?? resolveMycoHome();
  const currentVersion = deps.currentVersion ?? getPluginVersion();

  // The install marker owns the default release channel.
  const channel: ReleaseChannel = (channelArg as ReleaseChannel | undefined) ?? effectiveUpdateChannel(home);

  const refresh = async (): Promise<void> => {
    if (!(deps.isMemberHome ?? isMemberHome)(home)) {
      console.log('Agents refreshed: no (this home is not a member machine).');
      return;
    }
    const binary = deps.mycoBinary ?? readInstallMarker(home, true)?.bin
      ?? resolveBinary('managed-destination', { kind: 'machine' }, { mycoHome: home, platform: deps.platform }).path;
    try {
      await (deps.refreshMember ?? refreshMemberSetup)(binary, home);
      console.log('Agents refreshed: yes.');
    } catch (error) {
      console.error(`Agents refreshed: no (${error instanceof Error ? error.message : String(error)}). Next: myco member provision --refresh`);
      process.exitCode = 1;
    }
  };

  const finish = async (version: string, reason?: string): Promise<void> => {
    console.log(`Myco: from ${currentVersion} to ${version} on channel ${channel}${reason ? ` (${reason})` : ''}.`);
    await refresh();
  };

  const runners = (deps.runnerRecords ?? listRunnerRecords)(home).filter(isLiveRunner).filter(record =>
    (deps.runnerServiceInstalled ?? ((serverUrl, mycoHome) => workerServiceInstalled(executorServiceTarget(serverUrl, { mycoHome, binaryPath: deps.mycoBinary, platform: deps.platform }, 'runner'))))(record.serverUrl, home));
  if (runners.length > 0) {
    const summaries = new Set<string>();
    const runner = deps.runRunner ?? (await import('./runner.js')).run;
    for (const record of runners) {
      const selection = [...(channelArg ? ['--channel', channelArg] : []), ...(targetVersionArg ? ['--target-version', targetVersionArg] : [])];
      const ok = await runner(['update', '--server', record.serverUrl, ...(isCheck ? ['--check'] : []), ...selection], { mycoHome: home, stdout: line => {
        if (line.startsWith('Myco: ')) summaries.add(line.slice('Myco: '.length));
        else console.log(line);
      } });
      if (!ok) process.exitCode = 1;
    }
    if (summaries.size > 0) console.log(`Myco: ${[...summaries].join('; ')}`);
    const state = readRunnerUpdateState(home);
    if (isCheck) console.log('Agents refreshed: no (check only).');
    else if (state.transaction || Object.keys(state.requests ?? {}).length > 0) {
      console.log('Agents refreshed: no (runner update pending). Next: myco runner status; once idle, run myco update again to finish member setup if no binary handoff was needed.');
    } else await refresh();
    return;
  }

  // --check reports release availability and changes no binary or agent configuration.
  if (isCheck) {
    await runCheck(channel, deps, targetVersionArg);
    return;
  }

  // A channel override applies only to this invocation.
  if (channelArg) console.log(`Updating on the '${channelArg}' channel for this run; it is not saved.`);

  // Resolve the selected release assets.
  const refs = await resolveAssetRefsForTarget(targetVersionArg, channel, deps);
  if (!targetVersionArg) recordUpdateCheck(home, channel, currentVersion, refs?.targetVersion ?? currentVersion);
  if (!refs) {
    if (targetVersionArg) {
      console.error(`myco update: no release found for version ${targetVersionArg}`);
      process.exit(1);
    } else {
      await finish(currentVersion, 'no newer eligible release');
      return;
    }
  }

  if (!admitsUpdate(refs.targetVersion, currentVersion, channel)) {
    await finish(currentVersion, `channel target ${refs.targetVersion} is older or outside '${channel}'; staying put`);
    return;
  }
  const isV2 = isV2Version(currentVersion);

  console.log(`Updating Myco ${currentVersion} → ${refs.targetVersion}…`);

  const platform = deps.platform ?? (process.platform as NodeJS.Platform);
  const localAppData = deps.localAppData ?? process.env.LOCALAPPDATA;

  // A known target storage format must support every local Grove's stamped format.
  {
    const readVaultSchema = deps.readMaxStampedSchemaVersion ?? readMaxStampedSchemaVersion;
    const readTargetSchema = deps.readSupportedSchemaVersion ?? readSupportedSchemaVersion;
    const targetSchema = readTargetSchema(home, platform, refs.targetVersion, localAppData);
    if (targetSchema !== null) {
      const vaultSchema = readVaultSchema(home);
      if (vaultSchema !== null && targetSchema < vaultSchema) {
        const refusal = new SchemaGapDowngradeError(refs.targetVersion, vaultSchema, targetSchema);
        console.error(`myco update: ${refusal.message}`);
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
    console.error(`myco update: stage failed — ${stageResult.error}`);
    process.exit(1);
  }

  console.log(`  Staged ${stageResult.version} to ${stageResult.versionDir}`);

  // Adopt the verified staged binary.
  console.log('  Adopting…');

  // Installed member binaries retain the destination recorded by their installer.
  const mycoBinary = deps.mycoBinary
    ?? (isV2 ? readInstallMarker(home, true)?.bin : undefined)
    ?? resolveBinary('managed-destination', { kind: 'machine' }, { mycoHome: home, platform, localAppData }).path;
  if (isV2) {
    if (platform === 'win32') throw new Error('Myco 2.0 member binary updates on Windows are not supported yet; the installed binary is unchanged.');
    await (deps.adoptStaged ?? adoptStaged)({ home, platform, localAppData, version: stageResult.version, destination: mycoBinary });
    await finish(stageResult.version);
    return;
  }

  // Retained local runtimes restart through their installed service.
  const projectRoot = deps.projectRoot ?? process.cwd();
  const daemonPort = deps.daemonPort ?? resolveGlobalDaemonPort();
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

  await finish(stageResult.version);
}

// ---------------------------------------------------------------------------
// --check path
// ---------------------------------------------------------------------------

async function runCheck(channel: ReleaseChannel, deps: UpgradeDeps, target: string | null): Promise<void> {
  const currentVersion = deps.currentVersion ?? getPluginVersion();
  const channelFlag = channel === effectiveUpdateChannel(deps.home ?? resolveMycoHome()) ? '' : ` --channel ${channel}`;
  console.log(`Checking for updates on the '${channel}' channel…`);

  if (target !== null) {
    const refs = await resolveAssetRefsForTarget(target, channel, deps);
    if (refs === null) throw new Error(`myco update --check: no release found for version ${target}`);
    const eligible = admitsUpdate(refs.targetVersion, currentVersion, channel);
    console.log(`Myco: from ${currentVersion} to ${eligible ? refs.targetVersion : currentVersion} on channel ${channel} (check only${eligible ? '' : '; target is older or outside the channel; staying put'}).`);
    console.log('Agents refreshed: no (check only).');
    if (eligible) console.log(`Run \`myco update --target-version ${target}${channelFlag}\` to apply.`);
    return;
  }

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
      `myco update --check: failed to fetch releases — ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  recordUpdateCheck(deps.home ?? resolveMycoHome(), channel, currentVersion, checkResult.latest_version);
  console.log(`Myco: from ${currentVersion} to ${checkResult.latest_version ?? currentVersion} on channel ${channel} (check only).`);
  console.log('Agents refreshed: no (check only).');
  if (checkResult.update_available) {
    console.log(`Update available: ${currentVersion} → ${checkResult.latest_version}`);
    console.log(`Run \`myco update${channelFlag}\` to apply.`);
  } else if (checkResult.staying_put) {
    console.log(`The newest eligible '${channel}' release is older than installed ${currentVersion}; staying put.`);
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

/** Resolve a named release or the newest eligible release for this machine. */
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
