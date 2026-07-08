/**
 * `myco join <host>` / `myco leave <host>` orchestration (Task 2.2) — the
 * MEMBER side of the Team Host overlay.
 *
 * A member machine runs standard Myco. To route an attached project to a host it
 * must (1) stand up a userspace `tailscaled` and join the host's overlay, then
 * (2) write the `HostRecord` (+ bearer) that the Phase-1 proxy (`daemon/host-
 * proxy.ts`) already consumes. This module does both, behind injectable seams so
 * the whole flow unit-tests with no network, no launchctl, and no real join.
 *
 * MULTI-HOST — one tailscaled PER host. Each host runs its OWN Headscale, i.e. its
 * own single tailnet, and each tailnet independently hands out `100.64.0.0/10` —
 * so two joined hosts can BOTH be `100.64.0.1`. A single tailscaled binds exactly
 * one `--login-server`, so the member runs one userspace tailscaled PER host, each
 * keyed by host_id with its own short socket, its own statedir (under that host's
 * registry dir), its own LaunchAgent label, and its own outbound-proxy listener on
 * a DISTINCT port. That `proxy_port` — persisted on the host record and reused on
 * restart — is what selects the right tailnet's tailscaled for a dial even when
 * `overlay_address` collides (the proxy dials `CONNECT <overlay_address> via
 * localhost:<proxy_port>`, so distinct ports fully disambiguate).
 *
 * SUPERVISION SHAPE — a per-user LaunchAgent, NO root (the deliberate opposite of
 * Task 2.1's host tailscaled). Task 2.1 installs the HOST's tailscaled as a ROOT
 * system daemon because a host must survive reboot-before-login. A MEMBER only
 * needs the overlay while it is logged in and using Myco, so its userspace
 * tailscaled is exactly what `@myco/service`'s user-domain manager was built for
 * (`gui/<uid>` LaunchAgent on macOS, `systemd --user` on Linux). So this reuses
 * `getServiceManager()` directly; it never shells `sudo`, one LaunchAgent per host.
 *
 * DIAL MECHANISM — HTTP CONNECT, matching the proxy. Task 1.3's `defaultDial`
 * tunnels through a local HTTP-CONNECT proxy at `127.0.0.1:<proxy_port>`
 * (`connectViaHttpProxy`). So each host's tailscaled exposes an
 * `--outbound-http-proxy-listen=localhost:<port>` listener (NOT `--socks5-server`)
 * and that port is recorded as `HostRecord.proxy_port`.
 *
 * IDEMPOTENT: a re-join of the same host converges — the LaunchAgent install is a
 * content-compare no-op, THIS host's already-joined node (a resolvable 100.64 IP
 * on THIS host's socket) skips the single-use key `up`, the persisted `proxy_port`
 * is reused, and the existing `HostRecord` is UPDATED (its attached projects
 * preserved), never duplicated.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getServiceManager } from '@myco/service/manager.js';
import type { ServiceManager, ServiceSpec } from '@myco/service/types.js';
import { isOverlayRangeAddress } from '@myco/daemon/host-serve.js';

import {
  HOST_BEARER_SECRET,
  HOST_PROTOCOL_VERSION,
  MEMBER_OVERLAY_PROXY_PORT_BASE,
} from '../constants.js';
import {
  memberHostTag,
  resolveMemberBinDir,
  resolveMemberOverlayDir,
  resolveMemberTailscaledSocketPath,
  resolveMemberTailscaledStateDir,
} from '../grove/paths.js';
import {
  provisionTailscaleBinaries,
  realCommandRunner,
  realFetcher,
  resolveOverlayTarget,
  type BinaryFetcher,
  type CommandRunner,
} from './overlay-binaries.js';
import {
  getHost,
  readHostRegistry,
  removeHost,
  upsertHost,
  writeHostSecret,
  type AttachRef,
  type HostRecord,
} from './registry.js';

/** The member userspace-tailscaled LaunchAgent label PREFIX. The per-host label
 *  appends a short host tag (`memberTailscaledLabel`) so each joined host gets its
 *  own agent — distinct from Task 2.1's root labels (`com.tailscale.tailscaled` /
 *  `co.goondocks.myco-tailscaled`) so a machine could be both without a collision. */
export const MEMBER_TAILSCALED_LABEL_PREFIX = 'co.goondocks.myco-member-tailscaled';

/** This host's userspace-tailscaled LaunchAgent label. */
export function memberTailscaledLabel(hostId: string): string {
  return `${MEMBER_TAILSCALED_LABEL_PREFIX}.${memberHostTag(hostId)}`;
}

