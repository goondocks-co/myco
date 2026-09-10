/**
 * `myco member <op>` — the member's own CLI: `join`/`leave` record and forget
 * this machine's membership of a project (the token never reaches argv);
 * `drain [--all]` runs the one
 * drain implementation without a harness budget and ignoring the offline
 * latch; `status` shows the registry entry (token redacted), expiry, spool
 * depth, last acknowledgement and refusal, the latch, and how many capture
 * attempts found no membership at all.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getMachineId } from '../machine-id.js';
import { isSafeProjectRoot } from '../project-root.js';
import { RUNTIME_HOME_FILENAME, defaultMycoHome, readHomePin, resolveMycoHome } from '../paths/home.js';
import { unboundedBudget } from '../member/budget.js';
import { isProjectId, MEMBER_TOKEN_REFRESH_WINDOW_MS } from '../member/constants.js';
import { isHttpsUrl, isMemberTokenShape, resolveMemberProjectRoot } from '../member/credential.js';
import { refreshMemberCredential, type RefreshReport } from '../member/refresh.js';
import { runImport } from '../member/import.js';
import { clearMissingMembership, listMissingMemberships, pruneMissingMemberships, readMissingMembership } from '../member/no-membership.js';
import { listRegistryEntries, readRegistryEntry, removeRegistryEntry, writeRegistryEntry, REGISTRY_VERSION, type RegistryEntry } from '../member/registry.js';
import { applySpoolRetention, lastAckAt } from '../member/retention.js';
import { MemberSpool, type DrainResult } from '../member/spool.js';
import { ServerClient, type FetchLike } from '../member/transport.js';
import { openBrowser } from './open-browser.js';
import { loadManifests, resolvePackageRoot } from '../symbionts/detect.js';
import { SymbiontInstaller } from '../symbionts/installer.js';
import { ensureVaultGitignoreCurrent } from '../vault/gitignore.js';

export const MEMBER_HELP = `Usage: myco member <op> [options]

Ops:
  join <server-url> --project <id> (--token-stdin | --token-env <NAME>) [--root <dir>] [--provision <agent>]
                     Record this machine's membership of a project on a Myco server. The token is read
                     from stdin or from the named environment variable — never from the command line.
                     --provision writes the agent's hooks for this project.
  leave [--purge]    Forget this project's membership. The spool is kept unless --purge is given,
                     which also removes the hooks this project was provisioned with.
  drain [--all]      Deliver every spooled event for this project (or every joined project with --all);
                     no harness budget, the offline latch is ignored, retention is applied first.
  status [--all]     The registry entry (token redacted), expiry, spool depth per session,
                     last acknowledgement and refusal, the offline latch, and any capture
                     attempts that found no membership.
  refresh [--all]    Rotate the member token when its refresh window is open. The predecessor keeps
                     working until the successor is first used; an env-sourced token is never rotated.
  link-github [--root <dir>] [--open]
                     Connect your GitHub account to this membership for the dashboard: prints a one-time
                     link to open in a browser within ten minutes. --open hands it to the browser as well.
`;

export interface MemberCliDeps {
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
  /** Opens a URL in the browser for `link-github --open`; defaults to the platform opener. */
  openBrowser?: (url: string) => void;
}

const redact = (token: string): string => `${token.slice(0, 4)}…${token.slice(-4)}`;
const when = (ms: number | undefined): string => (ms === undefined ? '—' : new Date(ms).toISOString());

/**
 * The home every op reads, resolved from the directory the op is about: a
 * project pinned to a non-default home is addressed from inside it without
 * `MYCO_HOME`, exactly as its hooks are.
 */
const homeFor = (deps: MemberCliDeps, cwd?: string): string =>
  deps.mycoHome ?? resolveMycoHome({ cwd: cwd ?? deps.cwd ?? process.cwd() });

function entriesFor(args: readonly string[], deps: MemberCliDeps): RegistryEntry[] {
  const mycoHome = homeFor(deps);
  if (args.includes('--all')) return listRegistryEntries(mycoHome);
  const root = resolveMemberProjectRoot(deps.cwd);
  const entry = readRegistryEntry(root, mycoHome);
  if (!entry) {
    (deps.stderr ?? ((l) => process.stderr.write(`${l}\n`)))(`myco member: no registry entry for ${root} — run \`myco member join <server-url> --project <id>\``);
    return [];
  }
  return [entry];
}

