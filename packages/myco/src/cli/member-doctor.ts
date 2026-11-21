import { LEGACY_TRANSCRIPTS_NOT_IMPORTED } from './legacy-capture.js';
import { captureHealthChecks } from './doctor-capture.js';
import { doctorOutput } from './doctor-output.js';
import { doctorDeploymentRequest, doctorDeploymentFailure, doctorDeploymentHealth } from '@myco/cli/doctor-deployment.js';
import { managedMemberHarnesses, memberProvisionTarget, memberHarnessStatus } from '@myco/cli/member.js';
/** Home diagnostics and the current repository's Deployment checks. No repairs are performed. */
import { readUpdateNotice } from '../upgrade/check-cache.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { harnessToolsElsewhere } from '@goondocks/myco-shared/setup-guidance';
import { DOCTOR_SIGN_IN, DOCTOR_REFUSED_HOOK_REPAIR } from '@goondocks/myco-shared/setup-guidance';
import { withoutCredentialFlag } from '../mcp/deployment-upstream.js';
import type { CredentialSource } from '../member/constants.js';
import { REJOIN_HINT } from '../member/delivery-notice.js';
import { observationInstant as iso, observeProjectCapture, observeRunnerService } from '@myco/cli/home-observations.js';
import { readRefusedHook, REFUSED_HOOK_KINDS, refusedHookWords } from '../member/refused-hooks.js';
import { deploymentUrl, listDeploymentMembershipsResult, listRegistryEntriesResult, readRegistryEntryResult, registryConflictWords } from '../member/registry.js';
import { loadManifests, resolvePackageRoot } from '../symbionts/detect.js';
import { repositoryMycoEntries } from '@myco/symbionts/repository-entries.js';
import { SymbiontInstaller, MemberProvisionConflictError, MemberMcpConflictError } from '../symbionts/installer.js';
import { joinSentences } from '@myco/utils/sentences.js';
import { readProvisionRecord, UnreadableProvisionRecordError } from '../symbionts/member-provision-record.js';
import { missingMemberSkills } from '../symbionts/member-skill-links.js';
import { excludedVariableFolder, folderOriginWords, folderWords, harnessSettingsFolders, missingSettingsFolders, rejectedSettingsFolders, withSettingsFolderSnapshot } from '../symbionts/settings-folders.js';
import { FORGET_SETTINGS_FOLDER_FLAG, SETTINGS_FOLDER_FLAG } from './flags.js';
import { getPluginVersion } from '../version.js';
import { checkInstallation, checkAutomaticUpdate, checkMemberMcpResolution, checkWorkerServices, type DoctorCheck } from './doctor-member.js';
import { envOf, homeOf, membershipProblem, openDeployment, rootOf, type MemberVerbDeps } from './deployment-reader.js';
import type { WorkerServiceDeps } from './worker-service.js';
import { readDefaultDeployment } from '../member/default-deployment.js';
import { autoJoinIdentityIssues, listLeftRepositories, pendingImportHolds } from '../member/auto-join.js';
import { pathIsAbsent } from '../member/store.js';
import { listRunnerRecords, isLiveRunner } from '../runner/runner-registry.js';
import { legacyMigrationState } from '../member/legacy-migration.js';
import { observeLegacyStrayHistory } from '../member/legacy-strays.js';
import { legacyVaultFiles } from '../member/home-role.js';
import { peekDeploymentRecord, resolveWrangler, wranglerToolLine } from '@myco/server/cloudflare.js';
import type { CommandRunner } from '@myco/server/runner.js';
import { readSetupFile } from '@myco/setup/answers.js';
import { defaultMycoHome } from '../paths/home.js';

export interface MemberDoctorDeps extends MemberVerbDeps {
  cloudflareRunner?: CommandRunner;
  /** The worker service probe's own dependencies (service runner, platform). */
  worker?: WorkerServiceDeps;
  /** The directory the symbiont templates are read from. */
  packageRoot?: string;
}

const USAGE = 'Usage: myco doctor [--all]';


