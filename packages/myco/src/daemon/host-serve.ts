/**
 * Team Host — the HOST-side transport boundary (Task 2.3).
 *
 * A daemon opts in to serving its Grove(s) to member daemons over the private
 * overlay. When it does, `DaemonServer` binds a SECOND HTTP listener on the
 * overlay interface address ONLY, and every request arriving there passes the
 * blanket transport-boundary gate this module implements BEFORE any dispatch:
 *
 *   overlay CSRF (Host/Origin) → bearer (401) → lifecycle refusal (404)
 *     → version (409) → stamp local bearer → shared dispatch.
 *
 * The localhost listener is byte-identical to today — this module never touches
 * it. Everything here is scoped to the overlay listener.
 *
 * This is the mirror of the member-side gate the proxy dials into: the member's
 * `daemon/host-proxy.ts` attaches `Authorization: Bearer <host bearer>` and
 * `x-myco-host-protocol: <member version>` on every forwarded request; this gate
 * validates both. The 409 shape mirrors the team-sync worker gate exactly
 * (`packages/myco-team/worker/src/index.ts` `protocol_version_unsupported`,
 * both bounds echoed) so the member's proxy detects the skew off the same wire
 * contract.
 *
 * Pure module: config resolution, bearer mint/read, address validation, the
 * overlay-request mark, and the bearer/version/lifecycle gate helpers. The
 * overlay Host/Origin CSRF adaptation lives beside `validateLoopbackRequest` in
 * `server.ts` (it shares the mutating-body content-type check).
 */
import crypto from 'node:crypto';
import type http from 'node:http';

import {
  HOST_ENROLL_ROUTE,
  HOST_MIN_COMPAT_VERSION,
  HOST_PROTOCOL_HEADER,
  HOST_PROTOCOL_VERSION,
  HOST_SERVE_BEARER_SECRET,
} from '../constants.js';
import { LOG_KINDS } from '../constants/log-kinds.js';
import { readSecrets, writeSecret } from '../config/secrets.js';
import type { MachineConfig } from '../config/schema.js';
import { resolveMycoHome } from '../grove/paths.js';
import { timingSafeStringEqual } from '../grove/request-context.js';

/** The resolved host-serve enablement passed to `DaemonServer`. `null` means
 *  host serving is OFF and no second listener binds. */
export interface HostServeRuntime {
  /** The overlay interface IP the second listener binds. Never a wildcard. */
  overlayAddress: string;
  /**
   * Port the overlay listener binds. Omitted in production — the listener binds
   * the daemon's canonical port on the overlay IP (that is the port enrollment
   * records in the member's `overlay_address`). Tests set it to an ephemeral
   * port so a fixture that binds the overlay listener on `127.0.0.1` does not
   * collide with the loopback listener on the same IP+port.
   */
  overlayPort?: number;
  /** The host bearer every overlay request must present (`Authorization: Bearer`). */
  bearer: string;
  /** The host's control-plane id (`myco-team` `HostState.host_id`), surfaced from
   *  `host_serve` config so the enrollment endpoint can self-report it. Absent on a
   *  host enabled before Task 2.4 wrote it — the member falls back to its own ref. */
  hostId?: string;
  /** Human-readable host label (the host's tailnet node name). Same provenance +
   *  fallback as {@link hostId}. */
  label?: string;
}

/** A refusal the overlay gate emits before dispatch: status + JSON body, plus
 *  optional extra response headers (the version gate echoes the host version). */
