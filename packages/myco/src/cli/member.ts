import { importSignInHistory, withSignInCapture } from './signin-capture.js';
import { scanLegacyRegistrations } from '@myco/member/legacy-registration-files.js';
import { findingOwnedBinary } from '@myco/symbionts/registration-takeover.js';
import { repositoryName } from '@myco/utils/git.js';
import { askOnTerminal } from '@myco/setup/prompt.js';
import semver from 'semver';
import { readBinaryVersion, installedVersionSupersedes, LIVE_MEMBER_VERSION_TIMEOUT_MS } from '@myco/runtime/binary-version.js';
import { installedBinaryPath, isRunningExecutable } from '@myco/runtime/binary-resolution.js';
import { selfExecOf } from '@myco/runtime/self-exec.js';
import { withMemberRepair } from './member-repair.js';
export { MemberRepairBusyError } from './member-repair.js';
/**
 * `myco member <op>` — the member's own CLI: `join`/`leave` record and forget
 * this machine's membership of a project (the token never reaches argv);
 * `drain [--all]` runs the one
 * drain implementation without a harness budget and ignoring the offline
 * latch; `status` shows the registry entry (token redacted), expiry, spool
 * depth, last acknowledgement and refusal, the latch, and how many capture
 * attempts found no membership at all; `mcp-headers` prints the member
 * headers a remote MCP entry asks for.
 */
import { IDENTITY_LINK_TTL_MS, INVITE_CONTROLS } from '@goondocks/myco-shared/member-protocol';
import { seedMachineSettings } from '../member/machine-settings.js';
import { autoJoinIdentityIssues, listAutoJoinStates } from '../member/auto-join.js';
import { optOut, settleConnection } from './member-auto-join.js';
import { defaultMembership, readDefaultDeployment } from '../member/default-deployment.js';
import { selectedDeploymentMembership } from '../member/token-pairing.js';
import { assignLegacyPending, flushPending, listHeldEnds, listPending, PENDING_MAX_RECORDS, PENDING_TTL_MS } from '../member/pending.js';
import { harnessToolsElsewhere } from '@goondocks/myco-shared/setup-guidance';
import { hostname } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalRootIdentity } from '../utils/git-files.js';
import { readInstallation } from '@myco/install/installation.js';
import { checkInstallation, checkAutomaticUpdate, checkMemberMcpResolution, formatCheck, type DoctorCheck } from './doctor-member.js';
import { getMachineId } from '../machine-id.js';
import { isSafeProjectRoot } from '../project-root.js';
import { RUNTIME_HOME_FILENAME, defaultMycoHome, readHomePin, resolveMycoHome, type ResolvedMycoHome } from '../paths/home.js';
import { memberHomeFor, pinnedElsewhere, pinnedElsewhereRefusal, pinnedHomeLine, pinnedHomeRefusal } from '../member/home-for-folder.js';
import { unboundedBudget, type HookBudget } from '../member/budget.js';
import { CONNECT_TIMEOUT_CAP_MS, CREDENTIAL_FLAG, CREDENTIAL_SOURCES, deploymentScopedHeaders, isProjectId, memberHeaders, MEMBER_TOKEN_REFRESH_WINDOW_MS, SERVER_FLAG } from '../member/constants.js';
import { isMemberTokenShape, parseCredentialFlag, resolveCredential, resolveMemberProjectRoot } from '../member/credential.js';
import { admitMemberServerUrl, memberServerDialUrl, MEMBER_SERVER_URL_RULE } from '../member/server-url.js';
import { clearJoinRefusals } from '../member/join-code.js';
import { refreshMemberCredential, type RefreshReport } from '../member/refresh.js';
import { readRefusedHook, REFUSED_HOOK_KINDS, refusedHookWords } from '../member/refused-hooks.js';
import { clearMissingMembership, listMissingMembershipsResult, pruneMissingMemberships, readMissingMembership, readMissingMembershipResult, type MissingMembershipRecord } from '../member/no-membership.js';
import { deploymentUrl, listDeploymentMemberships, listRegistryEntries, listRegistryEntriesResult, readDeploymentMembership, readRegistryEntry, readRegistryEntryResult, removeRegistryEntry, writeRegistryEntry, REGISTRY_VERSION, registryConflictWords, type RegistryConflict, type RegistryEntry } from '../member/registry.js';
import { applySpoolRetention } from '../member/retention.js';
import { assignLegacySpoolDestination, listLegacySpools } from '../member/spool-migration.js';
import { listRoutingEntries, listRoutingEntriesResult, routingEntry, routingKey, type BufferedDestinationIssue } from '../member/routing.js';
import { memberDiagnostics, projectDiagnostics } from '../member/diagnostics.js';
import { memberTranscriptRoutingKey } from '../member/transcript-routing.js';
import { MemberSpool, type DrainResult } from '../member/spool.js';
import { drainEntryBacklog, type BacklogReport } from '../member/backlog.js';
import { REJOIN_HINT } from '../member/delivery-notice.js';
import { ServerClient, type FetchLike } from '../member/transport.js';
import { openBrowser } from './open-browser.js';
import { CutoverBackup } from '../member/cutover-backup.js';
import { linkMemberSkills, missingMemberSkills, skillsFolder, type SkillLinks } from '../symbionts/member-skill-links.js';
import { readProvisionRecord, readProvisionRecordStrict, recordProvision, reconcileProvisionAgents, forgetProvision, holdHookTrust, type ProvisionRecord } from '../symbionts/member-provision-record.js';
import { keepCurrent, reportHarnesses, HARNESS_REPORT_WINDOW_MS, type KeepCurrentResult } from '@myco/cli/member-keep-current.js';
import { getPluginVersion } from '../version.js';
import { postRoute } from './deployment-reader.js';
import { detectMachineInstalledSymbionts, loadManifests, resolvePackageRoot } from '../symbionts/detect.js';
import { MemberPendingLogoutError, MemberProvisionConflictError, SymbiontInstaller } from '../symbionts/installer.js';
import { ensureGitIgnored } from '@myco/utils/git-exclude.js';
import { describeWorkerService, workerServiceWords, type WorkerServiceDeps } from './worker-service.js';


export interface MemberCliDeps {
  /** Bound setup's capture follow-up to the Deployment it just joined. */
  signInCapture?: { serverUrl: string };
  fetch?: FetchLike;
  now?: () => number;
  cwd?: string;
  mycoHome?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** Reads `--token-stdin`; defaults to this process's stdin. */
  stdin?: () => string;
  env?: NodeJS.ProcessEnv;
  /** Where `--provision` writes; defaults to the real package root. */
  packageRoot?: string;
  /** The agents installed on this machine; defaults to `detectMachineInstalledSymbionts`. */
  agents?: () => string[];
  /** Asks the connect flow's one question; null where no terminal can answer. Defaults to stdin when it is a terminal. */
  ask?: (question: string) => Promise<string | null>;
  /** Opens a URL in the browser for `link-github --open`; defaults to the platform opener. */
  openBrowser?: (url: string) => void;
  /** What `join` and `leave` install and remove the worker service through; defaults to this machine's platform. */
  worker?: WorkerServiceDeps;
}

const redact = (token: string): string => `${token.slice(0, 4)}…${token.slice(-4)}`;
const when = (ms: number | undefined): string => (ms === undefined ? '—' : new Date(ms).toISOString());

/**
 * The home every op reads, resolved from the directory the op is about: a
 * project pinned to a non-default home is addressed from inside it without
 * `MYCO_HOME`, exactly as its hooks are.
 */
const homeFor = (deps: MemberCliDeps, cwd?: string): string => homeChoiceFor(deps, cwd).home;

/** The home an op uses for `cwd` and the rule that chose it (`memberHomeFor`); a home the caller names is its own. */
const homeChoiceFor = (deps: MemberCliDeps, cwd?: string): ResolvedMycoHome =>
  deps.mycoHome !== undefined ? { home: deps.mycoHome, source: 'env' } : memberHomeFor(path.resolve(cwd ?? deps.cwd ?? process.cwd()));

function entriesFor(args: readonly string[], deps: MemberCliDeps): RegistryEntry[] {
  const mycoHome = homeFor(deps);
  if (args.includes('--all')) return listRoutingEntries(mycoHome);
  const root = resolveMemberProjectRoot(deps.cwd);
  const entry = readRegistryEntry(root, mycoHome);
  if (!entry) {
    (deps.stderr ?? ((l) => process.stderr.write(`${l}\n`)))(`myco member: no registry entry for ${root} — run \`myco member join\``);
    return [];
  }
  return [entry];
}

/**
 * The memberships a diagnostic surface reads, and what the registry could not
 * answer for. Reads only: no migration and no write lock, so a damaged entry is
 * reported rather than repaired.
 */
function registrySelection(args: readonly string[], deps: MemberCliDeps): {
  root: string | null; all: boolean; entries: RegistryEntry[]; readable: boolean; unavailableEntries: number; heldDestinations: BufferedDestinationIssue[]; conflicts?: RegistryConflict[];
} {
  const mycoHome = homeFor(deps);
  const all = args.includes('--all');
  if (all) {
    const registry = listRegistryEntriesResult(mycoHome);
    const bound = new Set(registry.entries.map(routingKey));
    const routing = listRoutingEntriesResult(mycoHome, registry.entries);
    const retained = routing.entries.filter((entry) => !bound.has(routingKey(entry)));
    return { root: null, all, ...registry, entries: [...registry.entries, ...retained], heldDestinations: routing.heldDestinations };
  }
  const root = projectRootOrNull(deps.cwd);
  const selected = root === null ? null : readRegistryEntryResult(root, mycoHome);
  return {
    root, all, heldDestinations: [],
    ...(selected?.status === 'unavailable' && selected.conflict ? { conflicts: [selected.conflict] } : {}),
    entries: selected?.status === 'present' ? [selected.entry] : [],
    readable: selected?.status !== 'unavailable',
    unavailableEntries: selected?.status === 'unavailable' ? 1 : 0,
  };
}

/**
 * The missed-capture records a diagnostic surface reads, and what the store
 * could not answer for. A record naming another root, or one nothing can count
 * or date, is unavailable rather than a number.
 *
 * `missedCaptureRoot` is the root a hook keys its misses under, which carries no
 * project-root gate: a record exists for directories a registry entry cannot.
 */
function missedCaptureRoot(deps: MemberCliDeps): string | null {
  try {
    return resolveMemberProjectRoot(deps.cwd);
  } catch {
    return null;
  }
}

function missedCaptureSelection(root: string | null, all: boolean, deps: MemberCliDeps): {
  records: MissingMembershipRecord[]; readable: boolean; unavailableRecords: number;
} {
  const mycoHome = homeFor(deps);
  if (all) return listMissingMembershipsResult(mycoHome);
  const read = root === null ? null : readMissingMembershipResult(root, mycoHome);
  return {
    records: read?.status === 'present' ? [read.record] : [],
    readable: read?.status !== 'unavailable',
    unavailableRecords: read?.status === 'unavailable' ? 1 : 0,
  };
}

/** The flags `join` understands. An unknown flag is refused: a token must never reach argv, and a typo must never look like a success. */
interface JoinArgs {
  serverUrl?: string;
  project?: string;
  tokenStdin: boolean;
  tokenEnv?: string;
  root?: string;
  provision?: string;
  noWorker?: boolean;
  /** `--new [name]`: create a project for this folder, named `name` or the folder's own name. */
  create?: { name: string | null };
  noAgents?: boolean;
  error?: string;
}

function parseJoin(args: readonly string[]): JoinArgs {
  const parsed: JoinArgs = { tokenStdin: false };
  // The FIRST complaint is the one reported, and no message ever quotes an
  // argument's value: whoever typed `--token <secret>` typed a secret, and a
  // diagnostic that echoes it puts it in the terminal scrollback.
  const refuse = (message: string): void => { if (parsed.error === undefined) parsed.error = message; };
  const value = (name: string, next: string | undefined): string | undefined => {
    if (next === undefined || next.startsWith('--')) refuse(`${name} needs a value`);
    return next;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--project': parsed.project = value(arg, args[++i]); break;
      case '--token-stdin': parsed.tokenStdin = true; break;
      case '--token-env': parsed.tokenEnv = value(arg, args[++i]); break;
      case '--root': parsed.root = value(arg, args[++i]); break;
      case '--provision': parsed.provision = value(arg, args[++i]); break;
      case '--no-worker': parsed.noWorker = true; break;
      case '--no-agents': parsed.noAgents = true; break;
      case '--new': {
        // A name follows `--new` unless what follows is a flag or a server URL, which names the Deployment instead.
        const next = args[i + 1];
        const named = next !== undefined && !next.startsWith('--') && !/^[a-z][a-z0-9+.-]*:\/\//i.test(next);
        parsed.create = { name: named ? (i += 1, next) : null };
        break;
      }
      default:
        if (arg.startsWith('-')) refuse(`unknown option ${arg.split('=')[0]}`);
        else if (parsed.serverUrl === undefined) parsed.serverUrl = arg;
        else refuse('join takes one server URL');
    }
  }
  return parsed;
}

