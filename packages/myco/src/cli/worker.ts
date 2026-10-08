/** Compatibility commands preserve installed member workers and otherwise invoke runner commands. */
import { REJOIN_HINT } from '../member/delivery-notice.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveMycoHome } from '../paths/home.js';
import { deploymentUrl, readDeploymentMembership } from '../member/registry.js';
import { unboundedBudget } from '../member/budget.js';
import { refreshMembership } from '../member/refresh.js';
import { offerOf, WITHHELD_REASON } from '../runner/detect.js';
import { CLAIM_IDLE_POLL_MS, runWorker, sleep, type WorkerOptions } from '../runner/loop.js';
import { workerLogLine } from '../runner/log.js';
import { keepMachineAwake } from '../runner/keep-awake.js';
import { clearWorkerRefusal, isTerminalRefusal, recordWorkerRefusal, type TerminalRefusal } from '../runner/refusal.js';
import { programRuns, type ProgramProbe } from '../install/place-binary.js';
import { listRunnerRecords, readRunnerRecord } from '../runner/runner-registry.js';
import { workerLockPath, workerLockDir } from '../runner/instance.js';
import { workerServiceSpec, workerServiceUnit } from '../runner/service.js';
import { reloadServiceDetached, startService, type ServiceSpec } from '../server/service.js';
import { describeWorkerService, removeWorkerService, workerServiceWords, type WorkerServiceDeps } from './worker-service.js';
import { harnessesNamed, parseFlags } from './flags.js';
import { WORKER_DIAGNOSTIC_LOG } from '@goondocks/myco-shared/worker-log';
import { run as runRunnerCli } from './runner.js';
import { LEGACY_WORKER_WORDS, legacyWorkerInventory } from './runner-service.js';
import { executionDeploymentUrls } from './worker-service.js';
import { listWorkerUnits } from '../runner/service.js';
import { resolveHomeDir } from '../paths/home.js';
import { detectHarnessesAsync } from '../runner/detect.js';
import { type RunnerCliDeps } from './runner-deps.js';

export const WORKER_HELP = `myco worker — compatibility alias for myco runner

Enroll with myco runner register <host>, then myco runner install.
install | status | doctor | uninstall use the runner commands.
An existing legacy worker — uses member credential — is kept until explicitly
stopped with myco worker uninstall --server <url>. Its credential never switches
when runner authentication fails. --detect lists local harnesses.
`;

const SERVICE_VERBS = new Set(['install', 'uninstall', 'status', 'doctor']);