export interface OverlayGateRefusal {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Overlay request mark
// ---------------------------------------------------------------------------
//
// A request that arrived on the overlay listener is tagged here so the shared
// dispatch (`server.ts handleRequest`, `mcp/http.ts`) can branch on it WITHOUT
// re-deriving the listener: it skips attach classification (a host serves its
// own Groves locally and must NEVER re-proxy — the circular-proxy defense),
// skips the loopback CSRF gate (the overlay gate already validated it), and
// refuses the static/UI surface (the overlay carries only the daemon API). A
// WeakSet keys on the request object itself — no header spoofing surface, no
// leak (entries are collected with the request).

const overlayRequests = new WeakSet<http.IncomingMessage>();

/** Tag a request as having arrived on the overlay listener. */
export function markOverlayRequest(req: http.IncomingMessage): void {
  overlayRequests.add(req);
}

/** True when a request arrived on the overlay listener (see the note above). */
export function isOverlayRequest(req: http.IncomingMessage): boolean {
  return overlayRequests.has(req);
}

// ---------------------------------------------------------------------------
// Enablement + bearer
// ---------------------------------------------------------------------------

/**
 * True when `address` is a non-empty host the overlay listener may bind. Rejects
 * every wildcard / any-interface form: the overlay listener MUST bind exactly the
 * host's overlay IP so it is never reachable on the LAN or public internet. A
 * bind on `0.0.0.0`/`::` would defeat the whole transport-boundary model (spec §9:
 * "MUST bind the overlay interface only"). Also rejects an embedded scheme —
 * `server.listen` takes a bare host, not a URL.
 */
export function isBindableOverlayAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const a = address.trim();
  if (!a) return false;
  const wildcards = new Set(['0.0.0.0', '::', '0:0:0:0:0:0:0:0', '*', '[::]', '[::0]']);
  if (wildcards.has(a)) return false;
  if (a.includes('://')) return false;
  return true;
}

/**
 * True when `address` is within the overlay's private address space — the
 * Tailscale/Headscale CGNAT range 100.64.0.0/10 (IPv4). The overlay listener must
 * bind an overlay-interface address ONLY (spec §9): a LAN (192.168/16, 10/8) or
 * public IP is never a valid overlay bind target, even though the OS would only
 * actually bind a locally-assigned one. This is the stricter, config-boundary
 * assertion (enforced in {@link resolveHostServeConfig}, where the untrusted
 * config value enters) — distinct from {@link isBindableOverlayAddress}, which is
 * the permissive bind-time wildcard guard (a hermetic fixture must be able to bind
 * a loopback address, since a test cannot attach a real 100.64/10 TUN interface).
 *
 * IPv4-only by design of record (the overlay-design + spike consistently describe
 * "100.x IPs"). If Task 2.1 ever records the Tailscale IPv6 ULA address instead,
 * add the `fd7a:115c:a1e0::/48` branch here — the rejection log below names the
 * required range so that failure is self-explaining.
 */
