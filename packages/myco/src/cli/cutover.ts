/**
 * `myco cutover` — move this machine from Myco 1.4 to its 2.0 Deployment.
 *
 * Step 0 reads everything and changes nothing; it is the only place the run
 * refuses before a change, and a dry run stops after printing the plan it
 * builds. It refuses when another installation holds anything the run would
 * take: the `symbiont-config` claim in any home's claims folder, the machine
 * pin, a Myco hook, plugin or MCP entry at any place 1.4.8 registered one
 * (`LEGACY_REGISTRATIONS`), or the MCP entry a 2.0 agent would get, judged
 * against the Deployment's own URL. It also refuses a `myco daemon` unit it
 * cannot attribute to a home, a boot-scope 1.4 unit, and a vault whose every
 * session was captured under another machine id.
 *
 * Then, in order, each step safe to run again:
 *
 *   1. back up every agent settings file it changes, into one folder of the
 *      2.0 home (`member/cutover-backup.ts`), never beside the file;
 *   2. connect every folder a 1.4 project names, in this home's registry;
 *   3. provision the agents 2.0 captures, replacing their 1.4 registrations
 *      in place;
 *   4. remove every other 1.4 registration, including those of agents 2.0
 *      does not capture, and check that none is left;
 *   5. point the `symbiont-config` claim of every 1.4 home at the 2.0 home,
 *      so a 1.4 daemon that comes back leaves the agents alone, and pin the
 *      machine to the 2.0 home;
 *   6. stop and remove the 1.4 daemon units, found by reading the unit files,
 *      and ask each 1.4 home's own running daemon to exit;
 *   7. copy every 1.4 vault and verify the copy;
 *   8. import from the copies (`myco import --legacy`), then the agents'
 *      transcripts;
 *   9. cache the settings the Deployment holds for this machine, and name the
 *      plan folders 1.4 watched, which are set on the dashboard, never carried.
 *
 * Every run reads the vaults afresh: a copy is reused only while it holds the
 * very rows the vault holds now. What was imported is the Deployment's record,
 * not this machine's; a write the Deployment refuses fails the run.
 *
 * Nothing 1.4 wrote as data is deleted or rewritten: the vaults stay where
 * they are, and the import reads the copies.
 */
import { parse as parseYaml } from 'yaml';
import { seedMachineSettings } from '../member/machine-settings.js';
import fs from 'node:fs';
import path from 'node:path';
import { getMachineId } from '../machine-id.js';
import { isSafeProjectRoot } from '../project-root.js';
import { defaultMycoHome, readHomePin, resolveHomeDir, resolveMycoHomeWithSource, RUNTIME_HOME_FILENAME, type ResolvedMycoHome } from '../paths/home.js';
import { claimSubsystem, readClaim, resolveClaimsHome, SYMBIONT_CONFIG_SUBSYSTEM } from '../grove/subsystem-claim.js';
import { IMPORT_PACE_PER_MINUTE, importUntilSettled, type ImportReport } from '../member/import.js';
import { legacyProjectRoots, legacySessionSplit, legacyVaultFiles, runLegacyImport, LEGACY_MAX_PER_AGENT, LEGACY_WINDOW_DAYS, type LegacyImportReport } from '../member/legacy-import.js';
import { backupVault, copyProblem, readVaultContent, type TableCounts } from '../member/legacy-backup.js';
import { CutoverBackup, cutoverBackupDir, earlierCopyHolds, MANIFEST_FILE, RESTORE_FILE } from '../member/cutover-backup.js';
import { deploymentUrl, listDeploymentMemberships, readRegistryEntry, registryEntryPath, writeRegistryEntry, REGISTRY_VERSION, type DeploymentMembership } from '../member/registry.js';
import { ensureMemberDir, memberRoot, readPrivateJson, writePrivateFileAtomic } from '../member/store.js';
import type { FetchLike } from '../member/transport.js';

import { parseDirectoryMapping, canonicalPath, type DirectoryMapping } from '../symbionts/transcript-attribution.js';
import { stopHomeDaemon, type DaemonStop } from '../service/home-daemon.js';
import { attributeLegacyUnits, stopUnit, unitDirectories } from '../service/legacy-units.js';
import type { LaunchctlRunner } from '../service/launchd.js';
import { detectMachineInstalledSymbionts, loadManifests } from '../symbionts/detect.js';
import { removeLegacyRegistrations, rewriteKeepingMode, scanLegacyRegistrations, type LegacyFinding } from '../symbionts/legacy-registrations.js';
import { pinMachineHome, previewGlobalProvision, provisionGlobally, type ProvisionOutcome } from './member.js';
import { legacyImportComplete, legacyReportLines, reportLines, STOPPED_WORDS, transcriptImportComplete } from './import.js';
import { resolveManagedBinaryPath } from '../symbionts/installer.js';

