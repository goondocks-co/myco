/** Home diagnostics and the current repository's Deployment checks. No repairs are performed. */
import { readUpdateNotice } from '../upgrade/check-cache.js';
import fs from 'node:fs';
import path from 'node:path';
import { DOCTOR_SIGN_IN, DOCTOR_REFUSED_HOOK_REPAIR } from '@goondocks/myco-shared/setup-guidance';
import { withoutCredentialFlag } from '../mcp/deployment-upstream.js';
import type { CredentialSource } from '../member/constants.js';
import { REJOIN_HINT } from '../member/delivery-notice.js';
import { projectDiagnostics } from '../member/diagnostics.js';
import { readRefusedHook, REFUSED_HOOK_KINDS, refusedHookWords } from '../member/refused-hooks.js';
import { deploymentUrl, listDeploymentMembershipsResult, listRegistryEntriesResult, readRegistryEntryResult } from '../member/registry.js';
import { loadManifests, resolvePackageRoot } from '../symbionts/detect.js';
import { SymbiontInstaller } from '../symbionts/installer.js';
import { readProvisionRecord } from '../symbionts/member-provision-record.js';
import { missingMemberSkills } from '../symbionts/member-skill-links.js';
import { getPluginVersion } from '../version.js';
import { checkMemberMcpResolution, checkWorkerServices, formatCheck, type DoctorCheck } from './doctor-member.js';
import { envOf, homeOf, membershipProblem, openDeployment, rootOf, type MemberVerbDeps } from './deployment-reader.js';
import { executorServiceTarget, type WorkerServiceDeps } from './worker-service.js';
import { readDefaultDeployment } from '../member/default-deployment.js';
import { listLeftRepositories } from '../member/auto-join.js';
import { pathIsAbsent } from '../member/store.js';
import { listRunnerRecords, isLiveRunner } from '../runner/runner-registry.js';
import { workerServiceStatus } from '../runner/service.js';
import { hasLegacyInstall } from './member-dispatch.js';

export interface MemberDoctorDeps extends MemberVerbDeps {
  /** The worker service probe's own dependencies (service runner, platform). */
  worker?: WorkerServiceDeps;
  /** The directory the symbiont templates are read from. */
  packageRoot?: string;
}

const USAGE = 'Usage: myco doctor [--fix]';

const iso = (ms: number | null | undefined): string => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : 'unknown');

const row = (name: string, status: DoctorCheck['status'], detail: string): DoctorCheck => ({ name, status, detail, fixable: false });