export async function run(args: string[], deps: WorkerServiceDeps & RunnerCliDeps = {}): Promise<boolean> {
  (deps.stdout ?? console.log)('myco worker is a compatibility alias; enroll with `myco runner register <host>`.');
  if (args[0] === '--help' || args[0] === '-h') { console.log(WORKER_HELP); return true; }
  const { flags } = parseFlags(args);
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const named = flags.get('server');
  const machineLegacyUnits = listWorkerUnits(deps.home ?? resolveHomeDir(), deps.platform ?? process.platform);
  const legacyUnits = machineLegacyUnits.filter((unit) => unit.mycoHome === mycoHome);
  const legacyUrls = legacyUnits.flatMap((unit) => unit.serverUrl === null ? [] : [unit.serverUrl]);
  const matches = named === undefined || named === 'true' ? [] : legacyUrls.filter(url => workerLockPath('', url) === workerLockPath('', named));
  const exact = named === undefined ? undefined : legacyUrls.find(url => deploymentUrl(url) === deploymentUrl(named));
  if (exact === undefined && matches.length > 1) {
    legacyWorkerInventory(deps).forEach(line => (deps.stdout ?? console.log)(line));
    (deps.stderr ?? console.error)('myco worker: multiple legacy units share this origin; name the exact --server address printed in the inventory. No service changed.');
    return false;
  }
  const legacyUrl = exact ?? matches[0];
  const legacy = legacyUrl !== undefined;
  const verb = args[0];
  if (verb === 'install' && named === undefined && machineLegacyUnits.length > 0) {
    legacyWorkerInventory(deps).forEach(line => (deps.stdout ?? console.log)(line));
    (deps.stdout ?? console.log)('No service changed. Restart a legacy unit only with --server <url>; new execution requires `myco runner register <host>`, then `myco runner install`.');
    return true;
  }
  if (verb !== undefined && SERVICE_VERBS.has(verb)) {
    if (legacy || (named === undefined && legacyUrls.length > 0)) {
      if (verb === 'status' || verb === 'doctor') legacyWorkerInventory(deps).forEach(line => (deps.stdout ?? console.log)(line));
      let ok = true;
      for (const url of named === undefined ? legacyUrls : [legacyUrl!]) {
        (deps.stdout ?? console.log)(`${url}: ${LEGACY_WORKER_WORDS}`);
        if (verb === 'uninstall') {
          const removed = removeWorkerService(url, { ...deps, mycoHome });
          (deps.stdout ?? console.log)('unsupported' in removed ? `${url}: ${removed.unsupported}` : `${url}: ${removed.removed ? 'legacy worker service stopped and removed' : 'no legacy worker service was installed'}. Membership and capture are unchanged; nothing else to remove.`);
          ok = !('unsupported' in removed) && ok;
        } else {
          if (verb === 'install') {
            const found = legacyUnits.find((unit) => unit.serverUrl === url);
            if (found !== undefined) startService(found.spec, { platform: deps.platform, runner: deps.runner });
          }
          const words = workerServiceWords(describeWorkerService(url, { ...deps, mycoHome }));
          (deps.stdout ?? console.log)(`${url}: ${words.line}`);
          const offers = offerOf(await (deps.detect ?? (() => detectHarnessesAsync(undefined, undefined, { credentialBytes: false })))());
          (deps.stdout ?? console.log)(`harnesses offered: ${offers.offered.filter((h) => h.authenticated).map((h) => h.id).join(', ') || 'none'}; last contact: unknown locally, see the dashboard`);
          const state = describeWorkerService(url, { ...deps, mycoHome });
          ok = (verb === 'install' ? state?.installed === true && state.loaded && state.running : words.status === 'ok') && ok;
        }
      }
      if (named === undefined) {
        for (const record of listRunnerRecords(mycoHome)) {
          if (verb === 'install') continue;
          ok = await runRunnerCli([verb, '--server', record.serverUrl], deps) && ok;
        }
      } else if (verb !== 'install' && readRunnerRecord(named!, mycoHome) !== null) {
        ok = await runRunnerCli([verb, '--server', named!], deps) && ok;
      }
      return ok;
    }
    return runRunnerCli(args, deps);
  }
  if (verb === 'register' || verb === 'rotate' || (verb === 'run' && !legacy)) return runRunnerCli(args, deps);
  const only = harnessesNamed(args);

  if (flags.get('detect') === 'true') {
    const detected = await detectHarnessesAsync(only, undefined, { credentialBytes: false });
    const { withheld } = offerOf(detected);
    for (const found of detected) {
      const offered = withheld.includes(found.id) ? `  not offered: ${WITHHELD_REASON}` : '';
      console.log(`${found.id.padEnd(14)} ${found.installed ? 'installed' : 'absent   '}  ${found.authenticated ? 'logged in' : 'not logged in'}${offered}`);
    }
    return true;
  }

  const serverUrl = flags.get('server');
  if (serverUrl === undefined || serverUrl === 'true') {
    console.error('myco worker: --server <url> names the Deployment to attach to');
    return false;
  }
  if (!legacy) return runRunnerCli(['run', ...args], deps);
  console.log(`${serverUrl}: ${LEGACY_WORKER_WORDS}`);
  const attach = attachOptions(serverUrl, mycoHome);
  if (readDeploymentMembership(serverUrl, mycoHome) === null) return endRefused(serverUrl, mycoHome, 'no_membership');

  const stopping = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { stopping.abort(); });

  const outcome = await runWorker({
    ...attach,
    deploymentUrls: await executionDeploymentUrls(serverUrl, { ...deps, mycoHome }),
    ...(only.length === 0 ? {} : { only }),
    ...(flags.get('once') === 'true' ? { once: true } : {}),
    pollIdleMs: CLAIM_IDLE_POLL_MS,
    signal: stopping.signal,
  });
  attach.log(`drove ${outcome.driven} run${outcome.driven === 1 ? '' : 's'}`);
  if (outcome.replaced === true) return endReplacedWorker(serverUrl, mycoHome, stopping.signal);
  if (outcome.refused === null) return true;
  if (isTerminalRefusal(outcome.refused)) return endRefused(serverUrl, mycoHome, outcome.refused);
  console.error(`myco worker: ${serverUrl} refused this worker (${outcome.refused})`);
  return false;
}

/** What a terminal refusal means for a person. */
const TERMINAL_WORDS: Readonly<Record<TerminalRefusal, string>> = {
  not_admin: 'this membership is not an administrator\'s, so it cannot run work for the Deployment. No worker runs here until an administrator\'s machine installs one.',
  unauthorized: `the Deployment does not accept this machine's credential: ${REJOIN_HINT}.`,
  no_membership: 'this home holds no membership of the Deployment. Run `myco login`.',
};