const row = (name: string, status: DoctorCheck['status'], detail: string, summary?: string): DoctorCheck => ({ name, status, detail, summary, fixable: false });

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
    const folders = harnessSettingsFolders(manifest, mycoHome);
    const seen = folders.map(folder => {
      const installer = new SymbiontInstaller(manifest, root, packageRoot, false, mycoHome).inSettingsFolder(folder);
      const refusal = installer.settingsFolderRefusal();
      return { folder, refusal, hooks: refusal === null ? installer.inspectMemberHooks() : null };
    });
    const capturesSomewhere = seen.some(({ hooks }) => hooks?.member);
    for (const { folder, refusal, hooks } of seen) {
      if (refusal !== null || hooks === null) {
        checks.push(row('Capture', 'warn', joinSentences(refusal!.problem, refusal!.remedy)));
        continue;
      }
      if (folder.origin !== 'default') {
        const where = `${manifest.displayName}'s settings folder ${folderWords(folder.path)} (${folderOriginWords(folder, manifest.settingsFolder?.variable)})`;
        if (!hooks.readable) checks.push(row('Capture', 'warn', `${where}: its hooks (${hooks.target}) could not be read, so whether it captures is unknown. Restore read access to this file.`));
        else if (hooks.member) {
          capturing += 1;
          checks.push({ ...row('Capture', 'not-checked', `${where} has Myco's hooks; capture execution not checked. Start a new agent session from it to check capture.`), symbiont: manifest.name });
        } else if (capturesSomewhere) {
          checks.push(row('Capture', 'warn', `${where} has no Myco hooks, so sessions run from it are not captured. Run \`myco member provision --refresh\` to set it up.`, `${manifest.displayName} sessions run from ${folderWords(folder.path)} are not captured. Run \`myco member provision --refresh\`.`));
        }
        continue;
      }
      if (!hooks.readable) {
        checks.push(row('Capture', 'warn', `${manifest.displayName}'s ${hooks.scope} hooks (${hooks.target}) could not be read, so whether it captures is unknown. Restore read access to this file.`, `${manifest.displayName}'s capture settings could not be read. Restore read access to ${hooks.target}.`));
      } else if (hooks.member) {
        const broken = [...new Set(hooks.memberCommands.map(hookExecutable).filter((p): p is string => p !== null))]
          .map((program) => ({ program, problem: programProblem(program) }))
          .filter((entry): entry is { program: string; problem: string } => entry.problem !== null);
        if (broken.length > 0) {
          const { program, problem } = broken[0];
          checks.push(row('Capture', 'warn', `${manifest.displayName}'s ${hooks.scope} hooks (${hooks.target}) run ${program}, which ${problem}, so they capture nothing. Check this executable and its access permissions.`, `${manifest.displayName} cannot capture: its Myco command ${program} ${problem}. Check this executable and its access permissions.`));
        } else {
          capturing += 1;
          checks.push({ ...row('Capture', 'not-checked', `${manifest.displayName}'s ${hooks.scope} hooks (${hooks.target}) are connected; capture execution not checked.${manifest.registration?.memberCaptureLimits ? ' ' + manifest.registration.memberCaptureLimits : ' Start a new agent session to check capture.'}`), symbiont: manifest.name });
        }
      } else if (hooks.present) {
        checks.push(row('Capture', 'warn', `${manifest.displayName}'s ${hooks.scope} hooks (${hooks.target}) are Myco's 1.4 capture, not the member's. Review capture handover with \`myco cutover --dry-run\`.`, `${manifest.displayName} still uses Myco 1.4 capture. Run \`myco cutover --dry-run\` to review the handover.`));
      }
    }
  }
  if (capturing === 0 && required) {
    checks.push(row('Capture', 'fail', 'no harness on this machine captures for the member. Review the agent setup checks in this report before starting another session.', 'No agent on this machine captures sessions. Run `myco member provision` before starting another session.'));
  }
  return checks;
}

/**
 * Hook commands refused on this machine: missing harness or credential declarations, and unknown hook names.
 * Each exits 0, so this is where the refusal shows.
 */
