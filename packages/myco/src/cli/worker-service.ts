/**
 * The worker login service, as the CLI asks for it: install it where one
 * belongs, remove it, and say what state it is in.
 *
 * `myco worker install|uninstall|status`, `member join`, `member leave`,
 * `member status`, `myco remove` and `myco doctor` all go through here, so each
 * says the same thing about the same unit.
 */
import { resolveHomeDir, resolveMycoHome } from '../paths/home.js';
import { isDefaultMycoHome } from '../grove/paths.js';
import { deploymentUrl, listDeploymentMemberships, readDeploymentMembership, readDeploymentMembershipResult } from '../member/registry.js';
import { detectHarnesses, type DetectedHarness } from '../runner/detect.js';
import { probeWorkerAdmission, type WorkerAdmission } from '../runner/loop.js';
import { clearWorkerRefusal, readWorkerRefusal, recordWorkerRefusal, type TerminalRefusal } from '../runner/refusal.js';
import {
  harnessDirectories,
  installWorkerService,
  listWorkerUnits,
  uninstallWorkerService,
  workerServiceLogs,
  workerServiceRefusal,
  workerServiceStatus,
  type WorkerServiceRefusal,
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
  type ServiceOutcome,
  type ServiceRunner,
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
async function nativeDeploymentUrls(mycoHome: string): Promise<readonly string[]> {
  const { localDeploymentPresent, localDeploymentUrls, readLocalRecord, resolveLocalPaths } = await import('../server/local.js');
  const paths = resolveLocalPaths(mycoHome);
  return localDeploymentPresent(paths) ? localDeploymentUrls(readLocalRecord(paths)) : [];
}

/** How long the admission question may take before install goes ahead on what it knows. */
const ADMISSION_TIMEOUT_MS = 10_000;

const askDeployment = (serverUrl: string, token: string): Promise<WorkerAdmission> =>
  probeWorkerAdmission({ serverUrl, token, signal: AbortSignal.timeout(ADMISSION_TIMEOUT_MS) });

function targetOf(serverUrl: string, deps: WorkerServiceDeps): WorkerServiceTarget {
  const mycoHome = deps.mycoHome ?? resolveMycoHome({ cwd: process.cwd() });
  return {
    serverUrl: deploymentUrl(serverUrl),
    mycoHome,
    // The service-unit policy: the managed binary for the default home, and the
    // running binary for a home of its own.
    binaryPath: deps.binaryPath ?? resolveBinary('home-scoped-managed', { kind: 'machine' }, { mycoHome }).path,
    home: deps.home ?? resolveHomeDir(),
    ...(deps.platform === undefined ? {} : { platform: deps.platform }),
  };
}

/** Why a unit may not be written from this binary for this home, or null. */
function binaryRefusal(target: WorkerServiceTarget): string | null {
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

/** What asking for a worker service came to. */
export type EnsureWorkerOutcome =
  | { kind: 'installed'; outcome: ServiceOutcome; outLog: string }
  | { kind: 'refused'; refusal: WorkerServiceRefusal }
  | { kind: 'unsupported'; detail: string };

const ROLE_REFUSALS: Readonly<Record<'not_admin' | 'unauthorized', string>> = {
  not_admin: 'this membership is not an administrator\'s, and only an administrator\'s machine can run work for the Deployment.',
  unauthorized: 'the Deployment does not accept this machine\'s credential. Sign in again with `myco login`, then run `myco worker install`.',
};

/**
 * Install the worker service for one Deployment when one belongs on this
 * machine, and say why not when it does not. Installing again leaves a running
 * worker running.
 *
 * The Deployment is asked whether it admits this credential as a worker; a
 * refusal is recorded and no unit is written. Where it cannot be asked, a
 * refusal recorded earlier stands. `force` skips both.
 */
export async function ensureWorkerService(serverUrl: string, deps: WorkerServiceDeps & { force?: boolean } = {}): Promise<EnsureWorkerOutcome> {
  const target = targetOf(serverUrl, deps);
  const unusable = binaryRefusal(target);
  if (unusable !== null) return { kind: 'unsupported', detail: unusable };
  const membership = readDeploymentMembership(target.serverUrl, target.mycoHome);
  const refusal = workerServiceRefusal(target.serverUrl, {
    member: membership !== null,
    ownDeploymentUrls: await (deps.ownDeploymentUrls ?? nativeDeploymentUrls)(target.mycoHome),
    harnesses: (deps.detect ?? detectHarnesses)(),
  });
  if (refusal !== null) return { kind: 'refused', refusal };
  if (deps.force !== true) {
    const admission = await (deps.admission ?? askDeployment)(target.serverUrl, membership!.token);
    if (admission === 'not_admin' || admission === 'unauthorized') {
      recordWorkerRefusal(target.mycoHome, target.serverUrl, admission, (deps.now ?? Date.now)());
      return { kind: 'refused', refusal: { reason: admission, detail: ROLE_REFUSALS[admission] } };
    }
    const recorded = admission === 'unknown' ? readWorkerRefusal(target.mycoHome, target.serverUrl) : null;
    if (recorded !== null && recorded.code !== 'no_membership') {
      return {
        kind: 'refused',
        refusal: {
          reason: recorded.code,
          detail: `${ROLE_REFUSALS[recorded.code]} (recorded ${new Date(recorded.at).toISOString()}; the Deployment could not be asked again. \`myco worker install --force\` installs anyway.)`,
        },
      };
    }
  }
  try {
    const outcome = installWorkerService(target, (deps.harnessDirs ?? harnessDirectories)(), deps.runner === undefined ? {} : { runner: deps.runner });
    // The worker this starts records its own refusal if the Deployment still has one.
    clearWorkerRefusal(target.mycoHome, target.serverUrl);
    return { kind: 'installed', outcome, outLog: workerServiceLogs(target).outLog };
  } catch (error) {
    if (error instanceof ServicePathUnsupported || error instanceof ServicePlatformUnsupported) return { kind: 'unsupported', detail: error.message };
    throw error;
  }
}

/**
 * One line saying what a worker install came to, for every command that
 * installs one — `worker install`, `member join`, and a sign-in.
 */
export function ensuredWorkerWords(ensured: EnsureWorkerOutcome): { ok: boolean; line: string } {
  switch (ensured.kind) {
    case 'installed':
      if (!ensured.outcome.loaded) {
        return { ok: false, line: `the worker service is written, and the platform is not running it (${ensured.outcome.detail ?? 'no detail'}); run \`myco worker status\`` };
      }
      return {
        ok: true,
        line: `${ensured.outcome.changed ? 'a worker now runs whenever you are logged in' : 'the worker was already running'}; logs: ${ensured.outLog}`,
      };
    case 'refused':
      // A Deployment that runs its own worker needs none, and a membership that
      // cannot run one has nothing to fix; neither is a failure.
      return {
        ok: ensured.refusal.reason === 'own_deployment' || ensured.refusal.reason === 'not_admin',
        line: `no worker service installed: ${ensured.refusal.detail}`,
      };
    case 'unsupported':
      return { ok: false, line: `no worker service installed: ${ensured.detail}` };
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
  for (const found of listWorkerUnits(home, platform)) {
    if (found.mycoHome !== mycoHome) {
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
    return workerServiceStatus(targetOf(serverUrl, deps), serviceOptions(deps));
  } catch (error) {
    if (error instanceof ServicePlatformUnsupported) return null;
    throw error;
  }
}

/** What a recorded refusal means for a person, and whether anything is theirs to fix. */
const REFUSAL_WORDS: Readonly<Record<TerminalRefusal, { status: 'ok' | 'warn'; line: string }>> = {
  not_admin: { status: 'ok', line: 'no worker: this membership is not an administrator\'s, so it cannot run work for this Deployment' },
  unauthorized: { status: 'warn', line: 'no worker: the Deployment does not accept this machine\'s credential. Sign in again with `myco login`, then run `myco worker install`' },
  no_membership: { status: 'warn', line: 'no worker: the last one stopped because this home held no membership of the Deployment. Sign in with `myco login`, then run `myco worker install`' },
};

/** One line naming a worker service's state, for `worker status`, `member status` and `myco doctor`. `warn` is something to act on. */
export function workerServiceWords(status: WorkerServiceStatus | null): { status: 'ok' | 'warn'; line: string } {
  if (status === null) return { status: 'warn', line: 'this platform has no login service for a worker; run `myco worker --server <url>` to attach one' };
  const serving = status.serving === null ? null : status.serving.pid > 0 ? `process ${status.serving.pid} is serving this Deployment` : 'a worker process is serving this Deployment';
  if (serving !== null) {
    return status.installed
      ? { status: 'ok', line: `running at login; ${serving}. Logs: ${status.outLog}` }
      : { status: 'ok', line: `not installed; ${serving} (started outside the login service)` };
  }
  if (status.refusal !== null) return REFUSAL_WORDS[status.refusal.code];
  if (!status.installed) return { status: 'warn', line: 'not installed, and no worker on this machine serves this Deployment — run `myco worker install`' };
  if (!status.loaded) return { status: 'warn', line: `installed, and the platform is not holding it (${status.detail ?? 'no detail'}) — run \`myco worker install\`` };
  if (!status.running) return { status: 'warn', line: `installed, and its process is not running — see ${status.errLog}; \`myco worker install\` starts it` };
  return { status: 'warn', line: `running at login, and not yet serving this Deployment — see ${status.outLog}` };
}