/**
 * End a worker the Deployment will refuse on every later request. The refusal
 * is recorded for `worker status` and `myco doctor`, and the process ends
 * successfully, so a login service does not restart it into the same refusal.
 */
function endRefused(serverUrl: string, mycoHome: string, code: TerminalRefusal): true {
  recordWorkerRefusal(mycoHome, serverUrl, code, Date.now());
  console.error(`myco worker: ${serverUrl}: ${TERMINAL_WORDS[code]}`);
  return true;
}

/** The identity of a file on disk, which a replacement by rename or copy changes. */
export function executableIdentity(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    return `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

/**
 * Whether the program at `file` is still the one this process started from.
 *
 * A program replaced on disk ends the worker only once the new one runs; one
 * that does not is said once, and the worker keeps running on the program it
 * started from until the file changes again.
 */
export function sameProgram(
  file: string,
  identity = executableIdentity,
  runs: (file: string) => ProgramProbe = programRuns,
  log: (line: string) => void = () => {},
): () => boolean {
  const started = identity(file);
  let judged = started;
  return () => {
    const now = identity(file);
    if (started === null || now === null || now === started || now === judged) return true;
    judged = now;
    const probe = runs(file);
    if (probe.runs) return false;
    log(`the myco program on disk changed, and the new one does not run (${probe.detail}); staying on this one`);
    return true;
  };
}

/** Longest a replaced worker waits for its service to stop it before ending on its own. */
const SERVICE_RELOAD_WAIT_MS = 60_000;

/** What handing a replaced worker to its service needs; each defaults to the real process. */
export interface ReplacedWorkerDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  /** Ask for the unit to be loaded again, replacing process `replacing`. */
  reload?: (spec: ServiceSpec, replacing: number) => boolean;
  waitMs?: number;
}

/**
 * End a worker whose program was replaced, so the new program runs.
 *
 * A worker running as its macOS login service asks launchd to load its unit
 * again and waits to be stopped by that load: launchd's own restart of a
 * replaced program is killed once for a code requirement recorded at login
 * (`reloadServiceDetached`). True when the service stopped it. Anywhere else,
 * or when no reload comes, it ends non-zero and its service restarts it.
 */
export async function endReplacedWorker(serverUrl: string, mycoHome: string, stopped: AbortSignal, deps: ReplacedWorkerDeps = {}): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  const unit = workerServiceUnit(serverUrl, mycoHome);
  if (platform !== 'darwin' || (deps.env ?? process.env).XPC_SERVICE_NAME !== unit.label) return false;
  const spec = workerServiceSpec({ serverUrl, mycoHome, binaryPath: process.execPath, home: deps.home ?? os.homedir(), platform }, []);
  const reload = deps.reload ?? ((s: ServiceSpec, replacing: number) => reloadServiceDetached(s, { platform, replacing }));
  if (!reload(spec, process.pid)) return false;
  console.log(workerLogLine('asked the login service to start the new program'));
  await sleep(deps.waitMs ?? SERVICE_RELOAD_WAIT_MS, stopped);
  return stopped.aborted;
}

/** Where a worker attached from this terminal or a login service claims from, and how it knows it is alone. */
/** `program` is the file this process runs, whose replacement ends the worker once the new one runs. */
export function attachOptions(serverUrl: string, mycoHome: string, fetchImpl?: typeof fetch, program: string = process.execPath): Pick<WorkerOptions, 'serverUrl' | 'token' | 'renew' | 'lockDir' | 'runRoot' | 'stepRoot' | 'diagnosticRoot' | 'onAttached' | 'stillCurrent' | 'keepAwake' | 'log'> {
  const log = (line: string): void => { console.log(workerLogLine(line)); };
  return {
    serverUrl,
    token: () => readDeploymentMembership(serverUrl, mycoHome)?.token ?? null,
    // The membership's own rotation, the one every hook on this machine uses: a worker left running renews its credential, a lapsed one included.
    renew: async (force) => (await refreshMembership(serverUrl, { mycoHome, budget: unboundedBudget(), force, ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }) })).status,
    lockDir: workerLockDir(),
    runRoot: path.join(mycoHome, 'worker', 'runs'),
    stepRoot: path.join(mycoHome, 'worker', 'steps'),
    diagnosticRoot: path.join(mycoHome, path.dirname(WORKER_DIAGNOSTIC_LOG)),
    onAttached: () => { clearWorkerRefusal(mycoHome, serverUrl); },
    stillCurrent: sameProgram(program, executableIdentity, programRuns, log),
    keepAwake: keepMachineAwake,
    log,
  };
}