export function refusedHookChecks(mycoHome: string, now: number): DoctorCheck[] {
  return REFUSED_HOOK_KINDS.flatMap((kind) => {
    let record;
    try { record = readRefusedHook(kind, mycoHome, now, { prune: false, strict: true }); }
    catch (error) { return [row('Capture', 'warn', `refused hooks unavailable: ${error instanceof Error ? error.message : String(error)}. ${DOCTOR_REFUSED_HOOK_REPAIR}`, `Capture refusals could not be checked. Review \`myco doctor --all\` and restore access to the reported file.`)]; }
    return record === null ? [] : [row('Capture', 'warn', `${refusedHookWords(record)}, last ${iso(record.lastAt)}${record.lastHook ? ` (hook ${record.lastHook})` : ''}. ${DOCTOR_REFUSED_HOOK_REPAIR}`, `${record.count} capture attempts could not run since ${iso(record.firstAt)}; most recent ${iso(record.lastAt)}. ${DOCTOR_REFUSED_HOOK_REPAIR}`)];
  });
}

function setupRefusalWords(agent: string, error: unknown): string {
  const problem = error instanceof MemberProvisionConflictError ? error.problem : error instanceof Error ? error.message : String(error);
  const recovery = error instanceof MemberMcpConflictError ? error.localRemedy : undefined;
  return recovery === undefined
    ? joinSentences(`${agent}'s configuration could not be checked: ${problem}`, 'Review this configuration before changing global hooks or tools.')
    : joinSentences(problem, recovery);
}

/** The build and registration recorded by agent provisioning, with current wiring checked. */
export function setupChecks(mycoHome: string, version: string = getPluginVersion()): Array<DoctorCheck & { toolsDeployment?: string }> {
  return withSettingsFolderSnapshot(() => setupChecksNow(mycoHome, version));
}

function setupChecksNow(mycoHome: string, version: string): Array<DoctorCheck & { toolsDeployment?: string }> {
  const record = readProvisionRecord(mycoHome);
  let serverUrl: string | undefined;
  try { serverUrl = memberProvisionTarget(mycoHome); } catch (error) {
    if (!(error instanceof UnreadableProvisionRecordError)) throw error;
    return [row('Setup', 'warn', error.message)];
  }
  const agents = serverUrl === undefined ? [] : managedMemberHarnesses(mycoHome, serverUrl);
  if (serverUrl === undefined || (record === null && agents.length === 0)) return [row('Setup', 'warn', 'nothing records which agents Myco set up on this machine. Run `myco member provision`.')];
  const missing: string[] = [];
  const held: Array<DoctorCheck & { toolsDeployment: string }> = [];
  const heldAgents = new Set<string>();
  const issues: DoctorCheck[] = [];
  for (const manifest of loadManifests().filter((m) => agents.includes(m.name))) {
    try {
      const status = memberHarnessStatus(manifest.name, mycoHome, serverUrl);
      const behind = (status.folders ?? []).filter(entry => !entry.current && entry.folder.origin !== 'default');
      if (!status.current && status.stale === undefined && behind.length > 0 && status.folders?.[0]?.current) {
        for (const { folder, hooks, refusal } of behind) {
          issues.push(row('Setup', 'warn', refusal !== undefined ? refusal : hooks
            ? `Myco's setup of ${manifest.displayName} in ${folderWords(folder.path)} is incomplete or out of date (tools or skills). Run \`myco member provision --refresh\` to repair it.`
            : `${manifest.displayName}'s settings folder ${folderWords(folder.path)} has no Myco hooks, so sessions run from it are not captured. Run \`myco member provision --refresh\` to set it up.`));
        }
      } else if (!status.current) issues.push(row('Setup', 'warn', status.stale?.join('\n') ?? `${manifest.displayName}'s capture configuration is missing or stale. Run \`myco member provision --refresh\` to repair it.`, `${manifest.displayName}'s capture settings need attention. Run \`myco member provision --refresh\`.`));
      if (status.toolsDeployment !== undefined) {
        heldAgents.add(manifest.name);
        held.push({ ...row('Setup', status.current ? 'ok' : 'warn', harnessToolsElsewhere(manifest.displayName, os.hostname(), status.toolsDeployment)), toolsDeployment: status.toolsDeployment, toolsAgents: status.current ? [manifest.name] : [] });
      }
    } catch (error) {
      issues.push(row('Setup', 'warn', setupRefusalWords(manifest.displayName, error)));
    }
    const target = manifest.registration?.globalSkillsTarget;
    if (!target) continue;
    const absent = missingMemberSkills(mycoHome, target);
    if (absent.length > 0) missing.push(`${manifest.displayName} (${absent.join(', ')})`);
  }
  if (missing.length > 0) issues.push(row('Setup', 'warn', `skills are missing for ${missing.join('; ')}. Run \`myco member provision --refresh\` to update them.`));
  const notes = settingsFolderNotes(agents, mycoHome, record);
  if (record !== null && record.version !== version) issues.unshift(row('Setup', 'warn', `your agents were set up by Myco ${record.version}; this is ${version}. Run \`myco member provision --refresh\` to update them.`));
  if (issues.length > 0) return [...held, ...issues, ...notes];
  if (held.length === agents.length && held.length > 0) return [...held, ...notes];
  const current = agents.filter((agent) => !heldAgents.has(agent));
  const toolsAgents = current.filter(agent => loadManifests().some(manifest => manifest.name === agent && (manifest.registration?.globalMcpTarget?.length ?? 0) > 0));
  const covered = loadManifests().filter(manifest => current.includes(manifest.name)).flatMap(manifest => {
    const folders = harnessSettingsFolders(manifest, mycoHome);
    return folders.length > 1 ? [`${manifest.displayName} in ${folders.map(folder => `${folderWords(folder.path)} (${folderOriginWords(folder, manifest.settingsFolder?.variable)})`).join(', ')}`] : [];
  });
  const configured = covered.length === 0 ? '' : ` Myco's configuration is in place for ${covered.join('; ')}; capture from each folder is not checked here.`;
  return [...held, { ...row('Setup', 'ok', `${current.length === 0 ? 'no agent' : current.join(', ')} set up by this build for ${serverUrl}.${configured}`), toolsAgents }, ...notes];
}

