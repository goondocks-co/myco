import { resolveHomeDir, resolveMycoHome } from '../paths/home.js';
import path from 'node:path';
import { listDeploymentMemberships } from '@myco/member/registry.js';
import { codexInstallationRefusal } from '@goondocks/myco-shared/setup-guidance';
import { isLiveRunner, listRunnerRecords, readRunnerRecord, runnerDir } from '../runner/runner-registry.js';
import { unclassifiedWorkerHolders, workerHolder, workerLockDir } from '../runner/instance.js';
import { runnerRenewer } from '../runner/runner-rotation.js';
import { contactRunner, parseContact, type RunnerMetadata } from '../runner/runner-routes.js';
import { listWorkerUnits, harnessDirectories, installWorkerService, uninstallWorkerService, workerServiceSpec, workerServiceStatus, type WorkerServiceTarget } from '../runner/service.js';
import { runnerHarnessPreflight, type RunnerHarnessPreflight } from '@myco/runner/detect.js';
import { ServicePathUnsupported, ServicePlatformUnsupported, ServiceStopFailed } from '../server/service.js';
import { binaryRefusal, executorServiceTarget, describeWorkerService, executionDeploymentUrls, workerServiceWords, type WorkerServiceDeps } from './worker-service.js';
import { RUNNER_ADDRESS_RULE, runnerServerUrl, type RunnerCliDeps } from './runner-deps.js';
import { parseFlags } from './flags.js';
import { runnerUpdater, type RunnerUpdateCliDeps } from './runner-update.js';

export type RunnerServiceDeps = RunnerCliDeps & WorkerServiceDeps & { silentAbsentUninstall?: boolean; renew?: boolean };
export const LEGACY_WORKER_WORDS = 'legacy worker — uses member credential';
export const RUNNER_IDENTITY_REMAINS = 'The Deployment identity remains; remove it on the dashboard.';

export interface LegacyExecutor {
  serverUrl: string | null;
  mycoHome: string | null;
  unitLabel: string | null;
  installed: boolean;
  servingPid: number | null;
  retire: { argv: string[]; env: { MYCO_HOME: string } } | null;
}

/** Read-only executor observations; an unreadable owner has no executable retirement instruction. */
export async function legacyExecutors(deps: WorkerServiceDeps = {}): Promise<LegacyExecutor[]> {
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const lockDir = deps.lockDir ?? workerLockDir(deps.home);
  const executors: LegacyExecutor[] = [];
  for (const unit of listWorkerUnits(deps.home ?? resolveHomeDir(), deps.platform)) {
    const aliases = unit.serverUrl === null || unit.mycoHome === null ? []
      : await executionDeploymentUrls(unit.serverUrl, { ...deps, mycoHome: unit.mycoHome });
    const serving = aliases.map((alias) => workerHolder(lockDir, alias)).find((holder) => holder !== null);
    executors.push({
      serverUrl: unit.serverUrl, mycoHome: unit.mycoHome, unitLabel: unit.spec.unit.label, installed: true,
      servingPid: serving?.pid ?? null,
      retire: unit.mycoHome === null || unit.serverUrl === null ? null
        : { argv: ['myco', 'worker', 'uninstall', '--server', unit.serverUrl], env: { MYCO_HOME: unit.mycoHome } },
    });
  }
  const unknown = unclassifiedWorkerHolders(lockDir);
  const urls = new Set([...listDeploymentMemberships(mycoHome), ...listRunnerRecords(mycoHome)].map((record) => record.serverUrl));
  for (const serverUrl of urls) {
    if (executors.some((executor) => executor.mycoHome === mycoHome && executor.serverUrl === serverUrl)) continue;
    for (const alias of await executionDeploymentUrls(serverUrl, { ...deps, mycoHome })) {
      const state = describeWorkerService(alias, { ...deps, mycoHome });
      if (state?.serving == null || !unknown.some((holder) => holder.pid === state.serving!.pid)
        || executors.some((executor) => executor.servingPid === state.serving!.pid)) continue;
      executors.push({ serverUrl, mycoHome, unitLabel: null, installed: false, servingPid: state.serving.pid, retire: null });
    }
  }
  for (const holder of unknown) {
    if (!executors.some((executor) => executor.servingPid === holder.pid)) {
      executors.push({ serverUrl: null, mycoHome: null, unitLabel: null, installed: false, servingPid: holder.pid, retire: null });
    }
  }
  return executors;
}

