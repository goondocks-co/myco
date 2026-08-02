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
  HOST_EXTERNAL_MCP_TOKEN_SECRET,
  HOST_MIN_COMPAT_VERSION,
  HOST_PROTOCOL_HEADER,
  HOST_PROTOCOL_VERSION,
  HOST_SERVE_BEARER_SECRET,
} from '../constants.js';
import { LOG_KINDS } from '../constants/log-kinds.js';
import { readSecrets, writeSecret, writeSecretIfAbsent, loadLayeredSecrets } from '../config/secrets.js';
import {
  nativePerUserLockNamespace,
  type PerUserLockNamespace,
} from '@myco/utils/per-user-lock-namespace.js';
import { loadMergedConfig } from '../config/loader.js';
import type { MachineConfig } from '../config/schema.js';
import { listGroves } from '../grove/registry.js';
import { resolveMycoHome, resolveGroveDir } from '../grove/paths.js';
import { timingSafeStringEqual } from '../grove/request-context.js';
import { isAutoBackupDue } from '../backup/service.js';
import { getMachineId } from '../machine-id.js';
import { missingKeyReason } from '../agent/harness/provider-health.js';

/** The resolved host-serve enablement passed to `DaemonServer`. `null` means
 *  host serving is OFF and no second listener binds. */
