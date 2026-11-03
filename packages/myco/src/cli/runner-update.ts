/** Runner update commands share the supervisor's release and binary handoff capability. */
import { readInstallMarker } from '@myco/install/marker-reader.js';
import { recordUpdateCheck } from '../upgrade/check-cache.js';
import { getPluginVersion } from '../version.js';
import fs from 'node:fs';
import path from 'node:path';
import { resolveMycoHome } from '../paths/home.js';
import { holdWorkerInstance, workerHolder, workerLockDir } from '../runner/instance.js';
import { isLiveRunner, readRunnerRecord } from '../runner/runner-registry.js';
import { workerServiceSpec, installedRunnerTarget, workerServiceStatus } from '../runner/service.js';
import { runnerProgramVersion } from '../runner/program.js';
import { createRunnerUpdateController, readRunnerUpdateState, runnerUpdateStatePath, type RunnerLocalArtifactInput, type RunnerUpdateController, type RunnerUpdateDeps, type RunnerUpdateSelection } from '../runner/update.js';
import { runRunnerUpdateHelper, type RunnerUpdateHelperDeps } from '../runner/update-helper.js';
import { startService, stopService } from '../server/service.js';
import { RUNNER_REQUEST_TIMEOUT_MS } from '../runner/request.js';
import { executorServiceTarget, executionDeploymentUrls } from './worker-service.js';
import type { RunnerServiceDeps } from './runner-service.js';

export interface RunnerUpdateCliDeps extends RunnerServiceDeps {
  update?: RunnerUpdateDeps;
  updateHelper?: RunnerUpdateHelperDeps;
  version?: string;
  programVersion?: (file: string) => string;
  sourceArtifact?: RunnerLocalArtifactInput;
}

export function runnerUpdater(serverUrl: string, deps: RunnerUpdateCliDeps, log: (line: string) => void, running = false): RunnerUpdateController {
  const home = deps.mycoHome ?? resolveMycoHome();
  const caller = executorServiceTarget(serverUrl, { ...deps, mycoHome: home }, 'runner');
  let unavailable = false;
  let installed = caller;
  try { installed = installedRunnerTarget(caller); }
  catch (error) {
    if (!running) throw error;
    unavailable = true;
    log('runner update service metadata unavailable: ' + String(error));
  }
  const foreground = running && path.resolve(caller.binaryPath) !== path.resolve(installed.binaryPath);
  const target = foreground ? caller : installed;
  if (foreground) log('foreground runner uses another program; service updates require the installed runner');
  let currentVersion = deps.version ?? getPluginVersion();
  if (!running && (deps.sourceArtifact !== undefined || (deps.version === undefined && path.resolve(target.binaryPath) !== path.resolve(process.execPath)))) {
    if (!fs.existsSync(target.binaryPath)) { currentVersion = 'unknown'; log('installed runner program is unavailable'); }
    else try { currentVersion = (deps.programVersion ?? runnerProgramVersion)(target.binaryPath); }
    catch (error) { currentVersion = 'unknown'; log(error instanceof Error ? error.message : String(error)); }
  }
  return createRunnerUpdateController({
    serverUrl, home, binaryPath: target.binaryPath, currentVersion,
    serviceSpec: workerServiceSpec(target, []), platform: deps.platform, log,
    deps: { ...deps.update, ...(foreground || unavailable ? { serviceInstalled: () => false } : {}), ...(deps.now === undefined ? {} : { now: deps.now }) },
  });
}

/** Check immediately, or queue the same idle operation the running supervisor executes. */
export async function updateRunner(serverUrl: string, checkOnly: boolean, deps: RunnerUpdateCliDeps, selection: RunnerUpdateSelection = {}, immediate = false): Promise<boolean> {
  if (!immediate) return updateRunnerIdle(serverUrl, checkOnly, deps, selection);
  if (checkOnly) throw new Error('--now and --check cannot be combined');
  const home = deps.mycoHome ?? resolveMycoHome();
  if (!isLiveRunner(readRunnerRecord(serverUrl, home))) throw new Error(`this machine is not registered with ${serverUrl}`);
  const target = installedRunnerTarget(executorServiceTarget(serverUrl, { ...deps, mycoHome: home }, 'runner'));
  const spec = workerServiceSpec(target, []);
  const options = { platform: target.platform, runner: deps.runner };
  if (!workerServiceStatus(target, options).installed) throw new Error('runner service is not installed; run myco runner install first');
  const out = deps.stdout ?? console.log;
  out('Stopping runner service for immediate update.');
  try {
    stopService(spec, options);
    if (workerServiceStatus(target, options).running) throw new Error('runner service did not stop; no update applied');
    out('Applying runner update under the instance lock.');
    return await updateRunnerIdle(serverUrl, false, { ...deps, binaryPath: target.binaryPath }, selection, true);
  } finally {
    const pending = readRunnerUpdateState(home);
    if (target.platform === 'win32' && pending.guardian && pending.transaction?.ownerPid === process.pid) {
      out('The update helper starts the runner service after this command exits.');
    } else {
      out('Starting runner service.');
      const started = startService(spec, options);
      if (!started.running) throw new Error(started.detail ?? 'runner service did not start');
    }
  }
}

