import { resolveHomeDir, resolveMycoHome } from '../paths/home.js';
import { isLiveRunner, listRunnerRecords, readRunnerRecord, recordRunnerContact } from '../runner/runner-registry.js';
import { unclassifiedWorkerHolders, workerLockDir } from '../runner/instance.js';
import { runnerRenewer } from '../runner/runner-rotation.js';
import { contactRunner, parseContact } from '../runner/runner-routes.js';
import { detectHarnessesAsync, offerOf } from '../runner/detect.js';
import { listWorkerUnits, harnessDirectories, installWorkerService, uninstallWorkerService, workerServiceStatus } from '../runner/service.js';
import { ServicePathUnsupported, ServicePlatformUnsupported, ServiceStopFailed } from '../server/service.js';
import { binaryRefusal, executorServiceTarget, describeWorkerService, executionDeploymentUrls, workerServiceWords, type WorkerServiceDeps } from './worker-service.js';
import { RUNNER_ADDRESS_RULE, runnerServerUrl, type RunnerCliDeps } from './runner-deps.js';
import { parseFlags } from './flags.js';

export type RunnerServiceDeps = RunnerCliDeps & WorkerServiceDeps;
export const LEGACY_WORKER_WORDS = 'legacy worker — uses member credential';
export const RUNNER_IDENTITY_REMAINS = 'The Deployment identity remains; remove it on the dashboard.';

/** Every legacy unit names its owning home and its explicit retirement command. */
export function legacyWorkerInventory(deps: RunnerServiceDeps): string[] {
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  return listWorkerUnits(deps.home ?? resolveHomeDir(), deps.platform).map((unit) =>
    unit.mycoHome === null || unit.serverUrl === null
      ? `${LEGACY_WORKER_WORDS}: unit ${unit.unitFile} has unreadable ownership; inspect its owning home before retiring it`
      : `${unit.serverUrl}: ${LEGACY_WORKER_WORDS}; owning MYCO_HOME=${quote(unit.mycoHome)}; retire with \`MYCO_HOME=${quote(unit.mycoHome)} myco worker uninstall --server ${quote(unit.serverUrl)}\``);
}

/** Legacy units cannot prove their Deployment identity across origins; explicit retirement precedes runner execution. */
export function runnerExecutionRefusal(deps: RunnerServiceDeps): string | null {
  const commands = legacyWorkerInventory(deps);
  const unclassified = unclassifiedWorkerHolders(deps.lockDir ?? workerLockDir(deps.home));
  if (commands.length === 0 && unclassified.length === 0) return null;
  if (unclassified.length > 0) commands.push(`stop the foreground executor in its owning terminal (process ${unclassified.map((holder) => holder.pid > 0 ? holder.pid : 'unknown').join(', ')}); its Deployment identity is unverified`);
  return `${LEGACY_WORKER_WORDS} or unclassified executor remains on this machine. Its identity across origin aliases is unverified; let active work finish, then explicitly stop and remove it in its owning home: ${commands.join('; ')}. No service changed.`;
}