export interface HostServeRuntime {
  /**
   * The host's overlay identity — the 100.64/10 address members DIAL. NOT a
   * bind address: since the coexistence move to userspace networking there is
   * no TUN interface to bind, so the listener binds loopback and a
   * `tailscale serve --tcp` forward bridges the overlay to it. Still
   * load-bearing as the advertised address and the Host-header comparand.
   */
  overlayAddress: string;
  /**
   * The port the overlay listener binds on loopback AND that the serve forward
   * exposes overlay-side. REQUIRED — {@link resolveHostServeConfig} refuses to
   * serve without it. It is deliberately not optional-with-a-fallback: falling
   * back to the daemon's canonical port makes the overlay listener collide with
   * the loopback listener, whose EADDRINUSE is swallowed into a single warn
   * while `/api/host-serve/status` keeps reporting `serving: true`.
   */
  overlayPort: number;
  /** The host bearer every overlay request must present (`Authorization: Bearer`). */
  bearer: string;
  /** The host's control-plane id (`myco-team` `HostState.host_id`), surfaced from
   *  `host_serve` config so the enrollment endpoint can self-report it. Absent on a
   *  host enabled before Task 2.4 wrote it — the member falls back to its own ref. */
  hostId?: string;
  /** Human-readable host label (the host's tailnet node name). Same provenance +
   *  fallback as {@link hostId}. */
  label?: string;
  /** The one Grove this host serves (`host_serve.served_grove_id`), surfaced so
   *  {@link servedGroveRefusal} can refuse any overlay request whose resolved
   *  Grove doesn't match. Absent when the designation is unset (null) — a
   *  fail-closed outcome the filter enforces, not this module (see
   *  {@link resolveHostServeConfig}). */
  servedGroveId?: string;
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
 * True when `address` is a non-empty host this machine may ADVERTISE as its
 * overlay identity. Despite the historical name it no longer gates a bind: the
 * listener binds loopback (`OVERLAY_BIND_ADDRESS`), because userspace
 * networking creates no TUN and the 100.64 address is not bindable here at
 * all. It still gates what goes on the wire, and `isOverlayHost` compares
 * incoming Host headers against it, so the wildcard/scheme rejections below
 * remain load-bearing. Rejects every wildcard / any-interface form: a host that
 * advertised `0.0.0.0`/`::` would tell members to dial an address that is not an
 * identity, and would defeat the transport-boundary model that §9 originally
 * expressed as "MUST bind the overlay interface only" — restated by the
 * coexistence amendment as "never a wildcard or non-loopback bind, and the only
 * network path in is the overlay". Also rejects an embedded scheme, since this
 * is a bare host, not a URL.
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
 * Tailscale/Headscale CGNAT range 100.64.0.0/10 (IPv4). A host advertises an
 * overlay-space address ONLY: a LAN (192.168/16, 10/8) or public IP is never a
 * valid overlay identity. This is the stricter, config-boundary assertion
 * (enforced in {@link resolveHostServeConfig}, where the untrusted config value
 * enters) — distinct from {@link isBindableOverlayAddress}, which is the
 * permissive wildcard/shape guard a hermetic fixture can satisfy with a
 * loopback address.
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
export function resolveHostServeBearer(
  mycoHome: string = resolveMycoHome(),
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): string {
  // Mint-if-absent at the secrets-write layer: a cross-process race (two
  // daemons on a restart overlap, or a CLI-and-daemon pair) that both mint a
  // fresh bearer converges on ONE stored value, and a losing minter returns
  // the winner's stored bearer — never an orphaned one a member could enroll
  // with but the host never persists.
  return writeSecretIfAbsent(
    mycoHome,
    HOST_SERVE_BEARER_SECRET,
    () => crypto.randomBytes(32).toString('hex'),
    lockNamespace,
  ).value;
}

/**
 * Rotate the shared host-serve bearer: overwrite the machine-scoped secret with a
 * fresh 256-bit value and return it. v1's only bearer-revocation lever (spec §8:
 * "Bearer revocation = rotation-only … rotating re-enrolls everyone"). Because the
 * daemon reads the bearer once at startup (`resolveHostServeConfig` → `hostServe`),
 * a rotation is inert until the daemon restarts; the operator CLI restarts it and
 * warns that every member must re-join. Returns the new bearer for confirmation.
 */
export function rotateHostServeBearer(
  mycoHome: string = resolveMycoHome(),
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): string {
  const minted = crypto.randomBytes(32).toString('hex');
  writeSecret(mycoHome, HOST_SERVE_BEARER_SECRET, minted, lockNamespace);
  return minted;
}

interface HostServeLogger {
  info(kind: string, message: string, data?: Record<string, unknown>): void;
  warn(kind: string, message: string, data?: Record<string, unknown>): void;
}

/**
 * Resolve the machine's host-serve enablement into a {@link HostServeRuntime}
 * the server binds a second listener from, or `null` (host serving off). Never
 * throws: an enabled-but-misconfigured host (absent/invalid address, dangling
 * `served_grove_id`, un-mintable bearer) yields `null` plus exactly one clear
 * log — never a crash, never a fallback bind (Task 2.3 item 1).
 *
 * A `served_grove_id` naming no Grove on this machine is a dangling
 * designation (server-mode design spec §2: "referential integrity … a loud
 * startup error … never a silent total-refusal outage on a box that looks
 * healthy") and refuses the same way the address gate does. A `null`
 * designation is NOT dangling — it still resolves; the dispatch filter
 * (Task 2) is what makes an undesignated host serve nothing.
 */
/** True for a port number the overlay listener may bind. */
export function isValidOverlayPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** Why an enabled-looking config still yields no serving runtime. One reason
 *  per refusal branch below; consumed by the status route's `serving: false`
 *  body so the UI renders the daemon's actual diagnosis instead of a bare
 *  boolean (E1 §4.1, review RC3). */
export type HostServeRefusalReason =
  | 'disabled'
  | 'invalid_overlay_address'
  | 'invalid_overlay_port'
  | 'dangling_served_grove'
  | 'grove_registry_unreadable'
  | 'bearer_unavailable';

export type HostServeClassification =
  | { runtime: HostServeRuntime; reason?: undefined }
  | { runtime?: undefined; reason: HostServeRefusalReason };

/** Thin wrapper preserving the boot call sites' `runtime | null` contract —
 *  the classification (with its refusal reason) is the single source of
 *  truth; this only drops the reason. */
export function resolveHostServeConfig(options: {
  machineConfig: MachineConfig;
  mycoHome?: string;
  logger?: HostServeLogger;
  lockNamespace?: PerUserLockNamespace;
}): HostServeRuntime | null {
  return classifyHostServeConfig(options).runtime ?? null;
}

/**
 * READ-ONLY refusal probe: the same gate order as {@link classifyHostServeConfig}
 * but WITHOUT bearer resolution. Load-bearing distinction: bearer
 * resolution is mint-if-absent — a WRITE that takes a per-user file lock
 * and persists a machine secret — and the status route's `serving: false`
 * branch (the Phase-2 poll's hot path) must never do that on a GET (PR 2
 * diff review, C4 — a poll was creating `secrets.env`). Returns `null`
 * when the config is valid, i.e. serving would start on the next boot.
 */
export function classifyHostServeRefusalReadOnly(options: {
  machineConfig: MachineConfig;
  mycoHome?: string;
}): Exclude<HostServeRefusalReason, 'bearer_unavailable'> | null {
  const hostServe = options.machineConfig.daemon.host_serve;
  if (!hostServe?.enabled) return 'disabled';
  if (!isOverlayRangeAddress(hostServe.overlay_address)) return 'invalid_overlay_address';
  if (!isValidOverlayPort(hostServe.overlay_port)) return 'invalid_overlay_port';
  const servedGroveId = hostServe.served_grove_id?.trim() || undefined;
  if (servedGroveId) {
    const mycoHome = options.mycoHome ?? resolveMycoHome();
    try {
      if (!listGroves(mycoHome).some((grove) => grove.id === servedGroveId)) return 'dangling_served_grove';
    } catch {
      return 'grove_registry_unreadable';
    }
  }
  return null;
}

export function classifyHostServeConfig(options: {
  machineConfig: MachineConfig;
  mycoHome?: string;
  logger?: HostServeLogger;
  lockNamespace?: PerUserLockNamespace;
}): HostServeClassification {
  const hostServe = options.machineConfig.daemon.host_serve;
  if (!hostServe?.enabled) return { reason: 'disabled' };

  const address = hostServe.overlay_address;
  if (!isOverlayRangeAddress(address)) {
    options.logger?.warn(
      LOG_KINDS.HOST_SERVE,
      'Team Host serve is enabled but overlay_address is absent or not a 100.64/10 (CGNAT) overlay address — host serving stays off',
      { overlay_address: address ?? null },
    );
    return { reason: 'invalid_overlay_address' };
  }

  // Fail CLOSED on a missing/invalid port rather than falling back to the
  // daemon's canonical port: that fallback binds the overlay listener at the
  // address the loopback listener already holds, and the resulting EADDRINUSE
  // is swallowed into one warn while status still reports `serving: true`.
  const overlayPort = hostServe.overlay_port;
  if (!isValidOverlayPort(overlayPort)) {
    options.logger?.warn(
      LOG_KINDS.HOST_SERVE,
      'Team Host serve is enabled but overlay_port is absent or out of range — host serving stays off. '
      + 'Re-run `myco host enable` to allocate and persist one.',
      { overlay_port: overlayPort ?? null },
    );
    return { reason: 'invalid_overlay_port' };
  }

  const mycoHome = options.mycoHome ?? resolveMycoHome();

  // Empty/whitespace-only is treated as absent, same as null — the runtime
  // must never carry a meaningless empty-string designation.
  const servedGroveId = hostServe.served_grove_id?.trim() || undefined;
  if (servedGroveId) {
    try {
      if (!listGroves(mycoHome).some((grove) => grove.id === servedGroveId)) {
        options.logger?.warn(
          LOG_KINDS.HOST_SERVE,
          'Team Host serve is enabled but served_grove_id names no Grove on this machine — a dangling designation, host serving stays off',
          { served_grove_id: servedGroveId },
        );
        return { reason: 'dangling_served_grove' };
      }
    } catch (err) {
      // listGroves() walks + TOML-parses every grove.toml on the machine — an
      // unrelated corrupt/unreadable grove throws here. Treat "threw while
      // checking" the same as "grove missing": disable serving loudly, never
      // let it crash daemon boot (this function's never-throws contract).
      options.logger?.warn(
        LOG_KINDS.HOST_SERVE,
        'Team Host serve is enabled but served_grove_id could not be validated against the Grove registry — host serving stays off',
        { served_grove_id: servedGroveId, error: (err as Error).message },
      );
      return { reason: 'grove_registry_unreadable' };
    }
  }

  try {
    const bearer = resolveHostServeBearer(
      mycoHome,
      options.lockNamespace ?? nativePerUserLockNamespace,
    );
    return {
      runtime: {
        overlayAddress: (address as string).trim(),
        overlayPort,
        bearer,
        hostId: hostServe.host_id ?? undefined,
        label: hostServe.label ?? undefined,
        servedGroveId,
      },
    };
  } catch (err) {
    options.logger?.warn(
      LOG_KINDS.HOST_SERVE,
      'Team Host serve is enabled but the host bearer could not be resolved — host serving stays off',
      { error: (err as Error).message },
    );
    return { reason: 'bearer_unavailable' };
  }
}

// ---------------------------------------------------------------------------
// Served-grove designation health (`myco doctor`)
// ---------------------------------------------------------------------------

/**
 * Designation health, classified independent of the daemon boot path — used
 * by `myco doctor` so a dangling designation (`served_grove_id` names no
 * Grove on this machine) surfaces on demand, not only via the one-time log
 * {@link resolveHostServeConfig} emits at startup, which scrolls past.
 */
export type ServedGroveDesignationHealth =
  | { kind: 'not_serving' }
  | { kind: 'undesignated' }
  | { kind: 'dangling'; servedGroveId: string }
  | { kind: 'ok'; servedGroveId: string };

/**
 * Classify this machine's served-grove designation against the actual Grove
 * registry. Pure read, never throws — mirrors the same referential-
 * integrity check {@link resolveHostServeConfig} runs at boot: a corrupt or
 * unreadable UNRELATED Grove on the machine classifies as `dangling` rather
 * than propagating the error to the caller.
 */
export function resolveServedGroveDesignationHealth(
  machineConfig: MachineConfig,
  mycoHome: string = resolveMycoHome(),
): ServedGroveDesignationHealth {
  const hostServe = machineConfig.daemon.host_serve;
  if (!hostServe.enabled) return { kind: 'not_serving' };

  const servedGroveId = hostServe.served_grove_id?.trim() || undefined;
  if (!servedGroveId) return { kind: 'undesignated' };

  try {
    const exists = listGroves(mycoHome).some((grove) => grove.id === servedGroveId);
    return exists ? { kind: 'ok', servedGroveId } : { kind: 'dangling', servedGroveId };
  } catch {
    return { kind: 'dangling', servedGroveId };
  }
}

// ---------------------------------------------------------------------------
// Served-grove backup staleness (`myco doctor`, server-mode design spec §8)
// ---------------------------------------------------------------------------

/**
 * Backup staleness, classified independent of the daemon boot path — used by
 * `myco doctor` to surface a served Grove with no successful backup within
 * its configured interval. The served Grove is the sole copy of all
 * attached-project team knowledge (spec §8), so a stale backup is a
 * first-class warning, not an afterthought.
 */
export type ServedGroveBackupHealth =
  | { kind: 'not_applicable' }
  | { kind: 'stale'; servedGroveId: string }
  | { kind: 'ok'; servedGroveId: string };

/**
 * Classify this machine's served-grove backup posture using the SAME
 * bookkeeping the auto-backup PowerJob itself gates on ({@link isAutoBackupDue}
 * — newest backup for this machine older than the Grove's configured
 * `auto_interval_hours`, or none exists). `not_applicable` covers every case
 * where staleness isn't a meaningful question: serving is off, undesignated,
 * or the designation is dangling (all three are {@link resolveServedGroveDesignationHealth}'s
 * job to report). Pure read, never throws.
 */
export function resolveServedGroveBackupHealth(
  machineConfig: MachineConfig,
  mycoHome: string = resolveMycoHome(),
): ServedGroveBackupHealth {
  const designation = resolveServedGroveDesignationHealth(machineConfig, mycoHome);
  if (designation.kind !== 'ok') return { kind: 'not_applicable' };

  try {
    const stale = isAutoBackupDue({ groveId: designation.servedGroveId, machineId: getMachineId(), mycoHome });
    return { kind: stale ? 'stale' : 'ok', servedGroveId: designation.servedGroveId };
  } catch {
    return { kind: 'not_applicable' };
  }
}

// ---------------------------------------------------------------------------
// Served-grove team-key posture (`myco doctor`, server-mode design spec §5)
// ---------------------------------------------------------------------------

/**
 * Team-key posture for the served Grove — `missing_key` when the Grove's
 * effective agent provider is a cloud type (anthropic/openai/openrouter)
 * requiring a stored key and neither the served Grove's `secrets.env`, the
 * machine `secrets.env`, nor the inherited process env supplies it. This is
 * the SAME condition {@link probeProviderAvailable} suppresses scheduled LLM
 * dispatch on — this classifier exists so the same signal is queryable
 * on-demand (`myco doctor`) instead of only discoverable by watching every
 * scheduled tick get silently skipped.
 */
export type ServedGroveKeyHealth =
  | { kind: 'not_applicable' }
  | { kind: 'missing_key'; servedGroveId: string }
  | { kind: 'ok'; servedGroveId: string };

/**
 * Classify this machine's served-grove team-key posture. `not_applicable`
 * covers every case where the question doesn't apply: serving is off,
 * undesignated, dangling (all three are {@link resolveServedGroveDesignationHealth}'s
 * job to report), or no explicit cloud provider is configured for the Grove
 * (the claude-sdk default needs no stored key). Never throws — but NOT a
 * pure read: it calls `loadLayeredSecrets`, which mutates `process.env`
 * (see {@link resolveServedGroveKeyHealthIsolated}, the poll-safe wrapper
 * that undoes that side effect for a long-lived caller).
 */
export function resolveServedGroveKeyHealth(
  machineConfig: MachineConfig,
  mycoHome: string = resolveMycoHome(),
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): ServedGroveKeyHealth {
  const designation = resolveServedGroveDesignationHealth(machineConfig, mycoHome);
  if (designation.kind !== 'ok') return { kind: 'not_applicable' };

  try {
    const groveDir = resolveGroveDir(designation.servedGroveId, mycoHome);
    // Same layering the scheduler applies before a dispatch against this
    // Grove, with the same semantics: boot/shell env vars are protected
    // (never overwritten or deleted); keys layering itself wrote are
    // refreshed from the files on every call — grove file wins over machine
    // file, and a key deleted from both files is removed from the env. So
    // this classifier can never disagree with what a real dispatch would
    // see, including after a Team-page update or delete.
    loadLayeredSecrets([mycoHome, groveDir], process.env, lockNamespace);
    const mycoConfig = loadMergedConfig(groveDir, {
      groveId: designation.servedGroveId,
      mycoHome,
      projectTierOptional: true,
    });
    const provider = mycoConfig.agent.provider;
    if (!provider) return { kind: 'not_applicable' };
    const reason = missingKeyReason({ type: provider.type });
    return reason === 'missing_key'
      ? { kind: 'missing_key', servedGroveId: designation.servedGroveId }
      : { kind: 'ok', servedGroveId: designation.servedGroveId };
  } catch {
    return { kind: 'not_applicable' };
  }
}

/**
 * Same classification as {@link resolveServedGroveKeyHealth}, isolated from the
 * daemon's long-lived `process.env`. The underlying classifier calls
 * `loadLayeredSecrets`, which mutates the process env: it adds/refreshes the
 * keys it owns and deletes owned keys whose file entries disappeared (boot
 * env stays protected). Those refresh semantics already keep repeated bare
 * calls ACCURATE — a stale classification can no longer latch — so this
 * wrapper is pure env hygiene, not a correctness requirement: a polled route
 * (the Team page) should not leave the served Grove's secrets sitting in the
 * daemon's env between polls when nothing else needs them there.
 *
 * The wrapper snapshots the env key set before calling the real classifier
 * and deletes anything newly added afterward. Keys it removes were recorded
 * as layering-owned; the next layering call sees the changed (unset) value,
 * relinquishes the stale ownership entry, and re-adds the key from the files
 * — so wrapper cleanup and the ownership registry never fight. `myco doctor`
 * (a one-shot process) keeps calling {@link resolveServedGroveKeyHealth}
 * directly — the isolation cost is only worth paying where the process
 * outlives the check.
 */
export function resolveServedGroveKeyHealthIsolated(
  machineConfig: MachineConfig,
  mycoHome: string = resolveMycoHome(),
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): ServedGroveKeyHealth {
  const before = new Set(Object.keys(process.env));
  try {
    return resolveServedGroveKeyHealth(machineConfig, mycoHome, lockNamespace);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!before.has(key)) delete process.env[key];
    }
  }
}

