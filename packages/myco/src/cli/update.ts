/** `myco update` resolves, verifies and adopts a binary within the selected channel. */

import path from 'node:path';
import semver from 'semver';
import { automaticUpdatesEnabled, readInstallMarker } from '@myco/install/marker-reader.js';
import { validateSourceIntent } from '@myco/install/adoption.js';
import { setAutomaticUpdates } from '@myco/member/automatic-update-state.js';
import { parseStrictFlags } from './args.js';
import { updateBinary, binaryUpdatePath, admitsUpdate, explicitUpdateRefusal, resolveAssetRefsForTarget, type BinaryUpdateDeps } from '../upgrade/guarded-binary.js';
import { claimSubsystem, readClaim, SYMBIONT_CONFIG_SUBSYSTEM } from '../member/subsystem-claim.js';
import { resolveMycoPackageCheck } from '../upgrade/checker.js';
import { isDefaultMycoHome, resolveMycoHome } from '../paths/home.js';
import { refreshMemberSetup } from '../member/refresh-setup.js';
import { readRunnerUpdateState } from '../runner/update.js';
import { isMemberHome } from '../member/home-role.js';
import { getPluginVersion } from '../version.js';
import { listRunnerRecords, isLiveRunner } from '../runner/runner-registry.js';
import { recordUpdateCheck, effectiveUpdateChannel } from '../upgrade/check-cache.js';
import { workerServiceInstalled } from '../runner/service.js';
import { executorServiceTarget } from './worker-service.js';
import { RELEASE_CHANNELS, type ReleaseChannel } from '../constants/update.js';
import { readProvisionRecord } from '@myco/member/provision-record.js';

export const UPDATE_HELP = `Usage: myco update [options] [<version>]

Update this machine's Myco within its recorded release channel, then refresh
member agent setup. Runners update only between runs. Channel updates never
downgrade. Without an installed runner, an explicit version can step back.

A skipped release update says why; agent setup still refreshes. A refused
source install exits before refresh. A failed replacement restores the previous
version and reports the rollback.
Supports macOS, Linux and Windows.

Alias: myco upgrade

Arguments:
  <version>                    Update to this exact version (e.g. 2.0.0-alpha.3)

Options:
  --now                        Update immediately (identical to bare \`myco update\`)
  --check                      Report available updates only — never adopt
  --skip-binary                Keep this binary; still refresh agent setup
  --claim                      Take responsibility for this machine's agent setup
  --target-version <version>   Update to this exact version (flag form)
  --channel <alpha|beta|stable>      Update on this channel, this run only
  --automatic <off|on>         Turn automatic member updates off or on; no update run
  --source-checkout <path>     Adopt this running source build from an absolute checkout
  --source-commit <commit>     Record its full 40-hex commit (requires --source-checkout)
  -h, --help                   Show this help
`;

export { effectiveUpdateChannel } from '../upgrade/check-cache.js';

export interface UpgradeDeps extends BinaryUpdateDeps {
  /** Inject the update-check function (for positive --check tests). */
  checkFn?: typeof resolveMycoPackageCheck;
  /** Whether the home is a member's (`member/home-role.ts`). */
  isMemberHome?: (home: string) => boolean;
  /** Refresh a member home's agent setup with the adopted binary. */
  refreshMember?: (binary: string, home: string) => Promise<void>;
  runnerRecords?: typeof listRunnerRecords;
  runRunner?: typeof import('./runner.js').run;
  runnerServiceInstalled?: (serverUrl: string, home: string) => boolean;
  automaticUpdateWaitMs?: number;
}