/** How long `join` waits for a freshly-started tailscaled to bind its socket
 *  before `tailscale up` (the start→up race). Bounded, then a clear error. */
export const MEMBER_TAILSCALED_SOCKET_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Enrollment seam (Task 2.4 provides the real host-side endpoint)
// ---------------------------------------------------------------------------

/** What the host tells a member at enrollment: its identity, its overlay address
 *  (100.64 IP + daemon port), the shared serve-bearer, and its wire version. */
export interface HostEnrollment {
  host_id: string;
  label: string;
  /** The HOST's overlay address the proxy dials — `100.64.x.y:<daemon-port>`. */
  overlay_address: string;
  protocol_version: number;
  /** The shared host serve-bearer, stored under {@link HOST_BEARER_SECRET}. */
  bearer: string;
  /** Projects the host pre-associates at enrollment (usually empty — attach is a
   *  separate, UI-driven step). Preserved onto the record if present. */
  projects?: AttachRef[];
}

/** Everything the enrollment step knows after the overlay join. */
export interface EnrollmentContext {
  /** The canonical host_id being joined (`--host-id` ?? the `<host>` positional). */
  hostId: string;
  /** The `<host>` positional as typed. */
  hostRef: string;
  /** Headscale control-plane URL (from `--server-url`). */
  serverUrl?: string;
  /** The one-time key the operator passed (single-use). */
  oneTimeKey: string;
  /** This member's node name on the tailnet. */
  memberHostname: string;
  /** This member's own resolved 100.64 overlay IP on THIS host's tailnet (post-join). */
  memberOverlayIp: string;
  // --- pre-2.4 manual bridge (see stubEnrollmentClient) ---
  overlayAddress?: string;
  bearer?: string;
  protocolVersion?: number;
  label?: string;
}

export interface EnrollmentClient {
  /** Obtain the host serve-bearer + overlay address over the overlay. */
  enroll(ctx: EnrollmentContext): Promise<HostEnrollment>;
}

/**
 * Default enrollment client — a STUB until Task 2.4 builds the host enrollment
 * endpoint.
 *
 * TODO(2.4): replace the body below with the real overlay call — POST to the
 * host's enrollment endpoint (spec §8), which admits the member and returns
 * `{host_id, label, overlay_address, protocol_version, bearer}`. The member is
 * already on the overlay at this point (join happened first), so the call rides
 * the local proxy exactly like any other host request.
 *
 * Until then, `join` stays USABLE and testable via a manual bridge: the operator
 * supplies `--overlay-address` and `--bearer` (and optionally `--label`,
 * `--protocol-version`) and this stub assembles the enrollment from them. Missing
 * both is a hard, explanatory failure rather than a fabricated record — no
 * credential is ever invented.
 */
export const stubEnrollmentClient: EnrollmentClient = {
  async enroll(ctx: EnrollmentContext): Promise<HostEnrollment> {
    if (!ctx.overlayAddress || !ctx.bearer) {
      throw new Error(
        'Automatic host enrollment is not available yet (Task 2.4 delivers the host enrollment endpoint). '
        + 'For now, obtain the host overlay address + serve-bearer from the host operator and pass them explicitly:\n'
        + '  myco join <host> --key <one-time-key> --server-url <headscale-url> '
        + '--overlay-address <100.64.x.y:port> --bearer <serve-bearer>',
      );
    }
    return {
      host_id: ctx.hostId,
      label: ctx.label ?? ctx.hostRef,
      overlay_address: ctx.overlayAddress,
      protocol_version: ctx.protocolVersion ?? HOST_PROTOCOL_VERSION,
      bearer: ctx.bearer,
    };
  },
};

// ---------------------------------------------------------------------------
// Options / deps / result
// ---------------------------------------------------------------------------

export interface JoinOptions {
  /** The `<host>` positional — a host_id (matches the affiliation hint's
   *  `myco join <host_id>`). */
  hostRef: string;
  /** The one-time pre-auth key the operator passed (single-use). */
  key: string;
  /** Headscale control-plane URL (`--server-url`). Required to join a NOT-yet-
   *  joined overlay; omittable when this host is already joined. */
  serverUrl?: string;
  /** Member node name on the tailnet. Default: sanitized `os.hostname()`. */
  hostname?: string;
  // --- pre-2.4 manual enrollment bridge (see stubEnrollmentClient) ---
  overlayAddress?: string;
  bearer?: string;
  protocolVersion?: number;
  /** Canonical host_id override (when the positional is not itself the id). */
  hostId?: string;
  label?: string;
}

