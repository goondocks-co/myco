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
import type {
  InstalledServiceCommand,
  ServiceManager,
  ServiceSpec,
} from '@myco/service/types.js';
import { isOverlayRangeAddress } from '@myco/daemon/host-serve.js';
import { acquireTunnelBridgePort } from '@myco/daemon/host-proxy.js';
import { isGroveEraId } from '@myco/grove/ids.js';

import {
  ENROLLMENT_RETRY_BACKOFFS_MS,
  HOST_BEARER_SECRET,
  HOST_ENROLL_ROUTE,
  HOST_MIN_COMPAT_VERSION,
  HOST_PROTOCOL_HEADER,
  HOST_PROTOCOL_VERSION,
  HOST_PROXY_CONNECT_TIMEOUT_MS,
  HOST_PROXY_HEADERS_TIMEOUT_MS,
} from '../constants.js';
import {
  memberHostTag,
  resolveHostDir,
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
  withHostOperationLock,
  type HostOperationLease,
} from './operation-lock.js';
import { withLoopbackPortReleaseProof } from './loopback-port-proof.js';
import { assertValidSecretEntry, InvalidSecretValueError } from '@myco/config/secrets.js';
import {
  nativePerUserLockNamespace,
  type PerUserLockNamespace,
} from '@myco/utils/per-user-lock-namespace.js';
import { codedMembershipError } from './membership-error.js';
import {
  abandonHostEnrollment,
  advanceHostEnrollmentPhase,
  getHost,
  inspectHostMembershipForLeave,
  isValidObservedHostProtocolVersion,
  markHostEnrollmentTeardownPending,
  persistEnrollmentMembership,
  readHostRegistry,
  releaseHostProxyPort,
  reserveHostProxyPort,
  retireHostMembership,
  type AttachRef,
  type EnrollmentHostRecord,
  type HostProxyPortReservation,
} from '@myco/host/registry.js';

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
  /** The host's self-reported served Grove (protocol v2). `undefined` when the
   *  host predates served-grove designation — its enrollment response carried
   *  no `served_grove_id` field at all (distinct from the host reporting one
   *  explicitly as absent). Persisted onto the {@link HostRecord} at join
   *  (step 7) and later consulted by `attachCommand` as the ONE grove source
   *  for a new attach ref — no `--grove` flag. */
  served_grove_id?: string | null;
  enrollment_receipt?: {
    enrollment_nonce: string;
    host_id: string;
    protocol_version: number;
  };
}

export interface EnrollmentResult extends HostEnrollment {
  projects?: unknown;
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
  /** The host's overlay address to dial for enrollment (`100.64.x.y:<daemon-port>`) —
   *  a NON-SECRET the operator hands the joiner alongside the one-time key. The real
   *  client CONNECTs here through the local proxy; the SECRET bearer comes back in the
   *  response (never handed out-of-band). Same field the manual bridge reuses. */
  overlayAddress?: string;
  /** THIS host's local HTTP-CONNECT proxy port — the tunnel the real enroll client
   *  dials through (the same `proxy_port` the routing proxy later uses). */
  proxyPort?: number;
  /** Stable, durable request correlation for repeatable enrollment. */
  enrollmentNonce?: string;
  // --- manual bridge (see stubEnrollmentClient) ---
  bearer?: string;
  protocolVersion?: number;
  label?: string;
}

export interface EnrollmentClient {
  /** Obtain the host serve-bearer + overlay address over the overlay. */
  enroll(ctx: EnrollmentContext): Promise<EnrollmentResult>;
}

/**
 * The MANUAL enrollment bridge (test seam + escape hatch). `join` selects it only
 * when the operator passes `--bearer` explicitly — i.e. they already hold the shared
 * bearer and want to skip the automatic overlay handshake (a host without the
 * enrollment endpoint, or debugging). The operator supplies `--overlay-address` and
 * `--bearer` (and optionally `--label`/`--protocol-version`) and this assembles the
 * enrollment from them. Missing either is a hard, explanatory failure rather than a
 * fabricated record — no credential is ever invented.
 *
 * The DEFAULT path is {@link realEnrollmentClient}, which fetches the bearer over the
 * overlay (spec §8), so the operator never has to hand the secret bearer out-of-band.
 */