async function updateRunnerIdle(serverUrl: string, checkOnly: boolean, deps: RunnerUpdateCliDeps, selection: RunnerUpdateSelection, immediate = false): Promise<boolean> {
  const out = deps.stdout ?? console.log;
  const home = deps.mycoHome ?? resolveMycoHome();
  const record = readRunnerRecord(serverUrl, home);
  if (!isLiveRunner(record)) throw new Error(`this machine is not registered with ${serverUrl}; run \`myco runner register ${serverUrl}\` first`);
  const update = runnerUpdater(serverUrl, deps, out);
  const leavingSource = deps.sourceArtifact === undefined && readInstallMarker(home)?.source === 'checkout';
  const summary = (suffix: string, checked?: ReturnType<RunnerUpdateController['statusPayload']>): void => {
    const status = checked ?? update.statusPayload();
    const transaction = readRunnerUpdateState(home).transaction;
    const target = checked ? checked.latestVersion ?? checked.currentVersion
      : transaction?.toVersion ?? status.lastResult?.toVersion ?? status.currentVersion;
    const channel = checked?.channel ?? selection.channel ?? transaction?.installMarker.channel ?? status.channel ?? 'unavailable';
    out(`Myco: from ${status.currentVersion} to ${target} on channel ${channel} (${suffix}).`);
  };
  if (checkOnly) {
    const status = await update.check(selection);
    const recordedChannel = update.statusPayload().channel;
    if (recordedChannel !== null && selection.targetVersion === undefined
      && (selection.channel === undefined || selection.channel === recordedChannel)) {
      recordUpdateCheck(home, recordedChannel, status.currentVersion, status.latestVersion);
    }
    out(`${status.currentVersion} (${status.channel ?? 'channel unavailable'}): ${status.latestVersion === null || status.latestVersion === status.currentVersion ? 'no newer release' : `update available: ${status.latestVersion}`}`);
    summary('check only', status);
    return status.channel !== null;
  }
  const lockDir = deps.lockDir ?? workerLockDir(deps.home);
  const aliases = await executionDeploymentUrls(serverUrl, deps);
  let instance = holdWorkerInstance(lockDir, aliases, record.deploymentId);
  const deadline = performance.now() + RUNNER_REQUEST_TIMEOUT_MS;
  const lockPollMs = 100;
  while (immediate && !instance.held && performance.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, lockPollMs));
    instance = holdWorkerInstance(lockDir, aliases, record.deploymentId);
  }
  if (immediate && !instance.held) throw new Error('runner did not release its instance lock; no update applied');
  const queue = (): void => {
    if (deps.sourceArtifact) update.queueLocal(deps.sourceArtifact);
    else update.queueManual(selection);
  };
  if (!instance.held) {
    if (deps.sourceArtifact) {
      const capability = readRunnerUpdateState(home).runtimeCapabilities?.[serverUrl];
      const holder = workerHolder(lockDir, serverUrl);
      if (holder === null || holder.pid !== instance.holder?.pid || capability?.localArtifacts !== true
        || capability.pid !== holder.pid || capability.lockStartedAt !== holder.startedAt) {
        out('Source adoption was not queued because the active runner has not confirmed support. Wait for it to become idle, or stop it through its normal controls, then retry this source install.');
        return false;
      }
    }
    queue();
    if (leavingSource) out('Source build replacement with the selected channel release is queued; the binary stays unchanged until the runner is idle.');
    summary('queued; binary unchanged until the runner is idle');
    out(`Runner is busy; the update is queued for between runs. Next: myco runner status --server ${serverUrl}`);
    return true;
  }
  let result: Awaited<ReturnType<RunnerUpdateController['idle']>>;
  try {
    // Windows requires the process holding the executable to exit before its replacement.
    const applyHere = immediate && (deps.platform ?? process.platform) !== 'win32';
    queue(); result = await update.idle(applyHere ? 'caller' : undefined);
    if (applyHere && result === 'restart') {
      const target = installedRunnerTarget(executorServiceTarget(serverUrl, deps, 'runner'));
      const options = { platform: target.platform, runner: deps.runner };
      await runRunnerUpdateHelper(runnerUpdateStatePath(home), {
        ...deps.updateHelper,
        now: deps.updateHelper?.now ?? deps.now,
        alive: pid => {
          if (pid === process.pid) return false;
          if (deps.updateHelper?.alive) return deps.updateHelper.alive(pid);
          try { process.kill(pid, 0); return true; }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
        },
        stop: spec => stopService(spec, options),
        stopped: () => !workerServiceStatus(target, options).running,
        start: spec => {
          instance.release();
          out('Starting runner service with the updated program.');
          return deps.updateHelper?.start?.(spec, target.platform ?? process.platform) ?? startService(spec, options);
        },
      });
      result = 'continue';
    }
  } finally { instance.release(); }
  if (result === 'restart') {
    if (leavingSource) out('Source build replacement with the selected channel release is staged; the runner handoff is pending.');
    summary('verified and staged; awaiting idle service handoff');
    out('Verified update staged; the service restarts after this command exits.');
    return true;
  }
  if (result === 'hold') { summary('awaiting restart or health verification'); out('A runner update is already awaiting restart or health verification.'); return true; }
  summary('runner update result');
  const status = update.statusPayload();
  const receipt = status.lastResult;
  out(receipt === undefined ? 'Update check deferred; check runner status for the next check.' : `${receipt.result}: ${receipt.fromVersion} → ${receipt.toVersion}${receipt.reason === undefined ? '' : ` (${receipt.reason})`}`);
  return receipt?.result === 'no_update' || receipt?.result === 'updated';
}