export interface MemberOverlayDeps {
  fetcher?: BinaryFetcher;
  runner?: CommandRunner;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  /** USER-domain service manager. Default `getServiceManager()` (LaunchAgent /
   *  systemd --user) — NEVER a root/system manager. */
  serviceManager?: ServiceManager;
  brewBinDirs?: string[];
  enrollmentClient?: EnrollmentClient;
  /** Override the allocated per-host HTTP-CONNECT listener port (tests). */
  proxyPort?: number;
  /** Overrides for THIS host's tailscaled socket/state/bin dirs (tests inject temp/short paths). */
  socketPath?: string;
  stateDir?: string;
  binDir?: string;
  /** Wait for the just-started tailscaled to bind its socket before `up`
   *  (the start→up race). Default polls the socket path; tests inject a stub. */
  waitForSocket?: (socketPath: string) => Promise<boolean>;
  /** Resolve this member's own 100.64 overlay IP ON THIS HOST'S SOCKET (post-join sanity). */
  resolveMemberOverlayIp?: (runner: CommandRunner, tailscaleBin: string, socketPath: string) => Promise<string | null>;
  /** Best-effort reachability probe to the host over the overlay (never fatal). */
  checkHostReachable?: (overlayAddress: string, proxyPort: number) => Promise<boolean>;
  logger?: (message: string) => void;
}

export interface JoinResult {
  hostId: string;
  overlayAddress: string;
  proxyPort: number;
  memberOverlayIp: string;
  hostReachable: boolean;
  /** True when this join created the record; false when it converged an existing one. */
  created: boolean;
  notes: string[];
}

// ---------------------------------------------------------------------------
// join
// ---------------------------------------------------------------------------

