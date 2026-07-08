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
 * SUPERVISION SHAPE — a per-user LaunchAgent, NO root (the deliberate opposite of
 * Task 2.1's host tailscaled). Task 2.1 installs the HOST's tailscaled as a ROOT
 * system daemon because a host must survive reboot-before-login. A MEMBER only
 * needs the overlay while it is logged in and using Myco, so its userspace
 * tailscaled is exactly what `@myco/service`'s user-domain manager was built for
 * (`gui/<uid>` LaunchAgent on macOS, `systemd --user` on Linux) — the same
 * manager that supervises Myco's own daemon. So this reuses `getServiceManager()`
 * directly; it never shells `sudo` and never touches the system domain.
 *
 * DIAL MECHANISM — HTTP CONNECT, matching the proxy. Task 1.3's `defaultDial`
 * tunnels through a local HTTP-CONNECT proxy at `127.0.0.1:<proxy_port>`
 * (`connectViaHttpProxy`). So the member's tailscaled exposes an
 * `--outbound-http-proxy-listen=localhost:<port>` listener (NOT `--socks5-server`)
 * and that port is recorded as `HostRecord.proxy_port`. One tailscaled, one
 * listener, shared by every joined host.
 *
 * IDEMPOTENT: a re-join of the same host converges — the LaunchAgent install is a
 * content-compare no-op, an already-joined node (a resolvable 100.64 IP) skips
 * the single-use key `up`, and the existing `HostRecord` is UPDATED (its attached
 * projects preserved), never duplicated.
 */
import os from 'node:os';
import path from 'node:path';

import { getServiceManager } from '@myco/service/manager.js';
import type { ServiceManager, ServiceSpec } from '@myco/service/types.js';
import { isOverlayRangeAddress } from '@myco/daemon/host-serve.js';

import {
  HOST_BEARER_SECRET,
  HOST_PROTOCOL_VERSION,
  MEMBER_OVERLAY_PROXY_PORT,
} from '../constants.js';
import {
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

/** The member userspace-tailscaled LaunchAgent label — distinct from Task 2.1's
 *  root labels (`com.tailscale.tailscaled` / `co.goondocks.myco-tailscaled`) so a
 *  machine could in principle be both without a unit collision. */
export const MEMBER_TAILSCALED_LABEL = 'co.goondocks.myco-member-tailscaled';

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
  /** The `<host>` positional — a host_id. */
  hostRef: string;
  /** Headscale control-plane URL (from `--server-url`). */
  serverUrl?: string;
  /** The one-time key the operator passed (single-use). */
  oneTimeKey: string;
  /** This member's node name on the tailnet. */
  memberHostname: string;
  /** This member's own resolved 100.64 overlay IP (post-join). */
  memberOverlayIp: string;
  // --- pre-2.4 manual bridge (see stubEnrollmentClient) ---
  overlayAddress?: string;
  bearer?: string;
  protocolVersion?: number;
  hostId?: string;
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
 * supplies `--overlay-address` and `--bearer` (and optionally `--host-id`,
 * `--label`, `--protocol-version`) and this stub assembles the enrollment from
 * them. Missing both is a hard, explanatory failure rather than a fabricated
 * record — no credential is ever invented.
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
      host_id: ctx.hostId ?? ctx.hostRef,
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
   *  joined overlay; omittable when this machine is already on the tailnet. */
  serverUrl?: string;
  /** Member node name on the tailnet. Default: sanitized `os.hostname()`. */
  hostname?: string;
  // --- pre-2.4 manual enrollment bridge (see stubEnrollmentClient) ---
  overlayAddress?: string;
  bearer?: string;
  protocolVersion?: number;
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
  /** The local HTTP-CONNECT listener port. Default {@link MEMBER_OVERLAY_PROXY_PORT}. */
  proxyPort?: number;
  /** Overrides for the tailscaled socket/state/bin dirs (tests inject temp/short paths). */
  socketPath?: string;
  stateDir?: string;
  binDir?: string;
  /** Resolve this member's own 100.64 overlay IP (post-join sanity). */
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
  const proxyPort = deps.proxyPort ?? MEMBER_OVERLAY_PROXY_PORT;
  const socketPath = deps.socketPath ?? resolveMemberTailscaledSocketPath();
  const stateDir = deps.stateDir ?? resolveMemberTailscaledStateDir();
  const binDir = deps.binDir ?? resolveMemberBinDir();
  const overlayDir = resolveMemberOverlayDir();
  const hostname = sanitizeHostname(options.hostname ?? os.hostname());

  assertSocketPathFits(socketPath, platform);

  // 1. Provision the Tailscale client + daemon (shared with the host; NO headscale).
  log(`Provisioning Tailscale for ${target.os}/${target.arch}…`);
  const tailscale = await provisionTailscaleBinaries({ target, fetcher, runner, binDir, brewBinDirs: deps.brewBinDirs, logger: log });

  // 2. Supervise userspace tailscaled as a per-user LaunchAgent (NO root).
  const spec = buildMemberTailscaledSpec({
    executable: tailscale.tailscaledBin,
    socketPath,
    stateDir,
    proxyPort,
    workingDir: overlayDir,
    logDir: path.join(overlayDir, 'logs'),
  });
  const install = await serviceManager.install(spec);
  const status = await serviceManager.status(spec.label);
  if (!status.running) {
    await serviceManager.start(spec.label);
    log(`member tailscaled ${install.changed ? 'installed' : 'present'} + started (user LaunchAgent ${spec.label}).`);
  } else {
    log(`member tailscaled already running (user LaunchAgent ${spec.label}).`);
  }

  // 3. Join the overlay — but only if this node isn't already on the tailnet.
  //    The one-time key is single-use, so a converging re-join must NOT re-`up`.
  const resolveIp = deps.resolveMemberOverlayIp ?? defaultResolveMemberOverlayIp;
  let memberOverlayIp = await resolveIp(runner, tailscale.tailscaleBin, socketPath);
  if (memberOverlayIp) {
    log(`already on the overlay at ${memberOverlayIp} — skipping the one-time-key join.`);
  } else {
    if (!options.serverUrl?.trim()) {
      throw new Error('join requires --server-url <headscale-url> to join the overlay (this machine is not on a tailnet yet).');
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
        + 'If the key reports "authkey already used", mint a fresh one-time key on the host and retry.',
      );
    }
    memberOverlayIp = await resolveIp(runner, tailscale.tailscaleBin, socketPath);
  }

  if (!memberOverlayIp || !isOverlayRangeAddress(memberOverlayIp)) {
    throw new Error(
      `Could not resolve a 100.64.0.0/10 overlay IP for this member after join (got ${JSON.stringify(memberOverlayIp)}). `
      + 'The overlay join may not have completed — check the tailscaled LaunchAgent logs and retry.',
    );
  }
  log(`Member overlay IP: ${memberOverlayIp}`);

  // 4. Enroll: obtain the host's overlay address + serve-bearer (Task 2.4 seam).
  const enrollment = await enrollmentClient.enroll({
    hostRef: options.hostRef.trim(),
    serverUrl: options.serverUrl?.trim(),
    oneTimeKey: options.key,
    memberHostname: hostname,
    memberOverlayIp,
    overlayAddress: options.overlayAddress?.trim(),
    bearer: options.bearer?.trim(),
    protocolVersion: options.protocolVersion,
    hostId: options.hostId?.trim(),
    label: options.label?.trim(),
  });

  // 5. Best-effort reachability probe (never fatal — the live checklist is the
  //    authoritative verification).
  const reachProbe = deps.checkHostReachable ?? defaultCheckHostReachable;
  const hostReachable = await reachProbe(enrollment.overlay_address, proxyPort).catch(() => false);
  log(hostReachable
    ? `Host daemon reachable over the overlay via the local proxy (127.0.0.1:${proxyPort}).`
    : 'Host daemon not confirmed reachable yet — verify with `myco doctor` after the overlay settles.');
  if (!hostReachable) notes.push('host daemon not confirmed reachable over the overlay');

  // 6. Write the HostRecord (+ bearer). Merge onto any existing record so a
  //    converging re-join preserves attached projects + created_at.
  const existing = getHost(enrollment.host_id);
  const record: HostRecord = {
    host_id: enrollment.host_id,
    label: enrollment.label,
    overlay_address: enrollment.overlay_address,
    proxy_port: proxyPort,
    protocol_version: enrollment.protocol_version,
    created_at: existing?.created_at ?? new Date().toISOString(),
    projects: existing?.projects ?? enrollment.projects ?? [],
  };
  upsertHost(record);
  // The bearer NEVER lands in host.json — only in the record's secrets.env.
  writeHostSecret(enrollment.host_id, HOST_BEARER_SECRET, enrollment.bearer);
  log(`${existing ? 'Updated' : 'Wrote'} host record ${enrollment.host_id} (proxy_port=${proxyPort}).`);

  return {
    hostId: enrollment.host_id,
    overlayAddress: enrollment.overlay_address,
    proxyPort,
    memberOverlayIp,
    hostReachable,
    created: !existing,
    notes,
  };
}