/**
 * What doctor says about the settings folders of the agents Myco set up, beyond whether each is current: a folder in
 * the home folder that holds an agent's markers but fails a check, a folder the person retired, a recorded folder that
 * is gone, and hooks that wait for the person's review in each folder.
 */
function settingsFolderNotes(agents: readonly string[], mycoHome: string, record: ReturnType<typeof readProvisionRecord>): DoctorCheck[] {
  return loadManifests().filter(manifest => agents.includes(manifest.name)).flatMap(manifest => {
    const name = manifest.displayName;
    const variable = manifest.settingsFolder?.variable;
    const rejected = rejectedSettingsFolders(manifest).map(({ folder, reason }) => row('Setup', 'warn',
      `${folderWords(folder)} looks like a ${name} settings folder, but ${reason}, so Myco does not set it up and sessions run from it are not captured. If it is one of your ${name} folders, run \`myco member provision ${manifest.name} ${SETTINGS_FOLDER_FLAG} ${folderWords(folder)}\`.`));
    const retired = record?.excludedSettingsFolders?.[manifest.name] ?? [];
    const excluded = retired.length === 0 ? [] : [row('Setup', 'ok',
      `Myco leaves ${name} alone in ${retired.map(folder => folderWords(folder)).join(', ')}, which you retired. To set one up again, run \`myco member provision ${manifest.name} ${SETTINGS_FOLDER_FLAG} <folder>\`.`)];
    const namedRetired = excludedVariableFolder(manifest, mycoHome);
    const variableRetired = namedRetired === null ? [] : [row('Setup', 'warn',
      `${variable} names ${folderWords(namedRetired)}, which you retired, so Myco leaves it alone and sessions run from it are not captured. To set it up again, run \`myco member provision ${manifest.name} ${SETTINGS_FOLDER_FLAG} ${folderWords(namedRetired)}\`.`)];
    const gone = missingSettingsFolders(manifest, mycoHome).map(folder => row('Setup', 'warn',
      `${name}'s settings folder ${folderWords(folder)}, set up before, no longer exists. If it moved, run \`myco member provision ${manifest.name} ${SETTINGS_FOLDER_FLAG} <its new place>\`; to stop setting it up, run \`myco member provision ${manifest.name} ${FORGET_SETTINGS_FOLDER_FLAG} ${folderWords(folder)}\`.`));
    const trust = record?.pendingTrust?.[manifest.name];
    const folders = trust === undefined ? [] : harnessSettingsFolders(manifest, mycoHome);
    const review = trust === undefined ? [] : [row('Setup', 'warn', joinSentences(
      `${name} skips Myco's hooks until you review them, in ${folders.map(folder => folderWords(folder.path)).join(', ')}`,
      `${trust.action}${folders.length > 1 && variable !== undefined ? ` in each folder: start ${name} with ${variable} set to that folder for each one other than ${folderWords(folders[0]!.path)}` : ''}`))];
    return [...rejected, ...excluded, ...variableRetired, ...gone, ...review];
  });
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
    checks.push(row('Deployment', 'fail', `no member credential resolves for this project (--credential ${source}). Run \`myco login <address>\` to connect this machine.`));
  } else if (deployment !== null) {
    const tools = await doctorDeploymentRequest(() => deployment.listTools());
    authenticated = tools.ok;
    checks.push(tools.ok
      ? row('Project access', 'ok', `${deployment.serverUrl} answers, and serves this machine's credential ${tools.value.length} tools.`)
      : row('Project access', 'fail', doctorDeploymentFailure(deployment.serverUrl, tools, "this machine's tool list")));
  }

  // Read after the Deployment was asked: its read renews a credential whose window is open.
  const after = source === 'registry' ? readRegistryEntryResult(root, mycoHome) : null;
  if (after?.status === 'present') {
    const membership = after.entry;
    const expired = membership.expiresAt !== undefined && membership.expiresAt <= (deps.now ?? Date.now)();
    checks.push(membership.refreshTerminal === true
      ? row('Credential', 'fail', `the Deployment will not renew this credential — ${REJOIN_HINT}.`, `the Deployment will not renew this credential. Run \`myco login ${membership.serverUrl}\`; if refused, ${REJOIN_HINT}.`)
      : row('Credential', authenticated ? 'ok' : expired ? 'warn' : 'not-checked', `${membership.serverUrl}: ${authenticated ? 'authenticated' : 'authentication not checked'}; expires ${iso(membership.expiresAt)}${expired ? ' (expired)' : ''}. Start a new agent session after restoring access.`, expired && !authenticated ? `${membership.serverUrl}: local credential expiry has passed; authentication not checked. Restore the connection, then run \`myco doctor\` again.` : undefined));
  }

  const packageRoot = deps.packageRoot ?? resolvePackageRoot();
  checks.push(...captureChecks(root, mycoHome, packageRoot));
  const vaultDir = path.join(root, '.myco');
  checks.push(...checkMemberMcpResolution(vaultDir, envOf(deps), { registryRead: 'strict', folder: deps.cwd ?? process.cwd(), mycoHome }));
  return checks;
}

