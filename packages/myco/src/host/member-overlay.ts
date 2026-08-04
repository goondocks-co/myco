/**
 * `myco join <host>` / `myco leave <host>` orchestration for the member side
 * of the Team Host overlay.
 *
 * A member machine runs standard Myco. To route an attached project to a host it
 * must (1) stand up a userspace `tailscaled` and join the host's overlay, then
 * (2) write the `HostRecord` (+ bearer) consumed by `daemon/host-proxy.ts`.
 * This module does both, behind injectable seams so
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
 * SUPERVISION SHAPE — a per-user LaunchAgent, with no root access. The host's
 * tailscaled runs as a root system daemon so it survives reboot-before-login.
 * A member needs the overlay only while it is logged in and using Myco, so its
 * userspace tailscaled uses `@myco/service`'s user-domain manager
 * (`gui/<uid>` LaunchAgent on macOS, `systemd --user` on Linux). So this reuses
 * `getServiceManager()` directly; it never shells `sudo`, one LaunchAgent per host.
 *
 * DIAL MECHANISM — HTTP CONNECT, matching the proxy. `defaultDial` tunnels
 * through a local HTTP-CONNECT proxy at `127.0.0.1:<proxy_port>`
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
  withHostOperationLock,
  type HostOperationLease,
} from './operation-lock.js';
import { assertValidSecretEntry, InvalidSecretValueError } from '@myco/config/secrets.js';
import {
  nativePerUserLockNamespace,
  type PerUserLockNamespace,
} from '@myco/utils/per-user-lock-namespace.js';
import { codedMembershipError } from './membership-error.js';
import { listResidencyJournals } from './residency-journal.js';
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
 *  own agent — distinct from the root labels (`com.tailscale.tailscaled` /
 *  `co.goondocks.myco-tailscaled`) so a machine can be both without a collision. */
export const MEMBER_TAILSCALED_LABEL_PREFIX = 'co.goondocks.myco-member-tailscaled';

/** This host's userspace-tailscaled LaunchAgent label. */
export function memberTailscaledLabel(hostId: string): string {
  return `${MEMBER_TAILSCALED_LABEL_PREFIX}.${memberHostTag(hostId)}`;
}

/** How long `join` waits for a freshly-started tailscaled to bind its socket
 *  before `tailscale up` (the start→up race). Bounded, then a clear error. */
export const MEMBER_TAILSCALED_SOCKET_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Enrollment seam
// ---------------------------------------------------------------------------

/** What the host tells a member at enrollment: its identity, its overlay address
 *  (100.64 IP + daemon port), the shared serve-bearer, and its wire version. */
export interface HostEnrollment {
  host_id: string;
  label: string;
  protocol_version: number;
  /** The shared host serve-bearer, stored under {@link HOST_BEARER_SECRET}. */
  bearer: string;
  /** The host's self-reported served Grove. `undefined` means the response
   *  omitted `served_grove_id`; `null` means the host explicitly has no
   *  designation. Join persists it for `attachCommand` to use as the Grove
   *  source for a new attach ref. */
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
   *  a NON-SECRET the operator hands the joiner alongside the one-time key. The
   *  SECRET bearer comes back in the enrollment response, never out-of-band. */
  overlayAddress?: string;
  /** THIS host's local HTTP-CONNECT proxy port — the tunnel the real enroll client
   *  dials through (the same `proxy_port` the routing proxy later uses). */
  proxyPort?: number;
  /** Stable, durable request correlation for repeatable enrollment. */
  enrollmentNonce?: string;
  // --- manual enrollment context ---
  bearer?: string;
  protocolVersion?: number;
  label?: string;
}

export interface EnrollmentClient {
  /** Obtain the host serve-bearer + overlay address over the overlay. */
  enroll(ctx: EnrollmentContext): Promise<EnrollmentResult>;
}

/** The wire response the host enrollment endpoint returns. */
interface HostEnrollmentResponse {
  host_id: string;
  label: string;
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

/** The default enrollment client used by `join` unless a caller injects one. */
/**
 * Enrollment has no transport on this build. The member reached the host's
 * enrollment route through the overlay's CONNECT proxy, and that path is gone;
 * the HTTPS transport that replaces it arrives with the Funnel URL, which is
 * the first thing a member has to dial. Joining fails loudly rather than
 * writing a host record with no reachable address.
 */
export const realEnrollmentClient: EnrollmentClient = {
  async enroll(): Promise<EnrollmentResult> {
    throw new Error(
      'Joining a team host is unavailable on this build: the member transport is being rebuilt on the '
      + 'public host URL. No host record was written.',
    );
  },
};

/** Default backoff wait — a plain `setTimeout` wrapped as a Promise. Tests inject
 *  `deps.sleep` so retry backoff never costs real wall-clock time. */
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Bounded retry-with-backoff around a single {@link EnrollmentClient.enroll} call
 * — only the transport call is retried, nothing before or after it in
 * `joinHost`. {@link ENROLLMENT_RETRY_BACKOFFS_MS} bounds it at 3
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
  overlayAddress?: string;
  bearer?: string;
  protocolVersion?: number;
  /** Canonical host_id override (when the positional is not itself the id). */
  hostId?: string;
  label?: string;
}

