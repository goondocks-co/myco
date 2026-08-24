/**
 * `myco member <op>` — the member's own CLI: `join`/`leave` record and forget
 * this machine's membership of a project (the token never reaches argv);
 * `drain [--all]` runs the one
 * drain implementation without a harness budget and ignoring the offline
 * latch; `status` shows the registry entry (token redacted), expiry, spool
 * depth, last acknowledgement and refusal, and the latch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getMachineId } from '../machine-id.js';
import { isSafeProjectRoot } from '../project-root.js';
import { resolveMycoHome } from '../paths/home.js';
import { unboundedBudget } from '../member/budget.js';
import { isProjectId, MEMBER_TOKEN_REFRESH_WINDOW_MS } from '../member/constants.js';
import { isHttpsUrl, isMemberTokenShape, resolveMemberProjectRoot } from '../member/credential.js';
import { refreshMemberCredential, type RefreshReport } from '../member/refresh.js';
import { listRegistryEntries, readRegistryEntry, removeRegistryEntry, writeRegistryEntry, REGISTRY_VERSION, type RegistryEntry } from '../member/registry.js';
import { applySpoolRetention, lastAckAt } from '../member/retention.js';
import { MemberSpool, type DrainResult } from '../member/spool.js';
import { ServerClient, type FetchLike } from '../member/transport.js';
import { loadManifests, resolvePackageRoot } from '../symbionts/detect.js';
import { SymbiontInstaller } from '../symbionts/installer.js';

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
                     last acknowledgement and refusal, and the offline latch.
  refresh [--all]    Rotate the member token when its refresh window is open. The predecessor keeps
                     working until the successor is first used; an env-sourced token is never rotated.
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
}

const redact = (token: string): string => `${token.slice(0, 4)}…${token.slice(-4)}`;
const when = (ms: number | undefined): string => (ms === undefined ? '—' : new Date(ms).toISOString());

function entriesFor(args: readonly string[], deps: MemberCliDeps): RegistryEntry[] {
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
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

  const mycoHome = deps.mycoHome ?? resolveMycoHome();
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
  out(`joined ${parsed.project} at ${parsed.serverUrl} for ${root}`);

  if (parsed.provision) {
    const manifest = loadManifests().find((m) => m.name === parsed.provision);
    if (!manifest) return fail(`unknown agent "${parsed.provision}" — the membership is recorded; provision it with \`myco member join --provision <agent>\``);
    const installer = new SymbiontInstaller(manifest, root, deps.packageRoot ?? resolvePackageRoot(), false, undefined, null, 'member-project');
    out(installer.install().hooks
      ? `provisioned ${manifest.displayName} for ${root}`
      : `${manifest.displayName} cannot report to a server; nothing provisioned`);
  }
  return entry;
}

/** Forget this project's membership. The spool survives unless `--purge` is given, which also strips the hooks provisioning wrote. */
export function runLeave(args: readonly string[], deps: MemberCliDeps = {}): boolean {
  const out = deps.stdout ?? ((l) => process.stdout.write(`${l}\n`));
  const err = deps.stderr ?? ((l) => process.stderr.write(`${l}\n`));
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const root = resolveMemberProjectRoot(deps.cwd);
  const entry = readRegistryEntry(root, mycoHome);
  if (!entry) {
    err(`myco member leave: no membership recorded for ${root}`);
    process.exitCode = 2;
    return false;
  }
  removeRegistryEntry(root, mycoHome);
  out(`left ${entry.projectId} for ${root}`);
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
    const spool = new MemberSpool(entry.projectId, { mycoHome: deps.mycoHome });
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
    const spool = new MemberSpool(entry.projectId, { mycoHome: deps.mycoHome });
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

export async function run(args: readonly string[], deps: MemberCliDeps = {}): Promise<void> {
  const [op, ...rest] = args;
  switch (op) {
    case 'join': await runJoin(rest, deps); return;
    case 'leave': runLeave(rest, deps); return;
    case 'drain': await runDrain(rest, deps); return;
    case 'status': runStatus(rest, deps); return;
    case 'refresh': await runRefresh(rest, deps); return;
    default:
      (deps.stderr ?? ((l) => process.stderr.write(`${l}\n`)))(MEMBER_HELP.trimEnd());
      process.exitCode = 2;
  }
}