/** The flags `join` understands. An unknown flag is refused: a token must never reach argv, and a typo must never look like a success. */
interface JoinArgs {
  serverUrl?: string;
  project?: string;
  tokenStdin: boolean;
  tokenEnv?: string;
  root?: string;
  provision?: string;
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
  if (!parsed.serverUrl || !parsed.project) { err(MEMBER_HELP.trimEnd()); process.exitCode = 2; return null; }
  if (!isHttpsUrl(parsed.serverUrl)) return fail(`${parsed.serverUrl} is not an https server URL`);
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
  writeRegistryEntry(entry, { mycoHome });
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

  if (parsed.provision) {
    const manifest = loadManifests().find((m) => m.name === parsed.provision);
    if (!manifest) return fail(`unknown agent "${parsed.provision}" — the membership is recorded; provision it with \`myco member join --provision <agent>\``);
    const installer = new SymbiontInstaller(manifest, root, deps.packageRoot ?? resolvePackageRoot(), false, undefined, null, 'member-project');
    const installed = installer.install();
    out(installed.hooks || installed.mcp
      ? `provisioned ${manifest.displayName} for ${root}${installed.mcp ? ' (hooks and MCP)' : ''}`
      : `no registration changes for ${manifest.displayName} at ${root}`);
  }

  // #1148: the machine's existing history for this project, once, bounded by
  // what the Deployment allows. A failure never fails the join — the membership
  // is recorded, and `myco import` fetches the history whenever it is wanted.
  const report = await runImport({ project: parsed.project, serverUrl: parsed.serverUrl }, {
    fetch: deps.fetch, now: deps.now, cwd: root, mycoHome, machineId: entry.machineId,
  }).catch(() => null);
  const imported = report?.projects.reduce((n, project) => n + project.agents.reduce((m, a) => m + a.imported, 0), 0) ?? 0;
  if (imported > 0) out(`imported ${imported} past sessions; run \`myco import\` to reach further back`);
  return entry;
}

/** Forget this project's membership. The spool survives unless `--purge` is given, which also strips the hooks provisioning wrote. */
export function runLeave(args: readonly string[], deps: MemberCliDeps = {}): boolean {
  const out = deps.stdout ?? ((l) => process.stdout.write(`${l}\n`));
  const err = deps.stderr ?? ((l) => process.stderr.write(`${l}\n`));
  const mycoHome = homeFor(deps);
  const root = resolveMemberProjectRoot(deps.cwd);
  const entry = readRegistryEntry(root, mycoHome);
  if (!entry) {
    err(`myco member leave: no membership recorded for ${root}`);
    process.exitCode = 2;
    return false;
  }
  removeRegistryEntry(root, mycoHome);
  clearMissingMembership(root, mycoHome);
  out(`left ${entry.projectId} for ${root}`);
  // The pin points at a home that no longer holds this project. Left standing it
  // would send every hook here to look for a membership that is gone, and each
  // one would count another miss.
  if (unpinProjectHome(root, mycoHome)) out(`removed this project's ${RUNTIME_HOME_FILENAME} pin`);
  if (!args.includes('--purge')) {
    const depth = new MemberSpool(entry.projectId, { mycoHome }).sessionIds().length;
    out(`spool kept: ${depth} session file(s) — \`myco member drain\` after re-joining, or \`myco member leave --purge\` to discard`);
    return true;
  }
  fs.rmSync(new MemberSpool(entry.projectId, { mycoHome }).dir, { recursive: true, force: true });
  out('spool discarded');
  for (const manifest of loadManifests()) {
    const installer = new SymbiontInstaller(manifest, root, deps.packageRoot ?? resolvePackageRoot(), false, undefined, null, 'member-project');
    if (installer.uninstallMemberHooks()) out(`removed ${manifest.displayName} hooks from ${root}`);
    if (installer.uninstallMemberMcp()) out(`removed ${manifest.displayName} MCP server from ${root}`);
  }
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
  const results: DrainResult[] = [];
  for (const entry of entriesFor(args, deps)) {
    const spool = new MemberSpool(entry.projectId, { mycoHome: homeFor(deps) });
    const retention = applySpoolRetention(spool, now());
    if (retention.quarantined.length > 0 || retention.pruned > 0 || retention.releasedBlobs > 0) out(`${entry.projectId}: quarantined ${retention.quarantined.length}, pruned ${retention.pruned}, released ${retention.releasedBlobs} staged file(s)`);
    const client = new ServerClient(entry, deps.fetch ?? globalThis.fetch);
    const drained = await spool.drainAll(client, unboundedBudget(), { force: true, now });
    for (const r of drained) {
      out(`${entry.projectId} ${r.sessionId}: sent ${r.sent}, acked ${r.acked}, refused ${r.refused}, remaining ${r.remaining}${r.skipped ? ` (skipped: ${r.skipped})` : ''}${r.endedBy !== 'drained' ? ` — ended by ${r.endedBy}` : ''}`);
    }
    if (drained.length === 0) out(`${entry.projectId}: spool empty`);
    results.push(...drained);
  }
  return results;
}

