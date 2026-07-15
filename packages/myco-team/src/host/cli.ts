/**
 * `myco-team host <enable|disable|status>` CLI surface (Task 2.1).
 *
 * Thin argv parsing + human-readable output over the {@link hostEnable} /
 * {@link hostDisable} orchestration. All real seams (network fetcher, command
 * runner, service manager) default inside the orchestrator; this layer only
 * parses flags and prints — except for the `--designate-default --emit-join`
 * composite ({@link hostEnableAndEmitJoin}, Task 6), which is the `--serve`
 * installer flag's own orchestrator and needs its own injectable seams
 * (confirm-before-remint) for the same reason {@link hostEnable} does.
 */
import { resolveGroveDir, resolveMycoHome } from '@myco/grove/paths.js';
import { resolveGlobalDaemonPort } from '@myco/daemon/service-state.js';
import { writeSecret } from '@myco/config/secrets.js';
import { TEAM_AGENT_KEY_SECRET } from '@myco/constants.js';
import { KEYED_CLOUD_PROVIDER_ENV } from '@myco/agent/harness/provider-health.js';
import { evictDevice, listDevices, mintSetupKey, rotateBearer } from './devices.js';
import { hostDisable, hostEnable, type HostEnableDeps, type HostEnableOptions, type HostEnableResult } from './overlay.js';
import { readHostState } from './state.js';

const VALID_TEAM_KEY_PROVIDERS = Object.keys(KEYED_CLOUD_PROVIDER_ENV) as Array<keyof typeof KEYED_CLOUD_PROVIDER_ENV>;

/**
 * Validates `--team-key-provider` against `KEYED_CLOUD_PROVIDER_ENV`'s OWN
 * properties — never the bare `in` operator, which also matches inherited
 * `Object.prototype` keys (`toString`, `hasOwnProperty`, …) and would let a
 * typo like that silently pass validation. Returns `undefined` when no flag
 * was supplied (the `hostEnableAndEmitJoin` anthropic default applies
 * downstream); throws when a flag WAS supplied but isn't a recognized
 * provider, so the CLI can fail loudly — before any enable/mint/store side
 * effect — instead of silently storing the key under the wrong provider's
 * env name (the permanent keyless-suppression hazard this route class
 * exists to prevent).
 */
export function resolveTeamKeyProviderFlag(flagValue: string | undefined): keyof typeof KEYED_CLOUD_PROVIDER_ENV | undefined {
  if (flagValue === undefined) return undefined;
  if (!Object.prototype.hasOwnProperty.call(KEYED_CLOUD_PROVIDER_ENV, flagValue)) {
    throw new Error(
      `Unrecognized --team-key-provider "${flagValue}". Valid providers: ${VALID_TEAM_KEY_PROVIDERS.join(', ')}.`,
    );
  }
  return flagValue as keyof typeof KEYED_CLOUD_PROVIDER_ENV;
}

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

// ---------------------------------------------------------------------------
// `--designate-default --emit-join` composite (Task 6 — the `--serve`
// installer flag's orchestrator; server-mode design spec §3 steps 4-6)
// ---------------------------------------------------------------------------

/** First-8+last-4 masking, matching the masked-echo contract secrets are
 *  never printed in full under (server-mode design spec §5/§6). */
function maskTeamAgentKey(secret: string): string {
  const PREFIX = 8;
  const SUFFIX = 4;
  if (secret.length <= PREFIX + SUFFIX) return '*'.repeat(secret.length);
  return `${secret.slice(0, PREFIX)}${'*'.repeat(secret.length - PREFIX - SUFFIX)}${secret.slice(-SUFFIX)}`;
}

/** Real TTY y/N prompt — mirrors the readline pattern already used elsewhere
 *  in this package (`../cli.ts` `teamCreate`). A non-TTY caller (CI, a piped
 *  install script) gets `false` — never a hang waiting on stdin. */
async function defaultConfirmRemint(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(`${message} [y/N] `, (reply) => resolve(reply));
  });
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

