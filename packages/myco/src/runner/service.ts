/**
 * A member's worker as a login service.
 *
 * One unit per Deployment per member home, running `myco worker --server <url>`
 * under the home the membership is read from, restarted when it exits and
 * started again at every login. The unit is the per-user service every Myco
 * service is (`server/service.ts`); this module says what a worker's unit is and
 * when one should exist.
 *
 * A worker needs a membership to claim with, a harness logged in to drive, and a
 * Deployment that does not already run a worker of its own on this machine. Each
 * is checked before a unit is written, because a unit written without one is a
 * process restarting all day to do nothing.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { deploymentUrl } from '../member/registry.js';
import { HARNESSES } from './harnesses.js';
import { locate, type DetectedHarness } from './detect.js';
import { workerHolder, workerLockDir } from './instance.js';
import {
  installService,
  servicePathEnv,
  servicePaths,
  statusOfService,
  uninstallService,
  type ServiceOptions,
  type ServiceOutcome,
  type ServiceSpec,
  type ServiceUnit,
} from '../server/service.js';
import type { LockHolder } from '../utils/lifecycle-lock.js';

const WORKER_LABEL_PREFIX = 'co.goondocks.myco-worker';
const WORKER_UNIT_PREFIX = 'myco-worker';
const UNIT_ID_HEX_CHARS = 16;

/**
 * Seconds before a worker that exited is started again. A worker exits on its
 * own only when the Deployment refused it, and a refusal answered again every
 * few seconds is load on the Deployment and noise in the log.
 */
export const WORKER_RESTART_DELAY_SECONDS = 60;

/** Where a worker service runs from: the Deployment, the member home holding its membership, and the machine it runs on. */
export interface WorkerServiceTarget {
  serverUrl: string;
  /** The member home the unit runs under, which is where its membership is read. */
  mycoHome: string;
  /** The installed `myco` binary the unit runs. */
  binaryPath: string;
  /** The user's home directory. */
  home: string;
  platform?: NodeJS.Platform;
}

/** The unit for one Deployment from one member home; two homes joined to one Deployment get two units, and one lock between them. */
export function workerServiceUnit(serverUrl: string, mycoHome: string): ServiceUnit {
  const url = deploymentUrl(serverUrl);
  const id = crypto.createHash('sha256').update(JSON.stringify([url, path.resolve(mycoHome)])).digest('hex').slice(0, UNIT_ID_HEX_CHARS);
  return {
    label: `${WORKER_LABEL_PREFIX}.${id}`,
    unitName: `${WORKER_UNIT_PREFIX}-${id}`,
    description: `Myco worker for ${url}`,
    args: ['worker', '--server', url],
    logName: `worker-${new URL(url).host.replace(/[^A-Za-z0-9.-]/g, '_')}`,
    restartDelaySeconds: WORKER_RESTART_DELAY_SECONDS,
  };
}

/** Directories holding the harnesses this machine has, so a service finds them without a login shell's `PATH`. */
export function harnessDirectories(find: (binary: string) => string | null = locate): string[] {
  const binaries = HARNESSES.flatMap((h) => (h.launch.kind === 'sidecar' ? [h.binary, h.launch.binary] : [h.binary]));
  const dirs = binaries.map(find).filter((found): found is string => found !== null).map((found) => path.dirname(found));
  return [...new Set(dirs)];
}

export function workerServiceSpec(target: WorkerServiceTarget, harnessDirs: readonly string[]): ServiceSpec {
  const platform = target.platform ?? process.platform;
  return {
    unit: workerServiceUnit(target.serverUrl, target.mycoHome),
    binaryPath: target.binaryPath,
    home: target.home,
    pathEnv: servicePathEnv(target.binaryPath, target.home, platform, harnessDirs),
    logDir: path.join(target.mycoHome, 'logs'),
    env: { MYCO_HOME: target.mycoHome },
  };
}

/** What a worker service needs before one is written. */
export interface WorkerServicePreconditions {
  /** Whether the member home holds a membership of the Deployment. */
  member: boolean;
  /** The addresses this machine's own native Deployment answers at, whose `server run` process already runs a worker. */
  ownDeploymentUrls: readonly string[];
  /** What this machine has, as the worker will offer it. */
  harnesses: readonly DetectedHarness[];
}

/** Why no worker service is written, in words a person acts on. */
export type WorkerServiceRefusal =
  | { reason: 'no_membership'; detail: string }
  | { reason: 'own_deployment'; detail: string }
  | { reason: 'no_harness'; detail: string };

/** Null when a worker service belongs here; otherwise why it does not. */
export function workerServiceRefusal(serverUrl: string, pre: WorkerServicePreconditions): WorkerServiceRefusal | null {
  const url = deploymentUrl(serverUrl);
  if (!pre.member) return { reason: 'no_membership', detail: `this home holds no membership of ${url}. Run \`myco login\` first.` };
  if (pre.ownDeploymentUrls.some((own) => deploymentUrl(own) === url)) {
    return { reason: 'own_deployment', detail: `${url} is this machine's own Deployment, and \`myco server run\` already runs its worker.` };
  }
  if (!pre.harnesses.some((h) => h.authenticated)) {
    const found = pre.harnesses.filter((h) => h.installed).map((h) => h.id);
    return {
      reason: 'no_harness',
      detail: `no harness on this machine is logged in (installed: ${found.join(', ') || 'none'}). Log one in, then run \`myco worker install\`.`,
    };
  }
  return null;
}

/** Where a worker service writes its output. */
export function workerServiceLogs(target: WorkerServiceTarget): { outLog: string; errLog: string } {
  const { outLog, errLog } = servicePaths(workerServiceSpec(target, []), target.platform ?? process.platform);
  return { outLog, errLog };
}

export function installWorkerService(target: WorkerServiceTarget, harnessDirs: readonly string[], options: ServiceOptions = {}): ServiceOutcome {
  return installService(workerServiceSpec(target, harnessDirs), { platform: target.platform, ...options });
}

export function uninstallWorkerService(target: WorkerServiceTarget, options: ServiceOptions = {}): { unitFile: string; removed: boolean } {
  return uninstallService(workerServiceSpec(target, []), { platform: target.platform, ...options });
}

/** A worker service's state: the unit, whether the platform holds it, which process serves the Deployment, and where it writes. */
export interface WorkerServiceStatus {
  unitFile: string;
  installed: boolean;
  loaded: boolean;
  detail?: string;
  /** The process serving this Deployment on this machine, whichever started it. */
  serving: LockHolder | null;
  outLog: string;
  errLog: string;
}

export function workerServiceStatus(
  target: WorkerServiceTarget, options: ServiceOptions & { lockDir?: string } = {},
): WorkerServiceStatus {
  const spec = workerServiceSpec(target, []);
  const platform = target.platform ?? process.platform;
  const paths = servicePaths(spec, platform);
  const state = statusOfService(spec, { platform, ...options });
  return {
    unitFile: paths.unitFile,
    installed: state.installed,
    loaded: state.loaded,
    ...(state.detail === undefined ? {} : { detail: state.detail }),
    serving: workerHolder(options.lockDir ?? workerLockDir(target.home), target.serverUrl),
    outLog: paths.outLog,
    errLog: paths.errLog,
  };
}
