/**
 * The worker login service, as the CLI asks for it: install it where one
 * belongs, remove it, and say what state it is in.
 *
 * `myco worker install|uninstall|status`, `member join`, `member leave`,
 * `member status` and `myco doctor` all go through here, so each says the same
 * thing about the same unit.
 */
import { resolveHomeDir, resolveMycoHome } from '../paths/home.js';
import { deploymentUrl, readDeploymentMembership } from '../member/registry.js';
import { detectHarnesses, type DetectedHarness } from '../runner/detect.js';
import {
  harnessDirectories,
  installWorkerService,
  uninstallWorkerService,
  workerServiceLogs,
  workerServiceRefusal,
  workerServiceStatus,
  type WorkerServiceRefusal,
  type WorkerServiceStatus,
  type WorkerServiceTarget,
} from '../runner/service.js';
import { assertInstalledBinary, ServicePathUnsupported, ServicePlatformUnsupported, type ServiceOutcome, type ServiceRunner } from '../server/service.js';

/** What the service verbs read and run, each replaceable so a caller never hands a unit to the real platform by accident. */
export interface WorkerServiceDeps {
  mycoHome?: string;
  /** The user's home directory. */
  home?: string;
  /** The installed binary a unit runs; defaults to this process's executable. */
  binaryPath?: string;
  platform?: NodeJS.Platform;
  runner?: ServiceRunner;
  detect?: () => readonly DetectedHarness[];
  harnessDirs?: () => readonly string[];
  /** The addresses this machine's own native Deployment answers at. */
  ownDeploymentUrls?: (mycoHome: string) => Promise<readonly string[]>;
  lockDir?: string;
}

/** The addresses this machine's native Deployment answers at, or none when it runs none from this home. */
async function nativeDeploymentUrls(mycoHome: string): Promise<readonly string[]> {
  const { localDeploymentPresent, localDeploymentUrls, readLocalRecord, resolveLocalPaths } = await import('../server/local.js');
  const paths = resolveLocalPaths(mycoHome);
  return localDeploymentPresent(paths) ? localDeploymentUrls(readLocalRecord(paths)) : [];
}

function targetOf(serverUrl: string, deps: WorkerServiceDeps): WorkerServiceTarget {
  return {
    serverUrl: deploymentUrl(serverUrl),
    mycoHome: deps.mycoHome ?? resolveMycoHome({ cwd: process.cwd() }),
    binaryPath: deps.binaryPath ?? process.execPath,
    home: deps.home ?? resolveHomeDir(),
    ...(deps.platform === undefined ? {} : { platform: deps.platform }),
  };
}

/** What asking for a worker service came to. */
export type EnsureWorkerOutcome =
  | { kind: 'installed'; outcome: ServiceOutcome; outLog: string }
  | { kind: 'refused'; refusal: WorkerServiceRefusal }
  | { kind: 'unsupported'; detail: string };

/**
 * Install the worker service for one Deployment, when one belongs on this
 * machine; say why not when it does not. Installing twice leaves the first
 * install's worker running.
 */
export async function ensureWorkerService(serverUrl: string, deps: WorkerServiceDeps = {}): Promise<EnsureWorkerOutcome> {
  const target = targetOf(serverUrl, deps);
  try {
    assertInstalledBinary(target.binaryPath);
  } catch (error) {
    if (error instanceof ServicePathUnsupported) return { kind: 'unsupported', detail: error.message };
    throw error;
  }
  const refusal = workerServiceRefusal(target.serverUrl, {
    member: readDeploymentMembership(target.serverUrl, target.mycoHome) !== null,
    ownDeploymentUrls: await (deps.ownDeploymentUrls ?? nativeDeploymentUrls)(target.mycoHome),
    harnesses: (deps.detect ?? detectHarnesses)(),
  });
  if (refusal !== null) return { kind: 'refused', refusal };
  try {
    const outcome = installWorkerService(target, (deps.harnessDirs ?? harnessDirectories)(), deps.runner === undefined ? {} : { runner: deps.runner });
    return { kind: 'installed', outcome, outLog: workerServiceLogs(target).outLog };
  } catch (error) {
    if (error instanceof ServicePathUnsupported || error instanceof ServicePlatformUnsupported) return { kind: 'unsupported', detail: error.message };
    throw error;
  }
}

export function removeWorkerService(serverUrl: string, deps: WorkerServiceDeps = {}): { unitFile: string; removed: boolean } | { unsupported: string } {
  try {
    return uninstallWorkerService(targetOf(serverUrl, deps), deps.runner === undefined ? {} : { runner: deps.runner });
  } catch (error) {
    if (error instanceof ServicePlatformUnsupported) return { unsupported: error.message };
    throw error;
  }
}

function serviceOptions(deps: WorkerServiceDeps): { runner?: ServiceRunner; lockDir?: string } {
  return {
    ...(deps.runner === undefined ? {} : { runner: deps.runner }),
    ...(deps.lockDir === undefined ? {} : { lockDir: deps.lockDir }),
  };
}

/** The worker service for one Deployment, or null on a platform that defines no service. */
export function describeWorkerService(serverUrl: string, deps: WorkerServiceDeps = {}): WorkerServiceStatus | null {
  try {
    return workerServiceStatus(targetOf(serverUrl, deps), serviceOptions(deps));
  } catch (error) {
    if (error instanceof ServicePlatformUnsupported) return null;
    throw error;
  }
}

/** One line naming a worker service's state, for `member status` and `myco doctor`. */
export function workerServiceWords(status: WorkerServiceStatus | null): { ok: boolean; line: string } {
  if (status === null) return { ok: false, line: 'this platform has no login service for a worker; run `myco worker --server <url>` to attach one' };
  const serving = status.serving === null ? null : `process ${status.serving.pid} is serving this Deployment`;
  if (!status.installed) {
    return serving === null
      ? { ok: false, line: 'not installed, and no worker on this machine serves this Deployment — run `myco worker install`' }
      : { ok: true, line: `not installed; ${serving} (started outside the login service)` };
  }
  if (!status.loaded) return { ok: false, line: `installed and not running (${status.detail ?? 'the platform is not holding it'}) — see ${status.errLog}` };
  return serving === null
    ? { ok: false, line: `running at login, and no worker holds this Deployment yet — see ${status.errLog}` }
    : { ok: true, line: `running at login; ${serving}. Logs: ${status.outLog}` };
}

