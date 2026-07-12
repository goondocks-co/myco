/**
 * `myco-team host <enable|disable|status>` CLI surface (Task 2.1).
 *
 * Thin argv parsing + human-readable output over the {@link hostEnable} /
 * {@link hostDisable} orchestration. All real seams (network fetcher, command
 * runner, service manager) default inside the orchestrator; this layer only
 * parses flags and prints.
 */
import { evictDevice, listDevices, mintSetupKey, rotateBearer } from './devices.js';
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
  key mint [--expiration <dur>]        Mint a one-time setup key to hand a joiner.
  devices list                         List enrolled member devices.
  devices evict <id>                   Evict a device (immediate overlay cut).
  bearer rotate                        Rotate the shared host bearer (re-enrolls everyone).

enable stands up the OSS overlay on THIS machine as a Team Host: it provisions the
pinned headscale + tailscale binaries, supervises both as root services (they
survive reboot), joins the host node, and wires the local daemon to serve its
Grove(s) over the overlay. Root is required — you may be prompted for your sudo
password. --server-url is the address members dial to reach the control plane.

disable tears both services down and stops serving. status prints the current
host state.

key/devices/bearer are the operator control plane — they run ONLY here, on the
host's localhost, and are never reachable by members over the overlay.
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
    console.log(`  Served Grove:  ${result.servedGroveId}`);
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

  // --- operator control plane (localhost only; never overlay-served) ---

  if (subcommand === 'key') {
    const [action, ...keyRest] = rest;
    if (action !== 'mint') {
      console.error('Usage: myco-team host key mint [--expiration <dur>]');
      process.exit(2);
    }
    const flags = parseFlags(keyRest);
    const key = await mintSetupKey({ expiration: flags.get('expiration') });
    console.log('One-time setup key (hand this to the joiner — it works once):');
    console.log(`\n  ${key}\n`);
    console.log('The joiner runs:  myco join <host> --key <key> --server-url <headscale-url> --overlay-address <host-100.64-ip:port>');
    return;
  }

  if (subcommand === 'devices') {
    const [action, ...devRest] = rest;
    if (action === 'list') {
      const devices = await listDevices();
      if (devices.length === 0) {
        console.log('No devices enrolled.');
        return;
      }
      console.log('DEVICES');
      for (const d of devices) {
        console.log(`  ${d.id.padEnd(6)} ${(d.name || '(unnamed)').padEnd(24)} ${(d.overlay_ip ?? '-').padEnd(18)} ${d.online ? 'online' : 'offline'}  last-seen ${d.last_seen ?? '-'}`);
      }
      return;
    }
    if (action === 'evict') {
      const id = devRest.find((a) => !a.startsWith('--'));
      if (!id) {
        console.error('Usage: myco-team host devices evict <id>  (see `myco-team host devices list`)');
        process.exit(2);
      }
      await evictDevice(id);
      console.log(`Evicted device ${id} — its overlay node is cut immediately.`);
      return;
    }
    console.error('Usage: myco-team host devices <list|evict <id>>');
    process.exit(2);
  }

  if (subcommand === 'bearer') {
    const [action] = rest;
    if (action !== 'rotate') {
      console.error('Usage: myco-team host bearer rotate');
      process.exit(2);
    }
    const result = await rotateBearer();
    console.log('Host bearer rotated.');
    console.log(result.detail);
    console.log('WARNING: every joined member is now unauthenticated and must re-join with a fresh key (`myco-team host key mint`).');
    return;
  }

  console.error(`Unknown host command: ${subcommand}`);
  console.log(HOST_HELP);
  process.exit(1);
}