/** A local service operation always names a runner record, never a membership or a project. */
export async function runRunnerService(verb: 'install' | 'status' | 'doctor' | 'uninstall', args: readonly string[], deps: RunnerServiceDeps = {}): Promise<boolean> {
  const out = deps.stdout ?? console.log;
  const err = deps.stderr ?? console.error;
  const fail = (line: string): false => { err(`myco runner ${verb}: ${line}`); return false; };
  const { flags } = parseFlags([...args]);
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const named = flags.get('server');
  const server = named === undefined ? undefined : runnerServerUrl(named);
  if (named !== undefined && (named === 'true' || server === null)) return fail(RUNNER_ADDRESS_RULE);
  const records = listRunnerRecords(mycoHome);
  if (verb === 'status' || verb === 'doctor') legacyWorkerInventory(deps).forEach(line => out(line));
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
        out(`${url}: ${removed.removed ? 'runner service stopped and removed' : 'no runner service was installed'}. ${RUNNER_IDENTITY_REMAINS}`);
        continue;
      }
      if (verb === 'install') {
        if (!isLiveRunner(record)) { ok = fail(`not enrolled with ${url}; run \`myco runner register ${url}\``); continue; }
        const legacyRefusal = runnerExecutionRefusal(scoped);
        if (legacyRefusal !== null) { ok = fail(legacyRefusal); continue; }
        const unusable = binaryRefusal(target);
        if (unusable !== null) { ok = fail(unusable); continue; }
        const aliases = await executionDeploymentUrls(url, scoped);
        const legacy = aliases.map((alias) => describeWorkerService(alias, scoped));
        if (legacy.some((state) => state?.installed === true) || (!workerServiceStatus(target, options).installed && legacy.some((state) => state?.serving != null))) {
          ok = fail(`${LEGACY_WORKER_WORDS} or another executor already serves ${url}; let its active run finish, then stop it explicitly with \`myco worker uninstall --server ${url}\`. No service changed.`); continue;
        }
        const installed = installWorkerService(target, (deps.harnessDirs ?? harnessDirectories)(), options);
        const state = workerServiceStatus(target, options);
        if (!installed.loaded || !state.installed || !state.loaded || !state.running) {
          ok = fail(`the runner service is written but is not running (${state.detail ?? installed.detail ?? 'check its logs'}); run \`myco runner doctor --server ${url}\``); continue;
        }
        out(`${url}: runner service ${installed.changed ? 'installed and started' : 'already running'}. Logs: ${state.outLog}`);
        continue;
      }
      out(`${url}: ${isLiveRunner(record) ? `registered runner ${record.name} (${record.runnerId})` : record === null ? `not registered; run \`myco runner register ${url}\`` : 'registration pending'}`);
      const state = workerServiceStatus(target, options);
      const service = !state.installed ? 'not installed' : !state.loaded ? 'installed, not loaded' : !state.running ? 'installed, not running' : 'running at login';
      out(`  runner service: ${service}${state.detail === undefined ? '' : ` (${state.detail})`}`);
      const blocked = runnerExecutionRefusal(scoped);
      if (blocked !== null) out(`  execution refused: ${blocked}`);
      const legacy = describeWorkerService(url, scoped);
      if (legacy?.installed === true) out(`  ${LEGACY_WORKER_WORDS}: ${workerServiceWords(legacy).line}`);
      const offered = offerOf(await (deps.detect ?? (() => detectHarnessesAsync(undefined, undefined, { credentialBytes: false })))());
      out(`  harnesses offered: ${offered.offered.filter((h) => h.installed && h.authenticated).map((h) => h.id).join(', ') || 'none'}; withheld: ${offered.withheld.join(', ') || 'none'}`);
      if (!isLiveRunner(record)) { out('  last contact: unknown (no enrolled credential)'); ok = false; continue; }
      out(`  last contact: ${record.lastContactAt === undefined ? 'never recorded locally' : new Date(record.lastContactAt).toISOString()}`);
      const renew = runnerRenewer(url, { ...deps, mycoHome, notify: (line) => out(`  ${line}`) });
      await renew(false);
      const contact = () => contactRunner(url, readRunnerRecord(url, mycoHome)?.token ?? record.token, {}, deps.fetch);
      let answer = await contact();
      if (answer.class === 'unauthorized' && await renew(true) === 'refreshed') answer = await contact();
      if (answer.class === 'acked') {
        const contact = parseContact(answer.body);
        if (contact === null) { ok = fail('unreadable contact response'); continue; }
        if (!await recordRunnerContact(url, { runnerId: contact.runner.id, deploymentId: contact.runner.deploymentId }, (deps.now ?? Date.now)(), mycoHome)) out('  runner record busy; contact timestamp was not saved');
        out(`  contact acknowledged: ${new Date((deps.now ?? Date.now)()).toISOString()}`);
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