export const stubEnrollmentClient: EnrollmentClient = {
  async enroll(ctx: EnrollmentContext): Promise<HostEnrollment> {
    if (!ctx.overlayAddress || ctx.bearer === undefined) {
      throw new Error(
        'The manual enrollment bridge requires BOTH --overlay-address and --bearer. '
        + 'Omit --bearer to enroll automatically over the overlay (the default), or pass both:\n'
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

/** The wire response the host enrollment endpoint returns. */
interface HostEnrollmentResponse {
  host_id: string;
  label: string;
  overlay_address: string;
  protocol_version: number;
  bearer: string;
  served_grove_id?: string | null;
  enrollment_receipt?: {
    enrollment_nonce: string;
    host_id: string;
    protocol_version: number;
  };
}

function enrollmentFailure(message: string): Error {
  return codedMembershipError('host_enroll_failed', message);
}

function requiredEnrollmentString(value: Record<string, unknown>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    throw enrollmentFailure(`Host enrollment response has an invalid ${field}.`);
  }
  return candidate;
}

function enrollmentIdentity(
  value: Record<string, unknown>,
  field: 'host_id' | 'label',
  fallback: string,
): string {
  const candidate = value[field];
  if (candidate === undefined || (typeof candidate === 'string' && candidate.trim().length === 0)) {
    return fallback;
  }
  if (typeof candidate !== 'string') {
    throw enrollmentFailure(`Host enrollment response has an invalid ${field}.`);
  }
  return candidate;
}

function isCanonicalOverlayAuthority(value: string): boolean {
  const { host, port } = splitOverlayAddress(value);
  return isOverlayRangeAddress(host)
    && Number.isSafeInteger(port)
    && port >= 1
    && port <= 65535
    && value === `${host}:${port}`;
}

/** Validate all wire values before they reach enrollment, reachability, or disk. */
function parseEnrollmentResponse(
  value: unknown,
  identityFallback: { hostId: string; label: string; enrollmentNonce?: string },
): HostEnrollmentResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw enrollmentFailure('Host enrollment returned a response Myco could not read.');
  }
  const response = value as Record<string, unknown>;
  if (Object.hasOwn(response, 'projects')
    && (!Array.isArray(response.projects) || response.projects.length !== 0)) {
    throw enrollmentFailure('Host enrollment cannot assign project attachments.');
  }

  const bearer = requiredEnrollmentString(response, 'bearer');
  try {
    assertValidSecretEntry(HOST_BEARER_SECRET, bearer);
  } catch (error) {
    if (!(error instanceof InvalidSecretValueError)) throw error;
    throw enrollmentFailure('Host enrollment response has an invalid bearer.');
  }

  const protocolVersion = response.protocol_version;
  if (typeof protocolVersion !== 'number'
    || !Number.isSafeInteger(protocolVersion)
    || protocolVersion < HOST_MIN_COMPAT_VERSION
    || protocolVersion > HOST_PROTOCOL_VERSION) {
    throw enrollmentFailure('Host enrollment response has an invalid protocol_version.');
  }

  const servedGroveId = response.served_grove_id;
  if (servedGroveId !== undefined && servedGroveId !== null
    && (typeof servedGroveId !== 'string' || !isGroveEraId(servedGroveId, 'grove'))) {
    throw enrollmentFailure('Host enrollment response has an invalid served_grove_id.');
  }

  const overlayAddress = requiredEnrollmentString(response, 'overlay_address');
  if (!isCanonicalOverlayAuthority(overlayAddress)) {
    throw enrollmentFailure('Host enrollment response has an invalid overlay_address.');
  }

  const hostId = enrollmentIdentity(response, 'host_id', identityFallback.hostId);
  let enrollmentReceipt: HostEnrollmentResponse['enrollment_receipt'];
  if (response.enrollment_receipt !== undefined) {
    const receipt = response.enrollment_receipt;
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
      throw enrollmentFailure('Host enrollment response has an invalid enrollment_receipt.');
    }
    const fields = receipt as Record<string, unknown>;
    if (typeof fields.enrollment_nonce !== 'string'
      || fields.enrollment_nonce !== identityFallback.enrollmentNonce
      || fields.host_id !== hostId
      || fields.protocol_version !== protocolVersion) {
      throw enrollmentFailure('Host enrollment response has a mismatched enrollment_receipt.');
    }
    enrollmentReceipt = {
      enrollment_nonce: fields.enrollment_nonce,
      host_id: fields.host_id,
      protocol_version: fields.protocol_version,
    };
  }

  return {
    host_id: hostId,
    label: enrollmentIdentity(response, 'label', identityFallback.label),
    overlay_address: overlayAddress,
    protocol_version: protocolVersion,
    bearer,
    ...(Object.hasOwn(response, 'served_grove_id')
      ? { served_grove_id: servedGroveId as string | null }
      : {}),
    ...(enrollmentReceipt ? { enrollment_receipt: enrollmentReceipt } : {}),
  };
}

