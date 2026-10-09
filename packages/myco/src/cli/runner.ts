/**
 * `myco runner` — register this machine as a runner of a Deployment and drive
 * the Deployment's queued runs on its harnesses.
 *
 * A runner has its own bearer and nothing else of Myco: no membership, no
 * vault, no capture. Runner services use this home’s runner record; capture and agent settings
 * remain independent.
 */
import path from 'node:path';
import semver from 'semver';
import { RELEASE_CHANNELS, type ReleaseChannel } from '../constants/update.js';
import { resolveMycoHome } from '../paths/home.js';
import { keepMachineAwake } from '../runner/keep-awake.js';
import { CLAIM_IDLE_POLL_MS, runWorker } from '../runner/loop.js';
import { sameProgram } from '../runner/program.js';
import { getPluginVersion } from '../version.js';
import { workerLogLine } from '../runner/log.js';
import { workerLockDir } from '../runner/instance.js';
import { isLiveRunner, listRunnerRecords, readRunnerRecord, recordRunnerContact, runnerDir } from '../runner/runner-registry.js';
import { rotateRunnerCredential, runnerRenewer } from '../runner/runner-rotation.js';
import { RUNNER_CONTACT_PATH } from '../runner/runner-routes.js';
import { harnessesNamed, parseFlags } from './flags.js';
import { RUNNER_ADDRESS_RULE, runnerServerUrl } from './runner-deps.js';
import { registerRunner } from './runner-register.js';
import { runRunnerService, runnerExecutionRefusal } from './runner-service.js';
import { executionDeploymentUrls } from './worker-service.js';
import { runnerUpdater, updateRunner, type RunnerUpdateCliDeps } from './runner-update.js';
import { runRunnerUpdateHelper } from '../runner/update-helper.js';

export const RUNNER_HELP = `myco runner — run a Deployment's queued tasks on this machine's harnesses

Usage:
  myco runner register <host> [--name <name>] [--replace]
                                  Register this machine as a runner of the Deployment.
  myco runner run [--server <url>] [--once] [--harness <id>]...
                                  Claim and drive the Deployment's runs in this terminal.
  myco runner rotate [--server <url>]
                                  Rotate this runner's credential now.
  myco runner update [--check] [--server <url>] [--channel <alpha|beta|stable>] [--target-version <version>]
                                  Update within the installed channel between runs.
  myco runner status [--server <url>]
                                  Show registration, service, contact and harnesses.
  myco runner doctor [--server <url>]
                                  Diagnose registration and service refusals.
  myco runner install [--server <url>]
                                  Start this enrolled runner as a per-user service.
  myco runner uninstall [--server <url>]
                                  Remove the local service; retain Deployment identity.

register prints a link and a code. Open the link on a machine signed in to the
dashboard, check the code and the runner's name, and approve. This terminal
waits for approval; no browser is opened here, so it works over SSH. A bare
host defaults to HTTPS. --replace registers afresh over a record the
Deployment no longer accepts.

A runner holds its own credential, separate from any member's, and runs only
with the harnesses already signed in on this machine; the Deployment never
hands it a provider key. --server defaults to the only Deployment this machine
is registered with. One runner or worker serves a Deployment per machine: a
second one waits until the first stops.
`;

const RUNS_DIRNAME = 'runs';
const STEPS_DIRNAME = 'steps';
const DIAGNOSTICS_DIRNAME = 'diagnostics';
const SERVER_NEEDED = '--server needs the Deployment\'s address';

interface RunnerRunDeps extends RunnerUpdateCliDeps {
  /** Stops a running runner; defaults to SIGINT and SIGTERM. */
  signal?: AbortSignal;
}

const instant = (at: number | undefined): string => (at === undefined ? 'unknown' : new Date(at).toISOString());

/** The Deployment a verb acts on: the one named, else the only one this home is registered with. */
function resolveServer(flags: Map<string, string>, mycoHome: string): { serverUrl: string } | { error: string } {
  const named = flags.get('server');
  if (named === 'true') return { error: SERVER_NEEDED };
  if (named !== undefined) {
    const serverUrl = runnerServerUrl(named);
    return serverUrl === null ? { error: RUNNER_ADDRESS_RULE } : { serverUrl };
  }
  const held = listRunnerRecords(mycoHome).filter(isLiveRunner);
  if (held.length === 1) return { serverUrl: held[0]!.serverUrl };
  if (held.length === 0) return { error: 'this machine is registered with no Deployment; run `myco runner register <host>` first' };
  return { error: `this machine is registered with ${held.length} Deployments; name one with --server (${held.map((r) => r.serverUrl).join(', ')})` };
}