export function runStatus(args: readonly string[], deps: MemberCliDeps = {}): void {
  const out = deps.stdout ?? ((l) => process.stdout.write(`${l}\n`));
  const now = deps.now ?? Date.now;
  for (const entry of entriesFor(args, deps)) {
    const spool = new MemberSpool(entry.projectId, { mycoHome: homeFor(deps) });
    out(`project:    ${entry.projectId}`);
    out(`root:       ${entry.root}`);
    out(`server:     ${entry.serverUrl}`);
    out(`token:      ${redact(entry.token)}${entry.tokenId ? ` (${entry.tokenId})` : ''}`);
    out(`expires:    ${when(entry.expiresAt)}${entry.expiresAt !== undefined && entry.expiresAt <= now() ? ' (EXPIRED)' : ''}`);
    out(`refresh:    ${entry.refreshTerminal ? 'unavailable — re-provision with `myco member join`' : entry.refreshAfter === undefined ? 'not yet announced' : `after ${when(entry.refreshAfter)}`}`);
    out(`machine:    ${entry.machineId}`);
    out(`joined:     ${when(entry.joinedAt)}`);
    const sessions = spool.sessionIds();
    let lastAck = 0;
    let depth = 0;
    for (const sessionId of sessions) {
      const d = spool.depth(sessionId);
      depth += d;
      out(`spool:      ${sessionId} — ${d} un-acknowledged`);
    }
    for (const sessionId of spool.stateSessionIds()) lastAck = Math.max(lastAck, lastAckAt(spool, sessionId));
    out(`spool:      ${sessions.length} session file(s), ${depth} un-acknowledged event(s)`);
    out(`last ack:   ${lastAck > 0 ? when(lastAck) : '—'}`);
    const refused = spool.readRefused();
    const last = refused[refused.length - 1];
    out(`refused:    ${refused.length} logged${last ? `; last ${last.kind} ${last.eventId} (${last.code}) at ${when(last.at)}` : ''}`);
    const latch = spool.readLatch();
    out(`latch:      ${latch ? `offline since ${when(latch.since)}, next probe ${when(latch.nextProbeAt)} (backoff ${latch.backoffMs} ms)` : 'online'}`);
  }
  reportMissedCapture(out, args, deps);
}

/**
 * What the hooks that found no membership add up to.
 *
 * A hook that resolves no registry entry prints one line and exits 0, so the
 * loss leaves no trace in the harness. Status is where it becomes a number: a
 * project whose pin, home or join is wrong reads "N hook invocations found no
 * registry entry for <root>" instead of an empty report.
 */