export interface ComposeEnableOptions extends HostEnableOptions {
  /**
   * The team's LLM provider API key (server-mode design spec §5), optionally
   * supplied via env `MYCO_TEAM_AGENT_KEY` (the TRANSPORT name only — see
   * {@link TEAM_AGENT_KEY_SECRET}). Lands in the served Grove's
   * `secrets.env` via `writeSecret` under the PROVIDER-STANDARD env name
   * ({@link teamKeyProvider}, `KEYED_CLOUD_PROVIDER_ENV`) — NEVER in YAML,
   * and never under the transport name itself (a real dispatch never reads
   * that name).
   */
  teamAgentKey?: string;
  /**
   * Which provider's standard env name the key is stored under (default:
   * `'anthropic'` — the API-key path spec §5 documents). Only meaningful
   * when `teamAgentKey` is supplied.
   */
  teamKeyProvider?: keyof typeof KEYED_CLOUD_PROVIDER_ENV;
  /** One-time setup-key lifetime for the emitted join command. Default: `mintSetupKey`'s own default (`'1h'`). */
  setupKeyExpiration?: string;
}

export interface ComposeEnableDeps extends HostEnableDeps {
  /**
   * Confirm before minting a fresh one-time setup key when this machine was
   * ALREADY a Team Host before this call (server-mode design spec §3:
   * "prompts before minting a fresh join key … not a silent side effect of
   * every re-run"). Default: a real TTY y/N prompt. Return true to proceed
   * with a fresh mint.
   */
  confirmRemint?: (message: string) => Promise<boolean>;
}

export interface ComposeEnableResult {
  enable: HostEnableResult;
  /** The full ready-to-paste `myco join …` command, or null when the operator declined re-mint on a re-run. */
  joinCommand: string | null;
  /** Masked (first-8+last-4) echo of the team key that was written, or null when none was supplied. */
  teamAgentKeyMasked: string | null;
}

/**
 * `host enable --designate-default --emit-join`: enable (Task 3's default
 * designation path) → optionally seed the team's provider key into the
 * served Grove's secrets → mint a one-time setup key (prompting first on a
 * re-run) → the complete ready-to-paste join command. This is the `--serve`
 * installer flag's own orchestrator (server-mode design spec §3 steps 4-6),
 * seam-injectable the same way {@link hostEnable} is so it unit-tests with no
 * network, no sudo, and no real TTY.
 */
export async function hostEnableAndEmitJoin(
  options: ComposeEnableOptions,
  deps: ComposeEnableDeps = {},
): Promise<ComposeEnableResult> {
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  // Captured BEFORE `hostEnable` runs — "re-run" means this machine was
  // already a Team Host, not that this specific composite call happened
  // before (a `host enable` first, then `--emit-join` later, still counts).
  const alreadyEnabled = readHostState() !== null;

  const enable = await hostEnable(
    {
      serverUrl: options.serverUrl,
      hostname: options.hostname,
      listenAddr: options.listenAddr,
      headscaleUser: options.headscaleUser,
      keyExpiration: options.keyExpiration,
      groveDesignation: options.groveDesignation ?? 'default',
    },
    deps,
  );

  let teamAgentKeyMasked: string | null = null;
  const teamAgentKey = options.teamAgentKey?.trim();
  if (teamAgentKey) {
    const groveDir = resolveGroveDir(enable.servedGroveId, mycoHome);
    // Stored under the PROVIDER-STANDARD env name (never TEAM_AGENT_KEY_SECRET,
    // which is only the CLI-flag/env-var transport name a real dispatch never
    // reads — see TEAM_AGENT_KEY_SECRET's docstring, constants.ts). Default
    // provider 'anthropic' per spec §5's API-key path.
    const provider = options.teamKeyProvider ?? 'anthropic';
    const envKey = KEYED_CLOUD_PROVIDER_ENV[provider]?.[0];
    if (!envKey) {
      // Unreachable in practice: `resolveTeamKeyProviderFlag` already
      // validates `--team-key-provider` against `KEYED_CLOUD_PROVIDER_ENV`'s
      // own keys before this composite ever runs, so `provider` is always a
      // recognized key here. A silent `?? KEYED_CLOUD_PROVIDER_ENV.anthropic`
      // fallback would, if this invariant were ever violated upstream, store
      // the key under anthropic's env name while the caller believes it went
      // to `provider` — a keyless-suppression hazard this route class exists
      // to prevent. Fail loudly instead.
      throw new Error(`Invariant violation: no env name registered for team key provider "${provider}" in KEYED_CLOUD_PROVIDER_ENV.`);
    }
    writeSecret(groveDir, envKey, teamAgentKey);
    teamAgentKeyMasked = maskTeamAgentKey(teamAgentKey);
  }

  let shouldMint = true;
  if (alreadyEnabled) {
    const confirm = deps.confirmRemint ?? defaultConfirmRemint;
    shouldMint = await confirm('Team Host is already enabled on this machine. Mint a fresh one-time join key?');
  }
  if (!shouldMint) {
    return { enable, joinCommand: null, teamAgentKeyMasked };
  }

  const key = await mintSetupKey({ expiration: options.setupKeyExpiration }, { runner: deps.runner });
  const port = resolveGlobalDaemonPort(mycoHome);
  const joinCommand = `myco join ${enable.hostId} --key ${key} --server-url ${enable.serverUrl} --overlay-address ${enable.overlayAddress}:${port}`;
  return { enable, joinCommand, teamAgentKeyMasked };
}