// ---------------------------------------------------------------------------
// leave
// ---------------------------------------------------------------------------

export interface LeaveResult {
  removed: boolean;
  /** True when this was the LAST host and the LaunchAgent was torn down. */
  tailscaledRemoved: boolean;
  notes: string[];
}

/**
 * Detach this machine from a host: remove the HostRecord (+ bearer + attach
 * refs), and — when no other host remains — tear down the member tailscaled
 * LaunchAgent (the overlay is no longer needed). Idempotent: an unknown host is a
 * no-op, and a tear-down of an absent LaunchAgent tolerates the miss.
 */
export async function leaveHost(hostRef: string, deps: MemberOverlayDeps = {}): Promise<LeaveResult> {
  if (!hostRef?.trim()) throw new Error('leave requires a <host> — the host_id to detach from.');
  const log = deps.logger ?? ((m: string) => console.log(m));
  const platform = deps.platform ?? process.platform;
  const serviceManager = deps.serviceManager ?? getServiceManager({ platform });
  const notes: string[] = [];

  const record = getHost(hostRef.trim());
  if (!record) {
    log(`Not joined to host ${hostRef} — nothing to remove.`);
    return { removed: false, tailscaledRemoved: false, notes };
  }
  if (record.projects.length > 0) {
    notes.push(`removing ${record.projects.length} attach ref(s) for host ${record.host_id}`);
  }
  removeHost(record.host_id);
  log(`Removed host record + bearer for ${record.host_id}.`);

  // Tear down the shared tailscaled only when this was the last joined host.
  let tailscaledRemoved = false;
  if (readHostRegistry().length === 0) {
    try {
      await serviceManager.uninstall(MEMBER_TAILSCALED_LABEL);
      tailscaledRemoved = true;
      log('No hosts remain — member tailscaled LaunchAgent uninstalled.');
    } catch (err) {
      notes.push(`tailscaled uninstall: ${(err as Error).message}`);
    }
  } else {
    log('Other hosts remain joined — leaving the member tailscaled LaunchAgent running.');
  }

  return { removed: true, tailscaledRemoved, notes };
}