/** Every legacy unit names its owning home and its explicit retirement command. */
export async function legacyWorkerInventory(deps: RunnerServiceDeps): Promise<string[]> {
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  return (await legacyExecutors(deps)).map((unit) =>
    !unit.installed
      ? `stop the foreground executor in its owning terminal (process ${(unit.servingPid ?? 0) > 0 ? unit.servingPid : 'unknown'}); its Deployment identity is unverified`
      : unit.retire === null
      ? `${LEGACY_WORKER_WORDS}: unit ${unit.unitLabel} has unreadable ownership; inspect its owning home before retiring it`
      : `${unit.serverUrl}: ${LEGACY_WORKER_WORDS}; owning MYCO_HOME=${quote(unit.retire.env.MYCO_HOME)}; retire with \`MYCO_HOME=${quote(unit.retire.env.MYCO_HOME)} ${unit.retire.argv.map((arg, index) => index === unit.retire!.argv.length - 1 ? quote(arg) : arg).join(' ')}\``);
}

/** A preview uses precisely the PATH written to the service unit. */
export async function preflightRunnerService(target: WorkerServiceTarget, harnessDirs: readonly string[], deps: WorkerServiceDeps = {}): Promise<RunnerHarnessPreflight> {
  const spec = workerServiceSpec(target, harnessDirs);
  const runDir = path.join(runnerDir(target.serverUrl, target.mycoHome), 'runs');
  const pathEnv = (target.platform ?? process.platform) === 'win32'
    ? spec.pathEnv.replace(/%PATH%/gi, () => process.env.PATH ?? '') : spec.pathEnv;
  return runnerHarnessPreflight({ ...process.env, HOME: target.home, MYCO_HOME: target.mycoHome, PATH: pathEnv }, {
    home: target.home, mycoHome: target.mycoHome, runDir, codexHome: path.join(runDir, 'codex-home'),
    codexLogin: path.join(target.home, '.codex', 'auth.json'),
  }, deps);
}

/** The shared contact path can observe authority without creating or rotating a credential. */
export async function runnerServiceContact(serverUrl: string, deps: RunnerServiceDeps = {}, metadata: RunnerMetadata = {}) {
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const record = readRunnerRecord(serverUrl, mycoHome);
  if (!isLiveRunner(record)) throw new Error(`not enrolled with ${serverUrl}; run \`myco runner register ${serverUrl}\``);
  const renew = runnerRenewer(serverUrl, { ...deps, mycoHome, notify: deps.stdout });
  if (deps.renew !== false) await renew(false);
  const contact = () => contactRunner(serverUrl, readRunnerRecord(serverUrl, mycoHome)?.token ?? record.token, metadata, deps.fetch);
  let answer = await contact();
  if (deps.renew !== false && answer.class === 'unauthorized' && await renew(true) === 'refreshed') answer = await contact();
  return answer;
}

/** Legacy units cannot prove their Deployment identity across origins; explicit retirement precedes runner execution. */
export async function runnerExecutionRefusal(deps: RunnerServiceDeps): Promise<string | null> {
  const commands = await legacyWorkerInventory(deps);
  if (commands.length === 0) return null;
  return `${LEGACY_WORKER_WORDS} or unclassified executor remains on this machine. Its identity across origin aliases is unverified; let active work finish, then explicitly stop and remove it in its owning home: ${commands.join('; ')}. No service changed.`;
}

