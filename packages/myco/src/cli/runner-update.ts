/** Runner update commands share the supervisor's release and binary handoff capability. */
import { getPluginVersion } from '../version.js';
import fs from 'node:fs';
import path from 'node:path';
import { resolveMycoHome } from '../paths/home.js';
import { holdWorkerInstance, workerLockDir } from '../runner/instance.js';
import { isLiveRunner, readRunnerRecord } from '../runner/runner-registry.js';
import { workerServiceSpec, installedRunnerTarget } from '../runner/service.js';
import { runnerProgramVersion } from '../runner/program.js';
import { createRunnerUpdateController, type RunnerUpdateController, type RunnerUpdateDeps } from '../runner/update.js';
import type { RunnerUpdateHelperDeps } from '../runner/update-helper.js';
import { executorServiceTarget, executionDeploymentUrls } from './worker-service.js';
import type { RunnerServiceDeps } from './runner-service.js';

export interface RunnerUpdateCliDeps extends RunnerServiceDeps {
  update?: RunnerUpdateDeps;
  updateHelper?: RunnerUpdateHelperDeps;
  version?: string;
  programVersion?: (file: string) => string;
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
  if (!running && deps.version === undefined && path.resolve(target.binaryPath) !== path.resolve(process.execPath)) {
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
export async function updateRunner(serverUrl: string, checkOnly: boolean, deps: RunnerUpdateCliDeps): Promise<boolean> {
  const out = deps.stdout ?? console.log;
  const home = deps.mycoHome ?? resolveMycoHome();
  const record = readRunnerRecord(serverUrl, home);
  if (!isLiveRunner(record)) throw new Error(`this machine is not registered with ${serverUrl}; run \`myco runner register ${serverUrl}\` first`);
  const update = runnerUpdater(serverUrl, deps, out);
  if (checkOnly) {
    const status = await update.check();
    out(`${status.currentVersion} (${status.channel ?? 'channel unavailable'}): ${status.latestVersion === null || status.latestVersion === status.currentVersion ? 'no newer release' : `update available: ${status.latestVersion}`}`);
    return status.channel !== null;
  }
  update.queueManual();
  const instance = holdWorkerInstance(deps.lockDir ?? workerLockDir(deps.home), await executionDeploymentUrls(serverUrl, deps), record.deploymentId);
  if (!instance.held) {
    out('Update requested; the running runner applies it between runs. Check runner status for the result.');
    return true;
  }
  let result: Awaited<ReturnType<RunnerUpdateController['idle']>>;
  try { result = await update.idle(); } finally { instance.release(); }
  if (result === 'restart') {
    out('Verified update staged; the service restarts after this command exits.');
    return true;
  }
  if (result === 'hold') { out('A runner update is already awaiting restart or health verification.'); return true; }
  const status = update.contactPayload();
  const receipt = status.lastResult;
  out(receipt === undefined ? 'Update check deferred; check runner status for the next check.' : `${receipt.result}: ${receipt.fromVersion} → ${receipt.toVersion}${receipt.reason === undefined ? '' : ` (${receipt.reason})`}`);
  return receipt?.result === 'no_update' || receipt?.result === 'updated';
}