export const CUTOVER_HELP = `Usage: myco cutover [options]

Move this machine from Myco 1.4 to the Deployment it is signed in to
(\`myco login\` first). It first reads everything and stops, changing nothing,
if another installation holds anything it would take. Then it backs up each
agent settings file it changes, connects every folder a 1.4 project names,
points the agents 2.0 captures at 2.0, removes 1.4 from every other agent,
hands the agents' settings to 2.0, stops the 1.4 service, copies each 1.4
vault and checks the copy, and brings the vaults' history and your agents'
transcripts to the Deployment. The 1.4 vaults are left where they are; no
data is deleted. Safe to run again: it finishes what an earlier run left.

Options:
  --legacy-home <dir>  A Myco 1.4 home to cut over (default: ~/.myco, and this
                       home when it holds 1.4 vaults); repeat for several
  --map <dir>=<root>   Import transcripts recorded in <dir> (or, with a
                       trailing *, in every sibling directory named like it)
                       into the project connected at <root>; repeat for several
  --server <url>       Which Deployment, when this machine belongs to several
  --dry-run            Report what each step would do, and do nothing
  --help               Show this message
`;

interface Parsed {
  error?: string;
  help?: true;
  legacyHomes: string[];
  mappings: DirectoryMapping[];
  serverUrl?: string;
  dryRun: boolean;
}

export function parseArgs(args: readonly string[]): Parsed {
  const parsed: Parsed = { legacyHomes: [], mappings: [], dryRun: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const value = args[i + 1];
    switch (arg) {
      case '--help': case '-h':
        return { ...parsed, help: true };
      case '--dry-run':
        parsed.dryRun = true;
        break;
      case '--legacy-home': case '--server':
        if (value === undefined || value.startsWith('--')) return { ...parsed, error: `${arg} needs a value` };
        if (arg === '--legacy-home') parsed.legacyHomes.push(path.resolve(value)); else parsed.serverUrl = value;
        i += 1;
        break;
      case '--map': {
        const mapping = value === undefined ? null : parseDirectoryMapping(value);
        if (mapping === null) return { ...parsed, error: `${arg} needs <dir>=<root>, both absolute` };
        parsed.mappings.push(mapping);
        i += 1;
        break;
      }
      default:
        return { ...parsed, error: `unknown option ${arg}` };
    }
  }
  return parsed;
}

export interface CutoverDeps {
  fetch?: FetchLike;
  now?: () => number;
  mycoHome?: string;
  machineId?: string;
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** The agents provisioned; the detected ones by default. */
  agents?: () => string[];
  /** How a 1.4 home's running daemon is asked to exit; `stopHomeDaemon` by default. */
  stopDaemon?: (home: string) => Promise<DaemonStop>;
  /** launchctl, for a caller observing how units are stopped; the real one by default. */
  launchctl?: LaunchctlRunner;
  platform?: NodeJS.Platform;
  /** The unit folders read for 1.4 daemon units; the platform's user and boot folders by default. */
  unitDirs?: Array<{ dir: string; scope: 'user' | 'boot' }>;
  /** Every change the run plans, dry run or not: each file or entry it changes. */
  onPlan?: (outcomes: string[]) => void;
  /** Each planned change as the run makes it. */
  onAction?: (outcome: string) => void;
  /** How one agent is provisioned globally; `provisionGlobally` by default. */
  provision?: typeof provisionGlobally;
  packageRoot?: string;
  /** Requests a minute the imports stay under. */
  pace?: number;
}

/** What a cutover recorded between runs: the verified copy of each vault. */
interface CutoverState {
  backups: Record<string, { copy: string; counts: TableCounts; digest: string; at: number }>;
}

const statePath = (mycoHome: string): string => path.join(memberRoot(mycoHome), 'cutover.json');

function readState(mycoHome: string): CutoverState {
  const read = readPrivateJson<CutoverState>(statePath(mycoHome));
  return read.ok && typeof read.value?.backups === 'object' ? read.value : { backups: {} };
}

function writeState(mycoHome: string, state: CutoverState): void {
  ensureMemberDir(memberRoot(mycoHome), mycoHome);
  writePrivateFileAtomic(statePath(mycoHome), `${JSON.stringify(state, null, 2)}\n`);
}

/** The 1.4 homes a run cuts over: those named, else the default home and this one, where each holds a vault. */
export function legacyHomesFor(named: readonly string[], mycoHome: string, homeDir?: string): string[] {
  const candidates = named.length > 0 ? named : [defaultMycoHome(homeDir), mycoHome];
  return [...new Set(candidates.map((h) => path.resolve(h)))].filter((home) => named.length > 0 || legacyVaultFiles(home).length > 0);
}