export async function joinHost(options: JoinOptions, deps: MemberOverlayDeps = {}): Promise<JoinResult> {
  if (!options.hostRef?.trim()) {
    throw new Error('join requires a <host> — the host_id to enroll this machine with.');
  }
  if (!options.key?.trim()) {
    throw new Error('join requires --key <one-time-key> — the single-use pre-auth key the host operator minted.');
  }

  const log = deps.logger ?? ((m: string) => console.log(m));
  const notes: string[] = [];
  const runner = deps.runner ?? realCommandRunner;
  const fetcher = deps.fetcher ?? realFetcher;
  const platform = deps.platform ?? process.platform;
  const target = resolveOverlayTarget(platform, deps.arch ?? process.arch);
  const serviceManager = deps.serviceManager ?? getServiceManager({ platform });
  const enrollmentClient = deps.enrollmentClient ?? stubEnrollmentClient;
  const hostname = sanitizeHostname(options.hostname ?? os.hostname());

  // Canonical per-host key: everything about THIS host's tailscaled instance
  // (socket, statedir, label, proxy port, record) is keyed on it.
  const hostId = (options.hostId ?? options.hostRef).trim();
  const socketPath = deps.socketPath ?? resolveMemberTailscaledSocketPath(hostId);
  const stateDir = deps.stateDir ?? resolveMemberTailscaledStateDir(hostId);
  const binDir = deps.binDir ?? resolveMemberBinDir();
  const label = memberTailscaledLabel(hostId);
  // Persisted proxy_port: reuse THIS host's existing record's port (stable across
  // restarts), else allocate the lowest free port not used by another host.
  const proxyPort = deps.proxyPort ?? allocateMemberProxyPort(hostId);
  const overlayDir = resolveMemberOverlayDir();

  assertSocketPathFits(socketPath, platform);

  // 1. Provision the Tailscale client + daemon (shared across hosts; NO headscale).
  log(`Provisioning Tailscale for ${target.os}/${target.arch}…`);
  const tailscale = await provisionTailscaleBinaries({ target, fetcher, runner, binDir, brewBinDirs: deps.brewBinDirs, logger: log });

  // 2. Supervise THIS host's userspace tailscaled as a per-user LaunchAgent (NO root).
  const spec = buildMemberTailscaledSpec({
    hostId,
    executable: tailscale.tailscaledBin,
    socketPath,
    stateDir,
    proxyPort,
    workingDir: overlayDir,
    logDir: path.join(overlayDir, 'logs'),
  });
  const install = await serviceManager.install(spec);
  const status = await serviceManager.status(label);
  if (!status.running) {
    await serviceManager.start(label);
    log(`member tailscaled ${install.changed ? 'installed' : 'present'} + started (user LaunchAgent ${label}).`);
  } else {
    log(`member tailscaled already running (user LaunchAgent ${label}).`);
  }

  // 3. Wait for the freshly-started tailscaled to bind its socket before we drive
  //    the CLI against it (the start→up race). Bounded, then a clear error.
  const waitForSocket = deps.waitForSocket ?? defaultWaitForSocket;
  if (!(await waitForSocket(socketPath))) {
    throw new Error(
      `The userspace tailscaled socket ${socketPath} did not appear within ${MEMBER_TAILSCALED_SOCKET_TIMEOUT_MS}ms. `
      + `The LaunchAgent ${label} may have failed to start — check its logs (${path.join(overlayDir, 'logs')}) and retry.`,
    );
  }

  // 4. Join THIS host's tailnet — but only if THIS host's node isn't already on it.
  //    Keyed on THIS host's socket (not "any overlay IP"), so a second host on a
  //    different tailnet is not mistaken for already-joined. The one-time key is
  //    single-use, so a converging re-join must NOT re-`up`.
  const resolveIp = deps.resolveMemberOverlayIp ?? defaultResolveMemberOverlayIp;
  let memberOverlayIp = await resolveIp(runner, tailscale.tailscaleBin, socketPath);
  if (memberOverlayIp) {
    log(`this host's node already on the overlay at ${memberOverlayIp} — skipping the one-time-key join.`);
  } else {
    if (!options.serverUrl?.trim()) {
      throw new Error("join requires --server-url <headscale-url> to join this host's overlay (its tailscaled is not on the tailnet yet).");
    }
    log('Joining the overlay with the one-time key…');
    const up = await runner.run(tailscale.tailscaleBin, [
      '--socket', socketPath,
      'up',
      '--login-server', options.serverUrl.trim(),
      '--auth-key', options.key,
      '--hostname', hostname,
    ]);
    if (up.exitCode !== 0) {
      throw new Error(
        `\`tailscale up\` failed (exit ${up.exitCode}): ${up.stdout.trim()}. `
        + 'If the tailscaled socket was not ready the agent may still be starting — retry. '
        + 'If it reports "authkey already used", mint a fresh one-time key on the host and retry.',
      );
    }
    memberOverlayIp = await resolveIp(runner, tailscale.tailscaleBin, socketPath);
  }

  if (!memberOverlayIp || !isOverlayRangeAddress(memberOverlayIp)) {
    throw new Error(
      `Could not resolve a 100.64.0.0/10 overlay IP for this member on host ${hostId} after join (got ${JSON.stringify(memberOverlayIp)}). `
      + 'The overlay join may not have completed — check the tailscaled LaunchAgent logs and retry.',
    );
  }
  log(`Member overlay IP on host ${hostId}: ${memberOverlayIp}`);

  // 5. Enroll: obtain the host's overlay address + serve-bearer (Task 2.4 seam).
  const enrollment = await enrollmentClient.enroll({
    hostId,
    hostRef: options.hostRef.trim(),
    serverUrl: options.serverUrl?.trim(),
    oneTimeKey: options.key,
    memberHostname: hostname,
    memberOverlayIp,
    overlayAddress: options.overlayAddress?.trim(),
    bearer: options.bearer?.trim(),
    protocolVersion: options.protocolVersion,
    label: options.label?.trim(),
  });

  // 6. Best-effort reachability probe through THIS host's proxy port (never fatal).
  const reachProbe = deps.checkHostReachable ?? defaultCheckHostReachable;
  const hostReachable = await reachProbe(enrollment.overlay_address, proxyPort).catch(() => false);
  log(hostReachable
    ? `Host daemon reachable over the overlay via the local proxy (127.0.0.1:${proxyPort}).`
    : 'Host daemon not confirmed reachable yet — verify with `myco doctor` after the overlay settles.');
  if (!hostReachable) notes.push('host daemon not confirmed reachable over the overlay');

  // 7. Write THIS host's HostRecord (+ bearer). Merge onto any existing record so a
  //    converging re-join preserves attached projects + created_at.
  const existing = getHost(hostId);
  const record: HostRecord = {
    host_id: hostId,
    label: enrollment.label,
    overlay_address: enrollment.overlay_address,
    proxy_port: proxyPort,
    protocol_version: enrollment.protocol_version,
    created_at: existing?.created_at ?? new Date().toISOString(),
    projects: existing?.projects ?? enrollment.projects ?? [],
  };
  upsertHost(record);
  // The bearer NEVER lands in host.json — only in the record's secrets.env.
  writeHostSecret(hostId, HOST_BEARER_SECRET, enrollment.bearer);
  log(`${existing ? 'Updated' : 'Wrote'} host record ${hostId} (proxy_port=${proxyPort}).`);

  return {
    hostId,
    overlayAddress: enrollment.overlay_address,
    proxyPort,
    memberOverlayIp,
    hostReachable,
    created: !existing,
    notes,
  };
}