function liveInstalledRunners(home: string, deps: UpgradeDeps) {
  return (deps.runnerRecords ?? listRunnerRecords)(home).filter(isLiveRunner).filter(record =>
    (deps.runnerServiceInstalled ?? ((serverUrl, mycoHome) => workerServiceInstalled(executorServiceTarget(serverUrl, { mycoHome, binaryPath: deps.mycoBinary, platform: deps.platform }, 'runner'))))(record.serverUrl, home));
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
  const VALUE_FLAGS = new Set(['--target-version', '--channel', '--automatic', '--source-checkout', '--source-commit']);
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
    { name: '--skip-binary' },
    { name: '--claim' },
    { name: '--target-version', value: 'required' },
    { name: '--channel', value: 'required' },
    { name: '--automatic', value: 'required' },
    { name: '--source-checkout', value: 'required' },
    { name: '--source-commit', value: 'required' },
    { name: '--help', aliases: ['-h'] },
  ], UPDATE_HELP);

  // --target-version wins over positional.
  const targetVersionArg = parsed.value('--target-version') ?? positionalVersion;
  const sourceCheckout = parsed.value('--source-checkout');
  const sourceCommit = parsed.value('--source-commit');
  const currentVersion = deps.currentVersion ?? getPluginVersion();
  let source: { checkout: string; commit: string } | undefined;
  if (sourceCheckout !== undefined || sourceCommit !== undefined) {
    if (sourceCheckout === undefined || sourceCommit === undefined) throw new Error('myco update: --source-checkout and --source-commit are required together');
    if (targetVersionArg !== null || ['--check', '--skip-binary', '--channel', '--automatic'].some(flag => parsed.has(flag))) {
      throw new Error('myco update: installing a source build cannot be combined with a version, --check, --skip-binary, --channel or --automatic');
    }
    validateSourceIntent(sourceCheckout, sourceCommit, currentVersion);
    source = { checkout: sourceCheckout, commit: sourceCommit };
  }
  const automatic = parsed.value('--automatic');
  if (automatic !== undefined) {
    if (automatic !== 'off' && automatic !== 'on') {
      console.error("myco update: --automatic must be 'off' or 'on'");
      process.exit(1);
    }
    if (targetVersionArg !== null || ['--channel', '--check', '--skip-binary', '--now', '--claim'].some(flag => parsed.has(flag))) {
      console.error('myco update: --automatic cannot be combined with a version or other update options');
      process.exit(1);
    }
    const home = deps.home ?? resolveMycoHome();
    setAutomaticUpdates(home, automatic === 'on', deps.automaticUpdateWaitMs);
    console.log(`Automatic updates are turned ${automatic}.`);
    if (automatic === 'off') {
      try {
        if (liveInstalledRunners(home, deps).length > 0) console.log('Installed runners still update themselves between runs within their recorded release channel.');
      } catch (error) {
        console.warn(`Could not check whether installed runners will keep updating: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return;
  }

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

  // The install marker owns the default release channel.
  const channel: ReleaseChannel = (channelArg as ReleaseChannel | undefined) ?? effectiveUpdateChannel(home);
  const memberHome = () => (deps.isMemberHome ?? isMemberHome)(home);

  const refresh = async (): Promise<void> => {
    if (!memberHome()) {
      console.log('Agents refreshed: no (this home is not a member machine).');
      return;
    }
    const owner = readClaim(SYMBIONT_CONFIG_SUBSYSTEM);
    if (owner !== null && owner.owner !== path.resolve(home)) {
      console.log(`Agents refreshed: no (global agent setup is managed by ${owner.owner}).`);
      return;
    }
    const binary = binaryUpdatePath(home, deps);
    try {
      await (deps.refreshMember ?? refreshMemberSetup)(binary, home);
      const claim = readClaim(SYMBIONT_CONFIG_SUBSYSTEM);
      if (claim !== null && claim.owner !== path.resolve(home)) console.log(`Agents refreshed: no (global agent setup is managed by ${claim.owner}).`);
      else {
        const record = readProvisionRecord(home);
        if (record?.agents.length === 0) console.log('Agents refreshed: no.');
        else console.log('Agents refreshed: yes.');
      }
    } catch (error) {
      console.error(`Agents refreshed: no (${error instanceof Error ? error.message : String(error)}). Next: myco member provision --refresh`);
      process.exitCode = 1;
    }
  };

  if (!isCheck && parsed.has('--claim')) {
    const previous = readClaim(SYMBIONT_CONFIG_SUBSYSTEM);
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, path.resolve(home));
    if (readClaim(SYMBIONT_CONFIG_SUBSYSTEM)?.owner !== path.resolve(home)) throw new Error('Could not take responsibility for this machine’s agent setup.');
    console.log('This Myco home now manages this machine’s agent setup.');
    if (memberHome()) {
      const { claimMemberAgents } = await import('./member.js');
      claimMemberAgents(home, previous?.owner === path.resolve(home) ? undefined : previous?.owner);
    }
  }

  const runners = liveInstalledRunners(home, deps);
  const replacingSource = !source && readInstallMarker(home)?.source === 'checkout';
  if (runners.length > 0) {
    const summaries = new Set<string>();
    const runner = deps.runRunner ?? (await import('./runner.js')).run;
    if (parsed.has('--skip-binary')) console.log('Myco: binary update skipped (--skip-binary requested).');
    for (const record of parsed.has('--skip-binary') ? [] : runners) {
      const selection = [...(channelArg ? ['--channel', channelArg] : []), ...(targetVersionArg ? ['--target-version', targetVersionArg] : [])];
      const ok = await runner(['update', '--server', record.serverUrl, ...(isCheck ? ['--check'] : []), ...selection], { mycoHome: home,
        ...(source ? { sourceArtifact: { binaryPath: deps.sourceBinary ?? process.execPath, version: currentVersion, ...source } } : {}), stdout: line => {
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

  const outcome = await updateBinary('manual', { skipBinary: parsed.has('--skip-binary'), targetVersion: targetVersionArg, channel, source }, { ...deps, home, currentVersion });
  if (outcome.kind === 'skipped') {
    console.log(`Myco: binary update skipped (${outcome.reason}).`);
    if (source) { process.exitCode = 1; return; }
  }
  else if (outcome.kind === 'failed') {
    console.error(`Myco: update failed (${outcome.reason}).`);
    process.exitCode = 1;
  } else if (outcome.kind === 'rolled-back') {
    console.error(`Myco: update rolled back to ${outcome.version} (${outcome.reason}).`);
    process.exitCode = 1;
  } else if (outcome.kind === 'adopted') {
    if (replacingSource) console.log('Replacing this source build with the selected channel release.');
    const change = outcome.previousVersion === undefined ? `Installed ${outcome.version}` : `from ${outcome.previousVersion} to ${outcome.version}`;
    console.log(`Myco: ${change}${source ? ' (source build)' : ` on channel ${channel}`}.`);
  } else if (replacingSource) {
    console.log(`Myco: kept source build ${outcome.version}; no eligible release on the '${channel}' channel (${outcome.reason}).`);
    console.log('Choose a release channel with `myco update --channel alpha`, `--channel beta` or `--channel stable`.');
  } else console.log(`Myco: from ${currentVersion} to ${outcome.version} on channel ${channel} (${outcome.reason}).`);
  if ('retainedPrevious' in outcome) for (const retained of outcome.retainedPrevious ?? []) console.log(`Update files were kept at ${retained.path} (${retained.reason}).`);
  for (const warning of outcome.warnings ?? []) console.log(warning);
  if (targetVersionArg !== null && outcome.kind === 'adopted' && outcome.previousVersion !== undefined
    && semver.lt(outcome.version, outcome.previousVersion) && automaticUpdatesEnabled(home) && isDefaultMycoHome(home) && memberHome()) {
    console.log('Automatic updates will move this machine forward again; run `myco update --automatic off` to stay on this version.');
  }
  await refresh();
  if (source && outcome.kind === 'adopted' && !memberHome()) console.log('Next: myco setup');
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
    const eligible = admitsUpdate(refs.targetVersion, currentVersion, channel, true);
    console.log(`Myco: from ${currentVersion} to ${eligible ? refs.targetVersion : currentVersion} on channel ${channel} (check only${eligible ? '' : `; ${explicitUpdateRefusal(refs.targetVersion, currentVersion, channel)}`}).`);
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
