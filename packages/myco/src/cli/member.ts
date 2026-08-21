/**
 * `myco member <op>` — the member's own CLI: `drain [--all]` runs the one
 * drain implementation without a harness budget and ignoring the offline
 * latch; `status` shows the registry entry (token redacted), expiry, spool
 * depth, last acknowledgement and refusal, and the latch.
 */
import { resolveMycoHome } from '../paths/home.js';
import { unboundedBudget } from '../member/budget.js';
import { MEMBER_TOKEN_REFRESH_WINDOW_MS } from '../member/constants.js';
import { resolveMemberProjectRoot } from '../member/credential.js';
import { refreshMemberCredential, type RefreshReport } from '../member/refresh.js';
import { listRegistryEntries, readRegistryEntry, type RegistryEntry } from '../member/registry.js';
import { applySpoolRetention, lastActivityAt } from '../member/retention.js';
import { MemberSpool, type DrainResult } from '../member/spool.js';
import { ServerClient, type FetchLike } from '../member/transport.js';

export const MEMBER_HELP = `Usage: myco member <op> [options]

Ops:
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

export async function runDrain(args: readonly string[], deps: MemberCliDeps = {}): Promise<DrainResult[]> {
  const out = deps.stdout ?? ((l) => process.stdout.write(`${l}\n`));
  const now = deps.now ?? Date.now;
  const results: DrainResult[] = [];
  for (const entry of entriesFor(args, deps)) {
    const spool = new MemberSpool(entry.projectId, { mycoHome: deps.mycoHome });
    const retention = applySpoolRetention(spool, now());
    if (retention.quarantined.length > 0 || retention.pruned > 0) out(`${entry.projectId}: quarantined ${retention.quarantined.length}, pruned ${retention.pruned}`);
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
      lastAck = Math.max(lastAck, lastActivityAt(spool, sessionId));
      out(`spool:      ${sessionId} — ${d} un-acknowledged`);
    }
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
    case 'drain': await runDrain(rest, deps); return;
    case 'status': runStatus(rest, deps); return;
    case 'refresh': await runRefresh(rest, deps); return;
    default:
      (deps.stderr ?? ((l) => process.stderr.write(`${l}\n`)))(MEMBER_HELP.trimEnd());
      process.exitCode = 2;
  }
}