/**
 * Allocate the persisted HTTP-CONNECT listener port for a host. THIS host's
 * existing record's port is reused (stable across restarts — the proxy's dial
 * must not move); otherwise the lowest port at/above the base not already used by
 * another host record is chosen. Persisting the choice on the record is what keeps
 * every host's dial target stable while guaranteeing per-host distinctness.
 */
export function allocateMemberProxyPort(hostId: string): number {
  const existing = getHost(hostId);
  if (existing?.proxy_port) return existing.proxy_port;
  const used = new Set(
    readHostRegistry().map((r) => r.proxy_port).filter((p): p is number => typeof p === 'number'),
  );
  let port = MEMBER_OVERLAY_PROXY_PORT_BASE;
  while (used.has(port)) port += 1;
  return port;
}

// ---------------------------------------------------------------------------
// leave
// ---------------------------------------------------------------------------

export interface LeaveResult {
  removed: boolean;
  /** True when THIS host's tailscaled LaunchAgent was torn down. */
  tailscaledRemoved: boolean;
  notes: string[];
}

/**
 * Detach this machine from a host: tear down ONLY this host's tailscaled instance
 * (its LaunchAgent + socket), then remove its HostRecord (+ bearer + attach refs +
 * statedir). Every OTHER joined host — its own tailscaled, record, and bearer — is
 * untouched. Idempotent: an unknown host is a no-op, and an absent LaunchAgent /
 * socket tolerates the miss.
 */
export async function leaveHost(hostRef: string, deps: MemberOverlayDeps = {}): Promise<LeaveResult> {
  if (!hostRef?.trim()) throw new Error('leave requires a <host> — the host_id to detach from.');
  const log = deps.logger ?? ((m: string) => console.log(m));
  const platform = deps.platform ?? process.platform;
  const serviceManager = deps.serviceManager ?? getServiceManager({ platform });
  const notes: string[] = [];
  const hostId = hostRef.trim();

  const record = getHost(hostId);
  if (!record) {
    log(`Not joined to host ${hostId} — nothing to remove.`);
    return { removed: false, tailscaledRemoved: false, notes };
  }
  if (record.projects.length > 0) {
    notes.push(`removing ${record.projects.length} attach ref(s) for host ${hostId}`);
  }

  // Stop THIS host's tailscaled FIRST (before deleting its statedir with the record).
  let tailscaledRemoved = false;
  const label = memberTailscaledLabel(hostId);
  try {
    await serviceManager.uninstall(label);
    tailscaledRemoved = true;
  } catch (err) {
    notes.push(`tailscaled uninstall (${label}): ${(err as Error).message}`);
  }
  // Best-effort: drop the (now-orphaned) socket file.
  try { fs.rmSync(deps.socketPath ?? resolveMemberTailscaledSocketPath(hostId), { force: true }); } catch { /* best-effort */ }

  // Remove the record + bearer + statedir (removeHost rmSyncs the whole host dir).
  removeHost(hostId);
  log(`Removed host record + bearer for ${hostId}; tore down its tailscaled (${label}).`);

  const remaining = readHostRegistry().length;
  if (remaining > 0) log(`${remaining} other host(s) still joined — their overlays are untouched.`);

  return { removed: true, tailscaledRemoved, notes };
}

// ---------------------------------------------------------------------------
// Spec + default seams
// ---------------------------------------------------------------------------

/**
 * Build the {@link ServiceSpec} for a host's userspace tailscaled — a per-user
 * LaunchAgent (NO root), one per joined host. `--tun=userspace-networking` (no
 * kernel TUN, no privilege), a SHORT per-host `--socket`, a per-host `--statedir`,
 * and the per-host HTTP-CONNECT `--outbound-http-proxy-listen` the proxy dials.
 */
