/**
 * `myco worker` — attach this machine's harnesses to a Deployment.
 *
 * A worker runs where the harnesses are logged in, which is the machine a
 * person already codes on or a machine an operator keeps for the purpose. It
 * needs no vault and no project, so it reads the Deployment membership this
 * machine already holds and claims work across every Project that Deployment
 * serves.
 *
 * `install` keeps one running as a login service (`runner/service.ts`), under
 * the member home its membership lives in; `uninstall` removes it and `status`
 * reports it. Joining a Deployment installs it (`member join`), and leaving the
 * last project on a Deployment removes it (`member leave`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveMycoHome } from '../paths/home.js';
import { deploymentUrl, listDeploymentMemberships, readDeploymentMembership } from '../member/registry.js';
import { unboundedBudget } from '../member/budget.js';
import { refreshMembership } from '../member/refresh.js';
import { detectHarnesses } from '../runner/detect.js';
import { runWorker, type WorkerOptions } from '../runner/loop.js';
import { clearWorkerRefusal, isTerminalRefusal, recordWorkerRefusal, type TerminalRefusal } from '../runner/refusal.js';
import { workerLockDir } from '../runner/instance.js';
import { describeWorkerService, ensuredWorkerWords, ensureWorkerService, removeWorkerService, workerServiceWords, type WorkerServiceDeps } from './worker-service.js';
import { parseFlags } from './shared.js';

export const WORKER_HELP = `myco worker — run tasks for a Deployment on this machine's harnesses

Usage:
  myco worker --server <url> [options]   Attach in this terminal until stopped.
  myco worker install [--server <url>] [--force]
                                         Keep a worker running whenever you are logged in.
                                         --force installs where the Deployment refused
                                         this membership before.
  myco worker uninstall [--server <url>] Stop that worker and remove it.
  myco worker status [--server <url>]    Whether it is installed and serving.

Options:
  --server <url>     The Deployment to attach to. Required to attach; install,
                     uninstall and status default to every Deployment this
                     machine holds a membership of.
  --harness <id>     Offer only this harness. Repeatable.
  --once             Drive one run and stop.
  --no-worker        (myco server run) Start the Deployment without its own worker.
  --detect           Print what this machine has, and exit.

A worker offers the harnesses it finds installed and logged in. The Deployment
chooses which one runs each task, from the harness it prefers and the order it
falls back through. One worker serves a Deployment per machine: a second one
waits until the first stops.`;

/** What a worker waits before its first answer tells it the Deployment's own cadence. */
const POLL_IDLE_MS = 2_000;

/** Every `--harness` given, in order. */
function harnessesNamed(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === '--harness' && typeof args[i + 1] === 'string') out.push(args[i + 1]!);
  return out;
}

/** The Deployments a service verb acts on: the one named, else every one this home holds a membership of. */
function serversFor(flags: Map<string, string>, mycoHome: string): string[] | { error: string } {
  const named = flags.get('server');
  if (named === 'true') return { error: '--server needs the Deployment\'s address' };
  if (named !== undefined) return [deploymentUrl(named)];
  const held = listDeploymentMemberships(mycoHome).map((m) => deploymentUrl(m.serverUrl));
  return held.length > 0 ? held : { error: `this machine holds no Deployment membership in ${mycoHome}. Run \`myco login\` first.` };
}

async function runServiceVerb(verb: 'install' | 'uninstall' | 'status', args: string[], deps: WorkerServiceDeps): Promise<boolean> {
  const { flags } = parseFlags(args);
  const mycoHome = deps.mycoHome ?? resolveMycoHome({ cwd: process.cwd() });
  const scoped = { ...deps, mycoHome };
  const servers = serversFor(flags, mycoHome);
  if ('error' in servers) { console.error(`myco worker ${verb}: ${servers.error}`); return false; }
  let ok = true;
  for (const url of servers) {
    if (verb === 'install') {
      const words = ensuredWorkerWords(await ensureWorkerService(url, { ...scoped, force: flags.get('force') === 'true' }));
      console.log(`${url}: ${words.line}`);
      ok = words.ok && ok;
    } else if (verb === 'uninstall') {
      const removed = removeWorkerService(url, scoped);
      console.log('unsupported' in removed
        ? `${url}: ${removed.unsupported}`
        : removed.removed ? `${url}: worker service removed.` : `${url}: no worker service was installed.`);
    } else {
      const words = workerServiceWords(describeWorkerService(url, scoped));
      console.log(`${url}: ${words.line}`);
      ok = words.status === 'ok' && ok;
    }
  }
  return ok;
}

