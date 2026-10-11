/** Home diagnostics and the current repository's Deployment checks. No repairs are performed. */
import { readUpdateNotice } from '../upgrade/check-cache.js';
import fs from 'node:fs';
import path from 'node:path';
import { DOCTOR_SIGN_IN, DOCTOR_REFUSED_HOOK_REPAIR } from '@goondocks/myco-shared/setup-guidance';
import { withoutCredentialFlag } from '../mcp/deployment-upstream.js';
import type { CredentialSource } from '../member/constants.js';
import { REJOIN_HINT } from '../member/delivery-notice.js';
import { projectDiagnostics } from '../member/diagnostics.js';
import { MemberSpool } from '../member/spool.js';
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
import { ServerClient } from '../member/transport.js';
import { legacyMigrationPending, LegacyMigrationUnreadable } from '../member/legacy-migration.js';
import { legacyVaultFiles } from '../member/home-role.js';
import { defaultMycoHome } from '../paths/home.js';

export interface MemberDoctorDeps extends MemberVerbDeps {
  /** The worker service probe's own dependencies (service runner, platform). */
  worker?: WorkerServiceDeps;
  /** The directory the symbiont templates are read from. */
  packageRoot?: string;
}

const USAGE = 'Usage: myco doctor [--fix]';

const iso = (ms: number | null | undefined): string => (typeof ms === 'number' && Number.isFinite(ms) && !Number.isNaN(new Date(ms).getTime()) ? new Date(ms).toISOString() : 'unknown');

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
        checks.push(row('Capture', 'warn', `${manifest.displayName}'s ${hooks.scope} hooks (${hooks.target}) could not be read, so whether it captures is unknown. Run \`myco member provision ${manifest.name}\`.`));
      } else if (hooks.member) {
        const broken = [...new Set(hooks.memberCommands.map(hookExecutable).filter((p): p is string => p !== null))]
          .map((program) => ({ program, problem: programProblem(program) }))
          .filter((entry): entry is { program: string; problem: string } => entry.problem !== null);
        if (broken.length > 0) {
          const { program, problem } = broken[0];
          checks.push(row('Capture', 'warn', `${manifest.displayName}'s ${hooks.scope} hooks (${hooks.target}) run ${program}, which ${problem}, so they capture nothing. Run \`myco member provision ${manifest.name}\` from this project.`));
        } else {
          capturing += 1;
          checks.push(row('Capture', 'not-checked', `${manifest.displayName}'s ${hooks.scope} hooks (${hooks.target}) are installed; capture execution not checked. Start a new agent session, then run \`myco doctor\`.`));
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
    catch (error) { return [row('Capture', 'warn', `refused hooks unavailable: ${error instanceof Error ? error.message : String(error)}. ${DOCTOR_REFUSED_HOOK_REPAIR}`)]; }
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
  const checks: DoctorCheck[] = [];

  const problem = source === 'registry' ? membershipProblem(deps) : null;
  if (problem !== null) checks.push(row('Membership', 'fail', problem));

  let authenticated = false;
  const deployment = problem === null ? await openDeployment(source, deps) : null;
  if (deployment === null && problem === null) {
    checks.push(row('Deployment', 'fail', `no member credential resolves for this project (--credential ${source}). Run \`myco login <address>\`, then \`myco doctor --credential registry\`.`));
  } else if (deployment !== null) {
    const tools = await deployment.listTools();
    authenticated = tools.ok;
    checks.push(tools.ok
      ? row('Project access', 'ok', `${deployment.serverUrl} answers, and serves this machine's credential ${tools.value.length} tools.`)
      : row('Project access', 'fail', `${deployment.serverUrl} ${tools.error.code === 'unauthorized' ? 'refused' : 'could not serve'} this machine's tool list (${tools.error.code}): ${tools.error.message}. Run \`myco doctor\` from this repository after restoring access.`));
  }

  // Read after the Deployment was asked: its read renews a credential whose window is open.
  const after = source === 'registry' ? readRegistryEntryResult(root, mycoHome) : null;
  if (after?.status === 'present') {
    const membership = after.entry;
    const expired = membership.expiresAt !== undefined && membership.expiresAt <= (deps.now ?? Date.now)();
    checks.push(membership.refreshTerminal === true
      ? row('Credential', 'fail', `the Deployment will not renew this credential — ${REJOIN_HINT}.`)
      : row('Credential', authenticated ? 'ok' : expired ? 'warn' : 'not-checked', `${membership.serverUrl}: ${authenticated ? 'authenticated' : 'authentication not checked'}; expires ${iso(membership.expiresAt)}${expired ? ' (expired)' : ''}. Run \`myco doctor\` from this repository to check again.`));
  }

  const packageRoot = deps.packageRoot ?? resolvePackageRoot();
  checks.push(...captureChecks(root, mycoHome, packageRoot));
  const vaultDir = path.join(root, '.myco');
  checks.push(...await checkMemberMcpResolution(vaultDir, { ...envOf(deps), MYCO_HOME: mycoHome }, { registryRead: 'strict' }));
  return checks;
}

const HOME_HEALTH_TIMEOUT_MS = 1500;
export const RECENT_REFUSAL_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_CREDENTIAL_MS = RECENT_REFUSAL_MS;
const CUTOVER_RECORD = path.join('member', 'cutover.json');
const LOGOUT_DIRECTORY = path.join('member', 'logout');

/** A home with only unmigrated 1.4 vaults retains the local doctor. No binary is run to classify it. */
export function useHomeDoctor(home: string): boolean {
  const memberships = listDeploymentMembershipsResult(home);
  let pending: boolean;
  try { pending = legacyMigrationPending(home); }
  catch (error) {
    if (error instanceof LegacyMigrationUnreadable) return true;
    throw error;
  }
  return !pending || !memberships.readable || memberships.unavailableEntries > 0
    || memberships.memberships.length > 0 || !pathIsAbsent(path.join(home, 'runner'))
    || !pathIsAbsent(path.join(home, CUTOVER_RECORD)) || !pathIsAbsent(path.join(home, LOGOUT_DIRECTORY));
}

/** Repository opt-outs and the reconnection each marker permits. */
function leftRepositoryChecks(home: string): DoctorCheck[] {
  try {
    return listLeftRepositories(home).map(repository => {
      if ('error' in repository) return row('Repositories', 'warn', `${repository.error}. Inspect the marker under ${home}; run \`myco member join\` from the affected repository to reconnect.`);
      return row('Repository', 'warn',
        `${repository.root ?? `repository key ${repository.key} (path not recorded; older marker, identify the repository before reconnecting)`}: left alone${repository.serverUrl ? ` after leaving ${repository.serverUrl}` : ''}; ${repository.explicitJoinOnly ? 'capture will not automatically join it to another Myco' : 'capture is opted out until reconnected here or through Deployment settings'}. To reconnect, run \`myco member join\` from that repository.`);
    });
  } catch (error) {
    return [row('Repositories', 'warn', `left-alone repositories could not be read: ${error instanceof Error ? error.message : String(error)}. Inspect the markers, then run \`myco member join\` from any repository to reconnect`)];
  }
}

/** Local machine facts, independent of the current repository's binding. */
export async function homeReport(home: string, deps: MemberDoctorDeps = {}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const now = (deps.now ?? Date.now)();
  let runners: ReturnType<typeof listRunnerRecords> = [];
  try { runners = listRunnerRecords(home); }
  catch (error) { checks.push(row('Runner', 'fail', `runner records could not be read: ${error instanceof Error ? error.message : String(error)}. Inspect the runner records, then run \`myco runner doctor\``)); }
  const listing = listDeploymentMembershipsResult(home);
  if (!listing.readable || listing.unavailableEntries > 0) checks.push(row('Memberships', 'fail', 'Deployment memberships could not all be read; which Mycos this machine joined is unknown. Inspect the membership files, then run `myco login <address>`.'));
  if (listing.readable && listing.unavailableEntries === 0 && listing.memberships.length === 0 && runners.length === 0) {
    checks.push(row('Memberships', 'warn', DOCTOR_SIGN_IN));
  }
  let selected;
  try { selected = readDefaultDeployment(home, { strict: true }); }
  catch (error) { checks.push(row('Default Myco', 'warn', `${error instanceof Error ? error.message : String(error)}. Inspect ${path.join(home, 'member', 'default.json')}, then run \`myco login <address> --default\`.`)); }
  for (const membership of listing.memberships) {
    checks.push(row('Membership', 'ok', `${membership.serverUrl}${selected?.serverUrl === deploymentUrl(membership.serverUrl) ? ' (default for new repositories)' : ''}; machine ${membership.machineId}, joined ${iso(membership.joinedAt)}.`));
    const state = membership.refreshTerminal === true ? 'refused renewal' : membership.expiresAt !== undefined && membership.expiresAt <= now ? 'expired' : membership.expiresAt === undefined ? 'expiry unknown' : 'locally unexpired';
    checks.push(row('Credential', state === 'locally unexpired' ? 'not-checked' : membership.refreshTerminal === true ? 'fail' : 'warn', `${membership.serverUrl}: ${state}; expires ${iso(membership.expiresAt)} (local record; authentication not checked)${membership.refreshTerminal === true ? ` — ${REJOIN_HINT}` : ` — run \`myco login ${membership.serverUrl}\``}.`));
    const healthy = await new ServerClient(membership, deps.fetch ?? globalThis.fetch).health({
      connectTimeoutMs: HOME_HEALTH_TIMEOUT_MS,
      requestTimeoutMs: Math.min(deps.requestTimeoutMs ?? HOME_HEALTH_TIMEOUT_MS, HOME_HEALTH_TIMEOUT_MS),
    });
    checks.push(row('Deployment', healthy ? 'ok' : 'fail', healthy
      ? `${membership.serverUrl} answers its health route.`
      : `${membership.serverUrl} is unreachable or did not answer its health route. Check the address and connection, then run \`myco doctor\` again.${membership.expiresAt !== undefined && membership.expiresAt <= now - STALE_CREDENTIAL_MS ? ` If this address was abandoned, run myco logout ${membership.serverUrl} --local-only to remove its local membership.` : ''}`));
  }
  const projects = listRegistryEntriesResult(home);
  if (!projects.readable || projects.unavailableEntries > 0) checks.push(row('Repositories', 'fail', 'repository routes could not all be read; routing is unknown for those entries. Run `myco member join` from each affected repository.'));
  for (const entry of projects.entries) {
    checks.push(row('Repository', 'ok', `${entry.root} → ${entry.serverUrl} / ${entry.projectId}.`));
    const facts = projectDiagnostics(entry, home, now);
    checks.push(row('Capture backlog', facts.spool.readable && facts.spool.unacknowledgedTotal === 0 ? 'ok' : 'warn',
      `${entry.root}: ${facts.spool.readable ? `${facts.spool.unacknowledgedTotal ?? 'unknown'} event(s) waiting to deliver` : 'spool unreadable'}; last delivery ${iso(facts.spool.lastDeliveryAt)}.${facts.spool.readable && facts.spool.unacknowledgedTotal === 0 ? '' : ' Run `myco member drain` from that repository.'}`));
    if (!facts.latchReadable || facts.latch !== null) checks.push(row('Capture', 'warn', `${entry.root}: ${facts.latchReadable ? `delivery held off since ${iso(facts.latch?.since)}; next probe ${iso(facts.latch?.nextProbeAt)}` : 'offline latch unreadable'}. Run \`myco member drain\` from that repository.`));
    const refusals = new MemberSpool(entry, { mycoHome: home, initialize: false }).readRefused();
    if (!refusals.readable || refusals.entries.length > 0 || refusals.unreadableLines > 0) {
      const latest = refusals.entries.reduce<number | null>((last, refusal) => last === null ? refusal.at : Math.max(last, refusal.at), null);
      const recent = refusals.entries.filter(refusal => refusal.at >= now - RECENT_REFUSAL_MS).length;
      checks.push(row('Refusals', !refusals.readable || recent > 0 || refusals.unreadableLines > 0 ? 'warn' : 'ok',
        `${entry.root}: ${refusals.readable ? `${refusals.entries.length} refused events; newest ${iso(latest)}; ${recent} in the last 7 days; ${refusals.unreadableLines} unreadable log lines` : 'refusal log unreadable'}. Run myco logs from that repository.`));
    }
  }
  checks.push(...leftRepositoryChecks(home), ...refusedHookChecks(home, now));
  if (listing.memberships.length > 0) checks.push(...setupChecks(home));
  if (readRegistryEntryResult(rootOf(deps), home).status === 'missing') checks.push(...captureChecks(rootOf(deps), home, deps.packageRoot ?? resolvePackageRoot(), listing.memberships.length > 0));
  const worker = { ...deps.worker, mycoHome: home };
  try { checks.push(...await checkWorkerServices(path.join(rootOf(deps), '.myco'), worker)); }
  catch (error) { checks.push(row('Worker service', 'warn', `service state unavailable: ${error instanceof Error ? error.message : String(error)}. Run \`myco runner doctor\``)); }
  for (const record of runners) {
    checks.push(row('Runner', isLiveRunner(record) ? 'ok' : 'warn', `${record.serverUrl}: ${isLiveRunner(record) ? `registered ${record.name} (${record.runnerId})` : `registration pending; run \`myco runner register ${record.serverUrl}\``}; last contact ${iso(record.lastContactAt)}.`));
    try {
      const state = workerServiceStatus(executorServiceTarget(record.serverUrl, worker, 'runner'), { runner: worker.runner, lockDir: worker.lockDir });
      const words = !state.installed ? 'not installed' : !state.loaded ? 'installed, not loaded' : !state.running ? 'installed, stopped' : 'running';
      checks.push(row('Runner service', state.running ? 'ok' : 'warn', `${record.serverUrl}: ${words}${state.detail ? ` (${state.detail})` : ''}. Run \`myco runner install --server ${record.serverUrl}\`.`));
    } catch (error) {
      checks.push(row('Runner service', 'warn', `${record.serverUrl}: unavailable: ${error instanceof Error ? error.message : String(error)}. Run \`myco runner doctor --server ${record.serverUrl}\``));
    }
    checks.push(row('Runner offer', record.lastOffer ? 'ok' : 'not-checked', `${record.serverUrl}: ${record.lastOffer ? `offered ${record.lastOffer.offered.join(', ') || 'none'}; withheld ${record.lastOffer.withheld.join(', ') || 'none'}; observed ${iso(record.lastOffer.observedAt)}` : 'unknown (no acknowledged service offer); run `myco runner status` after starting the runner'}.`));
  }
  try {
    if (legacyMigrationPending(home)) {
      const homes = [...new Set([home, defaultMycoHome()].map(directory => path.resolve(directory)))];
      const vaults = [...new Set(homes.flatMap(directory => legacyVaultFiles(directory)))];
      checks.push(row('Myco 1.4', 'warn', `migration pending; retained vault files: ${vaults.join(', ')}. Next: \`myco cutover --dry-run\`.`));
    }
  } catch (error) {
    if (!(error instanceof LegacyMigrationUnreadable)) throw error;
    checks.push(row('Myco 1.4', 'fail', `migration state unavailable: ${error.message}. Inspect ${error.file}, then run \`myco cutover --dry-run\`.`));
  }
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
  const binding = readRegistryEntryResult(rootOf(deps), homeOf(deps));
  const projectChecks = source === 'env' || binding.status !== 'missing' ? await projectReport(source, deps) : [];
  const homeChecks = await homeReport(homeOf(deps), deps);
  const checkedCredential = projectChecks.some(check => check.name === 'Credential');
  const checks = [
    ...homeChecks.filter(check => !(checkedCredential && binding.status === 'present' && check.name === 'Credential' && check.detail.startsWith(binding.entry.serverUrl + ':'))),
    ...projectChecks,
  ];

  out('\nmyco doctor (member)\n');
  for (const check of checks) out(formatCheck(check));
  const failed = checks.filter((check) => check.status === 'fail');
  const warned = checks.filter((check) => check.status === 'warn');
  out('');
  const unchecked = checks.filter(check => check.status === 'not-checked');
  out(failed.length + warned.length + unchecked.length === 0 ? '  All checks passed.' : `  ${failed.length} failed, ${warned.length} warning(s), ${unchecked.length} not checked.`);
  if (flags.includes('--fix') && failed.length + warned.length > 0) out('  Nothing here repairs automatically; each row names the command that does.');
  out('');
  return failed.length === 0;
}
