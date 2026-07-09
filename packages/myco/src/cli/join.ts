/**
 * `myco join <host>` / `myco leave <host>` CLI surface (Task 2.2).
 *
 * Thin argv parsing + human-readable output over the {@link joinHost} /
 * {@link leaveHost} member-overlay orchestration. All real seams (binary fetcher,
 * command runner, user-domain service manager, enrollment client) default inside
 * the orchestrator; this layer only parses flags and prints.
 *
 * The command NAME is load-bearing: the Task 1.4 affiliation hint tells users to
 * run exactly `myco join <host_id>`.
 */
import { joinHost, leaveHost } from '../host/member-overlay.js';

/** Parse `--flag value` / `--flag=value` / bare `--flag` into a map. */
function parseFlags(args: string[]): { positionals: string[]; flags: Map<string, string> } {
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }
    const eq = arg.indexOf('=');
    if (eq > 2) { flags.set(arg.slice(2, eq), arg.slice(eq + 1)); continue; }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags.set(arg.slice(2), next); i += 1; }
    else flags.set(arg.slice(2), 'true');
  }
  return { positionals, flags };
}

const JOIN_HELP = `Usage: myco join <host> --key <one-time-key> --server-url <headscale-url> --overlay-address <100.64.x.y:port>

Enrolls THIS machine with a Team Host: it provisions a userspace tailscaled as a
per-user service (NO root), joins the host's overlay with the single-use key, then
enrolls with the host daemon over the overlay to receive the shared bearer, and
records the host so attached projects route to it. Re-running converges.

Options:
  --key <k>              REQUIRED. The single-use pre-auth key the host operator minted.
  --server-url <url>     Headscale control-plane URL (required unless already on the overlay).
  --overlay-address <100.64.x.y:port>
                         REQUIRED. The host daemon's overlay address to dial for enrollment.
                         A NON-SECRET the operator shares alongside the one-time key; the
                         secret bearer is fetched over the overlay, never handed out-of-band.
  --hostname <name>      This member's node name on the tailnet (default: this machine's hostname).

Manual bridge (skip the automatic overlay handshake — a host without the enrollment
endpoint, or debugging): pass the bearer explicitly and it is used as-is:
  --bearer <serve-bearer>   The shared host serve-bearer (selects the manual bridge).
  --host-id <id>  --label <name>  --protocol-version <n>   (optional overrides)
`;

const LEAVE_HELP = `Usage: myco leave <host>

Detaches this machine from a Team Host: removes the stored host record + bearer
(and its attach refs). When no other host remains, the userspace tailscaled
service is torn down too. Idempotent.
`;

export async function runJoin(args: string[]): Promise<void> {
  const { positionals, flags } = parseFlags(args);
  const hostRef = positionals[0];
  if (!hostRef) {
    console.error('join requires a <host> (the host_id).');
    console.log(JOIN_HELP);
    process.exit(2);
  }
  const key = flags.get('key');
  if (!key) {
    console.error('join requires --key <one-time-key>.');
    console.log(JOIN_HELP);
    process.exit(2);
  }

  const protocolVersionRaw = flags.get('protocol-version');
  const result = await joinHost({
    hostRef,
    key,
    serverUrl: flags.get('server-url'),
    hostname: flags.get('hostname'),
    overlayAddress: flags.get('overlay-address'),
    bearer: flags.get('bearer'),
    protocolVersion: protocolVersionRaw ? Number(protocolVersionRaw) : undefined,
    hostId: flags.get('host-id'),
    label: flags.get('label'),
  });

  console.log(`\n${result.created ? 'Joined' : 'Re-joined'} Team Host ${result.hostId}.`);
  console.log(`  Host overlay:  ${result.overlayAddress}`);
  console.log(`  Local proxy:   127.0.0.1:${result.proxyPort} (HTTP-CONNECT)`);
  console.log(`  Member IP:     ${result.memberOverlayIp}`);
  console.log(`  Reachable:     ${result.hostReachable ? 'yes' : 'not confirmed (verify with `myco doctor`)'}`);
  for (const note of result.notes) console.log(`  NOTE: ${note}`);
}

export async function runLeave(args: string[]): Promise<void> {
  const { positionals } = parseFlags(args);
  const hostRef = positionals[0];
  if (!hostRef) {
    console.error('leave requires a <host> (the host_id).');
    console.log(LEAVE_HELP);
    process.exit(2);
  }
  const result = await leaveHost(hostRef);
  if (!result.removed) {
    console.log(`Not joined to host ${hostRef} — nothing to remove.`);
    return;
  }
  console.log(`Left Team Host ${hostRef}.`);
  if (result.tailscaledRemoved) console.log('  Userspace tailscaled service torn down (no hosts remain).');
  for (const note of result.notes) console.log(`  NOTE: ${note}`);
}