const HOME_HEALTH_TIMEOUT_MS = 1500;
export { RECENT_REFUSAL_MS } from '@myco/cli/home-observations.js';
const STALE_CREDENTIAL_MS = 7 * 24 * 60 * 60 * 1000;
const CUTOVER_RECORD = path.join('member', 'cutover.json');
const LOGOUT_DIRECTORY = path.join('member', 'logout');

/** A home with only unmoved 1.4 vaults retains the local doctor. No binary is run to classify it. */
export function useHomeDoctor(home: string): boolean {
  const memberships = listDeploymentMembershipsResult(home);
  const migration = legacyMigrationState(home);
  return migration.state !== 'unmoved' || !memberships.readable || memberships.unavailableEntries > 0
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
  const checks: DoctorCheck[] = autoJoinIdentityIssues(home).map(issue => row('Repository connection', 'warn', issue.message));
  let cloudflare = false;
  try { cloudflare = peekDeploymentRecord(home) !== null; }
  catch (error) { checks.push(row('Cloudflare record', 'warn', error instanceof Error ? error.message : String(error))); }
  if (!cloudflare) {
    try { cloudflare = readSetupFile(home).answers.target === 'cloudflare'; }
    catch (error) { checks.push(row('Setup', 'warn', error instanceof Error ? error.message : String(error))); }
  }
  if (cloudflare) {
    try {
      const tool = await resolveWrangler({ mycoHome: home, runner: deps.cloudflareRunner });
      checks.push(row('Wrangler', 'ok', wranglerToolLine(tool)));
    } catch (error) { checks.push(row('Wrangler', 'warn', error instanceof Error ? error.message : String(error))); }
  }
  checks.push(...pendingImportHolds(home).map(held => row('History import', 'warn', held.message)));
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
  const reachable = new Set<string>();
  for (const membership of listing.memberships) {
    checks.push(row('Membership', 'ok', `${membership.serverUrl}${selected?.serverUrl === deploymentUrl(membership.serverUrl) ? ' (default for new repositories)' : ''}; machine ${membership.machineId}, joined ${iso(membership.joinedAt)}.`));
    const state = membership.refreshTerminal === true ? 'refused renewal' : membership.expiresAt !== undefined && membership.expiresAt <= now ? 'expired' : membership.expiresAt === undefined ? 'expiry unknown' : 'locally unexpired';
    checks.push(row('Credential', state === 'locally unexpired' ? 'not-checked' : membership.refreshTerminal === true ? 'fail' : 'warn', `${membership.serverUrl}: ${state}; expires ${iso(membership.expiresAt)} (local record; authentication not checked)${membership.refreshTerminal === true ? ` — ${REJOIN_HINT}; run \`myco login ${membership.serverUrl}\`` : ' — run `myco doctor` from a connected repository to check this credential'}.`));
    const health = await doctorDeploymentHealth(membership.serverUrl, {
      fetch: deps.fetch ?? globalThis.fetch,
      timeoutMs: Math.min(deps.requestTimeoutMs ?? HOME_HEALTH_TIMEOUT_MS, HOME_HEALTH_TIMEOUT_MS),
    });
    if (health.ok) reachable.add(deploymentUrl(membership.serverUrl));
    checks.push(row('Deployment', health.ok ? 'ok' : 'fail', health.ok
      ? `${membership.serverUrl} answers its health route.`
      : `${doctorDeploymentFailure(membership.serverUrl, health, 'its health route')}${membership.expiresAt !== undefined && membership.expiresAt <= now - STALE_CREDENTIAL_MS ? ` If this address was abandoned, run myco logout ${membership.serverUrl} --local-only to remove its local membership.` : ''}`));
  }
  const projects = listRegistryEntriesResult(home);
  for (const conflict of projects.conflicts ?? []) checks.push(row('Repository connection', 'fail', registryConflictWords(conflict)));
  if (!projects.readable || projects.unavailableEntries > 0) checks.push(row('Repositories', 'fail', 'repository routes could not all be read; routing is unknown for those entries. Run `myco member join` from each affected repository.'));
  const leftoverRoots = [rootOf(deps), ...projects.entries.map(entry => entry.root)];
  try {
    leftoverRoots.push(...listLeftRepositories(home).flatMap(repository => 'error' in repository || !repository.root ? [] : [repository.root]));
  } catch (error) {
    checks.push(row('Repository entries', 'warn', `left repository paths unavailable: ${error instanceof Error ? error.message : String(error)}`));
  }
  for (const leftover of repositoryMycoEntries(leftoverRoots)) {
    checks.push(row('Repository entries', 'warn', leftover.kind === 'unreadable'
      ? `${leftover.root}: could not check ${leftover.file}.`
      : `${leftover.root}: ${leftover.file} — ${leftover.entry}. Myco 2.0 does not manage repository harness config; review and remove these entries by hand.`, leftover.kind === 'unreadable'
        ? `${leftover.root}: repository agent settings could not be read. Restore access to ${leftover.file}.`
        : `${leftover.root}: repository agent settings still configure Myco. Review and remove the Myco entries in ${leftover.file} by hand.`));
  }
  for (const entry of projects.entries) {
    checks.push(row('Repository', 'ok', `${entry.displayRoot ?? entry.root} → ${entry.serverUrl} / ${entry.projectId}.`));
    const facts = observeProjectCapture(entry, home, now);
    checks.push(row('Capture backlog', facts.spool.readable && facts.spool.unacknowledgedTotal !== null ? facts.spool.unacknowledgedTotal === 0 ? 'ok' : 'info' : 'warn',
      `${entry.root}: ${facts.spool.readable ? `${facts.spool.unacknowledgedTotal ?? 'unknown'} event(s) waiting to deliver` : 'spool unreadable'}; last delivery ${iso(facts.spool.lastDeliveryAt)}.${facts.spool.readable && facts.spool.unacknowledgedTotal === 0 ? '' : ' Run `myco member drain` from that repository.'}`));
    if (!facts.latchReadable || facts.latch !== null) checks.push(row('Capture', 'warn', `${entry.root}: ${facts.latchReadable ? `delivery held off since ${iso(facts.latch?.since)}; next probe ${iso(facts.latch?.nextProbeAt)}` : 'offline latch unreadable'}. Run \`myco member drain\` from that repository.`));
    const refusals = facts.refusalHistory;
    if (!refusals.readable || refusals.total > 0 || refusals.unreadableLines > 0) {
      checks.push(row('Refusals', !refusals.readable || refusals.recent > 0 || refusals.unreadableLines > 0 ? 'warn' : 'ok',
        `${entry.root}: ${refusals.readable ? `${refusals.total} refused events; newest ${iso(refusals.latest)}; ${refusals.recent} in the last 7 days; ${refusals.unreadableLines} unreadable log lines` : 'refusal log unreadable'}. Run myco logs from that repository.`));
    }
  }
  checks.push(...captureHealthChecks(home, projects.entries, now, reachable));
  checks.push(checkInstallation(home), checkAutomaticUpdate(home));
  checks.push(...leftRepositoryChecks(home), ...refusedHookChecks(home, now));
  if (listing.memberships.length > 0) checks.push(...setupChecks(home));
  if (readRegistryEntryResult(rootOf(deps), home).status === 'missing') checks.push(...captureChecks(rootOf(deps), home, deps.packageRoot ?? resolvePackageRoot(), listing.memberships.length > 0));
  const worker = { ...deps.worker, mycoHome: home };
  try { checks.push(...await checkWorkerServices(path.join(rootOf(deps), '.myco'), worker)); }
  catch (error) { checks.push(row('Worker service', 'warn', `service state unavailable: ${error instanceof Error ? error.message : String(error)}. Run \`myco runner doctor\``)); }
  for (const record of runners) {
    checks.push(row('Runner', isLiveRunner(record) ? 'ok' : 'warn', `${record.serverUrl}: ${isLiveRunner(record) ? `registered ${record.name} (${record.runnerId})` : `registration pending; run \`myco runner register ${record.serverUrl}\``}; last contact ${iso(record.lastContactAt)}.`));
    try {
      const { state, words } = observeRunnerService(record.serverUrl, worker);
      checks.push(row('Runner service', state.running ? 'ok' : 'warn', `${record.serverUrl}: ${words}${state.detail ? ` (${state.detail})` : ''}. Run \`myco runner install --server ${record.serverUrl}\`.`));
    } catch (error) {
      checks.push(row('Runner service', 'warn', `${record.serverUrl}: unavailable: ${error instanceof Error ? error.message : String(error)}. Run \`myco runner doctor --server ${record.serverUrl}\``));
    }
    checks.push(row('Runner offer', record.lastOffer ? 'ok' : 'not-checked', `${record.serverUrl}: ${record.lastOffer ? `offered ${record.lastOffer.offered.join(', ') || 'none'}; withheld ${record.lastOffer.withheld.join(', ') || 'none'}; observed ${iso(record.lastOffer.observedAt)}` : 'unknown (no acknowledged service offer); run `myco runner status` after starting the runner'}.`));
  }
  const migration = legacyMigrationState(home);
  try { checks.push(...observeLegacyStrayHistory(home).map(line => row('Migration', 'info', line))); }
  catch (error) { checks.push(row('Migration', 'warn', `Earlier moves could not be checked: ${error instanceof Error ? error.message : String(error)}`)); }
  if (migration.state === 'unavailable') {
    checks.push(row('Myco 1.4', 'fail', `migration state unavailable: ${migration.detail}. Inspect ${migration.file}, then run \`myco cutover --dry-run\`.`));
  } else if (migration.state === 'needs-destination') {
    checks.push(row('Migration', 'warn', migration.legacyOwnsCapture
      ? 'an earlier cutover recorded backups, but Myco 1.4 services or agent registrations still own capture; run `myco cutover --dry-run` to confirm destinations and handover.'
      : 'moved by an earlier version; run `myco cutover --dry-run` to confirm where each project went.'));
  } else if (migration.state === 'handover-pending') {
    checks.push(row('Migration', 'warn', `${migration.legacyOwnsCapture ? 'Myco 1.4 services or agent registrations still own capture' : 'history destinations are recorded, but handover has not been confirmed'}; run \`myco cutover --dry-run\`, then \`myco cutover\`.`));
  } else if (migration.state === 'partial') {
    checks.push(row('Migration', 'warn', 'some project history or transcripts still need to finish; run `myco cutover --dry-run`, then `myco cutover` for history or `myco cutover --import-transcripts` for a failed transcript pass.'));
  } else if (migration.state === 'unmoved' || migration.state === 'changed') {
    const homes = [...new Set([home, defaultMycoHome()].map(directory => path.resolve(directory)))];
    const vaults = [...new Set(homes.flatMap(directory => legacyVaultFiles(directory)))];
    checks.push(row('Myco 1.4', 'warn', migration.state === 'changed' ? migration.warning
      : `migration pending; retained vault files: ${vaults.join(', ')}. Next: \`myco cutover --dry-run\`.`));
  } else if (migration.state === 'moved') {
    checks.push(row('Migration', 'ok', migration.transcriptsNotImported
      ? `history is complete at its recorded destinations. ${LEGACY_TRANSCRIPTS_NOT_IMPORTED}`
      : 'history and transcripts are complete at their recorded destinations.'));
  } else {
    checks.push(row('Migration', 'ok', 'no retained Myco 1.4 capture state.'));
  }
  return checks;
}

