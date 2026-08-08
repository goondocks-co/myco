/**
 * `myco host <enable|disable|status|rotate-key|members|revoke>` CLI surface.
 *
 * Thin argv parsing + human-readable output over the {@link hostEnable} /
 * {@link hostDisable} orchestration (`../team-host/serving.js`) — except for
 * the `--designate-default --emit-join` composite
 * ({@link hostEnableAndEmitJoin}, `../team-host/compose.js`), which is the
 * `--serve` installer flag's own orchestrator and needs its own injectable
 * seams (confirm-before-remint) for the same reason `hostEnable` does.
 *
 * Host operator orchestration moved here from `packages/myco-team`
 * (decision-48174c9f): serving is a mode of the one binary, not a separate
 * operator product. `myco-team host ...` now only points here.
 */
import { hostDisable, hostEnable, type HostEnableOptions, type HostEnableResult } from '../team-host/serving.js';
import { readHostState } from '../team-host/state.js';
import { loadMachineConfig } from '../config/loader.js';
import {
  hostEnableAndEmitJoin,
  resolveTeamKeyProviderFlag,
  TEAM_AGENT_KEY_SECRET,
} from '../team-host/compose.js';
import { connectToRunningDaemon, daemonErrorMessage, parseFlags } from './shared.js';
import { resolveVaultDir } from '../vault/resolve.js';

function flagMap(args: string[]): Map<string, string> {
  return parseFlags(args).flags;
}

/** Human-readable printout for `host enable`, shared by the bare and composite paths. */
function printEnableResult(result: HostEnableResult): void {
  console.log('\nTeam Host enabled.');
  console.log(`  Host ID:       ${result.hostId}`);
  console.log(`  Label:         ${result.label}`);
  console.log(`  Team storage:  ${result.servedGroveId}`);
  console.log(`  Daemon:        ${result.daemonRestarted ? 'restarted (team listener binding)' : 'restart pending — see notes'}`);
  for (const note of result.notes) console.log(`  NOTE: ${note}`);
}

export const HOST_HELP = `Usage: myco host <command>

Commands:
  enable [--hostname <name>]
         [--designate-default | --designate-fresh [--storage-name <name>]]
         [--emit-join]
         [--team-key <key>] [--team-key-provider <anthropic|openai|openrouter>]
         [--setup-key-expiration <dur>]
  disable
  status
  rotate-key [--expiration <dur>]        Mint a fresh one-time key to hand a joining team member.
  members                                List the machines enrolled on this host.
  revoke <member-id>                     Remove one member's access. Use when a machine was
                                         wiped or replaced and cannot re-join.

enable turns THIS machine into a Team Host: it publishes the daemon's team
surface at a public HTTPS address and wires the local daemon to serve your team
there. Teammates need only that address and a one-time key — there is no network
for them to join. The stack runs unprivileged as your user and does not disturb a
Tailscale you already have installed. (One exception: a machine whose daemon is
boot-scoped via \`myco service install\` needs sudo for the system-domain unit
step on macOS.) \`status\` prints the address teammates dial.

--designate-default --emit-join is the --serve installer flag's composite path:
enable, make this box's project storage what it serves for the team, optionally
store the team's LLM provider key (--team-key, or env ${TEAM_AGENT_KEY_SECRET} —
both are just the transport for the value) under --team-key-provider's standard
env name (default: anthropic), mint a one-time setup key, and print the complete
ready-to-paste "myco join ..." command. On a re-run (this machine is already a
Team Host), prompts before minting another key — re-emission is deliberate, not
automatic.

On a machine that already has project storage, the FIRST enable requires an
explicit designation choice (breaking change in 1.3.1): --designate-fresh
creates new dedicated team storage (name it with --storage-name; a later
re-enable adopts the same storage, history intact), --designate-default
serves this box's default Grove. An existing personal Grove is never
designated silently.

disable withdraws the public address and stops serving. status prints the
current Team Host state, including the address teammates dial.

rotate-key runs ONLY here, on this host's localhost — it is never reachable by
team members.
`;