/**
 * Record this machine's membership: verify the server answers and the token
 * has the shape the server mints, then write the registry entry. The check is
 * write-free — `GET /health` needs no credential and stores nothing — so a
 * mistyped id never leaves a trace on the server.
 */
export async function runJoin(args: readonly string[], deps: MemberCliDeps = {}): Promise<RegistryEntry | null> {
  const out = deps.stdout ?? ((l) => process.stdout.write(`${l}\n`));
  const err = deps.stderr ?? ((l) => process.stderr.write(`${l}\n`));
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const fail = (line: string): null => { err(`myco member join: ${line}`); process.exitCode = 2; return null; };

  const parsed = parseJoin(args);
  if (parsed.error) return fail(parsed.error);
  // With no token named, the folder is connected over the membership this machine already holds.
  if (!parsed.tokenStdin && parsed.tokenEnv === undefined) return connectFolder(parsed, deps, out, err, fail);
  if (parsed.create !== undefined) return fail('--new connects a folder over the membership this machine holds; it takes no token');
  if (!parsed.serverUrl || !parsed.project) { err(MEMBER_HELP.trimEnd()); process.exitCode = 2; return null; }
  if (!admitMemberServerUrl(parsed.serverUrl)) return fail(`${parsed.serverUrl} is not a server URL a member accepts (${MEMBER_SERVER_URL_RULE})`);
  if (!isProjectId(parsed.project)) return fail(`${parsed.project} is not a project id`);
  if (parsed.tokenStdin === (parsed.tokenEnv !== undefined)) return fail('pass the token with exactly one of --token-stdin or --token-env <NAME>');

  const token = (parsed.tokenStdin ? readStdin(deps) : env[parsed.tokenEnv!] ?? '').trim();
  if (!token) return fail(parsed.tokenStdin ? 'no token on stdin' : `${parsed.tokenEnv} is not set`);
  if (!isMemberTokenShape(token)) return fail('that is not a member token');

  const root = path.resolve(parsed.root ?? resolveMemberProjectRoot(deps.cwd));
  if (!isSafeProjectRoot(root)) return fail(`${root} is not a project directory`);

  const client = new ServerClient({ serverUrl: parsed.serverUrl, token, projectId: parsed.project }, deps.fetch ?? globalThis.fetch);
  if (!await client.health(unboundedBudget())) return fail(`${parsed.serverUrl} did not answer`);

  // The root this join is ABOUT resolves the home, so `--root <dir>` cannot
  // record a membership in one home and pin the project to another.
  const mycoHome = homeFor(deps, root);
  const existing = readRegistryEntry(root, mycoHome);
  const entry: RegistryEntry = {
    version: REGISTRY_VERSION,
    projectId: parsed.project,
    serverUrl: parsed.serverUrl,
    token,
    root,
    machineId: getMachineId(),
    joinedAt: existing?.joinedAt ?? now(),
    updatedAt: now(),
  };
  writeRegistryEntry(entry, { mycoHome, resolveConflict: true });
  // What this repository's hooks held while it had no connection joins the project now, and "Needs you" forgets it.
  await settleConnection(entry, { mycoHome, now, fetch: deps.fetch, tell: true, packageRoot: deps.packageRoot, stderr: err });
  const pinned = pinProjectHome(root, mycoHome);
  const machinePinned = pinMachineHome(mycoHome, deps);
  // The misses this root accumulated while unjoined are answered by the join itself.
  const missed = readMissingMembership(root, mycoHome);
  clearMissingMembership(root, mycoHome);
  pruneMissingMemberships(mycoHome, now());
  out(`joined ${parsed.project} at ${parsed.serverUrl} for ${root}`);
  reportPin(pinned, mycoHome, out, err);
  reportMachinePin(machinePinned, mycoHome, out);
  if (missed) out(`${missed.count} earlier capture attempt(s) here found no membership; new sessions are captured from now on`);
  out('connect your GitHub account for the dashboard: myco member link-github');

  // The settings the Deployment holds for this machine, cached before the first session reads them.
  await seedMachineSettings({ serverUrl: parsed.serverUrl, token }, { mycoHome, fetch: deps.fetch });
  if (parsed.provision && !provisionAgent(parsed.provision, root, mycoHome, deps, out, fail)) return null;

  await importJoinedHistory(entry, mycoHome, deps, out, err);
  return entry;
}

/** The member routes the connect flow reads the Deployment's projects from and creates one through. */
export const MEMBER_PROJECTS_LIST_PATH = '/members/projects/list';
export const MEMBER_PROJECTS_PATH = '/members/projects';
/** How long the connect flow waits for the Deployment to answer one request. */
const CONNECT_REQUEST_TIMEOUT_MS = 30_000;

/** A project on the member's Deployment, as `POST /members/projects/list` answers it. */
interface DeploymentProject { projectId: string; name: string; sessionCount: number }

/**
 * `myco member join [<server-url>] [--project <id|name> | --new [name]] [--root <dir>] [--no-agents]`: connect the folder
 * this runs in to a project on the Deployment this machine is a member of, over the membership `myco login` recorded,
 * so no token is typed. The project is one the Deployment holds, named by id or name, or one created for the folder.
 * With neither named, a terminal is asked which; anywhere else the projects and both commands are listed.
 */
async function connectFolder(
  parsed: JoinArgs, deps: MemberCliDeps, out: (line: string) => void, err: (line: string) => void, fail: (line: string) => null,
): Promise<RegistryEntry | null> {
  const now = deps.now ?? Date.now;
  const root = path.resolve(parsed.root ?? resolveMemberProjectRoot(deps.cwd));
  if (!isSafeProjectRoot(root)) return fail(`${root} is not a project directory; run this inside the repository to connect`);
  const chosen = homeChoiceFor(deps, root);
  const mycoHome = chosen.home;
  const selected = selectedDeploymentMembership(mycoHome, parsed.serverUrl);
  const memberships = selected === null ? [] : [selected];
  // A pin chose this home: say so before anything reads its credential, and refuse where it holds none. A pin that sends
  // the folder away from this machine's own home never has one of that home's memberships picked for it.
  if (parsed.serverUrl === undefined && pinnedElsewhere(chosen, deps.env)) {
    const known = listDeploymentMemberships(mycoHome);
    if (known.length > 0) return fail(pinnedElsewhereRefusal(chosen, root, known.map((membership) => deploymentUrl(membership.serverUrl))));
  }
  const pinnedRefusal = memberships.length === 0 ? pinnedHomeRefusal(chosen, root, parsed.serverUrl === undefined ? 'membership' : `membership of ${parsed.serverUrl}`) : null;
  if (pinnedRefusal !== null) return fail(pinnedRefusal);
  const pinnedLine = pinnedHomeLine(chosen, root);
  if (pinnedLine !== null) out(pinnedLine);
  if (memberships.length === 0) {
    const known = listDeploymentMemberships(mycoHome);
    if (parsed.serverUrl === undefined && known.length > 1) return fail(`this machine is a member of ${known.length} Deployments; name one (${known.map((m) => deploymentUrl(m.serverUrl)).join(', ')})`);
    if (parsed.serverUrl === undefined && known.length === 1) return fail(`no default Deployment is recorded; name ${deploymentUrl(known[0].serverUrl)} to connect this folder`);
    return fail(parsed.serverUrl === undefined ? 'this machine is not signed in to a Deployment — run `myco login <address>` first' : `this machine is not signed in to ${parsed.serverUrl} — run \`myco login <address>\` first`);
  }
  const membership = memberships[0];
  const serverUrl = membership.serverUrl;
  const client = new ServerClient({ serverUrl, token: membership.token }, deps.fetch ?? globalThis.fetch);
  const budget = { connectTimeoutMs: CONNECT_TIMEOUT_CAP_MS, requestTimeoutMs: CONNECT_REQUEST_TIMEOUT_MS };

  let project: DeploymentProject | undefined;
  const create = async (name: string): Promise<DeploymentProject | null> => {
    const made = await postRoute(client, budget, MEMBER_PROJECTS_PATH, { name });
    if (!made.ok) { fail(`${deploymentUrl(serverUrl)} did not create the project (${made.error.code}): ${made.error.message}`); return null; }
    return { projectId: String(made.value.projectId), name: String(made.value.name), sessionCount: 0 };
  };
  const defaultProjectName = repositoryName(root);
  if (parsed.create !== undefined) {
    const made = await create(parsed.create.name ?? defaultProjectName);
    if (made === null) return null;
    project = made;
  } else {
    const listed = await postRoute(client, budget, MEMBER_PROJECTS_LIST_PATH, {});
    if (!listed.ok) return fail(`${deploymentUrl(serverUrl)} did not list its projects (${listed.error.code}): ${listed.error.message}`);
    const projects = (Array.isArray(listed.value.projects) ? listed.value.projects : []) as DeploymentProject[];
    if (parsed.project !== undefined) {
      const wanted = parsed.project;
      const matches = projects.filter((p) => p.projectId === wanted || p.name.toLowerCase() === wanted.toLowerCase());
      if (matches.length === 0) return fail(`${deploymentUrl(serverUrl)} holds no project "${wanted}"; see its projects with \`myco member join\`, or create one with \`myco member join --new\``);
      if (matches.length > 1) return fail(`${matches.length} projects are named "${wanted}"; name one by id (${matches.map((p) => p.projectId).join(', ')})`);
      project = matches[0];
    } else {
      const lines = [`Projects on ${deploymentUrl(serverUrl)}:`, ...projects.map((p, n) => `  ${n + 1}) ${p.name} (${p.projectId}, ${p.sessionCount} session${p.sessionCount === 1 ? '' : 's'})`)];
      const answer = await (deps.ask ?? askOnTerminal)([...lines, `  n) a new project named "${defaultProjectName}"`, `Connect ${root} to which? `].join('\n'));
      if (answer === null) {
        for (const line of lines) out(line);
        return fail(`name the project to connect ${root} to: \`myco member join --project <id or name>\`, or \`myco member join --new [name]\` to create one`);
      }
      const picked = answer.trim().toLowerCase();
      if (picked === 'n' || picked === 'new') {
        const made = await create(defaultProjectName);
        if (made === null) return null;
        project = made;
      } else {
        const index = Number(picked);
        if (!Number.isSafeInteger(index) || index < 1 || index > projects.length) return fail(`"${answer.trim()}" names no project here; nothing was connected`);
        project = projects[index - 1];
      }
    }
  }

  const existing = readRegistryEntry(root, mycoHome);
  const entry: RegistryEntry = {
    version: REGISTRY_VERSION, projectId: project.projectId, serverUrl, token: membership.token, root,
    machineId: membership.machineId ?? getMachineId(), joinedAt: existing?.joinedAt ?? now(), updatedAt: now(),
  };
  writeRegistryEntry(entry, { mycoHome, resolveConflict: true });
  // What this repository's hooks held while it had no connection joins the project now, and "Needs you" forgets it.
  await settleConnection(entry, { mycoHome, now, fetch: deps.fetch, tell: true, packageRoot: deps.packageRoot, stderr: err });
  const pinned = pinProjectHome(root, mycoHome);
  const machinePinned = pinMachineHome(mycoHome, deps);
  clearMissingMembership(root, mycoHome);
  pruneMissingMemberships(mycoHome, now());
  out(`Connected ${root} to project ${project.name} (${project.projectId}) on ${deploymentUrl(serverUrl)}. Your agents capture there from now on.`);
  reportPin(pinned, mycoHome, out, err);
  reportMachinePin(machinePinned, mycoHome, out);
  await seedMachineSettings({ serverUrl, token: membership.token }, { mycoHome, fetch: deps.fetch });
  if (!parsed.noAgents) {
    for (const line of detectedProvisionLines(provisionDetectedAgents(mycoHome, serverUrl, root, { packageRoot: deps.packageRoot, agents: deps.agents, cwd: deps.cwd }))) out(line);
  } else recordNoAgents(mycoHome, serverUrl);
  await importJoinedHistory(entry, mycoHome, deps, out, err);
  return entry;
}