function reportMissedCapture(out: (line: string) => void, args: readonly string[], deps: MemberCliDeps): void {
  const mycoHome = homeFor(deps);
  // Status is one of the two moments that sweep the store (the other is `join`);
  // a hook counts its miss and gets out of the way.
  pruneMissingMemberships(mycoHome, (deps.now ?? Date.now)());
  const records = args.includes('--all')
    ? listMissingMemberships(mycoHome)
    : [readMissingMembership(resolveMemberProjectRoot(deps.cwd), mycoHome)].filter((r) => r !== null);
  for (const record of records) {
    out(`unmembered: ${record.count} hook invocation(s) found no registry entry for ${record.root}`);
    out(`            first ${when(record.firstAt)}, last ${when(record.lastAt)}${record.lastInvokedBy ? ` (${record.lastInvokedBy})` : ''}`);
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
 * The pin names an absolute path on THIS machine, so it must never reach the
 * repository: the vault `.gitignore` (which already lists `runtime.home`) is
 * written first, and a gate runs `git check-ignore` over the file this writes.
 * A committed pin would route a teammate's capture at a home that does not
 * exist on their machine — and their clone makes them its owner, so it would be
 * trusted — which is the silent loss this whole change exists to end.
 *
 * A pin naming a DIFFERENT home is never overwritten: it is the record of
 * another install (a `make dev-link` dogfood pin, say) and rewriting it would
 * move every hook, every `myco` command and the MCP server in that project to a
 * home its operator did not choose. The caller reports the conflict instead.
 */
function pinProjectHome(root: string, mycoHome: string): PinOutcome {
  const pinPath = path.join(root, '.myco', RUNTIME_HOME_FILENAME);
  const home = path.resolve(mycoHome);
  const existing = readHomePin(pinPath);
  if (existing !== null && existing !== home) return { kind: 'conflict', pinPath, pinned: existing };
  if (existing === home || pathsEquivalentHome(home, defaultMycoHome())) return { kind: 'settled' };
  try {
    fs.mkdirSync(path.dirname(pinPath), { recursive: true });
    ensureVaultGitignoreCurrent(path.dirname(pinPath));
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
type MachinePinOutcome = { kind: 'written'; pinPath: string } | { kind: 'settled' } | { kind: 'held'; pinPath: string; pinned: string } | { kind: 'unwritable'; pinPath: string };

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
function pinMachineHome(mycoHome: string, deps: MemberCliDeps): MachinePinOutcome {
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
    case 'lineage-expired': return 'this token chain has reached its lifetime — re-provision with `myco member join`';
    case 'unauthorized': return 'the server refused this token — re-provision with `myco member join`';
    case 'terminal': return 'the server refused to rotate this token — re-provision with `myco member join`';
    case 'route-missing': return 'this server does not rotate member tokens';
    case 'protocol': return 'the server refuses this build\'s member protocol — upgrade myco';
    case 'no-entry': return 'no registry entry';
    default: return 'the server could not be reached — try again later';
  }
}

/** The URL a member opens to connect a GitHub account: the key rides the fragment, which never reaches the server or a log. */
export function linkUrl(serverUrl: string, key: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/link#${key}`;
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
      out(`Open this link within ten minutes to connect your GitHub account to this membership:`);
      out(url);
      if (open) (deps.openBrowser ?? openBrowser)(url);
      return url;
    }
    case 'unauthorized': return fail('the server refused this credential — re-provision with `myco member join`');
    case 'route_missing': return fail('this server does not link GitHub accounts');
    case 'protocol': return fail('the server refuses this build\'s member protocol — upgrade myco');
    case 'refused': return fail(`the server refused: ${outcome.reason || outcome.code}`);
    case 'retry': return fail(`the server did not answer: ${outcome.detail}`);
  }
}

export async function run(args: readonly string[], deps: MemberCliDeps = {}): Promise<void> {
  const [op, ...rest] = args;
  switch (op) {
    case 'join': await runJoin(rest, deps); return;
    case 'leave': runLeave(rest, deps); return;
    case 'drain': await runDrain(rest, deps); return;
    case 'status': runStatus(rest, deps); return;
    case 'refresh': await runRefresh(rest, deps); return;
    case 'link-github': await runLinkGithub(rest, deps); return;
    default:
      (deps.stderr ?? ((l) => process.stderr.write(`${l}\n`)))(MEMBER_HELP.trimEnd());
      process.exitCode = 2;
  }
}