/** A local service operation always names a runner record, never a membership or a project. */
export async function runRunnerService(verb: 'install' | 'status' | 'doctor' | 'uninstall', args: readonly string[], deps: RunnerUpdateCliDeps = {}): Promise<boolean> {
  const out = deps.stdout ?? console.log;
  const err = deps.stderr ?? console.error;
  const fail = (line: string): false => { err(`myco runner ${verb}: ${line}`); return false; };
  const { flags } = parseFlags([...args]);
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const named = flags.get('server');
  const server = named === undefined ? undefined : runnerServerUrl(named);
  if (named !== undefined && (named === 'true' || server === null)) return fail(RUNNER_ADDRESS_RULE);
  const records = listRunnerRecords(mycoHome);
  if (verb === 'status' || verb === 'doctor') (await legacyWorkerInventory(deps)).forEach(line => out(line));
  const urls = server === undefined ? records.map((record) => record.serverUrl) : [server!];
  if (urls.length === 0) return fail('no runner registration in this home; run `myco runner register <host>` first');
  if (verb === 'install' && urls.length > 1) return fail('registered with multiple Deployments; name one with --server <url>');
  let ok = true;
  for (const url of urls) {
    const record = readRunnerRecord(url, mycoHome);
    const scoped = { ...deps, mycoHome };
    const target = executorServiceTarget(url, scoped, 'runner');
    const options = { ...(deps.runner === undefined ? {} : { runner: deps.runner }), ...(deps.lockDir === undefined ? {} : { lockDir: deps.lockDir }) };
    try {
      if (verb === 'uninstall') {
        const removed = uninstallWorkerService(target, options);
        if (removed.removed || !deps.silentAbsentUninstall) out(`${url}: ${removed.removed ? 'runner service stopped and removed' : 'no runner service was installed'}. ${RUNNER_IDENTITY_REMAINS}`);
        continue;
      }
      if (verb === 'install') {
        if (!isLiveRunner(record)) { ok = fail(`not enrolled with ${url}; run \`myco runner register ${url}\``); continue; }
        const legacyRefusal = await runnerExecutionRefusal(scoped);
        if (legacyRefusal !== null) { ok = fail(legacyRefusal); continue; }
        const unusable = binaryRefusal(target);
        if (unusable !== null) { ok = fail(unusable); continue; }
        const aliases = await executionDeploymentUrls(url, scoped);
        const legacy = aliases.map((alias) => describeWorkerService(alias, scoped));
        if (legacy.some((state) => state?.installed === true) || (!workerServiceStatus(target, options).installed && legacy.some((state) => state?.serving != null))) {
          ok = fail(`${LEGACY_WORKER_WORDS} or another executor already serves ${url}; let its active run finish, then stop it explicitly with \`myco worker uninstall --server ${url}\`. No service changed.`); continue;
        }
        const harnessDirs = (deps.harnessDirs ?? harnessDirectories)();
        const preview = await preflightRunnerService(target, harnessDirs, deps);
        out('  Coding agents (preview in the service PATH; confirmed by its acknowledged offer):');
        for (const harness of preview.harnesses) {
          out(`  ${harness.id}: ${harness.id === 'codex' && !preview.codex.ok ? codexInstallationRefusal(preview.codex.directory, preview.codex.rule)
            : !harness.installed ? 'not installed' : harness.authenticated ? 'signed in' : 'not signed in'}`);
        }
        const installed = installWorkerService(target, harnessDirs, options);
        const state = workerServiceStatus(target, options);
        if (!installed.loaded || !state.installed || !state.loaded || !state.running) {
          ok = fail(`the runner service is written but is not running (${state.detail ?? installed.detail ?? 'check its logs'}); run \`myco runner doctor --server ${url}\``); continue;
        }
        out(`${url}: runner service ${installed.changed ? 'installed and started' : 'already running'}. Logs: ${state.outLog}`);
        continue;
      }
      out(`${url}: ${isLiveRunner(record) ? `registered runner ${record.name} (${record.runnerId})` : record === null ? `not registered; run \`myco runner register ${url}\`` : 'registration pending'}`);
      const update = runnerUpdater(url, scoped, line => out(`  ${line}`));
      const updateStatus = update.contactPayload();
      out(`  version: ${updateStatus.currentVersion}; channel: ${updateStatus.channel ?? 'unavailable'}`);
      out(`  last update check: ${updateStatus.lastCheckAt === null ? 'never' : new Date(updateStatus.lastCheckAt).toISOString()}`);
      const lastUpdate = updateStatus.lastResult;
      out(`  last update result: ${lastUpdate === undefined ? 'none' : `${lastUpdate.result}: ${lastUpdate.fromVersion} → ${lastUpdate.toVersion}${lastUpdate.reason === undefined ? '' : ` (${lastUpdate.reason})`}`}`);
      const state = workerServiceStatus(target, options);
      const service = !state.installed ? 'not installed' : !state.loaded ? 'installed, not loaded' : !state.running ? 'installed, not running' : 'running at login';
      out(`  runner service: ${service}${state.detail === undefined ? '' : ` (${state.detail})`}`);
      const blocked = await runnerExecutionRefusal(scoped);
      if (blocked !== null) out(`  execution refused: ${blocked}`);
      const legacy = describeWorkerService(url, scoped);
      if (legacy?.installed === true) out(`  ${LEGACY_WORKER_WORDS}: ${workerServiceWords(legacy).line}`);
      const offer = record?.lastOffer;
      out(offer === undefined
        ? '  harnesses offered: unknown (no acknowledged service offer); observation time: unknown'
        : `  harnesses offered: ${offer.offered.join(', ') || 'none'}; withheld: ${offer.withheld.join(', ') || 'none'}; observed: ${new Date(offer.observedAt).toISOString()}`);
      out(`  last contact: ${record?.lastContactAt === undefined ? 'never recorded by the service' : new Date(record.lastContactAt).toISOString()}`);
      if (!isLiveRunner(record)) { ok = false; continue; }
      const answer = await runnerServiceContact(url, { ...scoped, stdout: (line) => out(`  ${line}`) }, { update: updateStatus });
      if (answer.class === 'acked') {
        const contact = parseContact(answer.body);
        if (contact === null) { ok = fail('unreadable contact response'); continue; }
        const runner = answer.body.runner as { state?: unknown } | undefined;
        out(`  Deployment state: ${String(runner?.state ?? 'unknown')}`);
      } else {
        out(`  contact refused or unavailable: ${answer.class}${'code' in answer ? ` (${answer.code})` : ''}${'detail' in answer ? `: ${answer.detail}` : ''}; no member credential is used`);
        ok = false;
      }
    } catch (error) {
      if (!(error instanceof ServicePathUnsupported || error instanceof ServicePlatformUnsupported || error instanceof ServiceStopFailed)) throw error;
      ok = fail(error.message);
    }
  }
  return ok;
}
