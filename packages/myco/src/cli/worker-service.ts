/** Shared executor service targets, lifecycle operations and diagnostics. */
import { listRunnerRecords } from '../runner/runner-registry.js';
import { REJOIN_HINT } from '../member/delivery-notice.js';
import fs from 'node:fs';
import path from 'node:path';
import { resolveHomeDir, resolveMycoHome } from '../paths/home.js';
import { isDefaultMycoHome } from '../grove/paths.js';
import { deploymentUrl, listDeploymentMemberships, readDeploymentMembership, readDeploymentMembershipResult } from '../member/registry.js';
import { type DetectedHarness } from '../runner/detect.js';
import { type WorkerAdmission } from '../runner/loop.js';
import { type TerminalRefusal } from '../runner/refusal.js';
import {
  listWorkerUnits,
  uninstallWorkerService,
  workerServiceStatus,
  type WorkerServiceStatus,
  type WorkerServiceTarget,
} from '../runner/service.js';
import { resolveBinary } from '../runtime/binary-resolution.js';
import { looksLikeDevBuildExecutable } from '../service/spec-builder.js';
import {
  assertInstalledBinary,
  ServicePathUnsupported,
  ServicePlatformUnsupported,
  uninstallService,
  type ServiceRunner,
  UNIT_NOT_HELD,
} from '../server/service.js';

/** What the service verbs read and run, each replaceable so a caller never hands a unit to the real platform by accident. */
export interface WorkerServiceDeps {
  mycoHome?: string;
  /** The user's home directory. */
  home?: string;
  /** The installed binary a unit runs; defaults to the binary policy for a service unit. */
  binaryPath?: string;
  platform?: NodeJS.Platform;
  runner?: ServiceRunner;
  detect?: () => readonly DetectedHarness[];
  harnessDirs?: () => readonly string[];
  /** The addresses this machine's own native Deployment answers at. */
  ownDeploymentUrls?: (mycoHome: string) => Promise<readonly string[]>;
  /** Whether the Deployment admits this home's credential as a worker. */
  admission?: (serverUrl: string, token: string) => Promise<WorkerAdmission>;
  lockDir?: string;
  now?: () => number;
}

/** The addresses this machine's native Deployment answers at, or none when it runs none from this home. */
export async function nativeDeploymentUrls(mycoHome: string): Promise<readonly string[]> {
  if (!fs.existsSync(path.join(mycoHome, 'server', 'local', 'server.json'))) return [];
  const { localDeploymentPresent, localDeploymentUrls, readLocalRecord, resolveLocalPaths } = await import('../server/local.js');
  const paths = resolveLocalPaths(mycoHome);
  return localDeploymentPresent(paths) ? localDeploymentUrls(readLocalRecord(paths)) : [];
}

/** Every recorded native alias is locked when the target names that Deployment. */
export async function executionDeploymentUrls(serverUrl: string, deps: WorkerServiceDeps = {}): Promise<readonly string[]> {
  const urls = await (deps.ownDeploymentUrls ?? nativeDeploymentUrls)(deps.mycoHome ?? resolveMycoHome());
  const { workerLockPath } = await import('../runner/instance.js');
  return urls.some((url) => workerLockPath('', url) === workerLockPath('', serverUrl)) ? [...new Set([serverUrl, ...urls])] : [serverUrl];
}

export function executorServiceTarget(serverUrl: string, deps: WorkerServiceDeps, executor: 'runner' | 'legacy-member' = 'legacy-member'): WorkerServiceTarget {
  const mycoHome = deps.mycoHome ?? resolveMycoHome({ cwd: process.cwd() });
  return {
    executor, serverUrl: deploymentUrl(serverUrl),
    mycoHome,
    // The service-unit policy: the managed binary for the default home, and the
    // running binary for a home of its own.
    binaryPath: deps.binaryPath ?? resolveBinary('home-scoped-managed', { kind: 'machine' }, { mycoHome }).path,
    home: deps.home ?? resolveHomeDir(),
    ...(deps.platform === undefined ? {} : { platform: deps.platform }),
  };
}

/** Why a unit may not be written from this binary for this home, or null. */
export function binaryRefusal(target: WorkerServiceTarget): string | null {
  try {
    assertInstalledBinary(target.binaryPath);
  } catch (error) {
    if (error instanceof ServicePathUnsupported) return error.message;
    throw error;
  }
  if (isDefaultMycoHome(target.mycoHome) && looksLikeDevBuildExecutable(target.binaryPath)) {
    return `a development build (${target.binaryPath}) does not write the default home's worker service. Run the installed myco, or point MYCO_HOME at a home of its own.`;
  }
  return null;
}

export function removeWorkerService(serverUrl: string, deps: WorkerServiceDeps = {}): { unitFile: string; removed: boolean } | { unsupported: string } {
  try {
    return uninstallWorkerService(executorServiceTarget(serverUrl, deps), deps.runner === undefined ? {} : { runner: deps.runner });
  } catch (error) {
    if (error instanceof ServicePlatformUnsupported) return { unsupported: error.message };
    throw error;
  }
}