function validateEnrollment(
  enrollment: EnrollmentResult,
  identityFallback: { hostId: string; label: string; enrollmentNonce?: string },
): EnrollmentResult {
  return parseEnrollmentResponse(enrollment, identityFallback);
}

/** How the real client puts an enrollment request on the wire. Injectable so tests
 *  can drive a fixture host without a live CONNECT proxy. Returns the raw status +
 *  body so the client owns parsing + the version-skew (409) mapping. */
export type EnrollmentTransport = (input: {
  overlayAddress: string;
  proxyPort: number;
  path: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<{ status: number; body: string }>;

/**
 * The real overlay enrollment transport: a POST tunneled through THIS host's local
 * userspace-tailscaled HTTP CONNECT proxy (`127.0.0.1:<proxyPort>`) to the host's
 * overlay address — the SAME dial as the routing proxy (`daemon/host-proxy.ts`),
 * riding its per-host loopback tunnel bridge ({@link acquireTunnelBridgePort} —
 * Bun's `node:http` client can neither drive a `method: 'CONNECT'` request nor
 * accept a caller-supplied socket; see the bridge doc). The Host header is pinned
 * to the overlay authority, matching the host's overlay CSRF allowlist.
 */
export const connectProxyEnrollTransport: EnrollmentTransport = ({ overlayAddress, proxyPort, path: reqPath, headers, body }) => {
  const { host, port } = splitOverlayAddress(overlayAddress);
  if (!host || !port) return Promise.reject(new Error(`Invalid host overlay address for enrollment: ${JSON.stringify(overlayAddress)}`));
  return new Promise((resolve, reject) => {
    Promise.all([import('node:http'), acquireTunnelBridgePort(proxyPort, host, port)]).then(([http, bridgePort]) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: bridgePort,
          path: reqPath,
          method: 'POST',
          headers: { ...headers, host: `${host}:${port}` },
          timeout: HOST_PROXY_HEADERS_TIMEOUT_MS,
          agent: false, // one-shot: a kept-alive socket would pin the tunnel open
        },
        (resp) => {
          const chunks: Buffer[] = [];
          resp.on('data', (c: Buffer) => chunks.push(c));
          resp.on('end', () => resolve({ status: resp.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
        },
      );
      req.once('error', reject);
      req.once('timeout', () => { req.destroy(); reject(new Error(`Enrollment request to ${host}:${port} via 127.0.0.1:${proxyPort} timed out.`)); });
      req.end(body);
    }).catch(reject);
  });
};

/**
 * The real enrollment client (Task 2.4) — the DEFAULT `join` path. The member is
 * already on the overlay, so this POSTs to the host's enrollment endpoint
 * ({@link HOST_ENROLL_ROUTE}) through the local proxy and returns the parsed
 * {@link HostEnrollment}. Enrollment is the ONE bearer-exempt overlay route (a member
 * obtains the bearer HERE); overlay membership is its trust boundary (spec §8/§9).
 *
 * The version header rides along so the host's version gate can reject a skewed
 * member at join (409 → a loud, non-retryable error) rather than after it stores a
 * bearer it can't use. host_id/label fall back to what the member already knows when
 * the host doesn't self-report them.
 */
export function createEnrollmentClient(transport: EnrollmentTransport = connectProxyEnrollTransport): EnrollmentClient {
  return {
    async enroll(ctx: EnrollmentContext): Promise<EnrollmentResult> {
      if (!ctx.overlayAddress?.trim()) {
        throw new Error(
          'Automatic enrollment needs the host overlay address to dial. Pass it (a non-secret the operator '
          + 'shares with the one-time key):\n  myco join <host> --key <one-time-key> --server-url <headscale-url> '
          + '--overlay-address <100.64.x.y:port>',
        );
      }
      if (ctx.proxyPort === undefined) {
        throw new Error('Internal: enrollment requires the local proxy port (proxy_port) to dial the host over the overlay.');
      }
      const body = JSON.stringify({
        member_hostname: ctx.memberHostname,
        member_overlay_ip: ctx.memberOverlayIp,
        enrollment_nonce: ctx.enrollmentNonce,
      });
      const { status, body: responseBody } = await transport({
        overlayAddress: ctx.overlayAddress.trim(),
        proxyPort: ctx.proxyPort,
        path: HOST_ENROLL_ROUTE,
        headers: { 'content-type': 'application/json', [HOST_PROTOCOL_HEADER]: String(HOST_PROTOCOL_VERSION) },
        body,
      });
      if (status === 409) {
        // Coded (see membership-error.ts): the daemon-API wrapper surfaces
        // `protocol_mismatch` on the wire so the Team page can render its own
        // outcome copy instead of this CLI-voiced message.
        throw codedMembershipError(
          'protocol_mismatch',
          `The host rejected enrollment with a protocol-version mismatch (409). This member speaks Team-Host `
          + `protocol v${HOST_PROTOCOL_VERSION}. Update the team host first (hosts update before members, `
          + 'D-F-5), then update this member with `myco update` if it is still behind, and retry.',
        );
      }
      if (status !== 200) {
        // Coded + body-SANITIZED (like the 409 branch): the raw host response
        // body is never carried onto the error — it can echo host internals,
        // and the daemon-API wrapper surfaces `err.message` verbatim on the
        // wire and into the Team page. Only the numeric status travels; the UI
        // maps the code to its own outcome copy (`ui/src/lib/membership-copy.ts`).
        const code = status === 401 || status === 403 ? 'host_enroll_rejected' : 'host_enroll_failed';
        throw codedMembershipError(code, `Host enrollment failed (HTTP ${status}).`);
      }
      let parsed: unknown;
      try { parsed = JSON.parse(responseBody); }
      catch { throw codedMembershipError('host_enroll_failed', 'Host enrollment returned a response Myco could not read.'); }
      return parseEnrollmentResponse(parsed, {
        hostId: ctx.hostId,
        label: ctx.label?.trim() || ctx.hostRef,
        enrollmentNonce: ctx.enrollmentNonce,
      });
    },
  };
}

/** The default (real) enrollment client used by `join` unless `--bearer` selects the
 *  manual bridge or a test injects its own client. */
export const realEnrollmentClient: EnrollmentClient = createEnrollmentClient();

/** Default backoff wait — a plain `setTimeout` wrapped as a Promise. Tests inject
 *  `deps.sleep` so retry backoff never costs real wall-clock time. */
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Bounded retry-with-backoff around a single {@link EnrollmentClient.enroll} call
 * (design spec §4, step 5) — ONLY the transport call is retried, nothing before or
 * after it in `joinHost`. {@link ENROLLMENT_RETRY_BACKOFFS_MS} bounds it at 3
 * attempts total (2s then 4s between them, none before the first or after the
 * last); the final attempt's failure is rethrown UNCHANGED so the caller sees the
 * same error a non-retrying `enroll` would have thrown.
 */
async function enrollWithRetry(
  client: EnrollmentClient,
  ctx: EnrollmentContext,
  sleep: (ms: number) => Promise<void>,
  log: (message: string) => void,
): Promise<EnrollmentResult> {
  const backoffs = ENROLLMENT_RETRY_BACKOFFS_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await client.enroll(ctx);
    } catch (err) {
      if (attempt >= backoffs.length) throw err;
      const delayMs = backoffs[attempt]!;
      log(`Enrollment attempt ${attempt + 1} failed (${(err as Error).message}) — retrying in ${delayMs}ms…`);
      await sleep(delayMs);
    }
  }
}

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
  /** Backoff wait between enrollment retry attempts (tests inject a no-real-wait
   *  fake). Default a plain `setTimeout` wrapped as a Promise. */
  sleep?: (ms: number) => Promise<void>;
  logger?: (message: string) => void;
  lockNamespace?: PerUserLockNamespace;
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

  const hostId = (options.hostId ?? options.hostRef).trim();
  return withHostOperationLock(
    hostId,
    'join',
    () => joinHostLocked(options, deps, hostId),
    deps.lockNamespace ?? nativePerUserLockNamespace,
  );
}