export async function runHostCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(HOST_HELP);
    process.exit(subcommand ? 0 : 2);
  }

  if (subcommand === 'enable') {
    // Refuse under sudo. Every path this command writes is HOME-derived, so as
    // root it would enable hosting in ROOT's home — a different machine_id and
    // root-owned files in the user's vault, while the user's own machine stays
    // unhosted. Myco elevates the individual steps that need it.
    if (process.getuid?.() === 0) {
      console.error(
        'Run `myco host enable` WITHOUT sudo — the whole stack runs unprivileged as your user, '
        + 'and Myco elevates only the individual steps that need it.',
      );
      process.exit(1);
    }
    const flags = flagMap(rest);
    const enableOptions: HostEnableOptions = {
      hostname: flags.get('hostname'),
      groveDesignation: flags.has('designate-default') ? 'default' : (flags.has('designate-fresh') ? 'fresh' : undefined),
      storageName: flags.get('storage-name'),
    };
    if (flags.has('designate-default') && flags.has('designate-fresh')) {
      console.error('Pass ONE of --designate-default or --designate-fresh, not both.');
      process.exit(2);
    }

    if (flags.has('emit-join')) {
      const teamAgentKey = flags.get('team-key') ?? process.env[TEAM_AGENT_KEY_SECRET];
      let teamKeyProvider: ReturnType<typeof resolveTeamKeyProviderFlag>;
      try {
        teamKeyProvider = resolveTeamKeyProviderFlag(flags.get('team-key-provider'));
      } catch (err) {
        console.error((err as Error).message);
        process.exit(2);
      }
      const composite = await hostEnableAndEmitJoin({
        ...enableOptions,
        teamAgentKey,
        teamKeyProvider,
        setupKeyExpiration: flags.get('setup-key-expiration'),
      });
      printEnableResult(composite.enable);
      if (composite.teamAgentKeyMasked) {
        console.log(`  Team key:      ${composite.teamAgentKeyMasked} (written to this host's team storage secrets)`);
      }
      console.log('');
      if (composite.joinCommand) {
        console.log('Join command (hand this to a member — it works once):\n');
        console.log(`  ${composite.joinCommand}\n`);
      } else {
        console.log('Join key mint skipped. Run `myco host rotate-key` when ready to add a member.');
      }
      return;
    }

    const result = await hostEnable(enableOptions);
    printEnableResult(result);
    return;
  }

  if (subcommand === 'disable') {
    // Same guard as enable: under sudo every HOME-derived path (control home,
    // host state, serve bearer) resolves to ROOT's home, so the disable
    // "succeeds" while the user's actual host keeps serving.
    if (process.getuid?.() === 0) {
      console.error(
        'Run `myco host disable` WITHOUT sudo — Myco elevates the individual removal steps that need it. '
        + 'Under sudo the teardown would target root\'s home, not yours.',
      );
      process.exit(1);
    }
    const result = await hostDisable();
    if (result.cleared) {
      console.log('Team Host disabled.');
    } else {
      console.error('Team Host disable completed with issues:');
      for (const err of result.errors) console.error(`  - ${err}`);
      process.exit(1);
    }
    return;
  }

  if (subcommand === 'status') {
    const state = readHostState();
    if (!state) {
      console.log('This machine is not a Team Host (run `myco host enable`).');
      return;
    }
    console.log(`Host ID:       ${state.host_id}`);
    console.log(`Enabled:       ${state.enabled_at}`);
    console.log(`Label:         ${state.label ?? '(unset)'}`);
    console.log(`Team storage:  ${loadMachineConfig().daemon.host_serve.served_grove_id ?? '(undesignated)'}`);
    // The address is what an operator actually needs from this command — it is
    // half of every invitation, and members have no other way to reach here.
    if (state.host_url) {
      console.log(`Address:       ${state.host_url}`);
    } else {
      console.log('Address:       (not published yet)');
      if (state.funnel_error) console.log(`  ${state.funnel_error}`);
    }
    return;
  }

  if (subcommand === 'rotate-key') {
    // Minted by the daemon, not here: the key is single-use and validated at
    // enrollment by the same daemon that issued it, so it has to be created
    // where that store lives.
    //
    // Requires an ALREADY-RUNNING daemon rather than starting one, for the
    // reason `join` does: the raw key crosses the wire exactly once and is not
    // recoverable, so a daemon spawned as a side effect of this command that
    // dies before the response lands would mint a key nobody ever sees.
    const flags = flagMap(rest);
    const client = await connectToRunningDaemon(
      resolveVaultDir(),
      'rotate-key needs the local daemon running — it mints the key, and the key is shown once.\n'
      + 'Start the daemon first (`myco service install`, or `myco daemon` under a supervisor for a\n'
      + 'headless box) and re-run. Nothing has been minted.',
    );
    // `post` resolves to a TRANSPORT envelope (`{ ok, data }`), never the
    // response body. Reading fields straight off it type-checks — every field
    // of the body is optional, so the envelope satisfies the shape — and is
    // always undefined at runtime, which reports failure on a successful mint
    // while the key has already been created and persisted host-side.
    const result = await client.post('/api/host-admin/mint-join-key', {
      expiration: flags.get('expiration'),
    });
    if (!result.ok) {
      // The daemon's own refusal (`not_a_host`, `host_not_published`) rather
      // than a generic failure — each names a different next step.
      console.error(daemonErrorMessage(result.data) ?? 'Could not mint a join key.');
      process.exit(1);
    }

    const body = result.data as { key?: string; expires?: string; join_command?: string };
    if (!body?.join_command) {
      // A 200 without the command means the key exists but the invitation
      // cannot be assembled — say so, rather than implying nothing happened.
      console.error('The host minted a key but returned no join command — run `myco host status` to check its address.');
      process.exit(1);
    }
    console.log('Join command (hand this to a member — it works once):\n');
    console.log(`  ${body.join_command}\n`);
    if (body.expires) console.log(`Expires: ${body.expires}`);
    return;
  }

  if (subcommand === 'members') {
    const client = await connectToRunningDaemon(
      resolveVaultDir(),
      'members needs the local daemon running — the roster lives with it.',
    );
    const result = await client.get('/api/host-admin/members');
    if (!result.ok) {
      console.error(daemonErrorMessage(result.data) ?? 'Could not read the member roster.');
      process.exit(1);
    }
    const body = result.data as {
      members?: Array<{ id: string; machine_id: string; label?: string; issued_at?: string; last_seen_at?: string }>;
    };
    const members = body?.members ?? [];
    if (members.length === 0) {
      console.log('No members enrolled.');
      return;
    }
    console.log(`${members.length} member${members.length === 1 ? '' : 's'}:\n`);
    for (const m of members) {
      console.log(`  ${m.id}`);
      console.log(`    machine:  ${m.machine_id}${m.label ? `  (${m.label})` : ''}`);
      if (m.issued_at) console.log(`    joined:   ${m.issued_at}`);
      if (m.last_seen_at) console.log(`    last seen: ${m.last_seen_at}`);
    }
    console.log('\nRevoke one with `myco host revoke <member-id>`.');
    return;
  }

  if (subcommand === 'revoke') {
    // The recovery path for a member that vanished without leaving. A machine
    // is admitted once per machine id, so a member whose Myco state was wiped
    // (reinstall, disk swap, a torn-down test box) is refused on re-join with
    // `machine_already_enrolled` and has no way to clear itself: `leave`
    // resigns from the MEMBER side, and its state is exactly what is gone.
    // Without this the operator's only option is hand-editing the host's
    // members.json.
    const memberId = rest[0];
    if (!memberId || memberId.startsWith('-')) {
      console.error('Usage: myco host revoke <member-id>   (list them with `myco host members`)');
      process.exit(1);
    }
    const client = await connectToRunningDaemon(
      resolveVaultDir(),
      'revoke needs the local daemon running — it owns the token store.',
    );
    const result = await client.post('/api/host-admin/revoke', { member_id: memberId });
    if (!result.ok) {
      console.error(daemonErrorMessage(result.data) ?? `Could not revoke ${memberId}.`);
      process.exit(1);
    }
    console.log(`Revoked ${memberId}.`);
    console.log('  Effective on that member\'s next request — nothing to restart.');
    console.log('  That machine can join again with a fresh key (`myco host rotate-key`).');
    return;
  }

  console.error(`Unknown host command: ${subcommand}`);
  console.log(HOST_HELP);
  process.exit(1);
}
