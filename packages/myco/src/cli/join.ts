/**
 * `myco join <host>` / `myco leave <host>` CLI surface (Task 2.2; consolidation
 * Task D-2: fallback posture).
 *
 * Thin argv parsing + human-readable output over the daemon API
 * (`POST /api/host-membership/join|leave`, `daemon/api/host-membership.ts`),
 * which itself wraps {@link joinHost}/{@link leaveHost}
 * (`host/member-overlay.ts`). Chris's PR #667 review direction: membership
 * "should frankly be only the UI and API, with the CLI being a secondary
 * fallback" — this file used to call `joinHost`/`leaveHost` in-process; it now
 * drives the SAME daemon route the Team page's join form posts to, so there is
 * one code path regardless of caller.
 *
 * The command NAME is load-bearing: the Task 1.4 affiliation hint tells users to
 * run exactly `myco join <host_id>`.
 *
 * Flag parser is shared via `cli/shared.ts#parseFlags` — `cli/attach.ts` (the
 * sibling member command) uses the same one so the two parse identically.
 */
import { connectToGlobalDaemon, daemonErrorMessage, parseFlags } from './shared.js';

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

This is a fallback surface — joining a host from the Team page (daemon dashboard)
is the primary path; this command drives the same daemon API.
`;

const LEAVE_HELP = `Usage: myco leave <host>

Detaches this machine from a Team Host: removes the stored host record + bearer
(and its attach refs). When no other host remains, the userspace tailscaled
service is torn down too. Idempotent.
`;

// join provisions binaries + does a real overlay round trip; leave mostly
// tears down local state. Both dwarf the daemon client's 2s request default.
const JOIN_TIMEOUT_MS = 60_000;
const LEAVE_TIMEOUT_MS = 20_000;

interface JoinResponseBody {
  host_id: string;
  overlay_address: string;
  proxy_port: number;
  member_overlay_ip: string;
  host_reachable: boolean;
  created: boolean;
  notes: string[];
  /** joinHost's step-by-step progress log, collected daemon-side and
   *  replayed here after the POST returns — the in-process CLI used to
   *  stream these live; the daemon API can only hand them back at the end.
   *  Optional: a daemon mid-upgrade may not send them. */
  steps?: string[];
}

interface LeaveResponseBody {
  removed: boolean;
  tailscaled_removed: boolean;
  notes: string[];
}

export async function runJoin(args: string[], vaultDir: string): Promise<void> {
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

  // The daemon runs the whole join (binary provisioning, overlay join,
  // enrollment) before answering — up to JOIN_TIMEOUT_MS of silence from the
  // operator's seat. Say so up front; the per-step log is replayed from the
  // response's `steps` once the join completes.
  console.log(`Joining Team Host ${hostRef} — provisioning the overlay and enrolling; this can take up to a minute…`);

  const protocolVersionRaw = flags.get('protocol-version');
  const client = await connectToGlobalDaemon(vaultDir);
  const result = await client.post('/api/host-membership/join', {
    host_ref: hostRef,
    key,
    server_url: flags.get('server-url'),
    hostname: flags.get('hostname'),
    overlay_address: flags.get('overlay-address'),
    bearer: flags.get('bearer'),
    protocol_version: protocolVersionRaw ? Number(protocolVersionRaw) : undefined,
    host_id: flags.get('host-id'),
    label: flags.get('label'),
  }, { timeoutMs: JOIN_TIMEOUT_MS });

  if (!result.ok) {
    console.error(`join failed: ${daemonErrorMessage(result.data) ?? 'the daemon did not respond'}`);
    process.exit(1);
  }

  const body = result.data as JoinResponseBody;
  for (const step of body.steps ?? []) console.log(`  ${step}`);
  console.log(`\n${body.created ? 'Joined' : 'Re-joined'} Team Host ${body.host_id}.`);
  console.log(`  Host overlay:  ${body.overlay_address}`);
  console.log(`  Local proxy:   127.0.0.1:${body.proxy_port} (HTTP-CONNECT)`);
  console.log(`  Member IP:     ${body.member_overlay_ip}`);
  console.log(`  Reachable:     ${body.host_reachable ? 'yes' : 'not confirmed (verify with `myco doctor`)'}`);
  for (const note of body.notes) console.log(`  NOTE: ${note}`);
}

export async function runLeave(args: string[], vaultDir: string): Promise<void> {
  const { positionals } = parseFlags(args);
  const hostRef = positionals[0];
  if (!hostRef) {
    console.error('leave requires a <host> (the host_id).');
    console.log(LEAVE_HELP);
    process.exit(2);
  }

  const client = await connectToGlobalDaemon(vaultDir);
  const result = await client.post('/api/host-membership/leave', { host_ref: hostRef }, { timeoutMs: LEAVE_TIMEOUT_MS });

  if (!result.ok) {
    console.error(`leave failed: ${daemonErrorMessage(result.data) ?? 'the daemon did not respond'}`);
    process.exit(1);
  }

  const body = result.data as LeaveResponseBody;
  if (!body.removed) {
    console.log(`Not joined to host ${hostRef} — nothing to remove.`);
    return;
  }
  console.log(`Left Team Host ${hostRef}.`);
  if (body.tailscaled_removed) console.log('  Userspace tailscaled service torn down (no hosts remain).');
  for (const note of body.notes) console.log(`  NOTE: ${note}`);
}
