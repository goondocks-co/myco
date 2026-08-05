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
  HOST_RESIGN_ROUTE,
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
import { authenticateMemberToken } from '../team-host/member-tokens.js';
import { REQUEST_CONTEXT_HEADERS } from '../grove/request-context.js';

/** The resolved host-serve enablement passed to `DaemonServer`. `null` means
 *  host serving is OFF and no second listener binds. */
export interface HostServeRuntime {
  /** The host bearer every team request must present (`Authorization: Bearer`). */
  bearer: string;
  /** The host's control-plane id, surfaced from `host_serve` config so the
   *  enrollment endpoint can self-report it. */
  hostId?: string;
  /** Human-readable host label. Same provenance + fallback as {@link hostId}. */
  label?: string;
  /** The one Grove this host serves (`host_serve.served_grove_id`), surfaced so
   *  {@link servedGroveRefusal} can refuse any team request whose resolved
   *  Grove doesn't match. Absent when the designation is unset (null) — a
   *  fail-closed outcome the filter enforces, not this module. */
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
// Team request mark
// ---------------------------------------------------------------------------
//
// A request that arrived on the team listener is tagged here so the shared
// dispatch (`server.ts handleRequest`, `mcp/http.ts`) can branch on it WITHOUT
// re-deriving the listener: it skips attach classification (a host serves its
// own Groves locally and must NEVER re-proxy — the circular-proxy defense),
// skips the loopback CSRF gate (the team gate already validated it), and
// refuses the static/UI surface (the team surface carries only the daemon API).
// A WeakSet keys on the request object itself — no header spoofing surface, no
// leak (entries are collected with the request).

const teamRequests = new WeakSet<http.IncomingMessage>();

/** Tag a request as having arrived on the team listener. */
export function markTeamRequest(req: http.IncomingMessage): void {
  teamRequests.add(req);
}

/** True when a request arrived on the team listener (see the note above). */
export function isTeamRequest(req: http.IncomingMessage): boolean {
  return teamRequests.has(req);
}

// ---------------------------------------------------------------------------
// Enablement + bearer
// ---------------------------------------------------------------------------

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
/** Why an enabled-looking config still yields no serving runtime. One reason
 *  per refusal branch below; consumed by the status route's `serving: false`
 *  body so the UI renders the daemon's actual diagnosis instead of a bare
 *  boolean (E1 §4.1, review RC3). */
export type HostServeRefusalReason =
  | 'disabled'
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
export interface TeamAuthOutcome {
  refusal: OverlayGateRefusal | null;
  /** The authenticated member, present only when `refusal` is null. */
  member: { id: string; machineId: string } | null;
}

/** The 401 every unauthenticated team request gets — one shape, so a caller
 *  cannot distinguish "no token" from "wrong token" from "revoked". */
function unauthorized(): OverlayGateRefusal {
  return {
    status: 401,
    // Stamp the host's live protocol version even on the unauthenticated
    // refusal — the member's reachability probe (no token) reads it here to
    // learn a host that has upgraded since join, so its recorded version can
    // catch up without a re-join (the version is public, like an API-version
    // header; the 409 version gate already echoes it to authenticated callers).
    headers: { [HOST_PROTOCOL_HEADER]: String(HOST_PROTOCOL_VERSION) },
    body: {
      error: 'host_unauthorized',
      message: 'Requests to a Team Host require a member token.',
    },
  };
}

/**
 * Authenticate a team request against the PER-MEMBER token store.
 *
 * The shared host bearer is no longer accepted, and that removal is the point
 * rather than a side effect: every member already holds it, so leaving it in
 * the accepted set would mean revoking one member changes nothing for anyone
 * who kept a copy — per-member revocation would be decorative. Cutover
 * therefore invalidates existing members by design.
 *
 * Returns the matched member so the caller can bind identity to it
 * ({@link teamMachineIdRejection}) instead of trusting a per-request header.
 */
export function teamAuthOutcome(req: http.IncomingMessage): TeamAuthOutcome {
  const presented = parseBearer(req.headers.authorization);
  if (!presented) return { refusal: unauthorized(), member: null };
  const auth = authenticateMemberToken(presented);
  if (!auth.ok) return { refusal: unauthorized(), member: null };
  return { refusal: null, member: { id: auth.id, machineId: auth.machineId } };
}

/**
 * Bind the request's machine identity to the token's.
 *
 * `x-myco-machine-id` is not a context-switching header, so it has always been
 * an unauthenticated per-request claim that flowed straight into every
 * `machine_id` column. The token carries the machine_id its member asserted at
 * enrollment — a trust-on-first-use anchor — so:
 *
 *   - **absent header → stamp from the token.** Nothing is lost; the caller
 *     simply did not repeat what the host already knows.
 *   - **present and MISMATCHED → 409, and no row written.** Not a silent
 *     overwrite. `machine_id` regenerates when `~/.myco/machine_id` is lost
 *     (reinstall, home wipe, new account) and can be baked wrong by the
 *     `gh`-timeout fallback — this repo has already run a backfill for that
 *     class. Overwriting would attribute rows forever to an identity that no
 *     longer exists, with no error anywhere. Divergence from a TOFU anchor is a
 *     re-join event, so it is surfaced as one.
 */
export function teamMachineIdRejection(
  req: http.IncomingMessage,
  member: { machineId: string },
): OverlayGateRefusal | null {
  const raw = req.headers[REQUEST_CONTEXT_HEADERS.machineId];
  const claimed = Array.isArray(raw) ? raw[0] : raw;
  if (claimed === undefined || claimed === '') return null;
  if (claimed === member.machineId) return null;
  return {
    status: 409,
    headers: { [HOST_PROTOCOL_HEADER]: String(HOST_PROTOCOL_VERSION) },
    body: {
      error: 'machine_identity_mismatch',
      message: 'This member token was issued to a different machine identity — re-join this host to re-establish it.',
      retryable: false,
    },
  };
}

/**
 * The raw routes the TEAM listener serves. An allowlist: anything not named
 * here is 404 on the team surface, including raw routes added later.
 */
const TEAM_ADMITTED_RAW_ROUTES: ReadonlySet<string> = new Set<string>([
  '/health', // reachability probe — a member confirms the host answers
  '/api/version', // version probe
  '/mcp', // the hosted MCP surface; gated downstream by servedGroveRefusal
  // ADMITTED, and only because it now carries its own gate. This route is
  // exempt from the per-member token check (a member obtains its token here),
  // so its admission depends entirely on the daemon-minted single-use join key
  // being validated IN the request — `consumeJoinKey`, `daemon/server.ts`.
  // Before that key existed the route returned the SHARED bearer to any caller
  // and its only real boundary was tailnet membership, which is why it stayed
  // un-admitted through the PR that published this socket. If the key check is
  // ever removed or weakened, this entry must come out in the same change.
  HOST_ENROLL_ROUTE,
  // Admitted, and NOT bearer-exempt — unlike enrollment, this one sits behind
  // the ordinary per-member token gate, because the credential presented is
  // exactly the authorization: a caller can only surrender the access it
  // already holds. Without it, `myco leave` is a member-side write only, the
  // host keeps a live record forever, and re-joining is refused with no
  // self-service way out.
  HOST_RESIGN_ROUTE,
]);

/**
 * Whether a RAW route (one registered outside the router, and therefore never
 * classified by `classifyRouteStamp`) may be served on the team listener.
 *
 * This is an allowlist, and the inversion is the point. The overlay gate this
 * replaces was a deny-list naming `/api/shutdown`, which meant a raw route added
 * later was served to members by default and had to be remembered into the deny
 * set. On a listener whose surface is published to the public internet, the
 * default must be refusal: a new raw route is unreachable here until it is
 * named above, and the reviewer of the PR that adds it has to make that call
 * explicitly.
 *
 * Router routes are not covered here — they carry scope-map stamps and are
 * refused by class in `overlayHostStampRefusal` (`host/routing.ts`).
 */
export function teamRawRouteAdmitted(pathname: string): boolean {
  return TEAM_ADMITTED_RAW_ROUTES.has(pathname);
}

/** The raw routes the team listener serves — exported so the meta gate can
 *  assert this set against the daemon's actual raw-route registrations. */
export function teamAdmittedRawRoutes(): ReadonlySet<string> {
  return TEAM_ADMITTED_RAW_ROUTES;
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
 * (`daemon/server.ts`) additionally asserts overlay provenance (`isTeamRequest`)
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
  protocol_version: number;
  /** The shared host serve-bearer (the secret enrollment delivers to a joiner). */
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
 * Build the enrollment response from the resolved host-serve runtime + the actual
 * bound team socket (known only after listen). The bearer is
 * `runtime.bearer` — the exact value {@link resolveHostServeBearer} minted/read at
 * config resolution, so there is one bearer per host, delivered here unchanged.
 */
/**
 * The enrollment response.
 *
 * `bearer` is now the member's OWN token, minted for this enrollment and passed
 * in — never `runtime.bearer`, the shared host secret. The field keeps its name
 * because it is the member's wire contract (it is stored under
 * `HOST_BEARER_SECRET` and sent as `Authorization: Bearer`), but what travels
 * is per-member and individually revocable.
 */
export function buildHostEnrollmentPayload(
  runtime: HostServeRuntime,
  memberToken: string,
): HostEnrollmentPayload {
  return {
    host_id: runtime.hostId ?? '',
    label: runtime.label ?? '',
    protocol_version: HOST_PROTOCOL_VERSION,
    bearer: memberToken,
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