/** Where the copy of a vault goes: under its home's `backups/`, beside `groves/` and never inside it. */
const copyPathFor = (home: string, vault: string, stamp: string): string =>
  path.join(home, 'backups', `cutover-${stamp}`, path.relative(path.join(home, 'groves'), vault));

/** The Deployment this machine is signed in to, or why there is none. */
function membershipFor(mycoHome: string, serverUrl: string | undefined): DeploymentMembership | string {
  const memberships = listDeploymentMemberships(mycoHome);
  if (serverUrl !== undefined) {
    return memberships.find((m) => deploymentUrl(m.serverUrl) === deploymentUrl(serverUrl)) ?? `this machine is not signed in to ${serverUrl}; run \`myco login\` first`;
  }
  if (memberships.length === 1) return memberships[0];
  return memberships.length === 0 ? 'this machine is not signed in to a Deployment; run `myco login` first' : `this machine belongs to ${memberships.length} Deployments; name one with --server`;
}

/** Why this home is the one a run uses, in words. */
function chosenBy(resolved: ResolvedMycoHome | null): string {
  if (resolved === null) return '';
  switch (resolved.source) {
    case 'env': return ' (named by MYCO_HOME)';
    case 'machine-pin': return ` (chosen by the machine pin ${resolved.pinPath})`;
    case 'project-pin': return ` (chosen by the pin ${resolved.pinPath})`;
    default: return '';
  }
}

/** What connecting one 1.4 project's folder comes to. */
type Binding =
  | { kind: 'absent'; projectId: string; root: string | null }
  | { kind: 'elsewhere'; projectId: string; root: string; boundTo: string }
  | { kind: 'connected' | 'connect'; projectId: string; root: string };

function bindingFor(project: { projectId: string; root: string | null }, mycoHome: string, serverUrl: string): Binding {
  const { projectId, root } = project;
  if (root === null || !fs.existsSync(root) || !isSafeProjectRoot(root)) return { kind: 'absent', projectId, root };
  const existing = readRegistryEntry(root, mycoHome);
  if (existing !== null && existing.projectId !== projectId) return { kind: 'elsewhere', projectId, root, boundTo: existing.projectId };
  return existing !== null && deploymentUrl(existing.serverUrl) === deploymentUrl(serverUrl) ? { kind: 'connected', projectId, root } : { kind: 'connect', projectId, root };
}

/** One change the cutover makes, planned before any is made. */
interface Action {
  /** What a dry run says it would do. */
  would: string;
  /** The outcomes it plans, each a file or entry it changes; a real run reports each one it made. */
  outcomes: string[];
  /** Do it; answer what it says and the planned outcomes it made. */
  run: () => Promise<{ lines: string[]; made: string[] }>;
}

