/**
 * `myco-team host <enable|disable|status>` CLI surface (Task 2.1).
 *
 * Thin argv parsing + human-readable output over the {@link hostEnable} /
 * {@link hostDisable} orchestration. All real seams (network fetcher, command
 * runner, service manager) default inside the orchestrator; this layer only
 * parses flags and prints.
 */
import { hostDisable, hostEnable } from './overlay.js';
import { readHostState } from './state.js';

function parseFlags(args: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq > 2) { flags.set(arg.slice(2, eq), arg.slice(eq + 1)); continue; }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags.set(arg.slice(2), next); i += 1; }
    else flags.set(arg.slice(2), 'true');
  }
  return flags;
}

const HOST_HELP = `Usage: myco-team host <command>

Commands:
  enable --server-url <https://host:8080> [--hostname <name>] [--listen-addr <addr>]
                                          [--user <headscale-user>] [--key-expiration <dur>]
  disable
  status

enable stands up the OSS overlay on THIS machine as a Team Host: it provisions the
pinned headscale + tailscale binaries, supervises both as root services (they
survive reboot), joins the host node, and wires the local daemon to serve its
Grove(s) over the overlay. Root is required — you may be prompted for your sudo
password. --server-url is the address members dial to reach the control plane.

disable tears both services down and stops serving. status prints the current
host state.
`;

export async function runHostCommand(args: string[]): Promise<void> {
  const [subcommand, ...rest] = args;

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(HOST_HELP);
    process.exit(subcommand ? 0 : 2);
  }

  if (subcommand === 'enable') {
    const flags = parseFlags(rest);
    const serverUrl = flags.get('server-url');
    if (!serverUrl) {
      console.error('host enable requires --server-url <https://host:8080>.');
      process.exit(2);
    }
    const result = await hostEnable({
      serverUrl,
      hostname: flags.get('hostname'),
      listenAddr: flags.get('listen-addr'),
      headscaleUser: flags.get('user'),
      keyExpiration: flags.get('key-expiration'),
    });
    console.log('\nTeam Host enabled.');
    console.log(`  Host ID:       ${result.hostId}`);
    console.log(`  Overlay IP:    ${result.overlayAddress}`);
    console.log(`  Control plane: ${result.serverUrl}`);
    console.log(`  headscale:     v${result.headscaleVersion}`);
    console.log(`  tailscale:     v${result.tailscaleVersion}`);
    console.log(`  Daemon:        ${result.daemonRestarted ? 'restarted (overlay listener binding)' : 'restart pending — see notes'}`);
    for (const note of result.notes) console.log(`  NOTE: ${note}`);
    return;
  }

  if (subcommand === 'disable') {
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
      console.log('This machine is not a Team Host (run `myco-team host enable`).');
      return;
    }
    console.log(`Host ID:       ${state.host_id}`);
    console.log(`Enabled:       ${state.enabled_at}`);
    console.log(`Overlay IP:    ${state.overlay_address}`);
    console.log(`Control plane: ${state.server_url}`);
    console.log(`headscale:     v${state.headscale_version}`);
    console.log(`tailscale:     v${state.tailscale_version}`);
    console.log(`Node ID:       ${state.node_id ?? '(unresolved)'}`);
    return;
  }

  console.error(`Unknown host command: ${subcommand}`);
  console.log(HOST_HELP);
  process.exit(1);
}