/** The runner's current bearer, read afresh on every request so a rotation is followed. */
function tokenReader(serverUrl: string, mycoHome: string, log: (line: string) => void): () => string | null {
  return () => {
    try {
      return readRunnerRecord(serverUrl, mycoHome)?.token ?? null;
    } catch (error) {
      log(`cannot read this runner's record: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
}

async function runVerb(args: readonly string[], deps: RunnerRunDeps): Promise<boolean> {
  const err = deps.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const fail = (line: string): boolean => { err(`myco runner run: ${line}`); return false; };
  const { flags } = parseFlags([...args]);
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const target = resolveServer(flags, mycoHome);
  if ('error' in target) return fail(target.error);
  const { serverUrl } = target;
  const record = readRunnerRecord(serverUrl, mycoHome);
  if (!isLiveRunner(record)) return fail(`this machine is not registered with ${serverUrl}; run \`myco runner register ${serverUrl}\``);

  const legacyRefusal = runnerExecutionRefusal(deps);
  if (legacyRefusal !== null) return fail(legacyRefusal);

  const log = (line: string): void => { (deps.stdout ?? console.log)(workerLogLine(line)); };
  let contactBusyLogged = false;
  let offerBusyLogged = false;
  const dir = runnerDir(serverUrl, mycoHome);
  const updater = runnerUpdater(serverUrl, { ...deps, mycoHome, binaryPath: deps.binaryPath ?? process.execPath }, log, true);
  updater.startup();
  const only = harnessesNamed([...args]);
  const stopping = deps.signal === undefined ? new AbortController() : null;
  if (stopping !== null) for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { stopping.abort(); });

  const outcome = await runWorker({
    serverUrl,
    token: tokenReader(serverUrl, mycoHome, log),
    renew: runnerRenewer(serverUrl, { mycoHome, fetch: deps.fetch, now: deps.now, notify: log }),
    compatibilityPath: RUNNER_CONTACT_PATH,
    detection: { credentialBytes: false },
    lockDir: deps.lockDir ?? workerLockDir(deps.home),
    deploymentId: record.deploymentId,
    deploymentUrls: await executionDeploymentUrls(serverUrl, { ...deps, mycoHome }),
    stillCurrent: sameProgram(deps.binaryPath ?? process.execPath, undefined, undefined, log),
    contactBody: () => ({ version: deps.version ?? getPluginVersion(), os: process.platform, update: updater.contactPayload() }),
    onContact: async (body) => {
      const runner = body.runner as { id: string; deploymentId: string };
      if (runner.id !== record.runnerId) throw new Error('authenticated contact names a different runner');
      if (!await recordRunnerContact(serverUrl, { runnerId: runner.id, deploymentId: runner.deploymentId }, (deps.now ?? Date.now)(), mycoHome)) {
        if (!contactBusyLogged) log('runner record busy; contact timestamp was not saved');
        contactBusyLogged = true;
      } else contactBusyLogged = false;
      updater.onContact(body);
      updater.acknowledgeHealthy();
    },
    onOfferAcknowledged: async (offer, at) => {
      if (!await recordRunnerContact(serverUrl, { runnerId: record.runnerId, deploymentId: record.deploymentId! }, at, mycoHome, offer)) {
        if (!offerBusyLogged) log('runner record busy; acknowledged harness offer was not saved');
        offerBusyLogged = true;
      } else offerBusyLogged = false;
    },
    onIdle: async () => { const outcome = await updater.idle(); return outcome === 'continue' ? undefined : outcome; },
    onClaim: () => updater.recordClaim(),
    onClaimCompleted: () => updater.recordClaim(true),
    runRoot: path.join(dir, RUNS_DIRNAME),
    stepRoot: path.join(dir, STEPS_DIRNAME),
    diagnosticRoot: path.join(dir, DIAGNOSTICS_DIRNAME),
    keepAwake: keepMachineAwake,
    ...(only.length === 0 ? {} : { only }),
    ...(flags.get('once') === 'true' ? { once: true } : {}),
    ...(deps.fetch === undefined ? {} : { fetchImpl: deps.fetch }),
    pollIdleMs: CLAIM_IDLE_POLL_MS,
    signal: deps.signal ?? stopping!.signal,
    log,
  });
  log(`drove ${outcome.driven} run${outcome.driven === 1 ? '' : 's'}`);
  if (outcome.replaced === true) return false;
  if (outcome.refused === null) return true;
  updater.recordHealthRefusal(outcome.refused);
  if (outcome.refused === 'unauthorized' || outcome.refused === 'no_membership') {
    return fail(`${serverUrl} does not accept this runner's credential; register it afresh with \`myco runner register ${serverUrl} --replace\``);
  }
  return fail(`${serverUrl} refused this runner (${outcome.refused})`);
}

async function rotateVerb(args: readonly string[], deps: RunnerRunDeps): Promise<boolean> {
  const out = deps.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const fail = (line: string): boolean => { err(`myco runner rotate: ${line}`); return false; };
  const { flags } = parseFlags([...args]);
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const target = resolveServer(flags, mycoHome);
  if ('error' in target) return fail(target.error);
  const { serverUrl } = target;
  const report = await rotateRunnerCredential(serverUrl, { mycoHome, fetch: deps.fetch, now: deps.now, force: true });
  const detail = report.detail === undefined ? '' : `: ${report.detail}`;
  switch (report.status) {
    case 'refreshed':
      out(`Rotated this runner's credential for ${serverUrl}. The next rotation window opens ${instant(report.record?.refreshAfter)}.`);
      return true;
    case 'too-early':
      out(`The Deployment rotates this runner's credential from ${instant(report.record?.refreshAfter)}; nothing changed.`);
      return true;
    case 'not-due':
      out('Another process rotated this runner\'s credential first; nothing more to do.');
      return true;
    case 'no-entry':
      return fail(`this machine is not registered with ${serverUrl}`);
    case 'busy':
      return fail('another myco runner process is rotating this credential; try again shortly');
    case 'retry':
      return fail(`could not reach ${serverUrl}${detail}; the same rotation is sent again next time`);
    case 'lineage-expired':
    case 'unauthorized':
      return fail(`${serverUrl} no longer accepts this runner${detail}; register it afresh with \`myco runner register ${serverUrl} --replace\``);
    default:
      return fail(`rotation ended ${report.status}${detail}`);
  }
}

/** Run a `myco runner` verb, and report whether it succeeded. */
export async function run(args: readonly string[], deps: RunnerRunDeps = {}): Promise<boolean> {
  const [verb, ...rest] = args;
  const err = deps.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  switch (verb) {
    case '__apply-update':
      if (rest.length !== 1 || !path.isAbsolute(rest[0]!)) throw new Error('runner update helper requires one absolute handoff path');
      await runRunnerUpdateHelper(rest[0]!, deps.updateHelper);
      return true;
    case 'register': return registerRunner(rest, deps);
    case 'run': return runVerb(rest, deps);
    case 'rotate': return rotateVerb(rest, deps);
    case 'update': {
      const { flags } = parseFlags(rest);
      const mycoHome = deps.mycoHome ?? resolveMycoHome();
      const target = resolveServer(flags, mycoHome);
      if ('error' in target) { err(`myco runner update: ${target.error}`); return false; }
      const channel = flags.get('channel');
      const targetVersion = flags.get('target-version');
      if (channel !== undefined && !RELEASE_CHANNELS.includes(channel as ReleaseChannel)) { err('myco runner update: invalid channel'); return false; }
      if (targetVersion !== undefined && !semver.valid(targetVersion)) { err('myco runner update: invalid target version'); return false; }
      try { return await updateRunner(target.serverUrl, flags.get('check') === 'true', { ...deps, mycoHome }, {
        ...(channel === undefined ? {} : { channel: channel as ReleaseChannel }), ...(targetVersion === undefined ? {} : { targetVersion }),
      }); }
      catch (error) { err(`myco runner update: ${error instanceof Error ? error.message : String(error)}`); return false; }
    }
    case 'status':
    case 'doctor':
    case 'install':
    case 'uninstall': return runRunnerService(verb, rest, deps);
    case undefined:
    case '--help':
    case '-h':
      (deps.stdout ?? ((line) => process.stdout.write(`${line}\n`)))(RUNNER_HELP.trimEnd());
      return true;
    default:
      err(`myco runner: unknown verb ${verb}`);
      err(RUNNER_HELP.trimEnd());
      return false;
  }
}