export interface MemberOverlayDeps {
  platform?: NodeJS.Platform;
  /** USER-domain service manager. Default `getServiceManager()` (LaunchAgent /
   *  systemd --user) — NEVER a root/system manager. */
  serviceManager?: ServiceManager;
  enrollmentClient?: EnrollmentClient;
  /** Override the team home the residency-journal gate reads (tests). */
  teamsHome?: string;
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

/**
 * Join a team host.
 *
 * Unavailable on this build. Joining used to mean provisioning a userspace
 * tailscaled for this host, reserving a loopback CONNECT-proxy port, bringing
 * the node onto the host's tailnet with a one-time key, and only then enrolling
 * through that tunnel — every step of which existed to create the network the
 * member dialed. That network is gone, and the HTTPS transport that replaces it
 * needs the host's public URL, which is the first thing a joining member has to
 * be given.
 *
 * This fails loudly and writes nothing rather than recording a host with no
 * reachable address: a host record whose address does not resolve is worse than
 * no record, because every drain and probe downstream treats it as a live target.
 */
export async function joinHost(_options: JoinOptions, _deps: MemberOverlayDeps = {}): Promise<JoinResult> {
  // Coded, so the browser renders mapped copy rather than this CLI-voiced prose
  // (`ui/src/lib/membership-copy.ts` keys on the code).
  throw codedMembershipError(
    'join_unavailable',
    'Joining a team host is unavailable on this build: the member transport is being rebuilt on the '
    + 'public host URL. No host record was written.',
  );
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
  const lockNamespace = deps.lockNamespace ?? nativePerUserLockNamespace;
  const notes: string[] = [];

  const inspection = inspectHostMembershipForLeave(hostId, lease, lockNamespace);
  if (!inspection.statePresent) {
    log(`Not joined to host ${hostId} — nothing to remove.`);
    return { removed: false, tailscaledRemoved: false, notes };
  }

  // Leaving destroys the bearer and every attach ref for this host, and the
  // bearer is unrecoverable — re-joining mints a new generation. So a leave
  // while projects are still attached (or mid-move) would leave them
  // registered nowhere, with capture diverting to a Grove that no longer
  // exists locally. Refuse until the projects are detached and no move is in
  // flight. Placed AFTER the nothing-to-remove no-op so a journal naming an
  // already-gone host (partial teardown) keeps the documented idempotent
  // return instead of turning into a refusal.
  const attachedProjects = inspection.record?.projects ?? [];
  if (attachedProjects.length > 0) {
    throw codedMembershipError(
      'leave_projects_attached',
      `Cannot leave host ${hostId}: ${attachedProjects.length} project(s) are still attached through it. `
      + 'Detach each project first (`myco detach`), then leave.',
    );
  }
  const inFlight = listResidencyJournals(deps.teamsHome)
    .filter((journal) => journal.host_id === hostId && journal.phase !== 'done');
  if (inFlight.length > 0) {
    throw codedMembershipError(
      'leave_transition_in_flight',
      `Cannot leave host ${hostId}: a project move involving this host is still in progress `
      + `("${inFlight[0]!.project_name}"). Wait for it to finish, then leave.`,
    );
  }

  // Leaving is now a registry write and nothing else. It used to have to stop
  // and uninstall this host's tailscaled, reconcile its CONNECT-proxy port
  // against the installed service's arguments, and refuse when the two
  // disagreed — a whole conflict-detection path that existed because the
  // member ran a per-host daemon whose identity could drift from the registry.
  // No process, no port, no drift.
  retireHostMembership(hostId, lease, lockNamespace);
  log(`Removed host record + bearer for ${hostId}.`);

  const remaining = readHostRegistry(lockNamespace).length;
  if (remaining > 0) log(`${remaining} other host(s) still joined — their membership is untouched.`);

  return { removed: true, tailscaledRemoved: false, notes };
}

// ---------------------------------------------------------------------------
// Spec + default seams
// ---------------------------------------------------------------------------

/** Reduce an arbitrary hostname to a tailnet-safe label. */
function sanitizeHostname(name: string): string {
  const clean = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return clean || 'myco-member';
}