const SERVICE_VERBS = new Set(['install', 'uninstall', 'status']);

export async function run(args: string[], deps: WorkerServiceDeps = {}): Promise<boolean> {
  if (args[0] === '--help' || args[0] === '-h') { console.log(WORKER_HELP); return true; }
  if (args[0] !== undefined && SERVICE_VERBS.has(args[0])) return runServiceVerb(args[0] as 'install' | 'uninstall' | 'status', args.slice(1), deps);
  const { flags } = parseFlags(args);
  const only = harnessesNamed(args);

  if (flags.get('detect') === 'true') {
    for (const found of detectHarnesses(only)) {
      console.log(`${found.id.padEnd(14)} ${found.installed ? 'installed' : 'absent   '}  ${found.authenticated ? 'logged in' : 'not logged in'}`);
    }
    return true;
  }

  const serverUrl = flags.get('server');
  if (serverUrl === undefined || serverUrl === 'true') {
    console.error('myco worker: --server <url> names the Deployment to attach to');
    return false;
  }
  const mycoHome = resolveMycoHome();
  const attach = attachOptions(serverUrl, mycoHome);
  if (readDeploymentMembership(serverUrl, mycoHome) === null) return endRefused(serverUrl, mycoHome, 'no_membership');

  const stopping = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { stopping.abort(); });

  const outcome = await runWorker({
    ...attach,
    ...(only.length === 0 ? {} : { only }),
    ...(flags.get('once') === 'true' ? { once: true } : {}),
    pollIdleMs: POLL_IDLE_MS,
    log: (line) => { console.log(`worker: ${line}`); },
    signal: stopping.signal,
  });
  console.log(`worker: drove ${outcome.driven} run${outcome.driven === 1 ? '' : 's'}`);
  // A worker whose program was replaced ends non-zero, so its service starts
  // the new one.
  if (outcome.replaced === true) return false;
  if (outcome.refused === null) return true;
  if (isTerminalRefusal(outcome.refused)) return endRefused(serverUrl, mycoHome, outcome.refused);
  console.error(`myco worker: ${serverUrl} refused this worker (${outcome.refused})`);
  return false;
}

/** What a terminal refusal means for a person. */
const TERMINAL_WORDS: Readonly<Record<TerminalRefusal, string>> = {
  not_admin: 'this membership is not an administrator\'s, so it cannot run work for the Deployment. No worker runs here until an administrator\'s machine installs one.',
  unauthorized: 'the Deployment does not accept this machine\'s credential. Sign in again with `myco login`, then run `myco worker install`.',
  no_membership: 'this home holds no membership of the Deployment. Run `myco login`, then `myco worker install`.',
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

/** Whether the program at `file` is still the one this process started from. */
export function sameProgram(file: string, identity = executableIdentity): () => boolean {
  const started = identity(file);
  return () => started === null || identity(file) === started;
}

/** Where a worker attached from this terminal or a login service claims from, and how it knows it is alone. */
export function attachOptions(serverUrl: string, mycoHome: string, fetchImpl?: typeof fetch): Pick<WorkerOptions, 'serverUrl' | 'token' | 'renew' | 'lockDir' | 'runRoot' | 'onAttached' | 'stillCurrent'> {
  return {
    serverUrl,
    token: () => readDeploymentMembership(serverUrl, mycoHome)?.token ?? null,
    // The membership's own rotation, the one every hook on this machine uses: a worker left running renews its credential, a lapsed one included.
    renew: async (force) => (await refreshMembership(serverUrl, { mycoHome, budget: unboundedBudget(), force, ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }) })).status,
    lockDir: workerLockDir(),
    runRoot: path.join(mycoHome, 'worker', 'runs'),
    onAttached: () => { clearWorkerRefusal(mycoHome, serverUrl); },
    stillCurrent: sameProgram(process.execPath),
  };
}
