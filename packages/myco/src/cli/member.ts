/**
 * `myco member <op>` — the member's own CLI: `drain [--all]` runs the one
 * drain implementation without a harness budget and ignoring the offline
 * latch; `status` shows the registry entry (token redacted), expiry, spool
 * depth, last acknowledgement and refusal, and the latch.
 */
import { resolveMycoHome } from '../paths/home.js';
import { unboundedBudget } from '../member/budget.js';
import { resolveMemberProjectRoot } from '../member/credential.js';
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
    out(`refresh:    ${entry.refreshAfter === undefined ? 'not yet announced' : `after ${when(entry.refreshAfter)}`}`);
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

export async function run(args: readonly string[], deps: MemberCliDeps = {}): Promise<void> {
  const [op, ...rest] = args;
  switch (op) {
    case 'drain': await runDrain(rest, deps); return;
    case 'status': runStatus(rest, deps); return;
    default:
      (deps.stderr ?? ((l) => process.stderr.write(`${l}\n`)))(MEMBER_HELP.trimEnd());
      process.exitCode = 2;
  }
}
