/**
 * `myco worker` — attach this machine's harnesses to a Deployment.
 *
 * A worker runs where the harnesses are logged in, which is the machine a
 * person already codes on or a machine an operator keeps for the purpose. It
 * needs no vault and no project, so it reads the Deployment membership this
 * machine already holds and claims work across every Project that Deployment
 * serves.
 */
import { resolveMycoHome } from '../paths/home.js';
import { readDeploymentMembership } from '../member/registry.js';
import { detectHarnesses } from '../runner/detect.js';
import { runWorker } from '../runner/loop.js';
import { parseFlags } from './shared.js';
import path from 'node:path';

export const WORKER_HELP = `myco worker — run tasks for a Deployment on this machine's harnesses

Usage:
  myco worker --server <url> [options]

Options:
  --server <url>     The Deployment to attach to. Required.
  --harness <id>     Offer only this harness. Repeatable.
  --once             Drive one run and stop.
  --no-worker        (myco server run) Start the Deployment without its own worker.
  --detect           Print what this machine has, and exit.

A worker offers the harnesses it finds installed and logged in. The Deployment
chooses which one runs each task, from the harness it prefers and the order it
falls back through.`;

const HEARTBEAT_MS = 30_000;
const POLL_IDLE_MS = 2_000;

/** Every `--harness` given, in order. */
function harnessesNamed(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === '--harness' && typeof args[i + 1] === 'string') out.push(args[i + 1]!);
  return out;
}

export async function run(args: string[]): Promise<boolean> {
  if (args[0] === '--help' || args[0] === '-h') { console.log(WORKER_HELP); return true; }
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
  const membership = readDeploymentMembership(serverUrl);
  if (membership === null) {
    console.error(`myco worker: this machine holds no membership of ${serverUrl}. Run \`myco login\` first.`);
    return false;
  }

  const stopping = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { stopping.abort(); });

  const driven = await runWorker({
    serverUrl,
    token: membership.token,
    runRoot: path.join(resolveMycoHome(), 'worker', 'runs'),
    ...(only.length === 0 ? {} : { only }),
    ...(flags.get('once') === 'true' ? { once: true } : {}),
    heartbeatMs: HEARTBEAT_MS,
    pollIdleMs: POLL_IDLE_MS,
    log: (line) => { console.log(`worker: ${line}`); },
    signal: stopping.signal,
  });
  console.log(`worker: drove ${driven} run${driven === 1 ? '' : 's'}`);
  return true;
}
