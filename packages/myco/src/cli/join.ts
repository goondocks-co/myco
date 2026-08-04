/**
 * `myco join <host>` / `myco leave <host>` CLI surface (Task 2.2; consolidation
 * Task D-2: fallback posture).
 *
 * Thin argv parsing + human-readable output over the daemon API
 * (`POST /api/host-membership/join|leave`, `daemon/api/host-membership.ts`),
 * which itself wraps `joinHost`/`leaveHost`
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
import { connectToGlobalDaemon, connectToRunningDaemon, daemonErrorMessage, parseFlags } from './shared.js';

const JOIN_HELP = `Usage: myco join <host> --key <one-time-key> --host-url <https://host.tailnet.ts.net:8443>

Enrolls THIS machine with a Team Host and records it, so attached projects route
there. Re-running converges.

Options:
  --key <k>          REQUIRED. The single-use key the host operator minted.
  --host-url <url>   REQUIRED. The host's public HTTPS address. A NON-SECRET the
                     operator shares alongside the key; the secret bearer comes
                     back over that address, never handed out separately.

Manual bridge (skip enrollment — a host without the enrollment endpoint, or
debugging): pass the bearer explicitly and it is used as-is:
  --bearer <serve-bearer>   The host serve-bearer (selects the manual bridge).
  --host-id <id>  --label <name>  --protocol-version <n>   (optional overrides)

This is a fallback surface — joining a host from the Team page (daemon dashboard)
is the primary path; this command drives the same daemon API.
`;

const LEAVE_HELP = `Usage: myco leave <host>

Detaches this machine from a Team Host: removes the stored host record + bearer
(and its attach refs). Idempotent.
`;

// join makes a real network round trip to the host; leave only touches local
// state. Both dwarf the daemon client's 2s request default.
const JOIN_TIMEOUT_MS = 60_000;
const LEAVE_TIMEOUT_MS = 20_000;

interface JoinResponseBody {
  host_id: string;
  host_url: string;
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

  // Daemon preflight BEFORE anything key-consuming: the key is single-use and
  // enrollment spends it daemon-side, so a daemon spawned as a side effect of
  // this command that dies mid-join burns the key for nothing. Refusing up
  // front when no daemon is already running costs nothing.
  const client = await connectToRunningDaemon(
    vaultDir,
    'join needs the local daemon running BEFORE it spends the single-use key —\n'
    + 'enrollment consumes the key even when a later step fails. Start the daemon first\n'
    + '(`myco service install`, or `myco daemon` under a supervisor for a headless box)\n'
    + 'and re-run join. The key has NOT been used.',
  );

  // The daemon runs the whole enrollment before answering — up to
  // JOIN_TIMEOUT_MS of silence from the operator's seat. Say so up front; the
  // per-step log is replayed from the response's `steps` once it completes.
  console.log(`Joining Team Host ${hostRef} — this build cannot join yet — the member transport is being rebuilt`);

  const protocolVersionRaw = flags.get('protocol-version');
  const result = await client.post('/api/host-membership/join', {
    host_ref: hostRef,
    key,
    host_url: flags.get('host-url'),
    bearer: flags.get('bearer'),
    protocol_version: protocolVersionRaw ? Number(protocolVersionRaw) : undefined,
    host_id: flags.get('host-id'),
    label: flags.get('label'),
  }, { timeoutMs: JOIN_TIMEOUT_MS });

  if (!result.ok) {
    const message = daemonErrorMessage(result.data);
    if (message) {
      console.error(`join failed: ${message}`);
    } else {
      // No response body — usually the JOIN_TIMEOUT_MS window elapsing while a
      // first-time join is still provisioning binaries daemon-side. The join
      // may yet complete (and the key may already be consumed), so steer the
      // operator to converge with a re-run, not to mint a fresh key blind.
      console.error('join failed: the daemon did not respond within the join window.');
      console.error('  The daemon may still be completing it, and the key may already be spent. Re-run the SAME');
      console.error('  join command to converge; mint a fresh key only if the re-run reports the key was used.');
    }
    process.exit(1);
  }

  const body = result.data as JoinResponseBody;
  for (const step of body.steps ?? []) console.log(`  ${step}`);
  console.log(`\n${body.created ? 'Joined' : 'Re-joined'} Team Host ${body.host_id}.`);
  console.log(`  Host address:  ${body.host_url}`);
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
  for (const note of body.notes) console.log(`  NOTE: ${note}`);
}
