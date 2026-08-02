/**
 * `myco host <enable|disable|status|rotate-key>` CLI surface.
 *
 * Thin argv parsing + human-readable output over the {@link hostEnable} /
 * {@link hostDisable} orchestration (`../team-host/overlay.js`) — except for
 * the `--designate-default --emit-join` composite
 * ({@link hostEnableAndEmitJoin}, `../team-host/compose.js`), which is the
 * `--serve` installer flag's own orchestrator and needs its own injectable
 * seams (confirm-before-remint) for the same reason `hostEnable` does.
 *
 * Host operator orchestration moved here from `packages/myco-team`
 * (decision-48174c9f): serving is a mode of the one binary, not a separate
 * operator product. `myco-team host ...` now only points here.
 */
import { hostDisable, hostEnable, type HostEnableOptions, type HostEnableResult } from '../team-host/overlay.js';
import { mintSetupKey } from '../team-host/control-plane.js';
import { readHostState } from '../team-host/state.js';
import { loadMachineConfig } from '../config/loader.js';
import { formatOverlayAuthority } from '../daemon/host-serve.js';
import {
  hostEnableAndEmitJoin,
  resolveTeamKeyProviderFlag,
  TEAM_AGENT_KEY_SECRET,
} from '../team-host/compose.js';
import { parseFlags } from './shared.js';

function flagMap(args: string[]): Map<string, string> {
  return parseFlags(args).flags;
}

/** Human-readable printout for `host enable`, shared by the bare and composite paths. */
function printEnableResult(result: HostEnableResult): void {
  console.log('\nTeam Host enabled.');
  console.log(`  Host ID:       ${result.hostId}`);
  console.log(`  Overlay:       ${formatOverlayAuthority(result.overlayAddress, result.overlayPort)}  (what members dial)`);
  console.log(`  Control plane: ${result.serverUrl}`);
  console.log(`  Team storage:  ${result.servedGroveId}`);
  console.log(`  headscale:     v${result.headscaleVersion}`);
  console.log(`  tailscale:     ${result.tailscaleVersion ? `v${result.tailscaleVersion}` : '(unknown)'}`);
  console.log(`  Daemon:        ${result.daemonRestarted ? 'restarted (overlay listener binding)' : 'restart pending — see notes'}`);
  for (const note of result.notes) console.log(`  NOTE: ${note}`);
}

const HOST_HELP = `Usage: myco host <command>

Commands:
  enable --server-url <https://host:8080> [--hostname <name>] [--listen-addr <addr>]
                                          [--user <headscale-user>] [--key-expiration <dur>]
                                          [--designate-default | --designate-fresh [--storage-name <name>]]
                                          [--emit-join]
                                          [--team-key <key>] [--team-key-provider <anthropic|openai|openrouter>]
                                          [--setup-key-expiration <dur>]
  disable
  status
  rotate-key [--expiration <dur>]        Mint a fresh one-time key to hand a joining team member.

enable turns THIS machine into a Team Host: it provisions the pinned overlay
networking binaries, joins this host to the overlay, and wires the local daemon
to serve your team over it. The whole stack runs unprivileged as your user —
no sudo on the default setup, and nothing here sees or disturbs a Tailscale
you already have installed. (The one exception: a machine whose daemon is
boot-scoped via \`myco service install\` needs sudo for the system-domain unit
step on macOS.) --server-url is the address teammates dial to reach this host.

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

disable tears down the overlay services and stops serving. status prints the
current Team Host state.

rotate-key runs ONLY here, on this host's localhost — it is never reachable by
team members over the overlay.
`;

export async function runHostCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(HOST_HELP);
    process.exit(subcommand ? 0 : 2);
  }

  if (subcommand === 'enable') {
    // Operators habitually sudo-prefix this command (the old help text even
    // promised a password prompt). Post-re-scope that inverts the outcome:
    // run as root, headscale's user unit would enroll into ROOT's session
    // with root's HOME — divergent machine_id, root-owned files in the
    // user's vault. Refuse up front with the caller-appropriate message
    // (the renderers' own guards stay as the backstop for other paths).
    if (process.getuid?.() === 0) {
      console.error(
        'Run `myco host enable` WITHOUT sudo — the whole stack runs unprivileged as your user, '
        + 'and Myco elevates only the individual steps that need it.',
      );
      process.exit(1);
    }
    const flags = flagMap(rest);
    const serverUrl = flags.get('server-url');
    if (!serverUrl) {
      console.error('host enable requires --server-url <https://host:8080>.');
      process.exit(2);
    }
    const enableOptions: HostEnableOptions = {
      serverUrl,
      hostname: flags.get('hostname'),
      listenAddr: flags.get('listen-addr'),
      headscaleUser: flags.get('user'),
      keyExpiration: flags.get('key-expiration'),
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
    // Same reflex-guard as enable: under sudo, every HOME-derived path
    // (control home, host state, serve bearer) resolves to ROOT'S home —
    // the disable "succeeds" while the user's actual host stays untouched.
    // Myco elevates the individual system-domain steps itself when a legacy
    // unit exists.
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
    // Read the port from machine config: HostState records the address only,
    // and an operator who cannot see the port cannot hand out a join command.
    const servePort = loadMachineConfig().daemon.host_serve.overlay_port;
    console.log(`Overlay:       ${servePort !== null
      ? formatOverlayAuthority(state.overlay_address, servePort)
      : `${state.overlay_address} (no overlay port persisted — re-run \`myco host enable\`)`}`);
    console.log(`Control plane: ${state.server_url}`);
    console.log(`headscale:     v${state.headscale_version}`);
    console.log(`tailscale:     ${state.tailscale_version ? `v${state.tailscale_version}` : '(unknown)'}`);
    console.log(`Node ID:       ${state.node_id ?? '(unresolved)'}`);
    return;
  }

  if (subcommand === 'rotate-key') {
    const flags = flagMap(rest);
    const key = await mintSetupKey({ expiration: flags.get('expiration') });
    console.log('One-time setup key (hand this to the joiner — it works once):');
    console.log(`\n  ${key}\n`);
    const state = readHostState();
    const servePort = loadMachineConfig().daemon.host_serve.overlay_port;
    const authority = state && servePort !== null
      ? formatOverlayAuthority(state.overlay_address, servePort)
      : '<host-100.64-ip:port>';
    console.log(`The joiner runs:  myco join ${state?.host_id ?? '<host>'} --key <key> `
      + `--server-url ${state?.server_url ?? '<headscale-url>'} --overlay-address ${authority}`);
    return;
  }

  console.error(`Unknown host command: ${subcommand}`);
  console.log(HOST_HELP);
  process.exit(1);
}