export function buildMemberTailscaledSpec(input: {
  hostId: string;
  executable: string;
  socketPath: string;
  stateDir: string;
  proxyPort: number;
  workingDir: string;
  logDir: string;
}): ServiceSpec {
  const label = memberTailscaledLabel(input.hostId);
  return {
    label,
    variant: 'prod',
    executable: input.executable,
    args: [
      '--tun=userspace-networking',
      `--socket=${input.socketPath}`,
      `--statedir=${input.stateDir}`,
      `--outbound-http-proxy-listen=localhost:${input.proxyPort}`,
    ],
    workingDir: input.workingDir,
    env: {},
    stdoutPath: path.join(input.logDir, `${label}.out.log`),
    stderrPath: path.join(input.logDir, `${label}.err.log`),
    runAtLoad: true,
    keepAlive: true,
    throttleSeconds: 10,
  };
}

/** Poll for the tailscaled socket to appear, up to
 *  {@link MEMBER_TAILSCALED_SOCKET_TIMEOUT_MS}. Cheap fix for the start→up race:
 *  a freshly-installed LaunchAgent needs a moment to bind its socket. */
async function defaultWaitForSocket(socketPath: string): Promise<boolean> {
  const deadline = Date.now() + MEMBER_TAILSCALED_SOCKET_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return fs.existsSync(socketPath);
}

/** `tailscale --socket=<sock> ip -4` → the first line, iff it is a 100.64/10
 *  address. Keyed on THIS host's socket, so it reports THIS host's tailnet only. */
export async function defaultResolveMemberOverlayIp(
  runner: CommandRunner,
  tailscaleBin: string,
  socketPath: string,
): Promise<string | null> {
  const res = await runner.run(tailscaleBin, ['--socket', socketPath, 'ip', '-4']);
  if (res.exitCode !== 0) return null;
  const line = res.stdout.split('\n').map((l) => l.trim()).find(Boolean);
  return line && isOverlayRangeAddress(line) ? line : null;
}

/**
 * Best-effort reachability probe: HTTP-CONNECT through THIS host's local proxy to
 * the host's overlay address, then a short `/health` GET. Any HTTP response (even
 * a 401 from the host bearer gate) proves the tunnel + host listener are up. Never
 * throws — the live checklist is the authoritative verification.
 */
async function defaultCheckHostReachable(overlayAddress: string, proxyPort: number): Promise<boolean> {
  const { host, port } = splitOverlayAddress(overlayAddress);
  if (!host || !port) return false;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
    import('node:http').then((http) => {
      const authority = `${host}:${port}`;
      const connectReq = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: authority, headers: { host: authority } });
      const timer = setTimeout(() => { connectReq.destroy(); done(false); }, 2500);
      connectReq.once('connect', (res, socket) => {
        clearTimeout(timer);
        if (res.statusCode !== 200) { socket.destroy(); done(false); return; }
        const probe = http.request({ host, port, path: '/health', method: 'GET', createConnection: () => socket, timeout: 2500 }, (probeRes) => {
          probeRes.resume();
          done(true); // any response proves the host listener is bound
        });
        probe.once('error', () => done(false));
        probe.once('timeout', () => { probe.destroy(); done(false); });
        probe.end();
      });
      connectReq.once('error', () => { clearTimeout(timer); done(false); });
      connectReq.end();
    }).catch(() => done(false));
  });
}

function splitOverlayAddress(overlayAddress: string): { host: string; port: number } {
  const raw = overlayAddress.includes('://') ? overlayAddress : `http://${overlayAddress}`;
  try {
    const url = new URL(raw);
    return { host: url.hostname, port: url.port ? Number(url.port) : 80 };
  } catch {
    return { host: '', port: 0 };
  }
}

/**
 * Guard the macOS `AF_UNIX` `sun_path` limit (104 bytes) before we hand the path
 * to tailscaled — a too-long socket path fails `bind()` at runtime with an opaque
 * error. {@link resolveMemberTailscaledSocketPath} already keeps the default short
 * (a hashed per-host tag); this catches a bad INJECTED override loudly at the call
 * site.
 */
function assertSocketPathFits(socketPath: string, platform: NodeJS.Platform): void {
  const limit = platform === 'darwin' ? 104 : 108;
  const bytes = Buffer.byteLength(socketPath);
  if (bytes >= limit) {
    throw new Error(
      `tailscaled --socket path is ${bytes} bytes, at/over the ${platform} AF_UNIX limit of ${limit}: ${socketPath}. `
      + 'Use a shorter socket path (the default lives under ~/.myco-ts/).',
    );
  }
}

/** Reduce an arbitrary hostname to a tailnet-safe label. */
function sanitizeHostname(name: string): string {
  const clean = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return clean || 'myco-member';
}