// ---------------------------------------------------------------------------
// External MCP config/token coherence (`myco doctor`, server-mode design
// spec §7)
// ---------------------------------------------------------------------------

/**
 * External MCP config/secret coherence — the config-layer half of "doctor
 * reports funnel/listener coherence" (Task 10). `missing_token` is the ONE
 * inconsistency this pure, file-based classifier can actually detect: the
 * toggle says enabled but no token has ever been minted (e.g. a hand-edited
 * `config.yaml`, or a secrets.env wiped out from under a running daemon) —
 * the listener cannot possibly authenticate a caller in that state.
 *
 * What this does NOT (and structurally cannot) verify without a live
 * process or shelling to `tailscale`: whether THIS daemon actually has the
 * listener bound right now, and whether Funnel is actually fronting the
 * port. Those are live-daemon/live-tailscaled observables — the Funnel
 * frontend is rig-validated in Task 12, not unit-testable, and daemon doctor
 * checks are deliberately process-independent (pure reads over
 * `~/.myco/config.yaml` + `secrets.env`, same as every other check in this
 * file). `ok` covers "config says enabled and a token exists" — a stronger
 * claim than that is out of scope for this classifier.
 */
export type ExternalMcpCoherence =
  | { kind: 'not_enabled' }
  | { kind: 'missing_token'; port: number }
  | { kind: 'ok'; port: number };