async function joinHostLocked(
  options: JoinOptions,
  deps: MemberOverlayDeps,
  hostId: string,
): Promise<JoinResult> {
  const log = deps.logger ?? ((m: string) => console.log(m));
  const notes: string[] = [];
  const runner = deps.runner ?? realCommandRunner;
  const fetcher = deps.fetcher ?? realFetcher;
  const platform = deps.platform ?? process.platform;
  const lockNamespace = deps.lockNamespace ?? nativePerUserLockNamespace;
  const target = resolveOverlayTarget(platform, deps.arch ?? process.arch);
  const serviceManager = deps.serviceManager ?? getServiceManager({ platform });
  // Default to the REAL client (fetches the bearer over the overlay). An explicit
  // --bearer means the operator already holds it and wants the manual bridge (no
  // HTTP handshake); tests inject their own client via deps.
  const enrollmentClient = deps.enrollmentClient ?? (options.bearer !== undefined ? stubEnrollmentClient : realEnrollmentClient);
  const hostname = sanitizeHostname(options.hostname ?? os.hostname());

  // Canonical per-host key: everything about THIS host's tailscaled instance
  // (socket, statedir, label, proxy port, record) is keyed on it.
  const socketPath = deps.socketPath ?? resolveMemberTailscaledSocketPath(hostId);
  const stateDir = deps.stateDir ?? resolveMemberTailscaledStateDir(hostId);
  const binDir = deps.binDir ?? resolveMemberBinDir();
  const label = memberTailscaledLabel(hostId);
  const overlayDir = resolveMemberOverlayDir();
  assertSocketPathFits(socketPath, platform);

  let proxyPortReservation = reserveHostProxyPort(hostId, deps.proxyPort, lockNamespace);
  if (proxyPortReservation.phase === 'teardown_pending') {
    throw new Error(
      `Host ${hostId} has an enrollment teardown pending; run \`myco leave ${hostId}\` `
      + 'to finish the verified cleanup before joining again.',
    );
  }
  const proxyPort = proxyPortReservation.proxyPort;
  let enrollmentCommitted = proxyPortReservation.recoveredCommit;
  let servicePreexisting: boolean | null = null;
  let expectedServiceSpec: ServiceSpec | null = null;

  try {
    // 1. Provision the Tailscale client + daemon (shared across hosts; NO headscale).
    log(`Provisioning Tailscale for ${target.os}/${target.arch}…`);
    const tailscale = await provisionTailscaleBinaries({ target, fetcher, runner, binDir, brewBinDirs: deps.brewBinDirs, logger: log });

    if (proxyPortReservation.recoveredCommit) {
      const waitForSocket = deps.waitForSocket ?? defaultWaitForSocket;
      if (!(await waitForSocket(socketPath))) {
        throw new Error(
          `Host ${hostId} is enrolled, but its tailscaled socket ${socketPath} is unavailable. `
          + 'Restore the existing member tailscaled service before retrying.',
        );
      }
      const resolveIp = deps.resolveMemberOverlayIp ?? defaultResolveMemberOverlayIp;
      const memberOverlayIp = await resolveIp(runner, tailscale.tailscaleBin, socketPath);
      if (!memberOverlayIp || !isOverlayRangeAddress(memberOverlayIp)) {
        throw new Error(
          `Host ${hostId} is enrolled, but its member overlay IP could not be resolved from ${socketPath}.`,
        );
      }
      const record = getHost(hostId, lockNamespace);
      if (!record
        || record.enrollment_generation !== proxyPortReservation.generation
        || record.proxy_port !== proxyPort) {
        throw new Error(`Host ${hostId} committed membership changed during join recovery.`);
      }
      const reachProbe = deps.checkHostReachable ?? defaultCheckHostReachable;
      const hostReachable = await reachProbe(record.overlay_address, proxyPort).catch(() => false);
      if (!hostReachable) notes.push('host daemon not confirmed reachable over the overlay');
      return {
        hostId,
        overlayAddress: record.overlay_address,
        proxyPort,
        memberOverlayIp,
        hostReachable,
        created: proxyPortReservation.baseGeneration === null,
        notes,
      };
    }

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
    expectedServiceSpec = spec;
    const beforeInstall = await serviceManager.status(label);
    servicePreexisting = beforeInstall.installed || beforeInstall.running;
    proxyPortReservation = advanceHostEnrollmentPhase(
      proxyPortReservation,
      'service_preparing',
      { preexisting: servicePreexisting, label },
      lockNamespace,
    );
    const install = await serviceManager.install(spec);
    const status = await serviceManager.status(label);
    if (!status.running) {
      await serviceManager.start(label);
      log(`member tailscaled ${install.changed ? 'installed' : 'present'} + started (user LaunchAgent ${label}).`);
    } else {
      log(`member tailscaled already running (user LaunchAgent ${label}).`);
    }
    proxyPortReservation = advanceHostEnrollmentPhase(
      proxyPortReservation,
      'service_ready',
      undefined,
      lockNamespace,
    );
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
      proxyPortReservation = advanceHostEnrollmentPhase(
        proxyPortReservation,
        'overlay_joining',
        undefined,
        lockNamespace,
      );
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
    proxyPortReservation = advanceHostEnrollmentPhase(
      proxyPortReservation,
      'overlay_joined',
      undefined,
      lockNamespace,
    );
    log(`Member overlay IP on host ${hostId}: ${memberOverlayIp}`);

    // 5. Enroll: obtain the host's overlay address + serve-bearer (Task 2.4 seam).
    //    Bounded retry-with-backoff (design spec §4) — a transient overlay/DERP-
    //    settling failure shouldn't burn the whole join.
    const sleep = deps.sleep ?? defaultSleep;
    proxyPortReservation = advanceHostEnrollmentPhase(
      proxyPortReservation,
      'enrolling',
      undefined,
      lockNamespace,
    );
    const enrollment = validateEnrollment(await enrollWithRetry(enrollmentClient, {
      hostId,
      hostRef: options.hostRef.trim(),
      serverUrl: options.serverUrl?.trim(),
      oneTimeKey: options.key,
      memberHostname: hostname,
      memberOverlayIp,
      overlayAddress: options.overlayAddress,
      proxyPort,
      enrollmentNonce: proxyPortReservation.enrollmentNonce,
      bearer: options.bearer,
      protocolVersion: options.protocolVersion,
      label: options.label?.trim(),
    }, sleep, log), {
      hostId,
      label: options.label?.trim() || options.hostRef.trim(),
      enrollmentNonce: proxyPortReservation.enrollmentNonce,
    });

    // 6. Best-effort reachability probe through THIS host's proxy port (never fatal).
    const reachProbe = deps.checkHostReachable ?? defaultCheckHostReachable;
    const hostReachable = await reachProbe(enrollment.overlay_address, proxyPort).catch(() => false);
    log(hostReachable
      ? `Host daemon reachable over the overlay via the local proxy (127.0.0.1:${proxyPort}).`
      : 'Host daemon not confirmed reachable yet — verify with `myco doctor` after the overlay settles.');
    if (!hostReachable) notes.push('host daemon not confirmed reachable over the overlay');

    // 7. host_id reconciliation — WARN, never re-key (server-mode design spec §4).
    //    The host's self-reported id can differ from the operator-typed one (a
    //    typo, or a host renamed since an earlier affiliation hint); adopting it
    //    would require re-keying this host's already-provisioned per-host
    //    tailscaled instance (socket/statedir/label, all derived from the TYPED
    //    id above) before enrollment ever ran — out of scope for v1. The typed
    //    id stays the record key unconditionally; a mismatch only ever produces
    //    a note, never a silent rewrite.
    if (enrollment.host_id && enrollment.host_id !== hostId) {
      const warning =
        `Host self-reported id "${enrollment.host_id}" differs from the typed id "${hostId}" — `
        + `keeping "${hostId}" as the host record key (Myco never re-keys a joined host silently). `
        + 'Verify this is the host you meant to join.';
      notes.push(warning);
      log(`WARNING: ${warning}`);
    }

    // 8. Persist host metadata and bearer through the registry transaction.
    const record: EnrollmentHostRecord = {
      host_id: hostId,
      label: enrollment.label,
      overlay_address: enrollment.overlay_address,
      protocol_version: enrollment.protocol_version,
      ...(Object.hasOwn(enrollment, 'served_grove_id')
        ? { served_grove_id: enrollment.served_grove_id }
        : {}),
      created_at: new Date().toISOString(),
    };
    const persisted = persistEnrollmentMembership(
      record,
      enrollment.bearer,
      proxyPortReservation,
      lockNamespace,
    );
    enrollmentCommitted = true;
    log(`${persisted.created ? 'Wrote' : 'Updated'} host record ${hostId} (proxy_port=${proxyPort}).`);

    return {
      hostId,
      overlayAddress: enrollment.overlay_address,
      proxyPort,
      memberOverlayIp,
      hostReachable,
      created: persisted.created,
      notes,
    };
  } catch (error) {
    const preOverlayPhase = proxyPortReservation.phase === 'reserved'
      || proxyPortReservation.phase === 'service_preparing'
      || proxyPortReservation.phase === 'service_ready';
    const automaticTeardownEligible = !enrollmentCommitted
      && proxyPortReservation.baseGeneration === null
      && proxyPortReservation.serviceOwned
      && preOverlayPhase;
    if (automaticTeardownEligible) {
      try {
        const installed = await serviceManager.inspect(label);
        if (!expectedServiceSpec
          || !installed
          || !installedCommandMatchesSpec(installed, expectedServiceSpec)) {
          throw new Error(
            `Installed service ${label} no longer matches this enrollment generation.`,
          );
        }
        await serviceManager.uninstall(label);
        await withLoopbackPortReleaseProof(proxyPortReservation.proxyPort, async (proof) => {
          abandonHostEnrollment(proxyPortReservation, proof, lockNamespace);
        });
        try { fs.rmSync(socketPath, { force: true }); } catch { /* stale socket cleanup is best-effort */ }
      } catch (cleanupError) {
        try {
          markHostEnrollmentTeardownPending(proxyPortReservation, lockNamespace);
        } catch { /* original state stays diagnosable */ }
        throw new AggregateError(
          [error, cleanupError],
          `Join failed and the uncommitted tailscaled instance for host ${hostId} could not be removed; its proxy-port claim remains reserved.`,
        );
      }
    } else if (!enrollmentCommitted
      && proxyPortReservation.phase === 'reserved'
      && servicePreexisting === null) {
      try {
        releaseHostProxyPort(proxyPortReservation, lockNamespace);
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          `Join failed and the proxy-port claim for host ${hostId} could not be released.`,
        );
      }
    }
    throw error;
  }
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
 * untouched. An interrupted pre-enrollment join is also removed when its durable
 * host directory remains. Idempotent: a host with no record or provisioning
 * state is a no-op, and an absent LaunchAgent / socket tolerates the miss.
 */