/** What a sweep did: the units it removed, and the ones it left because it could not tell whose they are. */
export interface WorkerSweep {
  removed: string[];
  kept: Array<{ unitFile: string; reason: string }>;
}

/**
 * Remove every worker unit this home is responsible for: the one for each
 * Deployment it holds a membership of, whether or not its file is still there,
 * and every unit on disk that names this home or names a membership whose file
 * no longer exists. A unit another home still has a membership for is left to
 * that home, and so is one whose membership or unit cannot be read: an
 * unreadable file is not an absent one.
 */
export function sweepWorkerServices(deps: WorkerServiceDeps = {}): WorkerSweep {
  const mycoHome = deps.mycoHome ?? resolveMycoHome({ cwd: process.cwd() });
  const home = deps.home ?? resolveHomeDir();
  const platform = deps.platform ?? process.platform;
  const options = { platform, ...(deps.runner === undefined ? {} : { runner: deps.runner }) };
  const sweep: WorkerSweep = { removed: [], kept: [] };
  for (const membership of listDeploymentMemberships(mycoHome)) {
    const outcome = removeWorkerService(membership.serverUrl, { ...deps, mycoHome, home, platform });
    if ('removed' in outcome && outcome.removed) sweep.removed.push(outcome.unitFile);
  }
  for (const record of listRunnerRecords(mycoHome)) {
    const outcome = uninstallWorkerService(executorServiceTarget(record.serverUrl, { ...deps, mycoHome, home, platform }, 'runner'), options);
    if (outcome.removed) sweep.removed.push(outcome.unitFile);
  }
  for (const found of listWorkerUnits(home, platform, true)) {
    if (found.mycoHome !== mycoHome) {
      if (found.executor === 'runner') {
        sweep.kept.push({ unitFile: found.unitFile, reason: 'the runner belongs to another home' });
        continue;
      }
      if (found.mycoHome === null || found.serverUrl === null) {
        sweep.kept.push({ unitFile: found.unitFile, reason: 'the unit does not say which home and Deployment it serves' });
        continue;
      }
      const membership = readDeploymentMembershipResult(found.serverUrl, found.mycoHome);
      if (membership.status === 'present') continue;
      if (membership.status === 'unavailable') {
        sweep.kept.push({ unitFile: found.unitFile, reason: `its membership in ${found.mycoHome} could not be read: ${membership.reason}` });
        continue;
      }
    }
    if (uninstallService(found.spec, options).removed) sweep.removed.push(found.unitFile);
  }
  return sweep;
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
    return workerServiceStatus(executorServiceTarget(serverUrl, deps), serviceOptions(deps));
  } catch (error) {
    if (error instanceof ServicePlatformUnsupported) return null;
    throw error;
  }
}

/** What a recorded refusal means for a person, and whether anything is theirs to fix. */
const REFUSAL_WORDS: Readonly<Record<TerminalRefusal, { status: 'ok' | 'warn'; line: string }>> = {
  not_admin: { status: 'ok', line: 'no worker: this membership is not an administrator\'s, so it cannot run work for this Deployment' },
  unauthorized: { status: 'warn', line: `no worker: the Deployment does not accept this machine's credential: ${REJOIN_HINT}` },
  no_membership: { status: 'warn', line: 'no worker: the last one stopped because this home held no membership of the Deployment. Sign in with `myco login`' },
};

/** One line naming a worker service's state, for `worker status`, `member status` and `myco doctor`. `warn` is something to act on. */
export function workerServiceWords(status: WorkerServiceStatus | null): { status: 'ok' | 'warn'; line: string } {
  if (status === null) return { status: 'ok', line: 'no executor on this machine (member only); this platform has no per-user executor service' };
  const serving = status.serving === null ? null : status.serving.pid > 0 ? `process ${status.serving.pid} is serving this Deployment` : 'a worker process is serving this Deployment';
  if (serving !== null) {
    return status.installed
      ? { status: 'ok', line: `${status.loaded && status.running ? 'running at login' : 'service installed'}; ${serving}. Logs: ${status.outLog}` }
      : { status: 'ok', line: `not installed; ${serving} (started outside the login service)` };
  }
  if (!status.installed) return { status: 'ok', line: 'no executor on this machine (member only)' };
  if (status.refusal !== null) return REFUSAL_WORDS[status.refusal.code];
  if (!status.loaded) {
    const why = status.detail === undefined || status.detail === UNIT_NOT_HELD ? '' : ` (${status.detail})`;
    return { status: 'warn', line: `installed, and the platform is not holding it${why} — inspect it with \`myco worker doctor --server <url>\`` };
  }
  if (!status.running) return { status: 'warn', line: `installed, and its process is not running — see ${status.errLog}` };
  return { status: 'warn', line: `running at login, and not yet serving this Deployment — see ${status.outLog}` };
}