export function resolveExternalMcpCoherence(
  machineConfig: MachineConfig,
  mycoHome: string = resolveMycoHome(),
): ExternalMcpCoherence {
  const externalMcp = machineConfig.daemon.external_mcp;
  if (!externalMcp.enabled) return { kind: 'not_enabled' };

  const token = readSecrets(mycoHome)[HOST_EXTERNAL_MCP_TOKEN_SECRET];
  if (!token || !token.trim()) return { kind: 'missing_token', port: externalMcp.port };
  return { kind: 'ok', port: externalMcp.port };
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
      // Stamp the host's live protocol version even on the unauthenticated
      // refusal — the member's reachability probe (no bearer) reads it here to
      // learn a host that has upgraded since join, so its recorded version can
      // catch up without a re-join (the version is public, like an API-version
      // header; the 409 version gate already echoes it to authenticated callers).
      headers: { [HOST_PROTOCOL_HEADER]: String(HOST_PROTOCOL_VERSION) },
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
// Served-grove filter (Task 2) — the dual-homed dispatch chokepoint gate
// ---------------------------------------------------------------------------

/**
 * Fail-closed served-grove gate for overlay requests. Refuses when serving has
 * no designation, when the resolved context has no grove, or when the grove is
 * not THE served grove. Returns null only for an exact designation match.
 *
 * This is the ONE dispatch-boundary check that closes the gap the blanket
 * bearer/lifecycle/version gate above leaves open: the bearer proves overlay
 * ADMISSION, not which Grove a member may reach. Without this filter, a
 * bearer-holding member could send `x-myco-grove-id` naming ANY Grove this
 * host owns — including the operator's own personal Groves — and the host
 * would happily resolve and open that Grove's DB (server-mode design spec §2,
 * the one Critical finding in the spec's independent review).
 *
 * MUST be called at BOTH overlay dispatch chokepoints — router routes
 * (`daemon/server.ts`, after `resolveRouteRequestContext`) and the raw `/mcp`
 * route (`mcp/http.ts`, after `resolveRequestContextOrLegacy`) — immediately
 * after the request's Grove context is resolved and BEFORE any dispatch. A
 * single-homed filter leaves the other chokepoint's full tool/route surface
 * open against any Grove on the box.
 *
 * The null-grove branch is explicit and unconditional — this function never
 * takes the `if (groveId && ...)` shape, which would fail OPEN for any
 * grove-less overlay request (a machine-level/no-tenancy route slipping past
 * a truthiness check). Every branch below is a distinct, named refusal reason;
 * only the exact-match branch returns null.
 */
export function servedGroveRefusal(
  runtime: HostServeRuntime,
  resolvedGroveId: string | null,
): OverlayGateRefusal | null {
  if (!runtime.servedGroveId) {
    return {
      status: 404,
      body: {
        error: 'not_found',
        message: 'This host is not designated to serve any Grove.',
      },
    };
  }
  if (resolvedGroveId === null) {
    return {
      status: 404,
      body: {
        error: 'not_found',
        message: 'This request resolved no Grove; the host serves exactly one designated Grove over the overlay.',
      },
    };
  }
  if (resolvedGroveId !== runtime.servedGroveId) {
    return {
      status: 404,
      body: {
        error: 'not_found',
        message: 'This Grove is not the one Grove this host serves over the overlay.',
      },
    };
  }
  return null;
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
  /**
   * This host's one served Grove (protocol v2, server-mode design spec §2).
   * `null` when serving is enabled but undesignated — a distinct wire state
   * from the field being ABSENT entirely, which is how a pre-v2 host's
   * enrollment response looks and is what tells a joining member "this host
   * predates served-grove designation" (`member-overlay.ts`
   * `HostEnrollmentResponse.served_grove_id`).
   */
  served_grove_id: string | null;
}

/**
 * THE one producer of the `<overlay-ip>:<port>` authority members dial.
 *
 * Every surface that tells someone which address to reach this host on goes
 * through here — the enrollment payload, the emitted `myco join` command, the
 * CLI status/enable printouts, and the host-serve status API. Before this
 * existed each derived its own, and several composed the DAEMON's canonical
 * port instead of the overlay port, which silently handed members an address
 * that cannot answer.
 */
export function formatOverlayAuthority(overlayAddress: string, overlayPort: number): string {
  return `${overlayAddress}:${overlayPort}`;
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
    overlay_address: formatOverlayAuthority(runtime.overlayAddress, overlayPort),
    protocol_version: HOST_PROTOCOL_VERSION,
    bearer: runtime.bearer,
    served_grove_id: runtime.servedGroveId ?? null,
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