/** The home a foreign registration names, for a `--legacy-home` suggestion. */
function homeNamedBy(subject: string): string | null {
  const home = /MYCO_HOME["=:\s]+"?([^"\s,}]+)/.exec(subject)?.[1] ?? /([^\s"']+)\/bin\/myco(?:\.exe)?\b/.exec(subject)?.[1];
  return home ?? null;
}

const suggestion = (subject: string): string => {
  const home = homeNamedBy(subject);
  return home === null ? '' : ` If ${home} is a Myco 1.4 home to cut over too, add \`--legacy-home ${home}\`.`;
};

/** A copy of `file` in this run's backup folder, unless an earlier cutover's copy already holds these bytes. */
function backupAction(file: string, backup: CutoverBackup, mycoHome: string): Action | null {
  if (earlierCopyHolds(mycoHome, file)) return null;
  return {
    would: `would back up ${file} to ${backup.pathFor(file)}, and keep the copy if the cutover changes the file`,
    outcomes: [],
    run: async () => { backup.take(file); return { lines: [], made: [] }; },
  };
}

/** The outcome a 1.4 registration's removal is known by. */
const removalOutcome = (f: LegacyFinding): string => `remove ${f.file} :: ${f.location.kind} :: ${(f.serversPath ?? []).join('/')} :: ${f.subject}`;

/**
 * Run the cutover and report it. The outcome is RETURNED, never written to
 * `process.exitCode` here; `cli.ts` sets the exit status.
 */
export async function run(args: readonly string[], deps: CutoverDeps = {}): Promise<boolean> {
  const out = deps.stdout ?? ((l) => process.stdout.write(`${l}\n`));
  const err = deps.stderr ?? ((l) => process.stderr.write(`${l}\n`));
  const parsed = parseArgs(args);
  if (parsed.error !== undefined) { err(`myco cutover: ${parsed.error}`); return false; }
  if (parsed.help === true) { out(CUTOVER_HELP.trimEnd()); return true; }

  const env = deps.env ?? process.env;
  const homeDir = env.HOME && env.HOME.length > 0 ? env.HOME : resolveHomeDir();
  const platform = deps.platform ?? process.platform;
  const resolved = deps.mycoHome === undefined ? resolveMycoHomeWithSource({ env, homeDir }) : null;
  const mycoHome = path.resolve(deps.mycoHome ?? resolved!.home);
  const now = deps.now ?? Date.now;
  const machineId = deps.machineId ?? getMachineId();
  const dry = parsed.dryRun;
  const step = (n: number, title: string) => out(`${n}. ${title}${dry ? ' (dry run)' : ''}`);
  let ok = true;
  const problem = (line: string) => { ok = false; err(`   ✗ ${line}`); };

  const membership = membershipFor(mycoHome, parsed.serverUrl);
  if (typeof membership === 'string') { err(`myco cutover: ${membership}`); return false; }
  const serverUrl = membership.serverUrl;
  const legacyHomes = legacyHomesFor(parsed.legacyHomes, mycoHome, homeDir);
  if (legacyHomes.length === 0) { err('myco cutover: no Myco 1.4 vault found; name a 1.4 home with --legacy-home'); return false; }
  const vaults = legacyHomes.flatMap((home) => legacyVaultFiles(home).map((vault) => ({ home, vault })));
  out(`Cutting over ${legacyHomes.join(', ')} to ${serverUrl}, into ${mycoHome}${chosenBy(resolved)}`);

  // 0. Everything the run would take over, checked before anything changes: the only place it refuses before a change.
  step(0, 'Check that nothing it would take over belongs to another installation');
  const blockers: string[] = [];
  const isLegacyOrThis = (home: string) => canonicalPath(home) === canonicalPath(mycoHome) || legacyHomes.some((h) => canonicalPath(h) === canonicalPath(home));

  // The symbiont-config claim, in every place a 1.4 or 2.0 daemon of these homes reads it.
  const claimsHomes = [...new Set([...legacyHomes, resolveClaimsHome()].map((h) => path.resolve(h)))];
  for (const claimsHome of claimsHomes) {
    const claim = readClaim(SYMBIONT_CONFIG_SUBSYSTEM, claimsHome);
    if (claim !== null && !isLegacyOrThis(claim.owner)) {
      blockers.push(`${claim.owner} holds your agents' settings (the ${SYMBIONT_CONFIG_SUBSYSTEM} claim in ${path.join(claimsHome, 'claims')}), and it is not a 1.4 home being cut over.${suggestion(`${claim.owner}/bin/myco`)}`);
    }
  }
  const pinPath = path.join(defaultMycoHome(homeDir), RUNTIME_HOME_FILENAME);
  const pinned = readHomePin(pinPath, { env });
  if (pinned !== null && canonicalPath(pinned) !== canonicalPath(mycoHome)) {
    blockers.push(`this machine is pinned to ${pinned} (${pinPath}), so hooks installed for ${mycoHome} would capture there instead. Run the cutover under that home (MYCO_HOME=${pinned}), or remove the pin if nothing uses it.`);
  }
  const bindings = legacyProjectRoots(vaults.map((v) => v.vault)).map((p) => bindingFor(p, mycoHome, serverUrl));
  const roots = bindings.flatMap((b) => (b.kind === 'connect' || b.kind === 'connected' ? [b.root] : []));
  if (roots.length === 0) {
    blockers.push('no folder a 1.4 project names is here to connect, so there is no membership to point your agents at. Bring the history alone with `myco import --legacy <1.4 home>`.');
  }
  const split = legacySessionSplit(vaults.map((v) => v.vault), machineId);
  const elsewhere = Object.entries(split.otherMachines).sort(([a], [b]) => a.localeCompare(b));
  if (split.thisMachine === 0 && elsewhere.length > 0) {
    blockers.push(`every session in the 1.4 vaults was captured under another machine id (${elsewhere.map(([m, n]) => `${m}: ${n}`).join(', ')}), not this machine's (${machineId}), so none would be imported. Run the cutover on the machine that captured them.`);
  }
  const units = attributeLegacyUnits(deps.unitDirs ?? unitDirectories(env, homeDir, platform), legacyHomes);
  for (const unit of units.unattributable) blockers.push(`${unit.file} runs \`myco daemon\` but names no home (no MYCO_HOME, no working directory), so it cannot be told apart from another installation's. Remove it if it is 1.4's, then run again.`);
  for (const unit of units.boot) blockers.push(`${unit.file} starts ${unit.home}'s 1.4 daemon at boot; remove it as an administrator (\`sudo launchctl bootout system/${unit.label}\` and delete the file), then run again.`);

  const agents = (deps.agents ?? (() => detectMachineInstalledSymbionts().map((m) => m.name)))();
  const previews = roots.length === 0 ? [] : agents.map((agent) => ({ agent, preview: previewGlobalProvision(agent, roots[0], mycoHome, serverUrl, { packageRoot: deps.packageRoot, legacyHomes }) }));
  for (const { agent, preview } of previews) {
    if (preview.kind === 'unknown') blockers.push(`${agent}: no such agent`);
    else if (preview.kind === 'refused') blockers.push(`${agent}: ${preview.detail}${suggestion(preview.detail)}`);
  }
  const provisioned = previews.flatMap(({ agent, preview }) => (preview.kind === 'ready' ? [{ agent, ...preview }] : []));
  const scanOptions = { homeDir, legacyHomes, ownHome: mycoHome, folders: roots };
  const scan = scanLegacyRegistrations(scanOptions);
  for (const { file, reason } of scan.unreadable) blockers.push(`${file} holds a Myco entry but could not be read (${reason}); fix or move it, then run again.`);
  // A connected folder's runtime.command pin naming a 1.4 home's binary is pointed at the 2.0 binary.
  const binary2 = resolveManagedBinaryPath(mycoHome);
  const underHome = (file: string, home: string) => path.resolve(file).startsWith(`${path.resolve(home)}${path.sep}`);
  const runtimePins = roots.flatMap((root) => {
    const pin = path.join(root, '.myco', 'runtime.command');
    let command: string;
    try { command = fs.readFileSync(pin, 'utf8').trim(); } catch { return []; }
    const first = command.split(/\s+/)[0] ?? '';
    const legacy = legacyHomes.some((home) => underHome(first, home)) && !underHome(first, mycoHome);
    return legacy ? [{ pin, command }] : [];
  });
  const foreign = scan.findings.filter((f) => f.verdict === 'foreign');
  for (const file of [...new Set(foreign.map((f) => f.file))]) {
    const here = foreign.filter((f) => f.file === file);
    const what = here.length === 1 ? `a Myco ${here[0].location.kind === 'mcp' ? 'MCP entry' : here[0].location.kind === 'hooks' ? 'hook' : 'plugin'}` : `${here.length} Myco hooks and entries`;
    blockers.push(`${file} holds ${what} of another installation (\`${here[0].subject}\`${here.length > 1 ? ' and more' : ''}).${suggestion(here[0].subject)}`);
  }
  if (blockers.length > 0) {
    for (const blocker of blockers) problem(blocker);
    err('   Nothing was changed.');
    return false;
  }
  out('   nothing another installation holds is in the way');
  if (elsewhere.length > 0) {
    out(`   warning: the 1.4 vaults record ${elsewhere.reduce((n, [, c]) => n + c, 0)} sessions under ${elsewhere.map(([m]) => m).join(', ')}, not this machine's id (${machineId}); those sessions are left for that machine to import`);
  }

  // The plan: every change, decided now, in the order it is made.
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const handledByProvisioning = (finding: LegacyFinding) => provisioned.some((p) => p.agent === finding.location.agent
    && (finding.location.kind === 'mcp' ? p.targets.mcp.includes(finding.file) && (finding.serversPath ?? []).length === 1 : p.targets.hooks === finding.file));
  const removals = scan.findings.filter((f) => f.verdict === 'legacy' && !handledByProvisioning(f));
  const removalFiles = [...new Set(removals.map((f) => f.file))];
  const displayName = (agent: string) => loadManifests().find((m) => m.name === agent)?.displayName ?? agent;
  const regular = (file: string) => { try { return fs.lstatSync(file).isFile(); } catch { return false; } };
  const touched = [...new Set([...provisioned.flatMap((p) => p.targets.all), ...removalFiles])].filter(regular);
  const backup = new CutoverBackup(cutoverBackupDir(mycoHome, stamp));
  const stillLegacy = (planned: readonly LegacyFinding[]): Set<string> => {
    const current = scanLegacyRegistrations(scanOptions).findings.filter((f) => f.verdict === 'legacy').map(removalOutcome);
    return new Set(planned.map(removalOutcome).filter((o) => current.includes(o)));
  };
  const claimFile = (claimsHome: string) => path.join(claimsHome, 'claims', `${SYMBIONT_CONFIG_SUBSYSTEM}.json`);
  const plan: Array<{ step: number; title: string; actions: Action[] }> = [
    { step: 1, title: 'Back up every agent settings file the cutover changes', actions: touched.flatMap((file) => backupAction(file, backup, mycoHome) ?? []) },
    { step: 2, title: 'Connect every folder a 1.4 project names', actions: bindings.flatMap((b): Action[] => (b.kind !== 'connect' ? [] : [{
      would: `${b.projectId}: would connect ${b.root}`, outcomes: [`connect ${b.root}`],
      run: async () => {
        const entryFile = registryEntryPath(b.root, mycoHome);
        if (fs.existsSync(entryFile)) backup.take(entryFile); else backup.created(entryFile);
        writeRegistryEntry({ ...membership, version: REGISTRY_VERSION, projectId: b.projectId, root: b.root, joinedAt: now(), updatedAt: now() }, { mycoHome });
        return { lines: [`${b.projectId}: connected ${b.root}`], made: readRegistryEntry(b.root, mycoHome)?.projectId === b.projectId ? [`connect ${b.root}`] : [] };
      },
    }])) },
    { step: 3, title: 'Point the agents 2.0 captures at 2.0', actions: provisioned.map((p): Action => ({
      would: `would point ${p.displayName} at ${mycoHome}${p.replaces.length > 0 ? `, replacing the 1.4 hooks and MCP entry of ${p.replaces.join(', ')}` : ''}`,
      outcomes: [`provision ${p.agent}`],
      run: async () => {
        const outcome: ProvisionOutcome = (deps.provision ?? provisionGlobally)(p.agent, roots[0], mycoHome, { packageRoot: deps.packageRoot, legacyHomes });
        if (outcome.kind === 'refused') throw new Error(`${p.agent}: ${outcome.detail}`);
        if (outcome.kind === 'unknown') throw new Error(`${p.agent}: no such agent`);
        return { lines: [outcome.detail], made: [`provision ${p.agent}`] };
      },
    })) },
    { step: 4, title: 'Take 1.4 out of every other place it registered with an agent', actions: [...removalFiles.map((file): Action => {
      const here = removals.filter((f) => f.file === file);
      const agent = here[0].location.agent;
      const captured = Boolean(loadManifests().find((m) => m.name === agent)?.registration?.memberHooksTarget) || here[0].location.kind === 'skills';
      const why = captured ? '' : `; ${displayName(agent)} is no longer captured by Myco 2.0`;
      const hooks = here.filter((f) => f.location.kind === 'hooks').length;
      const replacement = path.join(mycoHome, 'skills', path.basename(file));
      if (here[0].location.kind === 'skills') {
        const repoint = fs.existsSync(replacement);
        return {
          would: repoint
            ? `${displayName(agent)}: would point the skill link ${file} (now to ${here[0].linkTarget}) at ${replacement}`
            : `${displayName(agent)}: would remove the skill link ${file} (to ${here[0].linkTarget}); ${mycoHome} has no such skill`,
          outcomes: here.map(removalOutcome),
          run: async () => {
            backup.link(file, here[0].linkTarget!);
            const lines = removeLegacyRegistrations(file, here, legacyHomes, mycoHome).map((line) => `${displayName(agent)}: ${line}`);
            const left = stillLegacy(here);
            return { lines, made: here.map(removalOutcome).filter((o) => !left.has(o)) };
          },
        };
      }
      const what = [
        ...(hooks > 0 ? [`${hooks} 1.4 hook${hooks === 1 ? '' : 's'}`] : []),
        ...(here.some((f) => f.location.kind === 'mcp') ? [`the \`myco\` MCP entr${here.filter((f) => f.location.kind === 'mcp').length === 1 ? 'y' : 'ies'}`] : []),
        ...(here.some((f) => f.location.kind === 'plugin-file' || f.location.kind === 'plugin-manifest') ? ['the file'] : []),
      ].join(' and ');
      return {
        would: `${displayName(agent)}: would remove ${what} from ${file}${why}`,
        outcomes: here.map(removalOutcome),
        run: async () => {
          const lines = removeLegacyRegistrations(file, here, legacyHomes, mycoHome).map((line) => `${displayName(agent)}: ${line}${why}`);
          const left = stillLegacy(here);
          return { lines, made: here.map(removalOutcome).filter((o) => !left.has(o)) };
        },
      };
    }), ...runtimePins.map(({ pin, command }): Action => ({
      would: `would point ${pin} (now \`${command}\`, a 1.4 binary) at ${binary2}`, outcomes: [`runtime ${pin}`],
      run: async () => {
        if (!earlierCopyHolds(mycoHome, pin)) backup.take(pin);
        rewriteKeepingMode(pin, `${binary2}\n`);
        return { lines: [`pointed ${pin} at ${binary2}`], made: fs.readFileSync(pin, 'utf8').trim() === binary2 ? [`runtime ${pin}`] : [] };
      },
    }))] },
    { step: 5, title: 'Hand the agents\' settings to 2.0', actions: [
      ...claimsHomes.filter((h) => readClaim(SYMBIONT_CONFIG_SUBSYSTEM, h)?.owner !== mycoHome).map((claimsHome): Action => ({
        would: `would point the ${SYMBIONT_CONFIG_SUBSYSTEM} claim in ${path.join(claimsHome, 'claims')} at ${mycoHome}, so a 1.4 daemon that comes back leaves the agents alone`,
        outcomes: [`claim ${claimsHome}`],
        run: async () => {
          if (fs.existsSync(claimFile(claimsHome))) backup.take(claimFile(claimsHome)); else backup.created(claimFile(claimsHome));
          claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, mycoHome, { claimsHome });
          if (readClaim(SYMBIONT_CONFIG_SUBSYSTEM, claimsHome)?.owner !== mycoHome) throw new Error(`could not write the ${SYMBIONT_CONFIG_SUBSYSTEM} claim in ${path.join(claimsHome, 'claims')}`);
          return { lines: [`pointed the ${SYMBIONT_CONFIG_SUBSYSTEM} claim in ${path.join(claimsHome, 'claims')} at ${mycoHome}`], made: [`claim ${claimsHome}`] };
        },
      })),
      ...(pinned === null && canonicalPath(mycoHome) !== canonicalPath(defaultMycoHome(homeDir)) ? [{
        would: `would pin this machine to ${mycoHome} (${pinPath})`, outcomes: [`pin ${pinPath}`],
        run: async () => {
          backup.created(pinPath);
          const machinePin = pinMachineHome(mycoHome, { env });
          if (machinePin.kind === 'held' || machinePin.kind === 'unwritable') throw new Error(`could not pin this machine to ${mycoHome} (${pinPath})`);
          return { lines: [`pinned this machine to ${mycoHome} (${pinPath})`], made: [`pin ${pinPath}`] };
        },
      }] : []),
    ] },
    { step: 6, title: 'Stop the 1.4 service', actions: [
      ...units.stop.map((unit): Action => ({
        would: `would stop and remove ${unit.label} (${unit.file}), the 1.4 daemon of ${unit.home}`, outcomes: [`unit ${unit.file}`],
        run: async () => {
          backup.take(unit.file);
          await stopUnit(unit, platform, deps.launchctl);
          return { lines: [`stopped and removed ${unit.label} (${unit.file})`], made: fs.existsSync(unit.file) ? [] : [`unit ${unit.file}`] };
        },
      })),
      ...legacyHomes.map((home): Action => ({
        would: `would ask ${home}'s running daemon, if any, to exit`, outcomes: [],
        run: async () => {
          const stopped: DaemonStop = await (deps.stopDaemon ?? stopHomeDaemon)(home);
          return { lines: [stopped === 'stopped' ? `${home}: its running daemon exited`
            : stopped === 'none' ? `${home}: no daemon running`
            : `${home}: the daemon answering on its port is not ${home}'s; it was left running`], made: [] };
        },
      })),
    ] },
  ];
  deps.onPlan?.(plan.flatMap((s) => s.actions.flatMap((a) => a.outcomes)));

  for (const { step: n, title, actions } of plan) {
    step(n, title);
    if (actions.length === 0) out('   nothing to do');
    for (const action of actions) {
      if (dry) { out(`   ${action.would}`); continue; }
      try {
        const { lines, made } = await action.run();
        for (const line of lines) out(`   ${line}`);
        for (const outcome of made) deps.onAction?.(outcome);
        const missed = action.outcomes.filter((o) => !made.includes(o));
        if (missed.length > 0) throw new Error(`the cutover planned changes it did not make: ${missed.join('; ')}`);
      } catch (error) {
        problem(error instanceof Error ? error.message : String(error));
        err(n < 6 ? '   The 1.4 service is left running, and nothing was imported; run the cutover again once this is settled.' : '   Nothing was imported; run the cutover again once this is settled.');
        return false;
      }
    }
    if (!dry && n === 4) {
      const kept = backup.pruneUnchanged().filter((e) => 'backup' in e);
      if (kept.length > 0) {
        out(`   backed up ${kept.length} settings file${kept.length === 1 ? '' : 's'} the cutover changed to ${backup.dir} (${MANIFEST_FILE} lists each original and its copy):`);
        for (const entry of kept) out(`     ${entry.original}`);
      }
      const left = scanLegacyRegistrations(scanOptions).findings.filter((f) => f.verdict === 'legacy');
      if (left.length > 0) {
        for (const f of left) problem(`${f.file} still holds a 1.4 registration (\`${f.subject}\`)`);
        err('   The 1.4 service is left running, and nothing was imported; run the cutover again once this is settled.');
        return false;
      }
    }
  }
  if (!dry && backup.all.length > 0) {
    out(`   To undo these changes by hand, run the commands in ${path.join(backup.dir, RESTORE_FILE)}; ${MANIFEST_FILE} beside it lists every file, entry and link.`);
  }

  // 7. The copies, reused only while they hold what the vault holds now.
  step(7, 'Copy every 1.4 vault and check the copy');
  const state = readState(mycoHome);
  const copies: string[] = [];
  for (const { home, vault } of vaults) {
    const content = readVaultContent(vault);
    const held = state.backups[vault];
    if (held !== undefined && held.digest === content.digest && copyProblem(held.copy, content) === null) {
      copies.push(held.copy);
      out(`   ${vault}: copied earlier to ${held.copy}, and the copy still holds what the vault holds`);
      continue;
    }
    const copy = copyPathFor(home, vault, stamp);
    const changed = held === undefined ? '' : ' (the vault changed since the earlier copy)';
    if (dry) { out(`   would copy ${vault} (${JSON.stringify(content.counts)}) to ${copy}${changed}`); copies.push(vault); continue; }
    try {
      const verified = backupVault(vault, copy);
      state.backups[vault] = { copy, counts: verified.counts, digest: verified.digest, at: now() };
      writeState(mycoHome, state);
      copies.push(copy);
      out(`   ${vault}: copied to ${copy}${changed}, and the copy matches (${JSON.stringify(verified.counts)})`);
    } catch (error) {
      problem((error as Error).message);
    }
  }
  if (copies.length !== vaults.length) { problem('not every vault has a verified copy; nothing was imported'); return false; }

  // 8. The imports.
  step(8, 'Bring the 1.4 history and your agents\' transcripts to the Deployment');
  const importDeps = { fetch: deps.fetch, now: deps.now, mycoHome, machineId, sleep: deps.sleep, pace: deps.pace ?? IMPORT_PACE_PER_MINUTE };
  const legacy: LegacyImportReport = await runLegacyImport({ sources: copies, serverUrl, dryRun: dry }, { ...importDeps, progress: (l) => out(`   ${l}`) });
  if (legacy.refused !== undefined) { problem(legacy.refused); return false; }
  for (const line of legacyReportLines(legacy, dry)) out(`   ${line}`);
  if (!legacyImportComplete(legacy)) problem('the Deployment refused or failed part of the 1.4 history (above); run the cutover again to retry it');
  if (dry) {
    out('   would then import every agent transcript under the connected folders');
    return ok;
  }
  const transcripts: ImportReport = await importUntilSettled(
    { serverUrl, mappings: parsed.mappings, windowDays: LEGACY_WINDOW_DAYS, maxPerAgent: LEGACY_MAX_PER_AGENT, exclude: new Set(legacy.deleted) },
    { ...importDeps, onRetry: (attempt, waitMs) => out(`   the Deployment asked to wait; pass ${attempt + 1} in ${Math.round(waitMs / 1000)} s`) },
  );
  if (transcripts.refused !== undefined) problem(transcripts.refused);
  for (const line of reportLines(transcripts, false)) out(`   ${line}`);
  if (!transcriptImportComplete(transcripts)) {
    const why = transcripts.projects.filter((p) => p.endedBy !== undefined).map((p) => `${p.projectId}: ${STOPPED_WORDS[p.endedBy!] ?? p.endedBy}`);
    problem(`the transcript import stopped before it finished (${why.join('; ') || transcripts.refused || 'no reason given'}); run the cutover again to finish it`);
  }
  // 9. This machine's settings: the Deployment's are cached for the hooks, and 1.4's plan folders are named, never
  // carried: they are set on the dashboard, where each machine's settings are kept.
  step(9, 'Name the plan folders 1.4 watched, which this machine sets on the dashboard');
  await seedMachineSettings({ serverUrl, token: membership.token }, { mycoHome, fetch: deps.fetch });
  const legacyPlanDirs = [...new Set(legacyHomes.flatMap(legacyPlanDirsOf))];
  if (legacyPlanDirs.length === 0) out('   1.4 watched no extra plan folders on this machine');
  else {
    out(`   1.4 also watched these plan folders: ${legacyPlanDirs.join(', ')}`);
    out(`   to keep any, add it under Access › Runtimes › Settings for this machine: ${deploymentUrl(serverUrl)}/access`);
  }
  out(ok ? 'Cutover complete.' : 'Cutover finished with the problems above; run it again once they are settled.');
  return ok;
}

/** The extra plan folders a 1.4 home's machine configuration names, or none where it names none or cannot be read. */
export function legacyPlanDirsOf(home: string): string[] {
  try {
    const parsed = parseYaml(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')) as { capture?: { plan_dirs?: unknown } } | null;
    const dirs = parsed?.capture?.plan_dirs;
    return Array.isArray(dirs) ? dirs.filter((d): d is string => typeof d === 'string' && d.length > 0) : [];
  } catch {
    return [];
  }
}