async function importJoinedHistory(
  entry: RegistryEntry, mycoHome: string, deps: MemberCliDeps,
  stdout: (line: string) => void, stderr: (line: string) => void,
): Promise<void> {
  await withSignInCapture({ fetch: deps.fetch, now: deps.now, stdout }, capture => importSignInHistory({ serverUrl: entry.serverUrl, project: entry.projectId }, {
    now: deps.now, cwd: entry.root, mycoHome, machineId: entry.machineId, stdout, stderr,
  }, capture));
}

/**
 * Write `agent`'s member hooks and MCP entry for `root` from the membership
 * already recorded in `mycoHome` — the one provisioning step `join --provision`
 * and `provision` share. False (after `fail`) for an unknown agent or an MCP
 * entry the agent would merge into a configuration it refuses.
 */
function provisionAgent(
  agent: string,
  root: string,
  mycoHome: string,
  deps: MemberCliDeps,
  out: (line: string) => void,
  fail: (line: string) => unknown,
): boolean {
  const outcome = provisionChosenAgent(agent, root, mycoHome, deps);
  if (outcome.kind === 'unknown') {
    fail(`unknown agent "${agent}" — the membership is recorded; provision it with \`myco member provision <agent>\``);
    return false;
  }
  if (outcome.kind === 'refused') {
    fail(outcome.detail);
    return false;
  }
  out(outcome.detail);
  return true;
}

/** What provisioning one agent globally came to. */
export type ProvisionOutcome =
  | { kind: 'unknown' }
  | { kind: 'refused'; detail: string; code?: string }
  | { kind: 'provisioned' | 'unchanged'; detail: string; skills?: SkillLinks | null; hooksChanged?: boolean; captureReady?: boolean; written?: string[]; stale?: string[] };

/**
 * Install an agent's member hooks (or plugin) and MCP entry globally, from the
 * membership recorded for `root` in `mycoHome` — the one provisioning step
 * `member join --provision`, `member provision` and `myco cutover` share.
 * `legacyHomes` names 1.4 homes whose global registrations are replaced in
 * place rather than refused.
 */
/**
 * The member-global installer for `manifest`: over the connected folder `root`, or with no project root where no folder
 * is connected, when global provisioning neither reads nor retires any project's registrations.
 */
function globalInstaller(
  manifest: ReturnType<typeof loadManifests>[number], root: string | null, mycoHome: string, opts: { packageRoot?: string; legacyHomes?: readonly string[]; cwd?: string },
): SymbiontInstaller {
  const installer = new SymbiontInstaller(manifest, root ?? mycoHome, opts.packageRoot ?? resolvePackageRoot(), false, mycoHome)
    .replacingLegacy(opts.legacyHomes ?? []).forProjectFolder(root === null ? undefined : opts.cwd);
  return root === null ? installer.withoutProjectRoot() : installer;
}