/** Human-readable printout for `host enable`, shared by the bare and composite paths. */
function printEnableResult(result: HostEnableResult): void {
  console.log('\nTeam Host enabled.');
  console.log(`  Host ID:       ${result.hostId}`);
  console.log(`  Overlay IP:    ${result.overlayAddress}`);
  console.log(`  Control plane: ${result.serverUrl}`);
  console.log(`  Served Grove:  ${result.servedGroveId}`);
  console.log(`  headscale:     v${result.headscaleVersion}`);
  console.log(`  tailscale:     v${result.tailscaleVersion}`);
  console.log(`  Daemon:        ${result.daemonRestarted ? 'restarted (overlay listener binding)' : 'restart pending — see notes'}`);
  for (const note of result.notes) console.log(`  NOTE: ${note}`);
}

const HOST_HELP = `Usage: myco-team host <command>

Commands:
  enable --server-url <https://host:8080> [--hostname <name>] [--listen-addr <addr>]
                                          [--user <headscale-user>] [--key-expiration <dur>]
                                          [--designate-default] [--emit-join]
                                          [--team-key <key>] [--team-key-provider <anthropic|openai|openrouter>]
                                          [--setup-key-expiration <dur>]
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

--designate-default --emit-join is the --serve installer flag's composite path:
enable, designate the box's default Grove as the served Grove, optionally store the
team's LLM provider key (--team-key, or env MYCO_TEAM_AGENT_KEY — both are just the
transport for the value) under --team-key-provider's standard env name in that
Grove's secrets (default: anthropic), mint a one-time setup key, and print the
complete ready-to-paste "myco join ..." command. On a re-run (this machine was
already a Team Host), prompts before minting another key — re-emission is
deliberate, not automatic.

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
    const enableOptions: HostEnableOptions = {
      serverUrl,
      hostname: flags.get('hostname'),
      listenAddr: flags.get('listen-addr'),
      headscaleUser: flags.get('user'),
      keyExpiration: flags.get('key-expiration'),
      groveDesignation: flags.has('designate-default') ? 'default' : undefined,
    };

    if (flags.has('emit-join')) {
      const teamAgentKey = flags.get('team-key') ?? process.env[TEAM_AGENT_KEY_SECRET];
      let teamKeyProvider: keyof typeof KEYED_CLOUD_PROVIDER_ENV | undefined;
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
        console.log(`  Team key:      ${composite.teamAgentKeyMasked} (written to the served Grove's secrets.env)`);
      }
      console.log('');
      if (composite.joinCommand) {
        console.log('Join command (hand this to a member — it works once):\n');
        console.log(`  ${composite.joinCommand}\n`);
      } else {
        console.log('Join key mint skipped. Run `myco-team host key mint` when ready to add a member.');
      }
      return;
    }

    const result = await hostEnable(enableOptions);
    printEnableResult(result);
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
