/**
 * Headscale control-plane config generation + host-user/pre-auth-key minting
 * (Task 2.1).
 *
 * `renderHeadscaleConfig` is a PURE function: it maps the host's overlay-reachable
 * address + the myco-team host-control home into a v0.29.x `config.yaml`. Two
 * invariants the transport layer depends on:
 *   - `server_url` is the address members dial to reach this control plane
 *     (`tailscale up --login-server <server_url>`), derived from the operator's
 *     advertised host, never guessed.
 *   - all mutable state (sqlite DB, noise key) lives UNDER the machine-global
 *     host-control home, never in a system dir — so `host disable` can remove
 *     it wholesale. (Precision matters here: this module writes only the
 *     CONFIG file unprivileged; the DB and noise key are created by the
 *     headscale process itself at whatever identity it runs as. That is why
 *     the process now runs as the invoking user — user-cell headscale means
 *     user-owned runtime state.)
 *
 * SELF-HOSTED DERP POSTURE (spike §2.3, stated honestly in the generated file):
 * a self-hosted Headscale still lists Tailscale Inc's public DERP fleet as the
 * NAT-traversal fallback by default. This config keeps that default (embedded
 * DERP OFF) because upstream warns a lone self-hosted DERP is a single point of
 * failure. It is NOT a fully vendor-independent deployment, and the generated
 * file says so in a comment so the operator is never misled.
 *
 * `dns.override_local_dns: false` is REQUIRED on headscale 0.29.2: it defaults
 * that flag to true, which then requires `dns.nameservers.global` to be
 * non-empty or the config load is a fatal error. Team Host never overrides
 * local DNS (magic_dns is off too), so `false` is both correct and what
 * silences the fatal.
 *
 * Key minting shells the headscale CLI behind the {@link CommandRunner} seam so
 * it unit-tests with no real control plane. Invocations are UNPRIVILEGED:
 * headscale runs as the invoking user and its admin socket is pinned
 * user-owned under the host-control home (`unix_socket` below), so the CLI
 * reaches it with no sudo — which is what makes member adds and key rotation
 * daemon-callable. The exact v0.29 `preauthkeys`/`users` flag syntax is
 * pinned here and re-confirmed in live validation (the spike flagged a
 * `preauthkeys list` vs `create` flag-shape nit for Phase 2).
 */
import path from 'node:path';

import type { CommandRunner } from './binaries.js';

export interface HeadscaleLayout {
  /** The generated `config.yaml`. */
  configPath: string;
  /** State dir holding the sqlite DB + noise key. */
  stateDir: string;
  dbPath: string;
  noiseKeyPath: string;
  /** The admin CLI socket, pinned under the host-control home. Load-bearing
   *  for the user-cell re-scope: headscale 0.29.2's compiled-in default
   *  socket directory is root-owned, so a user-cell headscale that inherits
   *  the default cannot create its admin socket at all — which takes down
   *  every admin call (`users create`, `preauthkeys create`, `nodes list`)
   *  and therefore `host enable` itself. */
  adminSocketPath: string;
}

/** Resolve every headscale on-disk path under the host-control home. */
export function headscaleLayout(controlDir: string): HeadscaleLayout {
  const stateDir = path.join(controlDir, 'headscale');
  return {
    configPath: path.join(stateDir, 'config.yaml'),
    stateDir,
    dbPath: path.join(stateDir, 'db.sqlite'),
    noiseKeyPath: path.join(stateDir, 'noise_private.key'),
    adminSocketPath: path.join(stateDir, 'headscale.sock'),
  };
}

export interface HeadscaleConfigInput {
  /** The address members dial to reach the control plane, e.g. `https://host.example:8080`. */
  serverUrl: string;
  /** Where headscale binds locally, e.g. `0.0.0.0:8080`. */
  listenAddr: string;
  /** Resolved on-disk layout (state paths live under the host-control home). */
  layout: HeadscaleLayout;
  /** MagicDNS base domain. Team Host does not use MagicDNS; kept documented + off. */
  baseDomain?: string;
  /** How long an idle ephemeral node lingers before headscale drops it. */
  ephemeralInactivityTimeout?: string;
}

/**
 * Render a minimal, valid Headscale v0.29.x `config.yaml`. Built as a commented
 * template (not `YAML.stringify`) so the DERP-posture note survives into the
 * on-disk file the operator can read.
 */