/** Manifest-backed evidence of prior provisioning in this home's global registrations. */
export function registeredMemberHarnesses(mycoHome: string, serverUrl: string, opts: { packageRoot?: string; exclude?: string[]; onInspectionError?: (message: string) => void } = {}): string[] {
  return loadManifests().filter((manifest) => !opts.exclude?.includes(manifest.name)).flatMap((manifest) => {
    try {
      const installer = globalInstaller(manifest, null, mycoHome, opts).takingOverManagedEntries().forDeployment(serverUrl).preservingOtherMemberTools();
      return installer.capturesAsMember() && installer.memberRegistrationPresent() ? [manifest.name] : [];
    } catch (error) {
      if (!(error instanceof MemberProvisionConflictError)) throw error;
      opts.onInspectionError?.(`could not inspect ${manifest.displayName}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  });
}

/** Chosen agents, including surviving owned registrations absent from the provision record. */
export function managedMemberHarnesses(mycoHome: string, serverUrl: string, opts: { packageRoot?: string; onInspectionError?: (message: string) => void } = {}): string[] {
  const uncaptured = uncapturableMemberHarnesses(mycoHome, opts);
  const record = readProvisionRecordStrict(mycoHome);
  const recorded = (record?.agents ?? []).filter(agent => !uncaptured.has(agent));
  if (record?.discoverAgents === false) return recorded;
  return [...new Set([...recorded, ...registeredMemberHarnesses(mycoHome, serverUrl, { ...opts, exclude: recorded })])].sort();
}

function uncapturableMemberHarnesses(mycoHome: string, opts: { packageRoot?: string }): Set<string> {
  return new Set(loadManifests().filter(manifest => !globalInstaller(manifest, null, mycoHome, opts).capturesAsMember()).map(manifest => manifest.name));
}

/** The recorded destination, or an explicitly selected or unambiguous joined Deployment. */
export function memberProvisionTarget(mycoHome: string, serverUrl?: string): string | undefined {
  const record = readProvisionRecordStrict(mycoHome);
  if (record !== null && serverUrl === undefined) return record.serverUrl;
  const selected = selectedDeploymentMembership(mycoHome, serverUrl);
  if (selected !== null) return selected.serverUrl;
  const memberships = serverUrl === undefined ? listDeploymentMemberships(mycoHome) : [];
  return memberships.length === 1 ? memberships[0].serverUrl : undefined;
}

function provisionChosenAgent(agent: string, root: string | null, mycoHome: string, opts: { packageRoot?: string; serverUrl?: string; cwd?: string }): ProvisionOutcome {
  const outcome = withMemberRepair(mycoHome, 'myco member provision', () => {
    const backup = provisionBackup(mycoHome);
    try { return provisionGlobally(agent, root, mycoHome, { ...opts, backup }); }
    finally { backup.pruneUnchanged(); }
  }, { wait: true });
  if (outcome.kind === 'provisioned' || outcome.kind === 'unchanged') withManagedMemberHarnesses(mycoHome, opts, () => {});
  return outcome;
}

/** Reconcile fresh choices and owned registrations, and hold the repair lease through the operation. */
export function withManagedMemberHarnesses<T>(mycoHome: string, opts: { packageRoot?: string; serverUrl?: string; onInspectionError?: (message: string) => void; wait?: boolean }, fn: (record: ProvisionRecord, agents: string[], retiredSettingsProblems: ReadonlySet<string>) => T): T | null {
  return withMemberRepair(mycoHome, 'myco member reconcile', () => {
    const runningVersion = getPluginVersion();
    if (semver.valid(runningVersion) !== null && selfExecOf(process.execPath, process.argv[1]).args.length === 0) {
      try {
        const live = installedBinaryPath(mycoHome);
        if (fs.existsSync(live) && !isRunningExecutable(live)) {
          const liveVersion = readBinaryVersion(live, LIVE_MEMBER_VERSION_TIMEOUT_MS);
          if (installedVersionSupersedes(liveVersion, runningVersion)) {
            (opts.onInspectionError ?? console.warn)(`a different build of Myco is installed (${liveVersion}); this process leaves agent setup alone.`);
            return null;
          }
        }
      } catch (error) {
        (opts.onInspectionError ?? console.warn)(`The installed Myco version could not be checked (${error instanceof Error ? error.message : String(error)}); agent repair will continue using this build.`);
      }
    }
    const serverUrl = memberProvisionTarget(mycoHome, opts.serverUrl);
    if (serverUrl === undefined) return null;
    const retiredSettingsProblems = new Set<string>();
    for (const manifest of loadManifests()) {
      if (!manifest.registration?.retiredHookSettings) continue;
      const installer = globalInstaller(manifest, null, mycoHome, opts);
      try {
        installer.forDeployment(serverUrl).assertMemberProvisionAllowed();
      } catch (error) {
        if (!(error instanceof MemberPendingLogoutError)) throw error;
        retiredSettingsProblems.add(manifest.name);
        (opts.onInspectionError ?? console.warn)(error.message);
        continue;
      }
      try {
        let backup: CutoverBackup | undefined;
        try {
          const migrated = installer.reconcileRetiredHookSettings(undefined, file => {
            backup ??= provisionBackup(mycoHome);
            if (!backup.all.some(entry => entry.original === file)) backup.take(file);
          }, opts.onInspectionError);
          if (migrated === null) retiredSettingsProblems.add(manifest.name);
        } finally { backup?.pruneUnchanged(); }
      } catch (error) {
        retiredSettingsProblems.add(manifest.name);
        installer.reportRetiredSettingsProblem(error, opts.onInspectionError);
      }
    }
    const before = readProvisionRecordStrict(mycoHome);
    const agents = managedMemberHarnesses(mycoHome, serverUrl, opts);
    if (before === null && agents.length === 0) return null;
    const discovered = agents.filter(agent => !before?.agents.includes(agent));
    const record = reconcileProvisionAgents(mycoHome, { version: getPluginVersion(), serverUrl, discovered }, uncapturableMemberHarnesses(mycoHome, opts));
    return fn({ ...record, serverUrl }, record.agents, retiredSettingsProblems);
  }, { wait: opts.wait });
}

/** Read-only registration and settings currency through the installer. */
export function memberHarnessStatus(agent: string, mycoHome: string, serverUrl: string, opts: { packageRoot?: string } = {}): { current: boolean; currentExceptStaleTools?: boolean; toolsDeployment?: string; stale?: string[] } {
  const manifest = loadManifests().find((candidate) => candidate.name === agent);
  if (manifest === undefined) return { current: false };
  const installer = globalInstaller(manifest, null, mycoHome, opts).takingOverManagedEntries().forDeployment(serverUrl).preservingOtherMemberTools();
  installer.assertMemberProvisionAllowed();
  return inspectMemberHarness(installer, manifest, mycoHome, installer.scanMemberRegistrations());
}

function inspectMemberHarness(installer: SymbiontInstaller, manifest: ReturnType<typeof loadManifests>[number], mycoHome: string, scan: ReturnType<SymbiontInstaller['scanMemberRegistrations']>) {
  const toolsDeployment = installer.memberToolsDeployment(scan);
  const registrationCurrent = installer.memberRegistrationCurrent(scan);
  const stale = installer.memberGlobalTargets(scan).skipped;
  const target = manifest.registration?.globalSkillsTarget;
  const skillsCurrent = target == null || missingMemberSkills(mycoHome, target).length === 0;
  return { current: registrationCurrent && skillsCurrent, currentExceptStaleTools: stale.length > 0 && skillsCurrent && installer.memberRegistrationCurrent(scan, true), ...(stale.length === 0 ? {} : { stale }), ...(toolsDeployment === undefined ? {} : { toolsDeployment }) };
}

export function memberHarnessCurrent(agent: string, mycoHome: string, serverUrl: string, opts: { packageRoot?: string } = {}): boolean {
  return memberHarnessStatus(agent, mycoHome, serverUrl, opts).current;
}

export function provisionGlobally(
  agent: string, root: string | null, mycoHome: string,
  opts: { packageRoot?: string; legacyHomes?: readonly string[]; serverUrl?: string; backup?: CutoverBackup; preserveOtherMemberTools?: boolean; cwd?: string } = {},
): ProvisionOutcome {
  const manifest = loadManifests().find((m) => m.name === agent);
  if (!manifest) return { kind: 'unknown' };
  const installer = globalInstaller(manifest, root, mycoHome, opts);
  if (!opts.legacyHomes?.length) installer.takingOverManagedEntries();
  if (opts.serverUrl !== undefined) installer.forDeployment(opts.serverUrl);
  if (opts.preserveOtherMemberTools) installer.preservingOtherMemberTools();
  // Every agent file this may write is copied first; `restore.md` beside the copies puts back what the person had.
  const scan = installer.scanMemberRegistrations();
  const registration = installer.memberGlobalTargets(scan);
  const targets = opts.backup === undefined ? [] : registration.all;
  const absent = targets.filter((file) => !fs.existsSync(file));
  const regular = (file: string) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
  for (const file of targets) if (regular(file) && !opts.backup!.all.some((e) => e.original === file)) opts.backup!.take(file);
  let installed;
  try {
    installed = installer.install(scan);
  } catch (error) {
    if (!(error instanceof MemberProvisionConflictError)) throw error;
    const code = (error.cause as NodeJS.ErrnoException | undefined)?.code;
    return { kind: 'refused', detail: error.message, ...(code === undefined ? {} : { code }) };
  } finally {
    for (const file of absent) if (fs.existsSync(file) && !opts.backup!.all.some((e) => e.original === file)) opts.backup!.created(file);
  }
  const surface = installer.isMemberPluginFile() ? 'plugin' : 'hooks';
  // An agent Myco captures gets the skills of this home in its global skills folder, beside its hooks.
  const target = manifest.registration?.globalSkillsTarget;
  const skills = installer.capturesAsMember() && target ? linkMemberSkills(mycoHome, skillsFolder(target), opts.legacyHomes ?? []) : null;
  const skillsMoved = skills !== null && (skills.linked.length > 0 || skills.removed.length > 0);
  if (opts.preserveOtherMemberTools && opts.serverUrl !== undefined) {
    if (registration.skipped.length === 0 && !inspectMemberHarness(installer, manifest, mycoHome, scan).current) throw new Error(`${manifest.displayName}'s capture configuration is still incomplete`);
    installer.recordMemberProvision(readProvisionRecord(mycoHome)?.version ?? getPluginVersion());
    if (installed.hooks && manifest.registration?.memberHookTrustAction) holdHookTrust(mycoHome, agent, manifest.registration.memberHookTrustAction);
  }
  const stale = installer.staleRegistrationMessages(scan);
  const written = [installed.hooks ? surface : null, installed.mcp ? 'tools' : null, skillsMoved ? 'skills' : null, installed.settings ? 'settings' : null].filter((value): value is string => value !== null);
  const changed = written.length > 0;
  const detail = changed ? `provisioned ${manifest.displayName} globally (${written.join(', ')})` : `no global registration changes for ${manifest.displayName}`;
  return { kind: changed ? 'provisioned' : 'unchanged', detail: [detail, ...stale].join('\n'), skills, hooksChanged: installed.hooks, captureReady: registration.hooks !== null, written, stale };
}

/**
 * What provisioning one agent globally would find, without writing
 * (`SymbiontInstaller.globalOwnership`): whether 2.0 captures the agent at
 * all, the refusal provisioning would raise, the 1.4 homes it would replace,
 * and every file it may write.
 */
export type OwnershipPreview =
  | { kind: 'unknown' }
  | { kind: 'uncaptured'; displayName: string }
  | { kind: 'refused'; displayName: string; detail: string }
  | { kind: 'ready'; displayName: string; replaces: string[]; targets: ReturnType<SymbiontInstaller['memberGlobalTargets']> };

export function previewGlobalProvision(
  agent: string, root: string | null, mycoHome: string, serverUrl: string, opts: { packageRoot?: string; legacyHomes?: readonly string[]; preserveOtherMemberTools?: boolean } = {},
): OwnershipPreview {
  const manifest = loadManifests().find((m) => m.name === agent);
  if (!manifest) return { kind: 'unknown' };
  const installer = globalInstaller(manifest, root, mycoHome, opts);
  if (!opts.legacyHomes?.length) installer.takingOverManagedEntries();
  if (!installer.capturesAsMember()) return { kind: 'uncaptured', displayName: manifest.displayName };
  if (opts.preserveOtherMemberTools) installer.preservingOtherMemberTools();
  const scan = installer.scanMemberRegistrations();
  const found = installer.globalOwnership(serverUrl, scan);
  return found.problem !== null
    ? { kind: 'refused', displayName: manifest.displayName, detail: found.problem }
    : { kind: 'ready', displayName: manifest.displayName, replaces: found.replaces, targets: installer.memberGlobalTargets(scan) };
}

/** What provisioning every agent found on this machine came to: the agents set up, those already current, and those left alone with the reason. */
export interface DetectedProvision {
  provisioned: string[];
  unchanged: string[];
  toolsElsewhere?: string[];
  notices?: string[];
  partial?: string[];
  skipped: Array<{ agent: string; displayName: string; reason: string }>;
  /** Skill folders where another installation, or the person, holds a skill's place. */
  heldSkills: Array<{ folder: string; names: string[] }>;
}

/**
 * Provision every agent installed on this machine (`detectMachineInstalledSymbionts`, the detection the cutover uses)
 * for the member's Deployment `serverUrl`. Each goes through the cutover's own preview first, so an agent whose entries
 * belong to another installation is skipped with the reason and nothing of it is written; an agent Myco does not
 * capture as a member is skipped too. `root` is the connected folder, or null for a member with none connected yet:
 * then provisioning is global alone, with no project root to check or retire registrations in.
 */
export function provisionDetectedAgents(
  mycoHome: string, serverUrl: string, root: string | null, opts: { packageRoot?: string; agents?: () => string[]; preserveOtherMemberTools?: boolean; timeoutMs?: number; cwd?: string } = {},
): DetectedProvision {
  return provisionAgents((opts.agents ?? (() => detectMachineInstalledSymbionts().map((m) => m.name)))(), mycoHome, serverUrl, root, opts);
}

/**
 * Provision `agents` as `provisionDetectedAgents` does; the installer records each successful global registration.
 */
export function provisionAgents(
  agents: readonly string[], mycoHome: string, serverUrl: string, root: string | null, opts: { packageRoot?: string; preserveOtherMemberTools?: boolean; timeoutMs?: number; cwd?: string } = {},
): DetectedProvision {
  const found = withMemberRepair(mycoHome, 'myco member provision', () => installMemberAgents(agents, mycoHome, serverUrl, root, opts), { wait: true, timeoutMs: opts.timeoutMs });
  withManagedMemberHarnesses(mycoHome, opts, () => {});
  if (opts.preserveOtherMemberTools && found.skipped.length === 0) keepCurrent(mycoHome, { packageRoot: opts.packageRoot });
  return found;
}

function installMemberAgents(
  agents: readonly string[], mycoHome: string, serverUrl: string, root: string | null, opts: { packageRoot?: string; preserveOtherMemberTools?: boolean },
): DetectedProvision {
  const found: DetectedProvision = { provisioned: [], unchanged: [], skipped: [], heldSkills: [] };
  const backup = provisionBackup(mycoHome);
  try {
  for (const agent of agents) {
    const preview = previewGlobalProvision(agent, root, mycoHome, serverUrl, { ...opts });
    if (preview.kind === 'unknown') continue;
    if (preview.kind === 'uncaptured') { found.skipped.push({ agent, displayName: preview.displayName, reason: 'Myco does not capture it as a member yet' }); continue; }
    if (preview.kind === 'refused') { found.skipped.push({ agent, displayName: preview.displayName, reason: preview.detail }); continue; }
    const current = opts.preserveOtherMemberTools && readProvisionRecord(mycoHome)?.agents.includes(agent)
      && memberHarnessCurrent(agent, mycoHome, serverUrl, opts);
    const outcome: ProvisionOutcome = current
      ? { kind: 'unchanged', detail: `no global registration changes for ${preview.displayName}` }
      : provisionGlobally(agent, root, mycoHome, { ...opts, serverUrl, backup });
    if (outcome.kind === 'refused') { found.skipped.push({ agent, displayName: preview.displayName, reason: outcome.detail }); continue; }
    if (outcome.kind === 'unknown') continue;
    if (outcome.captureReady === false) {
      const surfaces = outcome.written ?? [];
      const words = surfaces.length > 1 ? `${surfaces.slice(0, -1).join(', ')} and ${surfaces.at(-1)}` : surfaces[0];
      if (words) (found.partial ??= []).push(`${words[0].toUpperCase()}${words.slice(1)} are set up for ${preview.displayName}.`);
      (found.partial ??= []).push(`Capture is not set up for ${preview.displayName}.`, ...outcome.stale ?? []);
    }
    else {
      (outcome.kind === 'provisioned' ? found.provisioned : found.unchanged).push(preview.displayName);
      (found.notices ??= []).push(...outcome.stale ?? []);
    }
    if (opts.preserveOtherMemberTools) {
      const status = memberHarnessStatus(agent, mycoHome, serverUrl, opts);
      if (status.toolsDeployment !== undefined) (found.toolsElsewhere ??= []).push(harnessToolsElsewhere(preview.displayName, hostname(), status.toolsDeployment));
    }
    const held = outcome.skills?.held ?? [];
    if (held.length > 0 && !found.heldSkills.some((h) => h.folder === outcome.skills!.folder)) found.heldSkills.push({ folder: outcome.skills!.folder, names: held.map((h) => h.name) });
  }
  } finally { backup.pruneUnchanged(); }
  return found;
}

/** Where one provisioning keeps copies of the agent files it changes: `<home>/backups/member-provision-<instant>/`. */
export function provisionBackup(mycoHome: string): CutoverBackup {
  const root = path.join(mycoHome, 'backups');
  const limit = 10;
  if (fs.existsSync(root)) {
    const folders = fs.readdirSync(root).filter((name) => name.startsWith('member-provision-')).sort();
    for (const name of folders.slice(0, Math.max(0, folders.length - limit + 1))) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
  return new CutoverBackup(path.join(root, `member-provision-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`), 'provision');
}

/**
 * Record that the person set up no agent (`--no-agents`), where nothing was recorded before, so a later refresh sets up
 * none on its own. A record of agents set up before is kept as it is.
 */
export function recordNoAgents(mycoHome: string, serverUrl: string): void {
  if (readProvisionRecord(mycoHome) === null) recordProvision(mycoHome, { version: getPluginVersion(), serverUrl, agents: [], discoverAgents: false }, { replace: true });
}

/** Explicit claim unions this home's choices with the prior owner's; absent prior choices use detected managed entries. */
export function claimMemberAgents(mycoHome: string, previousOwner?: string): void {
  withMemberRepair(mycoHome, 'myco update --claim', () => {
    const serverUrl = memberProvisionTarget(mycoHome);
    if (serverUrl === undefined) throw new Error('No unambiguous joined Deployment is available for agent setup; run myco member provision --server <url>.');
    const previous = previousOwner === undefined ? null : readProvisionRecord(previousOwner);
    const scan = scanLegacyRegistrations({ homeDir: process.env.HOME ?? path.dirname(defaultMycoHome()), legacyHomes: [], ownHome: mycoHome, allClaudeProjects: true });
    if (scan.unreadable.length > 0) throw new Error(`Could not inspect agent setup: ${scan.unreadable.map(entry => `${entry.file}: ${entry.reason}`).join('; ')}`);
    const managed = new Set(scan.findings.filter(finding => findingOwnedBinary(finding) !== undefined).map(finding => finding.location.agent));
    const inherited = previous?.agents.length ? previous.agents : detectMachineInstalledSymbionts().filter(manifest => managed.has(manifest.name)).map(manifest => manifest.name);
    recordProvision(mycoHome, { version: getPluginVersion(), serverUrl, agents: inherited, discoverAgents: true });
  }, { wait: true });
}

/** The lines a sign-in or a provisioning reports for `found`: what was set up, and each agent left alone with why. */
export function detectedProvisionLines(found: DetectedProvision): string[] {
  const ready = [...found.provisioned, ...found.unchanged];
  const lines: string[] = [];
  if (ready.length > 0) lines.push(`Capture is set up for ${ready.join(', ')}.`);
  lines.push(...found.partial ?? [], ...found.notices ?? [], ...found.toolsElsewhere ?? []);
  for (const skip of found.skipped) lines.push(`Skipped ${skip.displayName}: ${skip.reason.replace(/[.]+$/, '')}.`);
  for (const held of found.heldSkills) lines.push(`Left ${held.names.join(', ')} in ${held.folder} as they are: another installation or you put them there.`);
  if (ready.length === 0 && found.skipped.length === 0 && !found.partial?.length) lines.push('No supported agent is installed on this machine; once one is, run `myco member provision`.');
  return lines;
}

/**
 * `myco member provision [<agent>] [--root <dir>] [--server <url>]`: install an agent's hooks and MCP entry globally
 * from the recorded membership, or every agent installed on this machine when none is named. A connected folder's
 * binding names the Deployment; a member with no folder connected yet provisions for its one Deployment, or the one
 * `--server` names. No token is supplied or changed.
 */
export function runProvision(args: readonly string[], deps: MemberCliDeps = {}, refreshed?: (result: KeepCurrentResult | null, mycoHome: string) => void): boolean {
  const out = deps.stdout ?? ((l) => process.stdout.write(`${l}\n`));
  const err = deps.stderr ?? ((l) => process.stderr.write(`${l}\n`));
  const fail = (line: string): false => { err(`myco member provision: ${line}`); process.exitCode = 2; return false; };
  let agent: string | undefined;
  let rootArg: string | undefined;
  let serverArg: string | undefined;
  let refresh = false;
  let remove = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--refresh') refresh = true;
    else if (arg === '--remove') remove = true;
    else if (arg === '--root' || arg === '--server') {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) return fail(`${arg} needs a value`);
      if (arg === '--root') rootArg = value; else serverArg = value;
    } else if (arg.startsWith('-')) return fail(`unknown option ${arg.split('=')[0]}`);
    else if (agent === undefined) agent = arg;
    else return fail('provision takes one agent');
  }
  const invocationFolder = path.resolve(rootArg ?? deps.cwd ?? process.cwd());
  const root = resolveMemberProjectRoot(invocationFolder);
  const chosen = homeChoiceFor(deps, invocationFolder);
  const mycoHome = chosen.home;
  if (refresh) {
    if (remove) return fail('--refresh and --remove cannot be combined');
    if (agent !== undefined) return fail('--refresh sets up again the agents set up before; it takes no agent');
    const checked = withMemberRepair(mycoHome, 'myco member provision --refresh', () => {
      const record = readProvisionRecord(mycoHome);
      if (record === null) {
        const serverUrl = memberProvisionTarget(mycoHome, serverArg);
        if (serverUrl === undefined && serverArg === undefined) {
          const memberships = listDeploymentMemberships(mycoHome);
          if (memberships.length > 1) return fail(`this machine is a member of ${memberships.length} Deployments; name one with --server (${memberships.map(m => deploymentUrl(m.serverUrl)).join(', ')})`);
        }
        const agents = serverUrl === undefined ? [] : managedMemberHarnesses(mycoHome, serverUrl, deps);
        if (agents.length === 0) {
          out('Myco has not set up your agents on this machine; run `myco member provision` to set them up.');
          if (serverUrl !== undefined) recordNoAgents(mycoHome, serverUrl);
          return 'finished' as const;
        }
      }
      return 'repair' as const;
    }, { wait: true });
    if (checked !== 'repair' && checked !== 'finished') return false;
    const repaired = keepCurrent(mycoHome, { packageRoot: deps.packageRoot, serverUrl: serverArg, wait: true });
    if (checked === 'finished') return true;
    refreshed?.(repaired, mycoHome);
    if (repaired !== null) {
      if (repaired.harnesses.length === 0) out('No agent is set up for Myco on this machine; `myco member provision` sets them up.');
      if (repaired.ready.length > 0) out(`Capture is set up for ${repaired.ready.join(', ')}.`);
      for (const notice of repaired.notices ?? []) out(notice);
      for (const harness of repaired.harnesses) if (harness.action !== undefined) out(repaired.localActions?.[harness.id] ?? harness.action);
      if (repaired.harnesses.some(harness => ['repair_failed', 'unwritable'].includes(harness.state))) {
        process.exitCode = 1;
        return false;
      }
    }
    return true;
  }
  if (remove) {
    if (agent === undefined) return fail('--remove needs a harness');
    const manifest = loadManifests().find((candidate) => candidate.name === agent);
    if (manifest === undefined) return fail(`unknown agent "${agent}"`);
    const installer = globalInstaller(manifest, null, mycoHome, deps);
    const recordedServer = readProvisionRecord(mycoHome)?.serverUrl ?? selectedDeploymentMembership(mycoHome)?.serverUrl;
    if (recordedServer !== undefined) installer.forDeployment(recordedServer);
    try {
      withMemberRepair(mycoHome, 'myco member provision --remove', () => {
        installer.uninstallMemberRegistration();
        forgetProvision(mycoHome, agent);
      }, { wait: true });
    } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
    out(`Removed Myco's hooks and MCP entry for ${manifest.displayName}.`);
    return true;
  }
  const binding = isSafeProjectRoot(root) ? readRegistryEntry(root, mycoHome) : null;
  if (binding === null && listDeploymentMemberships(mycoHome).length === 0) {
    const pinnedRefusal = pinnedHomeRefusal(chosen, root, 'membership');
    if (pinnedRefusal !== null) return fail(pinnedRefusal);
  }
  if (binding === null && serverArg === undefined && pinnedElsewhere(chosen, deps.env)) {
    return fail(pinnedElsewhereRefusal(chosen, root, listDeploymentMemberships(mycoHome).map((m) => deploymentUrl(m.serverUrl))));
  }
  const pinnedLine = pinnedHomeLine(chosen, root);
  if (pinnedLine !== null) out(pinnedLine);
  if (rootArg !== undefined && binding === null) return fail(`no membership recorded for ${root} — run \`myco member join\` there first`);
  let serverUrl = binding?.serverUrl;
  if (serverUrl === undefined) {
    const memberships = listDeploymentMemberships(mycoHome);
    const selected = selectedDeploymentMembership(mycoHome, serverArg);
    const named = selected === null ? [] : [selected];
    if (serverArg === undefined && named.length === 0 && memberships.length > 1) return fail(`this machine is a member of ${memberships.length} Deployments; name one with --server (${memberships.map((m) => deploymentUrl(m.serverUrl)).join(', ')})`);
    if (serverArg === undefined && named.length === 0 && memberships.length === 1) return fail(`no default Deployment is recorded; name ${deploymentUrl(memberships[0].serverUrl)} with --server`);
    if (named.length === 0) return fail(serverArg === undefined ? 'no membership recorded on this machine — sign in with `myco login <address>` first' : `no membership recorded for ${serverArg}`);
    serverUrl = named[0].serverUrl;
  }
  const folder = binding === null ? null : root;
  if (agent === undefined) {
    const found = provisionDetectedAgents(mycoHome, serverUrl, folder, { packageRoot: deps.packageRoot, agents: deps.agents, cwd: invocationFolder });
    for (const line of detectedProvisionLines(found)) out(line);
    return true;
  }
  const outcome = provisionChosenAgent(agent, folder, mycoHome, { packageRoot: deps.packageRoot, serverUrl, cwd: invocationFolder });
  if (outcome.kind === 'unknown') return fail(`unknown agent "${agent}"`);
  if (outcome.kind === 'refused') return fail(outcome.detail);
  out(outcome.detail);
  const held = outcome.skills?.held ?? [];
  if (held.length > 0) out(`Left ${held.map((h) => h.name).join(', ')} in ${outcome.skills!.folder} as they are: another installation or you put them there.`);
  return true;
}

/**
 * Remove one member surface, reporting the removal or, when the agent's config
 * cannot be read, naming the file that was left as it is. The membership is
 * already forgotten by then, so the leave ends non-zero with a surface the
 * user can still find, rather than a silent survivor. Re-provisioning is not
 * offered here: there is no membership left to provision from.
 */
function relinquish(remove: () => boolean, removed: string, subject: string, out: (line: string) => void, err: (line: string) => void): void {
  try {
    if (remove()) out(removed);
  } catch (error) {
    if (!(error instanceof MemberProvisionConflictError)) throw error;
    const problem = error.problem;
    err(`myco member leave: ${problem}, so ${subject} was left in place. Fix the file, then remove its \`myco\` entry.`);
    process.exitCode = 2;
  }
}

/** Forget this project's membership. The spool survives unless `--purge` is given, which also strips the hooks provisioning wrote. */
export function runLeave(args: readonly string[], deps: MemberCliDeps = {}): boolean {
  const out = deps.stdout ?? ((l) => process.stdout.write(`${l}\n`));
  const err = deps.stderr ?? ((l) => process.stderr.write(`${l}\n`));
  const mycoHome = homeFor(deps);
  const root = resolveMemberProjectRoot(deps.cwd);
  const selected = readRegistryEntryResult(root, mycoHome);
  const entry = selected.status === 'present' ? selected.entry : null;
  if (!entry && selected.status === 'missing') {
    err(`myco member leave: no membership recorded for ${root}`);
    process.exitCode = 2;
    return false;
  }
  if (entry === null && args.includes('--purge')) {
    err('myco member leave: choose the repository connection with myco member join before purging its capture');
    process.exitCode = 2;
    return false;
  }
  // Leaving is an opt-out: auto-join leaves this repository alone until it is joined or connected again.
  void optOut(root, entry ? readDeploymentMembership(entry.serverUrl, mycoHome) : null, { mycoHome, now: (deps.now ?? Date.now)(), fetch: deps.fetch })
    .catch((error) => err(`myco member leave: could not report opt-out to ${deploymentUrl(entry?.serverUrl ?? 'Myco')} (${(error as Error).message})`));
  removeRegistryEntry(root, mycoHome);
  for (const manifest of loadManifests()) {
    relinquish(() => globalInstaller(manifest, null, mycoHome, deps).reconcileMemberProjectMcp(),
      `updated ${manifest.displayName}'s private Myco tools entries`, `${manifest.displayName}'s private Myco tools`, out, err);
  }
  clearMissingMembership(root, mycoHome);
  out(`left ${entry?.projectId ?? 'repository connections'} for ${root}; auto-join leaves it alone until you join it again`);
  // The pin points at a home that no longer holds this project. Left standing it
  // would send every hook here to look for a membership that is gone, and each
  // one would count another miss.
  if (unpinProjectHome(root, mycoHome)) out(`removed this project's ${RUNTIME_HOME_FILENAME} pin`);
  if (entry === null) {
    out('spools kept for the unresolved connections; re-join the intended Project before draining capture');
    return true;
  }
  if (!args.includes('--purge')) {
    const depth = new MemberSpool(entry, { mycoHome }).sessionIds().length;
    out(`spool kept: ${depth} session file(s) — \`myco member drain\` after re-joining, or \`myco member leave --purge\` to discard`);
    return true;
  }
  fs.rmSync(new MemberSpool(entry, { mycoHome }).dir, { recursive: true, force: true });
  out('spool discarded');
  if (clearJoinRefusals(mycoHome)) out('recorded join refusals cleared: a join code is presented again');
  return true;
}

function readStdin(deps: MemberCliDeps): string {
  if (deps.stdin) return deps.stdin();
  try {
    return fs.readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

export async function runDrain(args: readonly string[], deps: MemberCliDeps = {}): Promise<DrainResult[]> {
  const out = deps.stdout ?? ((l) => process.stdout.write(`${l}\n`));
  const now = deps.now ?? Date.now;
  const mycoHome = homeFor(deps);
  const results: DrainResult[] = [];
  const signIn = deps.signInCapture;
  let entries: RegistryEntry[];
  const serverAt = args.indexOf('--server');
  const projectAt = args.indexOf('--project');
  if (serverAt >= 0 || projectAt >= 0 || args.includes('--assign-legacy') || args.includes('--assign-pending')) {
    const serverUrl = serverAt < 0 ? undefined : args[serverAt + 1];
    const projectId = projectAt < 0 ? undefined : args[projectAt + 1];
    if (serverUrl === undefined || projectId === undefined || !isProjectId(projectId) || serverUrl.startsWith('--')) {
      (deps.stderr ?? console.error)('myco member drain: name both --server <url> and --project <id>');
      process.exitCode = 2;
      return [];
    }
    const entry = routingEntry({ serverUrl, projectId }, mycoHome);
    if (entry === null) {
      (deps.stderr ?? console.error)('myco member drain: this home holds no membership for the named Deployment');
      process.exitCode = 2;
      return [];
    }
    if (args.includes('--assign-legacy')) {
      const assignment = assignLegacySpoolDestination(entry, mycoHome);
      out(`legacy ${projectId}: ${assignment.status} to ${deploymentUrl(serverUrl)} — ${assignment.records} record(s) in ${assignment.sessions} session(s)${assignment.reason ? ` (${assignment.reason})` : ''}`);
      if (assignment.status === 'held') { process.exitCode = 2; return []; }
    }
    if (args.includes('--assign-pending')) {
      const rootAt = args.indexOf('--root-key');
      const rootKey = rootAt < 0 ? undefined : args[rootAt + 1];
      if (rootKey === undefined || !/^[0-9a-f]{16,64}$/.test(rootKey)) {
        (deps.stderr ?? console.error)('myco member drain: name --root-key <key> for the held pending capture');
        process.exitCode = 2;
        return [];
      }
      assignLegacyPending(rootKey, entry, { mycoHome, now: now() });
      const copied = flushPending(rootKey, new MemberSpool(entry, { mycoHome }), { mycoHome, now: now() });
      out(`legacy pending ${rootKey}: assigned to ${deploymentUrl(serverUrl)}/${projectId} — ${copied} record(s) moved`);
    }
    entries = [entry];
  } else entries = signIn === undefined ? entriesFor(args, deps)
    : listRoutingEntries(mycoHome, undefined, signIn);
  const drain = async (fetch: FetchLike | undefined, budget?: HookBudget): Promise<DrainResult[]> => {
    for (const entry of entries) {
      if (budget !== undefined && now() >= budget.deadline) {
        out('Some capture is still waiting; myco member drain retries it.');
        break;
      }
      const backlog = await drainEntryBacklog(entry, { mycoHome, fetch, now, budget });
      for (const line of backlogLines(entry.projectId, backlog)) out(line);
      if (deps.signInCapture !== undefined && backlog.endedBy !== 'done') out('Some capture is still waiting; myco member drain retries it.');
      // Retention follows the drain so acknowledged archive copies can be removed.
      const retention = applySpoolRetention(new MemberSpool(entry, { mycoHome }), now());
      if (retention.releasedBlobs > 0) out(`${entry.projectId}: released ${retention.releasedBlobs} staged file(s)`);
      results.push(...backlog.sessions.flatMap((s) => (s.events ? [s.events] : [])));
    }
    return results;
  };
  return deps.signInCapture === undefined || entries.length === 0 ? drain(deps.fetch)
    : withSignInCapture({ fetch: deps.fetch, now, stdout: out }, ({ fetch, budget }) => drain(fetch, budget));
}

/** One line per session a backlog walk reached, and one for a walk that reached none. */
export function backlogLines(projectId: string, backlog: BacklogReport): string[] {
  if (backlog.sessions.length === 0) return [`${projectId}: spool empty`];
  return backlog.sessions.map(({ sessionId, events: r, transcripts: t }) => {
    const parts: string[] = [];
    if (r) parts.push(`sent ${r.sent}, acked ${r.acked}, refused ${r.refused}, remaining ${r.remaining}${r.skipped ? ` (skipped: ${r.skipped})` : ''}${r.endedBy !== 'drained' ? ` — ended by ${r.endedBy}` : ''}`);
    if (t !== undefined) parts.push(typeof t === 'string' ? `transcript ${t === 'lease' ? 'held by another process' : t === 'deferred' ? 'waiting after a refusal' : 'names no symbiont; left undelivered'}` : `transcript segments ${t.shipped}${t.endedBy !== 'done' ? ` — ended by ${t.endedBy}` : ''}`);
    return `${projectId} ${sessionId}: ${parts.join('; ')}`;
  });
}

/**
 * This machine's membership, in lines.
 *
 * The facts come from `projectDiagnostics`, which `export` also reads. The token
 * is shown redacted here; a report carries none at all.
 */
export function runStatus(args: readonly string[], deps: MemberCliDeps = {}): void {
  const out = deps.stdout ?? ((l) => process.stdout.write(`${l}\n`));
  const now = deps.now ?? Date.now;
  const err = deps.stderr ?? ((l: string) => process.stderr.write(`${l}\n`));
  const mycoHome = homeFor(deps);
  if (args.some(arg => arg !== '--all') || args.length > 1) {
    err('usage: myco member status [--all]');
    process.exitCode = 2;
    return;
  }
  const selection = registrySelection(args, deps);
  out(formatCheck(checkInstallation(mycoHome)));
  out(formatCheck(checkAutomaticUpdate(mycoHome)));
  for (const entry of selection.entries) {
    const facts = projectDiagnostics(entry, mycoHome, now());
    const { membership, spool, latch, refusals } = facts;
    out(`project:    ${membership.projectId}`);
    out(`root:       ${(entry.displayRoot ?? membership.root) || 'no repository currently bound'}`);
    out(`server:     ${membership.serverUrl ?? 'unknown'}`);
    for (const check of projectMcpChecks(entry, mycoHome, deps, selection.all)) out(formatCheck(check));
    out(`token:      ${redact(entry.token)}${membership.tokenId ? ` (${membership.tokenId})` : ''}`);
    out(`expires:    ${membership.unavailableFields.includes('expiresAt') ? 'unknown' : `${when(membership.expiresAt ?? undefined)}${membership.expired === true ? ' (EXPIRED)' : ''}`}`);
    out(`refresh:    ${membership.refreshTerminal === null ? 'unknown'
      : membership.refreshTerminal ? `unavailable — ${REJOIN_HINT}`
      : membership.unavailableFields.includes('refreshAfter') ? 'unknown'
      : membership.refreshAfter === null ? 'not yet announced' : `after ${when(membership.refreshAfter)}`}`);
    out(`machine:    ${membership.machineId}`);
    out(`joined:     ${membership.joinedAt === null ? 'unknown' : when(membership.joinedAt)}`);
    if (membership.unavailableFields.length > 0) out(`membership: unknown ${membership.unavailableFields.join(', ')}`);
    for (const session of spool.sessions) out(`spool:      ${session.sessionId} — ${session.unacknowledged ?? 'unknown'} un-acknowledged`);
    out(`spool:      ${spool.readable ? spool.sessionFiles : 'unknown'} session file(s), ${spool.unacknowledgedTotal ?? 'unknown'} un-acknowledged event(s)`);
    // Anything the Deployment acknowledged: an event, a blob, a transcript segment. A recall answer stamps nothing.
    out(`last delivery: ${!spool.stateReadable ? 'unknown — state could not be read' : spool.lastDeliveryAt === null ? 'none acknowledged yet' : `acknowledged ${when(spool.lastDeliveryAt)}`}`);
    out(`lost:       ${facts.captureLoss.readable ? `${facts.captureLoss.payloads} payload(s), ${facts.captureLoss.plans} plan(s), ${facts.captureLoss.records} record(s)` : 'unknown — loss counts could not be read'}`);
    const last = refusals.entries[refusals.entries.length - 1];
    const damaged = refusals.unreadableLines > 0 ? `, ${refusals.unreadableLines} unreadable` : '';
    out(`refused:    ${refusals.logReadable ? `${refusals.loggedSinceLastReset} logged${damaged}${last ? `; last ${last.kind ?? 'unknown kind'} ${last.eventId ?? 'unknown event'} (${last.code ?? 'code not recognised'}${last.held ? ', kept spooled' : ''}) at ${last.at === null ? 'unknown' : when(last.at)}` : ''}` : 'the log could not be read'}`);
    out(`latch:      ${!facts.latchReadable ? 'unknown — latch could not be read' : latch ? `offline since ${when(latch.since)}, next probe ${when(latch.nextProbeAt)} (backoff ${latch.backoffMs} ms)` : 'online'}`);
    out(`worker:     ${workerServiceWords(describeWorkerService(entry.serverUrl, { ...deps.worker, mycoHome })).line}`);
  }
  for (const conflict of selection.conflicts ?? []) out(registryConflictWords(conflict));
  for (const held of selection.heldDestinations) out(`buffered destination: ${held.key} — ${held.reason}; capture held locally`);
  if (selection.all) {
    if (!selection.readable) err('myco member: the registry directory could not be read');
    else if (selection.unavailableEntries > 0) {
      out(`registry:   ${selection.unavailableEntries} ${selection.unavailableEntries === 1 ? 'entry' : 'entries'} could not be read`);
    }
  } else if (selection.root === null) err('myco member: this directory belongs to no project');
  else if (selection.conflicts?.length) { /* the conflicting connections are reported above */ }
  else if (!selection.readable) err(`myco member: the registry entry for ${selection.root} could not be read`);
  else if (selection.entries.length === 0) {
    err(`myco member: no registry entry for ${selection.root} — run \`myco member join\``);
  }
  reportMissedCapture(out, selection, deps);
  reportRefusedHooks(out, deps);
  reportAutoJoin(out, selection, deps);
}

/** Read each recorded presentation folder against the same canonical project binding. */
function projectMcpChecks(entry: RegistryEntry, mycoHome: string, deps: MemberCliDeps, all: boolean): DoctorCheck[] {
  if (entry.root.length === 0) return [];
  const folders = new Set([entry.displayRoot ?? entry.root]);
  const refused: DoctorCheck[] = [];
  if (all) for (const manifest of loadManifests()) {
    const scopes = globalInstaller(manifest, null, mycoHome, deps).memberMcpProjectFolders();
    if (scopes.status === 'unreadable') {
      refused.push({ name: 'Member MCP folders', status: 'warn', reason: 'mcp_target_unreadable', symbiont: manifest.name,
        scope: 'global', fixable: false, detail: `${manifest.displayName}'s project scopes could not be read: ${scopes.detail}` });
      continue;
    }
    for (const folder of scopes.folders) {
      if (canonicalRootIdentity(resolveMemberProjectRoot(folder)) === canonicalRootIdentity(entry.root)) folders.add(folder);
    }
  }
  const selected = all ? [...folders] : [deps.cwd ?? entry.displayRoot ?? entry.root];
  return [...refused, ...selected.flatMap(folder => checkMemberMcpResolution(path.join(entry.root, '.myco'), deps.env ?? process.env, { registryRead: 'strict', folder, mycoHome }))];
}

/** The hooks on this machine their own command refused (`member/refused-hooks.ts`): a count each, machine-wide. */
function reportRefusedHooks(out: (line: string) => void, deps: MemberCliDeps): void {
  const mycoHome = homeFor(deps);
  const now = (deps.now ?? Date.now)();
  for (const kind of REFUSED_HOOK_KINDS) {
    const record = readRefusedHook(kind, mycoHome, now);
    if (record === null) continue;
    out(`refused hook: ${refusedHookWords(record)}`);
    out(`            first ${when(record.firstAt)}, last ${when(record.lastAt)}${record.lastHook ? ` (hook ${record.lastHook})` : ''}; \`myco member provision\` rewrites the hooks it installed`);
  }
}

/**
 * Where auto-join stands (#1547): the Deployment new repositories join, the repositories that did not join and why,
 * and the capture held for repositories still joining, with when it is discarded: every repository with `--all`, and
 * this one alone without it.
 */
function reportAutoJoin(out: (line: string) => void, selection: { root: string | null; all: boolean }, deps: MemberCliDeps): void {
  const mycoHome = homeFor(deps);
  const now = (deps.now ?? Date.now)();
  for (const issue of autoJoinIdentityIssues(mycoHome)) out(issue.message);
  for (const legacy of listLegacySpools(mycoHome)) {
    out(`legacy capture: ${legacy.projectId} — ${legacy.records} event(s) in ${legacy.sessions} session(s); ${legacy.destination?.serverUrl ?? 'destination ambiguous'}; ${legacy.reason ?? 'retained locally with migration receipts'}`);
  }
  const held = readDefaultDeployment(mycoHome);
  out(`default:    ${held === null ? 'none — `myco login` records the Deployment new repositories join' : `${held.serverUrl} (new repositories join it)`}`);
  const mine = (root: string): boolean => selection.all || (selection.root !== null && canonicalRootIdentity(root) === canonicalRootIdentity(selection.root));
  for (const state of listAutoJoinStates(mycoHome).filter((s) => s.outcome !== 'joined' && mine(s.root))) {
    const why = state.outcome === 'outside_folders' ? 'outside the folders this machine captures'
      : state.outcome === 'unreachable' ? `the Deployment could not be reached (${state.detail ?? 'no answer'}); tried again at the next hook`
      : `${state.reason ?? 'refused'}${state.detail ? ` — ${state.detail}` : ''}`;
    out(`not joined: ${state.root} — ${why} (last tried ${when(state.attemptAt)})`);
  }
  for (const pending of listPending({ mycoHome, now }).filter((p) => mine(p.root))) {
    out(`pending:    ${pending.root} (${pending.serverUrl ?? 'destination unassigned'}) — ${pending.records} event(s) in ${pending.sessions} session(s) waiting to join since ${when(pending.createdAt)}; ${pending.assignedTo ? `assigned copy retained for ${pending.assignedTo.serverUrl}/${pending.assignedTo.projectId}` : pending.serverUrl === undefined ? `held until explicitly assigned with --root-key ${pending.rootKey} or discarded` : `discarded after ${when(pending.createdAt + PENDING_TTL_MS)}`}`);
  }
  for (const end of listHeldEnds(mycoHome).filter((e) => mine(e.root))) {
    out(`held no more: ${end.root} (${end.serverUrl ?? 'destination unassigned'}) — ${end.held === 'full' ? `the ${PENDING_MAX_RECORDS} events kept for it were reached` : `capture older than ${PENDING_TTL_MS / 86_400_000} days was discarded`} (${when(end.at)})`);
  }
}

/** A safe Git project root, or null outside one. */
function projectRootOrNull(cwd?: string): string | null {
  try {
    const root = resolveMemberProjectRoot(cwd);
    return isSafeProjectRoot(root) ? root : null;
  } catch {
    return null;
  }
}

/** Export selected memberships and routing checks as one JSON document. */
export async function runExport(args: readonly string[], deps: MemberCliDeps = {}): Promise<void> {
  const out = deps.stdout ?? ((l) => process.stdout.write(`${l}\n`));
  const mycoHome = homeFor(deps);
  const { root, all, entries, heldDestinations, ...registry } = registrySelection(args, deps);
  const { records: missedCapture, ...missedCaptureStore } = missedCaptureSelection(root, all, deps);
  const { checkBinaryVersionSkew, checkRuntimePin, checkMemberMcpResolution } = await import('./doctor-member.js');
  const toFacts = (check: DoctorCheck, checkRoot: string | null = null) => ({
    name: check.name, status: check.status, reason: check.reason ?? null, symbiont: check.symbiont ?? null,
    scope: check.scope ?? null, root: check.root ?? (check.scope === 'global' ? null : checkRoot), fixable: check.fixable, fixId: check.fixId ?? null,
    ...(check.toolsDeployment === undefined ? {} : { toolsDeployment: check.toolsDeployment }),
    ...(check.projectId === undefined ? {} : { projectId: check.projectId }),
    ...(check.memberHome === undefined ? {} : { memberHome: check.memberHome, homeSource: check.homeSource }),
    ...(check.configPath === undefined ? {} : { configPath: check.configPath, context: check.context }),
    ...(check.folder === undefined ? {} : { folder: check.folder }),
  });
  const machineChecks = [checkBinaryVersionSkew(), await checkRuntimePin()]
    .filter((check): check is DoctorCheck => check !== null).map((check) => toFacts(check));
  const projectChecks = entries.map(entry => projectMcpChecks(entry, mycoHome, deps, all).map(check => toFacts(check, entry.root)));
  const checks = [...new Map([...machineChecks, ...projectChecks.flat()].map((check) => [JSON.stringify(check), check])).values()];
  out(JSON.stringify({ ...memberDiagnostics({
    mycoHome, now: (deps.now ?? Date.now)(), entries, missedCapture, heldDestinations,
    selection: { root, scope: all ? 'all' : 'root' }, registry, missedCaptureStore, checks,
  }), installation: readInstallation(mycoHome) }, null, 2));
}

/**
 * What the hooks that found no membership add up to.
 *
 * A hook that resolves no registry entry prints one line and exits 0, so the
 * loss leaves no trace in the harness. Status is where it becomes a number: a
 * project whose pin, home or join is wrong reads "N hook invocations found no
 * registry entry for <root>" instead of an empty report.
 */
function reportMissedCapture(out: (line: string) => void, selection: { root: string | null; all: boolean }, deps: MemberCliDeps): void {
  const mycoHome = homeFor(deps);
  // Status is one of the two moments that sweep the store (the other is `join`);
  // a hook counts its miss and gets out of the way.
  pruneMissingMemberships(mycoHome, (deps.now ?? Date.now)());
  const { records, readable, unavailableRecords } = missedCaptureSelection(selection.all ? null : missedCaptureRoot(deps), selection.all, deps);
  for (const record of records) {
    out(`unmembered: ${record.count} hook invocation(s) found no registry entry for ${record.root}`);
    out(`            first ${when(record.firstAt)}, last ${when(record.lastAt)}${record.lastInvokedBy ? ` (${record.lastInvokedBy})` : ''}`);
  }
  if (!readable) {
    out(`unmembered: unknown — ${selection.all ? 'the missed-capture store' : 'the record for this project'} could not be read`);
  } else if (unavailableRecords > 0) {
    out(`unmembered: ${unavailableRecords} record(s) could not be read`);
  }
}

/** What `pinProjectHome` did, so the caller can say it in the user's words. */
type PinOutcome =
  | { kind: 'written'; pinPath: string }
  | { kind: 'settled' }
  | { kind: 'conflict'; pinPath: string; pinned: string }
  | { kind: 'unwritable'; pinPath: string };

/**
 * Pin the project at the home this membership lives in, when that is not the
 * default one.
 *
 * The hooks a join provisions carry no environment — an agent launched from a
 * GUI inherits none — so the pin is the only thing that tells them which home
 * holds this project's membership. Nothing is written for the default home:
 * that is what an unpinned project already resolves.
 *
 * The pin names a machine-local absolute path. Git's clone-local exclude
 * file must ignore it before the pin is created.
 *
 * A trusted pin selecting another install is never overwritten. The caller
 * reports the conflict and preserves the operator's selected home.
 */
function pinProjectHome(root: string, mycoHome: string): PinOutcome {
  const pinPath = path.join(root, '.myco', RUNTIME_HOME_FILENAME);
  const home = path.resolve(mycoHome);
  const existing = readHomePin(pinPath);
  if (existing !== null && existing !== home) return { kind: 'conflict', pinPath, pinned: existing };
  if (existing === home || pathsEquivalentHome(home, defaultMycoHome())) return { kind: 'settled' };
  try {
    fs.mkdirSync(path.dirname(pinPath), { recursive: true });
    ensureGitIgnored(root, pinPath);
    createHomePin(pinPath, home);
    return { kind: 'written', pinPath };
  } catch {
    // A read-only checkout still holds the membership; only the pin is missing.
    return { kind: 'unwritable', pinPath };
  }
}

/**
 * What a join says about the pin. A conflict is reported and the exit status
 * is set: the membership IS recorded, but until the pin is settled this
 * project's agents capture into the home the pin names, not this one.
 */
function reportPin(outcome: PinOutcome, mycoHome: string, out: (l: string) => void, err: (l: string) => void): void {
  switch (outcome.kind) {
    case 'written':
      out(`pinned this project to ${path.resolve(mycoHome)}, so agents launched with no environment capture here`);
      return;
    case 'conflict':
      err(`myco member join: ${outcome.pinPath} already pins this project to ${outcome.pinned}; the membership is recorded, but agents here capture into ${outcome.pinned}`);
      err(`  keep that home: run \`MYCO_HOME=${outcome.pinned} myco member join\` instead`);
      err(`  move to this one: \`myco member leave --purge\` in the pinned home first`);
      process.exitCode = 2;
      return;
    case 'unwritable':
      err(`myco member join: could not write ${outcome.pinPath}; agents launched with no environment will not find this membership`);
      process.exitCode = 2;
      return;
    case 'settled':
  }
}

/** What `pinMachineHome` did. */
export type MachinePinOutcome = { kind: 'written'; pinPath: string } | { kind: 'settled' } | { kind: 'held'; pinPath: string; pinned: string } | { kind: 'unwritable'; pinPath: string };

/**
 * Pin the MACHINE at this membership's home, when the home is not the default
 * one and no machine pin exists.
 *
 * A harness that starts `myco mcp` outside the project — at `/`, at the user's
 * home — walks no project pin, and a GUI-launched one carries no environment,
 * so the machine pin (`~/.myco/runtime.home`, read after the project pin and
 * before the default) is the one thing left that names this home. Written
 * once: a machine pin naming another home is another install's choice and is
 * left standing, the way a project pin naming another home is.
 */
export function pinMachineHome(mycoHome: string, deps: Pick<MemberCliDeps, 'env'>): MachinePinOutcome {
  const home = path.resolve(mycoHome);
  const defaultHome = defaultMycoHome(deps.env?.HOME && deps.env.HOME.length > 0 ? deps.env.HOME : undefined);
  if (pathsEquivalentHome(home, defaultHome)) return { kind: 'settled' };
  const pinPath = path.join(defaultHome, RUNTIME_HOME_FILENAME);
  const existing = readHomePin(pinPath, { env: deps.env ?? process.env });
  if (existing === home) return { kind: 'settled' };
  if (existing !== null) return { kind: 'held', pinPath, pinned: existing };
  try {
    fs.mkdirSync(defaultHome, { recursive: true });
    createHomePin(pinPath, home);
    return { kind: 'written', pinPath };
  } catch {
    return { kind: 'unwritable', pinPath };
  }
}

function reportMachinePin(outcome: MachinePinOutcome, mycoHome: string, out: (l: string) => void): void {
  switch (outcome.kind) {
    case 'written':
      out(`pinned this machine to ${path.resolve(mycoHome)} (${outcome.pinPath}), so an MCP server started outside the project finds it`);
      return;
    case 'held':
      out(`this machine stays pinned to ${outcome.pinned} (${outcome.pinPath}); an MCP server started outside this project resolves that home`);
      return;
    case 'unwritable':
      out(`could not write ${outcome.pinPath}; an MCP server started outside this project resolves the default home`);
      return;
    case 'settled':
  }
}

/** Remove a pin this home wrote. A pin naming another home belongs to that one. */
function unpinProjectHome(root: string, mycoHome: string): boolean {
  const pinPath = path.join(root, '.myco', RUNTIME_HOME_FILENAME);
  if (readHomePin(pinPath) !== path.resolve(mycoHome)) return false;
  try {
    fs.rmSync(pinPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

const pathsEquivalentHome = (a: string, b: string): boolean => path.resolve(a) === path.resolve(b);

/** A pin is read by every launcher and must not be writable by anyone else. */
const PIN_FILE_MODE = 0o644;

/** Create an absent pin exclusively; contents and mode use the same open file. */
function createHomePin(pinPath: string, home: string): void {
  const file = fs.openSync(pinPath, 'wx', PIN_FILE_MODE);
  try {
    fs.writeFileSync(file, `${home}\n`);
    fs.fchmodSync(file, PIN_FILE_MODE);
  } finally {
    fs.closeSync(file);
  }
}

export async function runRefresh(args: readonly string[], deps: MemberCliDeps = {}): Promise<RefreshReport[]> {
  const out = deps.stdout ?? ((l) => process.stdout.write(`${l}\n`));
  const now = deps.now ?? Date.now;
  const reports: RefreshReport[] = [];
  for (const entry of entriesFor(args, deps)) {
    const report = await refreshMemberCredential(entry.root, { mycoHome: deps.mycoHome, fetch: deps.fetch, now, budget: unboundedBudget() });
    out(`${entry.projectId}: ${refreshLine(report)}`);
    reports.push(report);
  }
  return reports;
}

function refreshLine(report: RefreshReport): string {
  const entry = report.entry;
  switch (report.status) {
    case 'refreshed': return `rotated to ${report.tokenId ?? '—'}, expires ${when(entry?.expiresAt)}; the previous token works until this one is first used`;
    case 'not-due': return `not due — refresh window opens ${when(entry?.refreshAfter ?? (entry?.expiresAt === undefined ? undefined : entry.expiresAt - MEMBER_TOKEN_REFRESH_WINDOW_MS))}`;
    case 'too-early': return `the server is not ready to rotate yet — retry after ${when(entry?.refreshAfter)}`;
    case 'busy': return 'another myco process is rotating this token';
    case 'lineage-expired': return `this machine was inactive too long, or its credential ended — ${REJOIN_HINT}`;
    case 'unauthorized': return `the server refused this token — ${REJOIN_HINT}`;
    case 'terminal': return `the server refused to rotate this token — ${REJOIN_HINT}`;
    case 'route-missing': return 'this server does not rotate member tokens';
    case 'non-rotating': return `this credential does not rotate — it delivers until ${when(entry?.expiresAt)}; before then, ${REJOIN_HINT}`;
    case 'protocol': return 'the server refuses this build\'s member protocol — upgrade myco';
    case 'no-entry': return 'no registry entry';
    default: return 'the server could not be reached — try again later';
  }
}

/** What `link-github` prints once the Deployment has a linked admin: only an admin links a member's GitHub account from then on. */
export const LINK_REQUIRES_ADMIN_HINT = `this server already has an admin, so only an admin can link a GitHub account now — ask an admin to link yours in the dashboard's ${INVITE_CONTROLS.page} page`;

/** The URL a member opens to connect a GitHub account: the key rides the fragment, which never reaches the server or a log. */
export function linkUrl(serverUrl: string, key: string): string {
  return memberServerDialUrl(`${serverUrl.replace(/\/+$/, '')}/link#${key}`);
}

/**
 * Mint a one-time link for this root's membership and print the URL to open.
 * The key appears once, on stdout; the browser opener is used only on request,
 * as a child process argv is visible on the machine for a moment.
 */
export async function runLinkGithub(args: readonly string[], deps: MemberCliDeps = {}): Promise<string | null> {
  const out = deps.stdout ?? ((l) => process.stdout.write(`${l}\n`));
  const err = deps.stderr ?? ((l) => process.stderr.write(`${l}\n`));
  const fail = (line: string): null => { err(`myco member link-github: ${line}`); process.exitCode = 2; return null; };
  let root: string | undefined;
  let open = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--open') open = true;
    else if (arg === '--root') { root = args[++i]; if (root === undefined || root.startsWith('--')) return fail('--root needs a value'); }
    else return fail(`unknown option ${arg.split('=')[0]}`);
  }
  const resolved = path.resolve(root ?? resolveMemberProjectRoot(deps.cwd));
  // Same rule as `join`: the named root is the directory that resolves the home.
  const mycoHome = homeFor(deps, resolved);
  const entry = readRegistryEntry(resolved, mycoHome);
  if (!entry) return fail(`no registry entry for ${resolved} — an env-sourced credential has none; run \`myco member join\` on this machine first`);
  const client = new ServerClient({ serverUrl: entry.serverUrl, token: entry.token, projectId: entry.projectId }, deps.fetch ?? globalThis.fetch);
  const outcome = await client.linkGithub(unboundedBudget());
  switch (outcome.class) {
    case 'linked': {
      const url = linkUrl(entry.serverUrl, outcome.key);
      out(`Open this link within ${IDENTITY_LINK_TTL_MS / 60_000} minutes to connect your GitHub account to this membership:`);
      out(url);
      if (open) (deps.openBrowser ?? openBrowser)(url);
      return url;
    }
    case 'unauthorized': return fail(`the server refused this credential — ${REJOIN_HINT}`);
    case 'route_missing': return fail('this server does not link GitHub accounts');
    case 'protocol': return fail('the server refuses this build\'s member protocol — upgrade myco');
    case 'refused':
      if (outcome.code === 'link_requires_admin') return fail(LINK_REQUIRES_ADMIN_HINT);
      return fail(`the server refused: ${outcome.reason || outcome.code}`);
    case 'retry': return fail(`the server did not answer: ${outcome.detail}`);
  }
}

/**
 * Print the member headers for this directory's membership as one JSON object:
 * the headers helper a remote MCP entry names (Codex `http_headers_helper`).
 * The entry's URL was fixed when it was provisioned, so the helper names that
 * Deployment and prints nothing when the membership resolved now is on any
 * other — a rejoin elsewhere never hands the new Deployment's bearer to the
 * old URL. The host runs it when it connects and after a 401, so it reads the
 * registry each time and never rotates — the hooks' refresh path is the one writer.
 */
export function runMcpHeaders(args: readonly string[], deps: MemberCliDeps = {}): void {
  const out = deps.stdout ?? ((l) => process.stdout.write(`${l}\n`));
  const err = deps.stderr ?? ((l) => process.stderr.write(`${l}\n`));
  const fail = (line: string, code: number): void => { err(`myco member mcp-headers: ${line}`); process.exitCode = code; };
  const source = parseCredentialFlag(args);
  if (source === null) return fail(`pass ${CREDENTIAL_FLAG} ${CREDENTIAL_SOURCES.join('|')}`, 2);
  const serverIdx = args.indexOf(SERVER_FLAG);
  const expected = serverIdx >= 0 ? args[serverIdx + 1] : undefined;
  if (!expected || expected.startsWith('--')) return fail(`pass ${SERVER_FLAG} <server-url>, the Deployment this entry's URL names`, 2);
  if (source === 'registry') {
    const home = homeFor(deps);
    const binding = readRegistryEntryResult(resolveMemberProjectRoot(deps.cwd), home, { upgrade: true });
    if (binding.status === 'unavailable') return fail(binding.conflict ? registryConflictWords(binding.conflict) : 'the repository connection could not be read', 1);
    if (binding.status === 'missing') {
      const membership = readDeploymentMembership(expected, home);
      if (!membership || deploymentUrl(membership.serverUrl) !== deploymentUrl(expected) || !admitMemberServerUrl(membership.serverUrl) || !isMemberTokenShape(membership.token)) {
        return fail('no valid membership for the configured Deployment', 1);
      }
      out(JSON.stringify(deploymentScopedHeaders(membership)));
      return;
    }
  }
  const record = resolveCredential(source, { cwd: deps.cwd, env: deps.env, mycoHome: deps.mycoHome, invokedBy: 'mcp-headers' });
  if (record === null) {
    process.exitCode = 1;
    return;
  }
  if (deploymentUrl(record.serverUrl) !== deploymentUrl(expected)) {
    return fail(`this membership is on ${deploymentUrl(record.serverUrl)}, not ${deploymentUrl(expected)} — re-provision the agent's MCP entry`, 1);
  }
  out(JSON.stringify(memberHeaders(record)));
}

interface MemberCommandRegistration {
  hidden?: boolean;
  help: string;
  run: (rest: readonly string[], deps: MemberCliDeps) => Promise<void>;
}

const memberHelpCommand: MemberCommandRegistration = {
  hidden: true,
  help: '',
  run: async (_rest, deps) => { (deps.stdout ?? console.log)(MEMBER_HELP.trimEnd()); },
};

export const MEMBER_COMMANDS: Record<string, MemberCommandRegistration> = {
  '--help': memberHelpCommand,
  '-h': memberHelpCommand,
  'join': {
    help: `  join [--project <id|name> | --new [name]] [--root <dir>] [--no-agents] [<server-url>]
                     Connect the repository you are in to a project on the Deployment this machine is
                     signed in to (\`myco login\`): an existing one by id or name, or a new one (named
                     for the folder unless you name it). With neither, a terminal asks which. Your agents
                     are set up to capture there; --no-agents leaves them as they are.
  join <server-url> --project <id> (--token-stdin | --token-env <NAME>) [--root <dir>] [--provision <agent>]
                     Record this machine's membership of a project on a Myco server. The token is read
                     from stdin or from the named environment variable — never from the command line.
                     --provision installs the agent's hooks and MCP entry globally. Execution is a
                     separate opt-in through \`myco runner register <host>\` and \`myco runner install\`.`,
    run: async (rest, deps) => { await runJoin(rest, deps); },
  },
  'leave': {
    help: `  leave [--purge]    Forget this project's membership, and remove the surfaces that answer over it: any
                     member plugin (OpenCode, Pi) and the project's own Myco MCP entry, so those agents
                     fall back to what is installed for all your projects. Runner and legacy worker
                     services are kept. The spool is kept unless
                     --purge is given, which also removes the hooks this project was provisioned with.`,
    run: async (rest, deps) => { runLeave(rest, deps); },
  },
  'routing-key': {
    help: `  routing-key --credential registry|env [--root <dir>]
                     Print the transcript destination key for the selected project.`,
    run: async (rest, deps) => {
      const source = parseCredentialFlag(rest);
      if (source === null) { (deps.stderr ?? console.error)('myco member routing-key: declare --credential registry|env'); process.exitCode = 2; return; }
      const rootAt = rest.indexOf('--root');
      const cwd = rootAt >= 0 ? rest[rootAt + 1] : deps.cwd ?? process.cwd();
      if (cwd === undefined) { process.exitCode = 2; return; }
      try { (deps.stdout ?? console.log)(memberTranscriptRoutingKey(source, cwd, homeFor(deps, cwd), deps.env ?? process.env)); }
      catch (error) { (deps.stderr ?? console.error)(`myco member routing-key: ${(error as Error).message}`); process.exitCode = 1; }
      return;
    },
  },
  'drain': {
    help: `  drain [--all]      Deliver every spooled event for this project (or every joined project with --all);
                     no harness budget, the offline latch is ignored, retention is applied first.
  drain --assign-legacy --server <url> --project <id>
                     Assign held Project-only capture to the named destination, then migrate and drain it.
  drain --assign-pending --root-key <key> --server <url> --project <id>
                     Assign legacy pending capture to the named destination, then drain it.`,
    run: async (rest, deps) => { await runDrain(rest, deps); },
  },
  'helper': {
    help: `  helper --project <id> --server <url> --home <dir>
                     The project's helper: ships its spool in passes under the helper lock until nothing is
                     left, then exits (at most 120 s). Hooks start it detached; its log is
                     <home>/logs/helper.log (\`--stderr\` keeps it on stderr).`,
    run: async (rest, deps) => { await (await import('./member-helper.js')).runHelperVerb(rest, { fetch: deps.fetch, now: deps.now }); },
  },
  'status': {
    help: `  status [--all]     The registry entry (token redacted), expiry, spool depth per session,
                     last acknowledgement and refusal, the offline latch, any capture
                     attempts that found no membership, the default Deployment, and the
                     repositories that did not join or are still joining.`,
    run: async (rest, deps) => { runStatus(rest, deps); },
  },
  'export': {
    help: `  export [--all]     The same facts as status, as one JSON document, with the binary, runtime-pin
                     and MCP-resolution checks. Carries no token, no captured content and no
                     free-text detail; the document's omissions list names what is left out.`,
    run: async (rest, deps) => { await runExport(rest, deps); },
  },
  'refresh': {
    help: `  refresh [--all]    Rotate the member token when its refresh window is open. The predecessor keeps
                     working until the successor is first used; an env-sourced token is never rotated.`,
    run: async (rest, deps) => { await runRefresh(rest, deps); },
  },
  'link-github': {
    help: `  link-github [--root <dir>] [--open]
                     Connect your GitHub account to this membership for the dashboard: prints a one-time
                     link to open in a browser within ${IDENTITY_LINK_TTL_MS / 60_000} minutes. --open hands it to the browser as well.`,
    run: async (rest, deps) => { await runLinkGithub(rest, deps); },
  },
  'raw-claims': {
    help: `  raw-claims [--credential registry|env] [--server <url>] [--apply --revision <reviewed-revision>]
                     Preview raw data with no recorded uploader, by project, kind, count and date.
                     Only the recorded owner may claim it. Review the preview, then explicitly apply
                     its revision to make that data private to you. No captured content is printed.
                     Uses the recorded default Deployment or --server. Env needs only
                     MYCO_SERVER_URL and MYCO_MEMBER_TOKEN; neither command needs a Project.`,
    run: async (rest, deps) => { if (!await (await import('./member-raw-claims.js')).runRawClaims(rest, deps)) process.exitCode = 2; },
  },
  'ownership': {
    help: `  ownership [--credential registry|env] [--server <url>] [--owner <member-id> | --transfer <member-id>] [--revision <reviewed-revision>]
                     Preview this Deployment's recorded owner and eligible admins. Use --owner to
                     record an initial owner, or --transfer to name a new owner from the preview.`,
    run: async (rest, deps) => { if (!await (await import('./member-ownership.js')).runOwnership(rest, deps)) process.exitCode = 2; },
  },
  'role': {
    help: `  role [--credential registry|env] [--server <url>] [--member <member-id> --role admin|member --revision <reviewed-revision>]
                     Preview members and their role revisions. The owner can explicitly promote or
                     demote one member using the role revision from that preview.`,
    run: async (rest, deps) => { if (!await (await import('./member-role.js')).runRole(rest, deps)) process.exitCode = 2; },
  },
  'provision': {
    help: `  provision [<agent>] [--root <dir>] [--server <url>] [--refresh]
  provision --remove <agent>
                     Install the agent's hooks and MCP entry globally using the recorded membership, or
                     every agent installed on this machine when none is named. An agent whose entries
                     belong to another installation is left alone and named. --root selects the
                     membership, not the installation scope; --server picks the Deployment when this
                     machine is a member of several. --refresh repairs agent setup and checks the member token for renewal.`,
    run: async (rest, deps) => {
      let refresh: { result: KeepCurrentResult | null; home: string } | undefined;
      runProvision(rest, deps, (result, home) => { refresh = { result, home }; });
      if (refresh !== undefined) await reportHarnesses(refresh.result, refresh.home, (deps.now ?? Date.now)() + HARNESS_REPORT_WINDOW_MS, deps);
      return;
    },
  },
  'mcp-headers': {
    help: `  mcp-headers --credential registry|env --server <server-url>
                     Print this project's MCP request headers as JSON, for an agent that reaches the
                     server's MCP over HTTP and asks a command for its headers. Prints nothing unless
                     the membership is on <server-url>. Written by --provision.`,
    run: async (rest, deps) => { runMcpHeaders(rest, deps); },
  },
  'auto-join': {
    help: `  auto-join (--root <dir> | --sweep)
                     Join a repository with no connection to this machine's default Deployment, or
                     record why it cannot; --sweep does it for every repository met before. Your
                     agents' hooks start it on their own; \`status\` shows what it did.`,
    run: async (rest, deps) => { await (await import('./member-auto-join.js')).runAutoJoin(rest, deps); },
  },
};

export const MEMBER_HELP = `Usage: myco member <op> [options]

Ops:
${Object.values(MEMBER_COMMANDS).filter(command => !command.hidden).map(command => command.help).join('\n')}
`;

export async function run(args: readonly string[], deps: MemberCliDeps = {}): Promise<void> {
  const [op, ...rest] = args;
  const command = op !== undefined && Object.hasOwn(MEMBER_COMMANDS, op) ? MEMBER_COMMANDS[op] : undefined;
  if (command) return command.run(rest, deps);
  (deps.stderr ?? console.error)(MEMBER_HELP.trimEnd());
  process.exitCode = 2;
}