export async function leaveHost(hostRef: string, deps: MemberOverlayDeps = {}): Promise<LeaveResult> {
  if (!hostRef?.trim()) throw new Error('leave requires a <host> — the host_id to detach from.');
  const hostId = hostRef.trim();
  return withHostOperationLock(
    hostId,
    'leave',
    (lease) => leaveHostLocked(hostId, deps, lease),
    deps.lockNamespace ?? nativePerUserLockNamespace,
  );
}

function installedMemberProxyPort(
  args: readonly string[],
  expectedStateDir: string,
): number | null {
  if (!args.includes(`--statedir=${expectedStateDir}`)) return null;
  const listeners = args
    .filter((arg) => arg.startsWith('--outbound-http-proxy-listen='))
    .map((arg) => arg.slice('--outbound-http-proxy-listen='.length));
  if (listeners.length !== 1) return null;
  const match = listeners[0]!.match(/^localhost:([0-9]+)$/);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isSafeInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

function installedCommandMatchesSpec(
  installed: InstalledServiceCommand,
  expected: ServiceSpec,
): boolean {
  return installed.executable === expected.executable
    && installed.args.length === expected.args.length
    && installed.args.every((arg, index) => arg === expected.args[index]);
}

async function leaveHostLocked(
  hostId: string,
  deps: MemberOverlayDeps,
  lease: HostOperationLease,
): Promise<LeaveResult> {
  const log = deps.logger ?? ((m: string) => console.log(m));
  const platform = deps.platform ?? process.platform;
  const lockNamespace = deps.lockNamespace ?? nativePerUserLockNamespace;
  const serviceManager = deps.serviceManager ?? getServiceManager({ platform });
  const notes: string[] = [];

  const inspection = inspectHostMembershipForLeave(hostId, lease, lockNamespace);
  const label = memberTailscaledLabel(hostId);
  const installed = await serviceManager.inspect(label);
  const servicePort = installed
    ? installedMemberProxyPort(
      installed.args,
      deps.stateDir ?? resolveMemberTailscaledStateDir(hostId),
    )
    : null;
  if (inspection.proxyPort !== null
    && servicePort !== null
    && inspection.proxyPort !== servicePort) {
    throw new Error(
      `Could not safely remove host ${hostId}: registry port ${inspection.proxyPort} conflicts with installed service port ${servicePort}.`,
    );
  }
  const proxyPort = inspection.proxyPort ?? servicePort;
  if (!inspection.statePresent && installed === null) {
    log(`Not joined to host ${hostId} — nothing to remove.`);
    return { removed: false, tailscaledRemoved: false, notes };
  }
  if (proxyPort === null) {
    throw new Error(
      `Could not safely remove host ${hostId}: no trustworthy proxy-port identity remains in the registry or installed service.`,
    );
  }
  const record = inspection.record;
  if (record && record.projects.length > 0) {
    notes.push(`removing ${record.projects.length} attach ref(s) for host ${hostId}`);
  }

  // Stop THIS host's tailscaled FIRST (before deleting its statedir with the record).
  let tailscaledRemoved = false;
  try {
    await serviceManager.uninstall(label);
    await withLoopbackPortReleaseProof(proxyPort, async (proof) => {
      retireHostMembership(hostId, lease, proof, proxyPort, lockNamespace);
    });
    tailscaledRemoved = installed !== null;
  } catch (err) {
    throw new Error(
      `Could not remove tailscaled ${label}; the host registry remains intact so its proxy port stays reserved.`,
      { cause: err },
    );
  }
  // Best-effort: drop the (now-orphaned) socket file.
  try { fs.rmSync(deps.socketPath ?? resolveMemberTailscaledSocketPath(hostId), { force: true }); } catch { /* best-effort */ }

  log(`Removed host record + bearer for ${hostId}; tore down its tailscaled (${label}).`);

  const remaining = readHostRegistry(lockNamespace).length;
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
 * Best-effort reachability probe: a `/health` GET tunneled through THIS host's
 * local CONNECT proxy to the host's overlay address. Any HTTP response (even a 401
 * from the host bearer gate) proves the tunnel + host listener are up. Never throws.
 *
 * The tunnel rides the per-host loopback bridge ({@link acquireTunnelBridgePort},
 * exactly like {@link connectProxyEnrollTransport} and `defaultDial`) — Bun's
 * `node:http` client can neither drive a `method: 'CONNECT'` request nor accept a
 * caller-supplied socket, which under the Bun-compiled daemon made this probe
 * silently ALWAYS return false instead of actually dialing. An outer timer bounds
 * the whole attempt, including a CONNECT the proxy never answers — that timer's
 * handler destroys the in-flight probe request too (via `done`), not just the
 * bridge port, so a hung CONNECT/GET never leaks the socket past this call's
 * return the way a resolve-only timeout would.
 */
/** The reachability probe's full result: whether the tunnel + host listener are
 *  up, and the host's LIVE protocol version if it stamped one on the response
 *  (the overlay 401 the bearer-less probe receives carries it). `protocolVersion`
 *  is null when the response carried no valid version header (or unreachable). */
export interface HostHealthProbe {
  reachable: boolean;
  protocolVersion: number | null;
}

/**
 * Dial the host's `/health` over the overlay through the local CONNECT proxy and
 * read both liveness and the host's live protocol version from the response.
 * Any HTTP response (even the bearer-gate 401) proves the tunnel + host listener
 * are up AND carries `x-myco-host-protocol` — so one dial confirms reachability
 * and learns whether the host has upgraded since join. Never throws.
 */
export async function dialHostHealth(overlayAddress: string, proxyPort: number): Promise<HostHealthProbe> {
  const { host, port } = splitOverlayAddress(overlayAddress);
  if (!host || !port) return { reachable: false, protocolVersion: null };
  return await new Promise<HostHealthProbe>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let probe: import('node:http').ClientRequest | undefined;
    const done = (reachable: boolean, protocolVersion: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      probe?.destroy(); // release the one-shot tunnel on every exit path — success, error, AND outer timeout
      resolve({ reachable, protocolVersion });
    };
    timer = setTimeout(() => done(false, null), HOST_PROXY_CONNECT_TIMEOUT_MS);
    Promise.all([import('node:http'), acquireTunnelBridgePort(proxyPort, host, port)]).then(([http, bridgePort]) => {
      // The outer timer may have already fired while the dynamic import / bridge
      // acquisition was in flight — don't open a request `done` no longer tracks.
      if (settled) return;
      probe = http.request(
        { host: '127.0.0.1', port: bridgePort, path: '/health', method: 'GET', headers: { host: `${host}:${port}` }, agent: false },
        (probeRes) => {
          const raw = probeRes.headers[HOST_PROTOCOL_HEADER];
          const value = Array.isArray(raw) ? raw[0] : raw;
          const parsed = value !== undefined ? Number(value) : NaN;
          probeRes.resume();
          done(
            true,
            isValidObservedHostProtocolVersion(parsed) ? parsed : null,
          ); // any response proves the tunnel + host listener are up
        },
      );
      probe.once('error', () => done(false, null));
      probe.end();
    }).catch(() => done(false, null));
  });
}

/** Backward-compatible boolean reachability probe (join + doctor). Wraps
 *  {@link dialHostHealth}; callers that also need the host's live protocol
 *  version use `dialHostHealth` directly. */
export async function defaultCheckHostReachable(overlayAddress: string, proxyPort: number): Promise<boolean> {
  return (await dialHostHealth(overlayAddress, proxyPort)).reachable;
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
