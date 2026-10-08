/** Per-user executor units with credential-class commands over the shared platform adapter. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { deploymentUrl } from '../member/registry.js';
import { HARNESSES } from './harnesses.js';
import { locate, offerOf, type DetectedHarness } from './detect.js';
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
import { readWorkerRefusal, type WorkerRefusalRecord } from './refusal.js';

const UNIT_ID_HEX_CHARS = 16;

/**
 * Seconds before a worker that exited is started again. A worker exits on its
 * own only when the Deployment refused it, and a refusal answered again every
 * few seconds is load on the Deployment and noise in the log.
 */
export const WORKER_RESTART_DELAY_SECONDS = 60;

/** The Deployment, credential home and machine paths an executor service names. */
export interface WorkerServiceTarget {
  executor?: 'runner' | 'legacy-member';
  serverUrl: string;
  /** The credential home the unit reads through MYCO_HOME. */
  mycoHome: string;
  /** The installed `myco` binary the unit runs. */
  binaryPath: string;
  /** The user's home directory. */
  home: string;
  platform?: NodeJS.Platform;
}

/** Deployment and credential home name the unit; machine-wide locks serialize execution. */
export function workerServiceUnit(serverUrl: string, mycoHome: string, executor: 'runner' | 'legacy-member' = 'legacy-member'): ServiceUnit {
  const url = deploymentUrl(serverUrl);
  const id = crypto.createHash('sha256').update(JSON.stringify([url, path.resolve(mycoHome)])).digest('hex').slice(0, UNIT_ID_HEX_CHARS);
  return unitWithId(id, url, executor);
}

function unitWithId(id: string, url: string, executor: 'runner' | 'legacy-member' = 'legacy-member'): ServiceUnit {
  const kind = executor === 'runner' ? 'runner' : 'worker';
  return {
    label: `co.goondocks.myco-${kind}.${id}`,
    unitName: `myco-${kind}-${id}`,
    description: `Myco ${kind} for ${url}`,
    args: executor === 'runner' ? ['runner', 'run', '--server', url] : ['worker', '--server', url],
    logName: `${kind}-${new URL(url).host.replace(/[^A-Za-z0-9.-]/g, '_')}`,
    restartDelaySeconds: WORKER_RESTART_DELAY_SECONDS,
  };
}

/** A worker unit found on disk, with the Deployment and member home it names where it can be read. */
export interface FoundWorkerUnit {
  executor: 'runner' | 'legacy-member';
  unitFile: string;
  serverUrl: string | null;
  mycoHome: string | null;
  spec: ServiceSpec;
}

const UNIT_FILE = {
  darwin: /^co\.goondocks\.myco-(worker|runner)\.([0-9a-f]{16})\.plist$/,
  linux: /^myco-(worker|runner)-([0-9a-f]{16})\.service$/,
  win32: /^myco-(worker|runner)-([0-9a-f]{16})\.task\.xml$/,
} as const;

const unescapeXml = (value: string): string =>
  value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * Every worker unit written for this user, whichever home wrote it. The
 * Deployment and home are read back from the unit's own arguments and
 * environment; a unit that cannot be read names neither, and can still be
 * removed by its file name.
 */