/** Print home facts and, when a credential resolves here, the repository checks. */
export async function run(args: readonly string[], source: CredentialSource, deps: MemberDoctorDeps = {}): Promise<boolean> {
  const out = deps.stdout ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.stderr ?? ((line: string) => process.stderr.write(`${line}\n`));
  const flags = withoutCredentialFlag(args);
  const unknown = flags.filter(flag => flag !== '--all');
  if (unknown.length > 0) { err(`${USAGE}\nmyco doctor: unknown option ${unknown[0]}`); return false; }
  const notice = readUpdateNotice(homeOf(deps), getPluginVersion());
  const binding = readRegistryEntryResult(rootOf(deps), homeOf(deps));
  const projectChecks = source === 'env' || binding.status !== 'missing' ? await projectReport(source, deps) : [];
  const homeChecks = await homeReport(homeOf(deps), deps);
  const checkedCredential = projectChecks.some(check => check.name === 'Credential');
  const checks = [
    ...homeChecks.filter(check => !(checkedCredential && binding.status === 'present' && check.name === 'Credential' && check.detail.startsWith(binding.entry.serverUrl + ':'))),
    ...projectChecks,
  ];

  for (const line of doctorOutput(checks, { all: flags.includes('--all') })) out(line);
  if (notice !== null) out(notice);
  return !checks.some(check => check.status === 'fail');
}