export function renderHeadscaleConfig(input: HeadscaleConfigInput): string {
  const baseDomain = input.baseDomain ?? 'myco-host.internal';
  const ephemeral = input.ephemeralInactivityTimeout ?? '30m';
  return `# Managed by \`myco host enable\` — do not edit by hand.
# Regenerated on every host enable; removed on host disable.
server_url: ${input.serverUrl}
listen_addr: ${input.listenAddr}
metrics_listen_addr: 127.0.0.1:9090
grpc_listen_addr: 127.0.0.1:50443
grpc_allow_insecure: false

# Overlay address space. The host + every member get a 100.64.0.0/10 (CGNAT)
# address; the daemon's overlay listener binds the host's 100.64 IP (Task 2.3
# refuses to serve on any non-CGNAT address).
prefixes:
  v4: 100.64.0.0/10
  v6: fd7a:115c:a1e0::/48
  allocation: sequential

noise:
  private_key_path: ${input.layout.noiseKeyPath}

# Admin CLI socket, pinned under the host-control home — NEVER inherited from
# headscale's compiled-in default (whose directory is root-owned; a user-cell
# headscale inheriting it cannot create the socket, which takes down every
# admin call and \`host enable\` with them). Permission is pinned too:
# headscale's own default is group 0770, and the daemon is the only intended
# admin client, so owner-only.
unix_socket: ${input.layout.adminSocketPath}
unix_socket_permission: "0700"

database:
  type: sqlite
  sqlite:
    path: ${input.layout.dbPath}

# DERP (NAT-traversal relay) posture — read this honestly:
# A fully self-hosted Headscale still falls back to Tailscale Inc's public DERP fleet
# by default. We keep the embedded DERP server OFF because upstream warns a single
# self-hosted DERP node is a single point of failure. This means Team Host is
# self-hosted for the CONTROL plane but not vendor-independent for the relay
# fallback path. Direct WireGuard (the >90% common case) touches no vendor infra.
#
# \`urls\` MUST stay non-empty. headscale 0.29.2 refuses to boot on an empty DERP
# map ("initial DERPMap is empty, Headscale requires at least one entry"), and
# the failure is vicious rather than loud: \`tailscale up\` then hangs FOREVER
# against a control plane that never came up, so it reads as a hang, not an
# error. A future "remove the vendor dependency" edit that empties this will
# take the overlay down. Pinned by tests/cli/host-headscale-config.test.ts.
derp:
  server:
    enabled: false
  urls:
    - https://controlplane.tailscale.com/derpmap/default
  auto_update_enabled: true
  update_frequency: 24h

disable_check_updates: true

# headscale 0.29.2 REMOVED \`ephemeral_node_inactivity_timeout\` in favour of this
# nested key. The old one did not error — it warned and was silently ignored, so
# the timeout Myco believed it was setting was never applied.
node:
  ephemeral:
    inactivity_timeout: ${ephemeral}

dns:
  magic_dns: false
  base_domain: ${baseDomain}
  override_local_dns: false
  nameservers:
    global: []

log:
  level: info
  format: text
`;
}

// ---------------------------------------------------------------------------
// Host user + one-time pre-auth key
// ---------------------------------------------------------------------------

export interface MintPreauthKeyInput {
  headscaleBin: string;
  configPath: string;
  /** Headscale user name that owns the host + member nodes. */
  user: string;
  /** Key lifetime, e.g. `1h`. One-time by default (no `--reusable`). */
  expiration: string;
  runner: CommandRunner;
}

/**
 * Ensure the headscale user exists, then mint a ONE-TIME pre-auth key the host
 * node joins with. Idempotent on the user (an "already exists" create is
 * tolerated). Returns the key string.
 *
 * v0.29 references the user by numeric id for `preauthkeys create`, so we resolve
 * the id from `users list --output json` after ensuring the user exists.
 */
export async function mintPreauthKey(input: MintPreauthKeyInput): Promise<string> {
  // Unprivileged: headscale runs as the invoking user, so its admin socket
  // (pinned via `unix_socket` under the host-control home) is user-owned and
  // the CLI resolves it from the same `--config`. No sudo — this is what
  // makes member adds and key rotation daemon-callable.
  const run = (args: string[], opts?: { input?: string }) =>
    input.runner.run(input.headscaleBin, ['--config', input.configPath, ...args], opts);

  // 1. Ensure the user exists (tolerate "already exists").
  const created = await run(['users', 'create', input.user, '--output', 'json']);
  if (created.exitCode !== 0 && !/already exists|taken|unique/i.test(created.stdout)) {
    throw new Error(`headscale users create ${input.user} failed (exit ${created.exitCode}): ${created.stdout.trim()}`);
  }

  // 2. Resolve the user id.
  const listed = await run(['users', 'list', '--output', 'json']);
  if (listed.exitCode !== 0) {
    throw new Error(`headscale users list failed (exit ${listed.exitCode}): ${listed.stdout.trim()}`);
  }
  const userId = parseUserId(listed.stdout, input.user);
  if (userId === null) {
    throw new Error(`headscale user "${input.user}" not found after create — cannot mint a pre-auth key.`);
  }

  // 3. Mint the one-time key.
  const minted = await run([
    'preauthkeys', 'create', '--user', String(userId), '--expiration', input.expiration, '--output', 'json',
  ]);
  if (minted.exitCode !== 0) {
    throw new Error(`headscale preauthkeys create failed (exit ${minted.exitCode}): ${minted.stdout.trim()}`);
  }
  const key = parsePreauthKey(minted.stdout);
  if (!key) {
    throw new Error(`could not parse the pre-auth key from headscale output: ${minted.stdout.trim()}`);
  }
  return key;
}

/** Extract a user's numeric id from `headscale users list --output json`. */
export function parseUserId(json: string, user: string): number | null {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return null; }
  const users = Array.isArray(parsed) ? parsed : (parsed as { users?: unknown[] })?.users;
  if (!Array.isArray(users)) return null;
  for (const u of users) {
    const rec = u as { id?: unknown; name?: unknown };
    if (rec.name === user) {
      const id = typeof rec.id === 'string' ? Number(rec.id) : rec.id;
      return typeof id === 'number' && Number.isFinite(id) ? id : null;
    }
  }
  return null;
}

/** Extract the key string from `headscale preauthkeys create --output json`. */
export function parsePreauthKey(json: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch {
    // Non-JSON fallback: some versions print the bare key on stdout.
    const trimmed = json.trim();
    return /^[a-f0-9]{16,}$/i.test(trimmed) ? trimmed : null;
  }
  const key = (parsed as { key?: unknown }).key;
  return typeof key === 'string' && key.trim() ? key.trim() : null;
}