export function listWorkerUnits(home: string, platform: NodeJS.Platform = process.platform, includeRunners = false): FoundWorkerUnit[] {
  const pattern = UNIT_FILE[platform as keyof typeof UNIT_FILE];
  if (pattern === undefined) return [];
  const probe: ServiceSpec = {
    unit: unitWithId('0'.repeat(UNIT_ID_HEX_CHARS), 'https://unit.invalid'), binaryPath: '/myco', home, pathEnv: '', logDir: home, env: {},
  };
  const dir = path.dirname(servicePaths(probe, platform).unitFile);
  if (!fs.existsSync(dir)) return [];
  const found: FoundWorkerUnit[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const match = pattern.exec(name);
    if (match === null || (!includeRunners && match[1] === 'runner')) continue;
    const executor = match[1] === 'runner' ? 'runner' : 'legacy-member';
    const id = match[2]!;
    const unitFile = path.join(dir, name);
    const text = unescapeXml(fs.readFileSync(unitFile, 'utf8'));
    const serverUrl = /--server(?:<\/string>\s*<string>|\s+)([^<\s"]+)/.exec(text)?.[1] ?? null;
    const mycoHome = /MYCO_HOME(?:<\/key><string>|=)([^<\n"]+)/.exec(text)?.[1] ?? null;
    found.push({
      executor, unitFile, serverUrl, mycoHome,
      spec: { ...probe, unit: unitWithId(id, serverUrl ?? 'https://unit.invalid', executor) },
    });
  }
  return found;
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
    unit: workerServiceUnit(target.serverUrl, target.mycoHome, target.executor),
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
  /** The addresses this machine's own native Deployment answers at. */
  ownDeploymentUrls: readonly string[];
  /** What this machine has, as the worker will offer it. */
  harnesses: readonly DetectedHarness[];
}

/** Why no worker service is written, in words a person acts on. */
export type WorkerServiceRefusal =
  | { reason: 'no_membership'; detail: string }
  | { reason: 'own_deployment'; detail: string }
  | { reason: 'no_harness'; detail: string }
  | { reason: 'not_admin'; detail: string }
  | { reason: 'unauthorized'; detail: string };

/** Null when a worker service belongs here; otherwise why it does not. */
export function workerServiceRefusal(serverUrl: string, pre: WorkerServicePreconditions): WorkerServiceRefusal | null {
  const url = deploymentUrl(serverUrl);
  if (!pre.member) return { reason: 'no_membership', detail: `this home holds no membership of ${url}. Run \`myco login\` first.` };
  if (pre.ownDeploymentUrls.some((own) => deploymentUrl(own) === url)) {
    return { reason: 'own_deployment', detail: `${url} names this machine's native Deployment. Enroll explicitly with \`myco runner register ${url}\`, then \`myco runner install\`.` };
  }
  const offer = offerOf(pre.harnesses);
  if (!offer.offered.some((h) => h.authenticated)) {
    const found = pre.harnesses.filter((h) => h.installed).map((h) => h.id);
    const withheld = offer.withheld.length === 0 ? '' : `; logged in but not offered: ${offer.withheld.join(', ')}`;
    return {
      reason: 'no_harness',
      detail: `no harness a worker offers is logged in on this machine (installed: ${found.join(', ') || 'none'}${withheld}). Log one in, then run \`myco worker install\`.`,
    };
  }
  return null;
}

/** Where a worker service writes its output. */
export function workerServiceLogs(target: WorkerServiceTarget): { outLog: string; errLog: string } {
  const { outLog, errLog } = servicePaths(workerServiceSpec(target, []), target.platform ?? process.platform);
  return { outLog, errLog };
}

/** Install the worker unit. A worker already running under the same unit, give or take its `PATH`, keeps running. */
export function installWorkerService(target: WorkerServiceTarget, harnessDirs: readonly string[], options: ServiceOptions = {}): ServiceOutcome {
  return installService(workerServiceSpec(target, harnessDirs), { platform: target.platform, ...options, keepRunning: true });
}

export function uninstallWorkerService(target: WorkerServiceTarget, options: ServiceOptions = {}): { unitFile: string; removed: boolean } {
  return uninstallService(workerServiceSpec(target, []), { platform: target.platform, ...options });
}

/** A worker service's state: the unit, whether the platform holds it, which process serves the Deployment, and where it writes. */
export interface WorkerServiceStatus {
  unitFile: string;
  installed: boolean;
  loaded: boolean;
  running: boolean;
  detail?: string;
  /** The refusal that last ended a worker for this Deployment from this home. */
  refusal: WorkerRefusalRecord | null;
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
    running: state.running,
    ...(state.detail === undefined ? {} : { detail: state.detail }),
    refusal: target.executor === 'runner' ? null : readWorkerRefusal(target.mycoHome, target.serverUrl),
    serving: workerHolder(options.lockDir ?? workerLockDir(target.home), target.serverUrl),
    outLog: paths.outLog,
    errLog: paths.errLog,
  };
}