export function isOverlayRangeAddress(address: string | null | undefined): boolean {
  if (!isBindableOverlayAddress(address)) return false;
  const v4 = (address as string).trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const octets = v4.slice(1, 5).map(Number);
  if (octets.some((o) => o > 255)) return false;
  // 100.64.0.0/10 → first octet 100, second octet in [64, 127].
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

/**
 * Read the machine-scoped host-serve bearer, minting + persisting a fresh 256-bit
 * one on first use. Stored in `~/.myco/secrets.env` under {@link HOST_SERVE_BEARER_SECRET}
 * (never in any registry/config file), owner-only perms via the secrets helper.
 * This is the single flat-trust host bearer Task 2.4 hands to joining members.
 */
export function resolveHostServeBearer(mycoHome: string = resolveMycoHome()): string {
  const existing = readSecrets(mycoHome)[HOST_SERVE_BEARER_SECRET];
  if (existing && existing.trim()) return existing.trim();
  const minted = crypto.randomBytes(32).toString('hex');
  writeSecret(mycoHome, HOST_SERVE_BEARER_SECRET, minted);
  return minted;
}

/**
 * Rotate the shared host-serve bearer: overwrite the machine-scoped secret with a
 * fresh 256-bit value and return it. v1's only bearer-revocation lever (spec §8:
 * "Bearer revocation = rotation-only … rotating re-enrolls everyone"). Because the
 * daemon reads the bearer once at startup (`resolveHostServeConfig` → `hostServe`),
 * a rotation is inert until the daemon restarts; the operator CLI restarts it and
 * warns that every member must re-join. Returns the new bearer for confirmation.
 */
export function rotateHostServeBearer(mycoHome: string = resolveMycoHome()): string {
  const minted = crypto.randomBytes(32).toString('hex');
  writeSecret(mycoHome, HOST_SERVE_BEARER_SECRET, minted);
  return minted;
}

interface HostServeLogger {
  info(kind: string, message: string, data?: Record<string, unknown>): void;
  warn(kind: string, message: string, data?: Record<string, unknown>): void;
}

/**
 * Resolve the machine's host-serve enablement into a {@link HostServeRuntime}
 * the server binds a second listener from, or `null` (host serving off). Never
 * throws: an enabled-but-misconfigured host (absent/invalid address, un-mintable
 * bearer) yields `null` plus exactly one clear log — never a crash, never a
 * fallback bind (Task 2.3 item 1).
 */
export function resolveHostServeConfig(options: {
  machineConfig: MachineConfig;
  mycoHome?: string;
  logger?: HostServeLogger;
}): HostServeRuntime | null {
  const hostServe = options.machineConfig.daemon.host_serve;
  if (!hostServe?.enabled) return null;

  const address = hostServe.overlay_address;
  if (!isOverlayRangeAddress(address)) {
    options.logger?.warn(
      LOG_KINDS.HOST_SERVE,
      'Team Host serve is enabled but overlay_address is absent or not a 100.64/10 (CGNAT) overlay address — host serving stays off',
      { overlay_address: address ?? null },
    );
    return null;
  }

  try {
    const bearer = resolveHostServeBearer(options.mycoHome ?? resolveMycoHome());
    return {
      overlayAddress: (address as string).trim(),
      bearer,
      hostId: hostServe.host_id ?? undefined,
      label: hostServe.label ?? undefined,
    };
  } catch (err) {
    options.logger?.warn(
      LOG_KINDS.HOST_SERVE,
      'Team Host serve is enabled but the host bearer could not be resolved — host serving stays off',
      { error: (err as Error).message },
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// The transport-boundary gate (bearer / lifecycle / version)
// ---------------------------------------------------------------------------

/** Parse a `Bearer <token>` Authorization header into its token, or null. */
function parseBearer(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string') return null;
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Blanket bearer check — EVERY overlay request (router routes, raw routes, `/mcp`)
 * must present `Authorization: Bearer <host bearer>`. Constant-time comparison via
 * the same primitive the daemon-token gate uses. Missing/wrong → 401. The single
 * transport-boundary admission gate (spec §9).
 */
export function overlayBearerRejection(
  req: http.IncomingMessage,
  bearer: string,
): OverlayGateRefusal | null {
  const presented = parseBearer(req.headers.authorization);
  if (!presented || !timingSafeStringEqual(presented, bearer)) {
    return {
      status: 401,
      body: {
        error: 'host_unauthorized',
        message: 'Overlay requests to a Team Host require the host bearer.',
      },
    };
  }
  return null;
}

/**
 * Lifecycle/operator raw routes that are the host's LOCALHOST control plane and
 * are NEVER part of the overlay-served surface (spec §9: "operator control plane
 * = host localhost only"). `/api/shutdown` mutates daemon lifecycle; a member
 * daemon must never be able to drain the host. Refused (404 — not part of this
 * listener's surface) regardless of a valid bearer. `/health` and `/api/version`
 * are read-only liveness/version probes and stay bearer+version-gated so a member
 * can confirm reachability.
 */
const OVERLAY_REFUSED_LIFECYCLE_ROUTES = new Set<string>(['/api/shutdown']);

/** True when `pathname` is an operator/lifecycle raw route the overlay refuses. */
export function overlayLifecycleRefused(pathname: string): boolean {
  return OVERLAY_REFUSED_LIFECYCLE_ROUTES.has(pathname);
}

// ---------------------------------------------------------------------------
// Enrollment — the ONE bearer-exempt overlay route (Task 2.4)
// ---------------------------------------------------------------------------

/**
 * The single overlay route EXEMPT from the blanket bearer gate: host enrollment.
 *
 * WHY the exemption exists (the load-bearing security decision): enrollment is how
 * a joining member OBTAINS the bearer, so a bearer-gated enrollment endpoint would
 * be a chicken-and-egg deadlock — no member could ever get in. It is gated INSTEAD
 * by overlay reachability. In v1, being on the overlay already means the operator
 * minted you a one-time admission key and you completed overlay admission (spec §8),
 * so **overlay membership IS the enrollment trust boundary** (spec §9: two gates —
 * overlay admission + bearer; enrollment sits behind the first). The route handler
 * (`daemon/server.ts`) additionally asserts overlay provenance (`isOverlayRequest`)
 * and 404s any localhost/non-overlay hit, so the exemption never widens the
 * localhost surface.
 *
 * The exemption is SURGICAL — {@link overlayBearerExempt} matches ONLY this exact
 * path (`HOST_ENROLL_ROUTE`, `constants.ts`); every other overlay route (router,
 * raw, `/mcp`) stays bearer-gated.
 */

/** True for the ONE overlay route whose bearer check is skipped (see {@link HOST_ENROLL_ROUTE}). */
export function overlayBearerExempt(pathname: string): boolean {
  return pathname === HOST_ENROLL_ROUTE;
}

/** The enrollment payload a member receives — its own overlay address, wire version,
 *  the shared bearer, and (best-effort) the host's self-reported id/label. Mirrors the
 *  member-side `HostEnrollment` shape (`host/member-overlay.ts`). */
export interface HostEnrollmentPayload {
  host_id: string;
  label: string;
  /** `<host 100.64 IP>:<daemon overlay port>` — the address the member's proxy dials. */
  overlay_address: string;
  protocol_version: number;
  /** The shared host serve-bearer (the secret enrollment delivers over the overlay). */
  bearer: string;
  /** Pre-associated projects — always empty in v1 (attach is a separate UI step). */
  projects: never[];
}

/**
 * Build the enrollment response from the resolved host-serve runtime + the actual
 * bound overlay port (`server.overlayPort`, known only after listen). The bearer is
 * `runtime.bearer` — the exact value {@link resolveHostServeBearer} minted/read at
 * config resolution, so there is one bearer per host, delivered here unchanged.
 */
export function buildHostEnrollmentPayload(runtime: HostServeRuntime, overlayPort: number): HostEnrollmentPayload {
  return {
    host_id: runtime.hostId ?? '',
    label: runtime.label ?? '',
    overlay_address: `${runtime.overlayAddress}:${overlayPort}`,
    protocol_version: HOST_PROTOCOL_VERSION,
    bearer: runtime.bearer,
    projects: [],
  };
}

/**
 * Version gate — an overlay request must carry `x-myco-host-protocol` inside the
 * inclusive window `[HOST_MIN_COMPAT_VERSION, HOST_PROTOCOL_VERSION]`. Missing or
 * out-of-window (a version skew never self-heals) → 409 `protocol_version_unsupported`
 * echoing BOTH bounds and re-stamping the host's version header, mirroring the
 * team-sync worker gate so the member's proxy maps it to a loud, non-retryable
 * error (routing-layer §5.3). Runs AFTER the bearer gate so an unauthenticated
 * caller never learns the host's protocol window.
 */
export function overlayVersionRejection(req: http.IncomingMessage): OverlayGateRefusal | null {
  const raw = req.headers[HOST_PROTOCOL_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const version = value !== undefined ? Number(value) : NaN;
  const inWindow =
    Number.isFinite(version)
    && version >= HOST_MIN_COMPAT_VERSION
    && version <= HOST_PROTOCOL_VERSION;
  if (inWindow) return null;

  const presented = value === undefined ? '(missing)' : `v${value}`;
  return {
    status: 409,
    headers: { [HOST_PROTOCOL_HEADER]: String(HOST_PROTOCOL_VERSION) },
    body: {
      error: 'protocol_version_unsupported',
      message:
        `Member Team-Host protocol ${presented} is outside the host's supported window `
        + `[${HOST_MIN_COMPAT_VERSION}, ${HOST_PROTOCOL_VERSION}]. Run \`myco update\` on this machine.`,
      host_protocol_version: HOST_PROTOCOL_VERSION,
      host_min_compat_version: HOST_MIN_COMPAT_VERSION,
    },
  };
}