// ---------------------------------------------------------------------------
// Spec + default seams
// ---------------------------------------------------------------------------

/**
 * Build the {@link ServiceSpec} for the member's userspace tailscaled — a
 * per-user LaunchAgent (NO root). `--tun=userspace-networking` (no kernel TUN, no
 * privilege), a SHORT `--socket`, a `--statedir` under the member home, and the
 * HTTP-CONNECT `--outbound-http-proxy-listen` the proxy dials.
 */
export function buildMemberTailscaledSpec(input: {
  executable: string;
  socketPath: string;
  stateDir: string;
  proxyPort: number;
  workingDir: string;
  logDir: string;
}): ServiceSpec {
  return {
    label: MEMBER_TAILSCALED_LABEL,
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
    stdoutPath: path.join(input.logDir, `${MEMBER_TAILSCALED_LABEL}.out.log`),
    stderrPath: path.join(input.logDir, `${MEMBER_TAILSCALED_LABEL}.err.log`),
    runAtLoad: true,
    keepAlive: true,
    throttleSeconds: 10,
  };
}

/** `tailscale --socket=<sock> ip -4` → the first line, iff it is a 100.64/10 address. */
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
 * Best-effort reachability probe: HTTP-CONNECT through the local proxy to the
 * host's overlay address, then a short `/health` GET. Any HTTP response (even a
 * 401 from the host bearer gate) proves the tunnel + host listener are up. Never
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
 * error. {@link resolveMemberTailscaledSocketPath} already keeps the default
 * short; this catches a bad INJECTED override loudly at the call site.
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