/** The program a hook command runs: its first word after any `NAME=value` assignments, unquoted. */
export function hookExecutable(command: string): string | null {
  const words = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const program = words.find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
  return program === undefined ? null : program.replace(/^(["'])(.*)\1$/, '$2');
}

/** Why a hook's program cannot run, or null when it can. */
function programProblem(program: string): string | null {
  if (!path.isAbsolute(program)) return null;
  try {
    fs.accessSync(program, fs.constants.X_OK);
    return null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'is missing' : 'is not executable';
  }
}

/**
 * Which harnesses capture for the member, at which scope. A harness with 1.4
 * capture only is named for provisioning, and a member hook whose program is
 * missing or not executable captures nothing, so it is named too.
 */
function captureChecks(root: string, mycoHome: string, packageRoot: string, required = true): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  let capturing = 0;
  for (const manifest of loadManifests()) {
    if (!manifest.registration?.hooksTarget && !manifest.registration?.memberHooksTarget) continue;
    const at = (scope: 'member-global' | 'member-project') => new SymbiontInstaller(manifest, root, packageRoot, false, undefined, null, scope, mycoHome);
    const seen = [at('member-global').inspectMemberHooks(), at('member-project').inspectMemberHooks()];
    for (const hooks of seen) {
      if (!hooks.readable) {
        checks.push(row('Capture', 'warn', `${manifest.displayName}'s ${hooks.scope} hooks (${hooks.target}) could not be read, so whether it captures is unknown.`));
      } else if (hooks.member) {
        const broken = [...new Set(hooks.memberCommands.map(hookExecutable).filter((p): p is string => p !== null))]
          .map((program) => ({ program, problem: programProblem(program) }))
          .filter((entry): entry is { program: string; problem: string } => entry.problem !== null);
        if (broken.length > 0) {
          const { program, problem } = broken[0];
          checks.push(row('Capture', 'warn', `${manifest.displayName}'s ${hooks.scope} hooks (${hooks.target}) run ${program}, which ${problem}, so they capture nothing. Run \`myco member provision ${manifest.name}\` from this project.`));
        } else {
          capturing += 1;
          checks.push(row('Capture', 'ok', `${manifest.displayName} captures for the member from its ${hooks.scope} hooks (${hooks.target}).`));
        }
      } else if (hooks.present) {
        checks.push(row('Capture', 'warn', `${manifest.displayName}'s ${hooks.scope} hooks (${hooks.target}) are Myco's 1.4 capture, not the member's. Run \`myco member provision ${manifest.name}\`.`));
      }
    }
  }
  if (capturing === 0 && required) {
    checks.push(row('Capture', 'fail', 'no harness on this machine captures for the member. Run `myco member provision <agent>` from this project.'));
  }
  return checks;
}

/**
 * The hooks on this machine their own command refused (`member/refused-hooks.ts`): one that names no harness, or no
 * credential source. Each exits 0, so this is where the loss shows.
 */
export function refusedHookChecks(mycoHome: string, now: number): DoctorCheck[] {
  return REFUSED_HOOK_KINDS.flatMap((kind) => {
    let record;
    try { record = readRefusedHook(kind, mycoHome, now, { prune: false, strict: true }); }
    catch (error) { return [row('Capture', 'warn', `refused hooks unavailable: ${error instanceof Error ? error.message : String(error)}`)]; }
    return record === null ? [] : [row('Capture', 'warn', `${refusedHookWords(record)}, last ${iso(record.lastAt)}${record.lastHook ? ` (hook ${record.lastHook})` : ''}. ${DOCTOR_REFUSED_HOOK_REPAIR}`)];
  });
}

/** The build and registration recorded by agent provisioning, with current wiring checked. */
export function setupChecks(mycoHome: string, version: string = getPluginVersion()): DoctorCheck[] {
  const record = readProvisionRecord(mycoHome);
  if (record === null) return [row('Setup', 'warn', 'nothing records which agents Myco set up on this machine. Run `myco member provision`.')];
  if (record.version !== version) {
    return [row('Setup', 'warn', `your agents were set up by Myco ${record.version}; this is ${version}. Run \`myco member provision --refresh\`.`)];
  }
  const missing: string[] = [];
  for (const manifest of loadManifests().filter((m) => record.agents.includes(m.name))) {
    try {
      const installer = new SymbiontInstaller(manifest, mycoHome, resolvePackageRoot(), false, undefined, null, 'member-global', mycoHome)
        .withoutProjectRoot().forDeployment(record.serverUrl);
      if (!installer.memberRegistrationCurrent()) return [row('Setup', 'warn', `${manifest.displayName}'s hooks or MCP entry are missing or stale. The next Myco helper pass repairs them; run \`myco member provision --refresh\` to repair them now.`)];
    } catch (error) {
      return [row('Setup', 'warn', `${manifest.displayName}'s configuration could not be checked: ${error instanceof Error ? error.message : String(error)}. Run \`myco member provision ${manifest.name}\`.`)];
    }
    const target = manifest.registration?.globalSkillsTarget;
    if (!target) continue;
    const absent = missingMemberSkills(mycoHome, target);
    if (absent.length > 0) missing.push(`${manifest.displayName} (${absent.join(', ')})`);
  }
  if (missing.length > 0) return [row('Setup', 'warn', `skills are missing for ${missing.join('; ')}. Run \`myco member provision --refresh\`.`)];
  return [row('Setup', 'ok', `${record.agents.length === 0 ? 'no agent' : record.agents.join(', ')} set up by this build for ${record.serverUrl}.`)];
}

/** The Deployment and capture checks scoped to one repository. */
export async function projectReport(source: CredentialSource, deps: MemberDoctorDeps = {}): Promise<DoctorCheck[]> {
  const root = rootOf(deps);
  const mycoHome = homeOf(deps);
  const now = (deps.now ?? Date.now)();
  const checks: DoctorCheck[] = [];

  const read = source === 'registry' ? readRegistryEntryResult(root, mycoHome) : null;
  const problem = source === 'registry' ? membershipProblem(deps) : null;
  if (problem !== null) checks.push(row('Membership', 'fail', problem));

  const deployment = problem === null ? await openDeployment(source, deps) : null;
  if (deployment === null && problem === null) {
    checks.push(row('Deployment', 'fail', `no member credential resolves for this project (--credential ${source}).`));
  } else if (deployment !== null) {
    if (read?.status === 'present') {
      checks.push(row('Membership', 'ok', `project ${deployment.projectId} on ${deployment.serverUrl} (machine ${read.entry.machineId}, joined ${iso(read.entry.joinedAt)}).`));
    }
    if (!(await deployment.healthy())) {
      checks.push(row('Deployment', 'fail', `${deployment.serverUrl} did not answer its health route from this machine.`));
    } else {
      const tools = await deployment.listTools();
      checks.push(tools.ok
        ? row('Deployment', 'ok', `${deployment.serverUrl} answers, and serves this machine's credential ${tools.value.length} tools.`)
        : row('Deployment', 'fail', `${deployment.serverUrl} answers its health route and refused this machine's tool list (${tools.error.code}): ${tools.error.message}`));
    }
  }

  // Read after the Deployment was asked: its read renews a credential whose window is open.
  const after = source === 'registry' ? readRegistryEntryResult(root, mycoHome) : null;
  if (after?.status === 'present') {
    const facts = projectDiagnostics(after.entry, mycoHome, now);
    const { membership, spool, latch, refusals } = facts;
    if (membership.refreshTerminal === true) {
      checks.push(row('Credential', 'fail', `the Deployment will not renew this credential — ${REJOIN_HINT}.`));
    } else if (membership.expired === true) {
      checks.push(row('Credential', 'warn', `expired at ${iso(membership.expiresAt)}; the next hook or member read renews it unless this machine has been inactive too long.`));
    } else {
      checks.push(row('Credential', 'ok', `expires ${iso(membership.expiresAt)}; ${membership.refreshAfter === null ? 'the renewal window is not announced yet' : `renews after ${iso(membership.refreshAfter)}`}.`));
    }

    if (!spool.readable || spool.unacknowledgedTotal === null) {
      checks.push(row('Spool', 'warn', 'the spool could not be read, so what is waiting to deliver is unknown.'));
    } else if (spool.unacknowledgedTotal > 0) {
      checks.push(row('Spool', 'warn', `${spool.unacknowledgedTotal} event(s) in ${spool.sessionFiles} session file(s) are waiting to deliver; the next hook drains them, or run \`myco member drain\`.`));
    } else {
      checks.push(row('Spool', 'ok', `nothing waiting to deliver (last delivery ${spool.lastDeliveryAt === null ? 'never' : iso(spool.lastDeliveryAt)}).`));
    }
    if (!facts.latchReadable) checks.push(row('Spool', 'warn', 'the offline latch could not be read, so whether capture is holding off is unknown.'));
    else if (latch !== null) checks.push(row('Spool', 'warn', `capture has held off the Deployment since ${iso(latch.since)}; next probe ${iso(latch.nextProbeAt)}.`));
    if (!refusals.logReadable) checks.push(row('Refusals', 'warn', 'the refusal log could not be read.'));
    else if (refusals.loggedSinceLastReset > 0) {
      checks.push(row('Refusals', 'warn', `the Deployment refused ${refusals.loggedSinceLastReset} event(s); \`myco logs\` lists them.`));
    }
  }

  const packageRoot = deps.packageRoot ?? resolvePackageRoot();
  checks.push(...captureChecks(root, mycoHome, packageRoot));
  const vaultDir = path.join(root, '.myco');
  checks.push(...await checkMemberMcpResolution(vaultDir, { ...envOf(deps), MYCO_HOME: mycoHome }, { registryRead: 'strict' }));
  return checks;
}

const CUTOVER_RECORD = path.join('member', 'cutover.json');
const LOGOUT_DIRECTORY = path.join('member', 'logout');

/** A home with only 1.4 state retains the local doctor. No binary is run to classify it. */
export function useHomeDoctor(home: string): boolean {
  const memberships = listDeploymentMembershipsResult(home);
  return !hasLegacyInstall(home) || !memberships.readable || memberships.unavailableEntries > 0
    || memberships.memberships.length > 0 || !pathIsAbsent(path.join(home, 'runner'))
    || !pathIsAbsent(path.join(home, CUTOVER_RECORD)) || !pathIsAbsent(path.join(home, LOGOUT_DIRECTORY));
}

/** Repository opt-outs and the reconnection each marker permits. */
function leftRepositoryChecks(home: string): DoctorCheck[] {
  try {
    return listLeftRepositories(home).map(repository => row('Repository', 'ok',
      `${repository.root ?? `repository key ${repository.key} (path not recorded)`}: left alone${repository.serverUrl ? ` after logout from ${repository.serverUrl}` : ''}; ${repository.explicitJoinOnly ? 'capture will not automatically join it to another Myco' : 'capture is opted out until reconnected here or through Deployment settings'}. To reconnect, run \`myco member join\` from that repository.`));
  } catch (error) {
    return [row('Repositories', 'warn', `left-alone repositories could not be read: ${error instanceof Error ? error.message : String(error)}`)];
  }
}

/** Local machine facts, independent of the current repository's binding. */
export async function homeReport(home: string, deps: MemberDoctorDeps = {}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const now = (deps.now ?? Date.now)();
  let runners: ReturnType<typeof listRunnerRecords> = [];
  try { runners = listRunnerRecords(home); }
  catch (error) { checks.push(row('Runner', 'fail', `runner records could not be read: ${error instanceof Error ? error.message : String(error)}`)); }
  const listing = listDeploymentMembershipsResult(home);
  if (!listing.readable || listing.unavailableEntries > 0) checks.push(row('Memberships', 'fail', 'Deployment memberships could not all be read; which Mycos this machine joined is unknown.'));
  if (listing.readable && listing.unavailableEntries === 0 && listing.memberships.length === 0 && runners.length === 0) {
    checks.push(row('Memberships', 'warn', DOCTOR_SIGN_IN));
  }
  const selected = readDefaultDeployment(home);
  for (const membership of listing.memberships) {
    checks.push(row('Membership', 'ok', `${membership.serverUrl}${selected?.serverUrl === deploymentUrl(membership.serverUrl) ? ' (default for new repositories)' : ''}; machine ${membership.machineId}, joined ${iso(membership.joinedAt)}.`));
    const state = membership.refreshTerminal === true ? 'refused renewal' : membership.expiresAt !== undefined && membership.expiresAt <= now ? 'expired' : membership.expiresAt === undefined ? 'expiry unknown' : 'locally unexpired';
    checks.push(row('Credential', state === 'locally unexpired' ? 'ok' : 'warn', `${membership.serverUrl}: ${state}; expires ${iso(membership.expiresAt)} (local record; authentication not checked)${membership.refreshTerminal === true ? ` — ${REJOIN_HINT}` : ''}.`));
    const provision = readProvisionRecord(home);
    checks.push(row('Agents', provision?.serverUrl === membership.serverUrl ? 'ok' : 'warn', `${membership.serverUrl}: ${provision?.serverUrl === membership.serverUrl ? provision.agents.join(', ') || 'none recorded' : 'no provisioning recorded for this Deployment'}.`));
  }
  const projects = listRegistryEntriesResult(home);
  if (!projects.readable || projects.unavailableEntries > 0) checks.push(row('Repositories', 'fail', 'repository routes could not all be read; routing is unknown for those entries.'));
  for (const entry of projects.entries) {
    checks.push(row('Repository', 'ok', `${entry.root} → ${entry.serverUrl} / ${entry.projectId}.`));
    const facts = projectDiagnostics(entry, home, now);
    checks.push(row('Capture backlog', facts.spool.readable && facts.spool.unacknowledgedTotal === 0 ? 'ok' : 'warn',
      `${entry.root}: ${facts.spool.readable ? `${facts.spool.unacknowledgedTotal ?? 'unknown'} event(s) waiting to deliver` : 'spool unreadable'}; last delivery ${iso(facts.spool.lastDeliveryAt)}.`));
    if (!facts.latchReadable || facts.latch !== null) checks.push(row('Capture', 'warn', `${entry.root}: ${facts.latchReadable ? `delivery held off since ${iso(facts.latch?.since)}; next probe ${iso(facts.latch?.nextProbeAt)}` : 'offline latch unreadable'}.`));
    if (!facts.refusals.logReadable || facts.refusals.loggedSinceLastReset > 0 || facts.refusals.unreadableLines > 0) checks.push(row('Refusals', 'warn', `${entry.root}: ${facts.refusals.logReadable ? `${facts.refusals.loggedSinceLastReset} refused events; ${facts.refusals.unreadableLines} unreadable log lines` : 'refusal log unreadable'}. Run \`myco logs\` from that repository.`));
  }
  checks.push(...leftRepositoryChecks(home), ...refusedHookChecks(home, now));
  if (listing.memberships.length > 0 || runners.length === 0) checks.push(...setupChecks(home));
  if (readRegistryEntryResult(rootOf(deps), home).status === 'missing') checks.push(...captureChecks(rootOf(deps), home, deps.packageRoot ?? resolvePackageRoot(), listing.memberships.length > 0));
  const worker = { ...deps.worker, mycoHome: home };
  try { checks.push(...await checkWorkerServices(path.join(rootOf(deps), '.myco'), worker)); }
  catch (error) { checks.push(row('Worker service', 'warn', `service state unavailable: ${error instanceof Error ? error.message : String(error)}`)); }
  for (const record of runners) {
    checks.push(row('Runner', isLiveRunner(record) ? 'ok' : 'warn', `${record.serverUrl}: ${isLiveRunner(record) ? `registered ${record.name} (${record.runnerId})` : 'registration pending'}; last contact ${iso(record.lastContactAt)}.`));
    try {
      const state = workerServiceStatus(executorServiceTarget(record.serverUrl, worker, 'runner'), { runner: worker.runner, lockDir: worker.lockDir });
      const words = !state.installed ? 'not installed' : !state.loaded ? 'installed, not loaded' : !state.running ? 'installed, stopped' : 'running';
      checks.push(row('Runner service', state.running ? 'ok' : 'warn', `${record.serverUrl}: ${words}${state.detail ? ` (${state.detail})` : ''}. Check \`myco runner status --server ${record.serverUrl}\`.`));
    } catch (error) {
      checks.push(row('Runner service', 'warn', `${record.serverUrl}: unavailable: ${error instanceof Error ? error.message : String(error)}`));
    }
    checks.push(row('Runner offer', record.lastOffer ? 'ok' : 'warn', `${record.serverUrl}: ${record.lastOffer ? `offered ${record.lastOffer.offered.join(', ') || 'none'}; withheld ${record.lastOffer.withheld.join(', ') || 'none'}; observed ${iso(record.lastOffer.observedAt)}` : 'unknown (no acknowledged service offer)'}.`));
  }
  if (hasLegacyInstall(home)) checks.push(row('Myco 1.4', 'warn', `1.4 data may remain at ${path.join(home, 'groves')}; migration completion is not verified. Next: \`myco cutover --dry-run\`.`));
  return checks;
}

/** Print home facts and, when a credential resolves here, the repository checks. */
export async function run(args: readonly string[], source: CredentialSource, deps: MemberDoctorDeps = {}): Promise<boolean> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const flags = withoutCredentialFlag(args);
  const unknown = flags.filter(flag => flag !== '--fix');
  if (unknown.length > 0) { err(`${USAGE}\nmyco doctor: unknown option ${unknown[0]}`); return false; }
  const notice = readUpdateNotice(homeOf(deps), getPluginVersion());
  if (notice !== null) out(notice);
  const checks = await homeReport(homeOf(deps), deps);
  if (source === 'env' || readRegistryEntryResult(rootOf(deps), homeOf(deps)).status !== 'missing') checks.push(...await projectReport(source, deps));

  out('\nmyco doctor (member)\n');
  for (const check of checks) out(formatCheck(check));
  const failed = checks.filter((check) => check.status === 'fail');
  const warned = checks.filter((check) => check.status === 'warn');
  out('');
  out(failed.length + warned.length === 0 ? '  All checks passed.' : `  ${failed.length} failed, ${warned.length} warning(s).`);
  if (flags.includes('--fix') && failed.length + warned.length > 0) out('  Nothing here repairs automatically; each row names the command that does.');
  out('');
  return failed.length === 0;
}
