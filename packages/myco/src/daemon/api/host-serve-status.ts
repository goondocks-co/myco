/**
 * Team Host operator-side serving status (Team Host E-4 W1 Task T4,
 * decision-ef693c71 D3).
 *
 *   GET /api/host-serve/status
 *
 * `localhost-only` (`host/routing.ts` ROUTE_RULES): reports THIS machine's
 * own host-serve enablement/runtime state — machine-scoped, no project/Grove
 * tenancy, and never a valid overlay surface (see the ROUTE_RULES comment).
 *
 * UNCONDITIONAL POSITIVE READ — this route never refuses. A machine that
 * isn't serving returns `{ serving: false }`, not a 404/409 the way the
 * served-grove's team-write surface (`team-config.ts`) refuses `not_serving`
 * for a caller who has no business asking. The operator dashboard IS that
 * business — "is this box serving?" is exactly the question a not-serving
 * answer must be able to answer plainly.
 *
 * Runtime-vs-config judgment call: `deps.hostServe` is the SAME
 * boot-resolved {@link HostServeRuntime} `daemon/main.ts` already threads into
 * `team-config.ts`'s `teamWriteDeps` (`resolveHostServeConfig`, evaluated
 * once at daemon startup) — reused here rather than re-parsing
 * `daemon.host_serve` from disk, so `overlay_address`/`host_id`/`label`/
 * `served_grove_id`/`bearer_present` reflect what this RUNNING daemon
 * actually enforces (the same values `servedGroveRefusal` gates on), not a
 * possibly-newer on-disk value that needs a restart to take effect (mirrors
 * `resolveHostServeBearer`'s rotation-needs-restart contract). The four
 * health classifiers below, by contrast, take a FRESHLY loaded
 * `MachineConfig` — the SAME choice `handleGetTeamConfig` already makes for
 * `resolveServedGroveKeyHealthIsolated` — because a stale-vs-live divergence
 * there (e.g. `served_grove_id` edited on disk since boot) is itself the
 * diagnostic signal an operator dashboard exists to surface, exactly as
 * `myco doctor`'s on-demand checks do.
 */
import { loadMachineConfig } from '../../config/loader.js';
import { readSecrets } from '../../config/secrets.js';
import { HOST_EXTERNAL_MCP_TOKEN_SECRET } from '../../constants.js';
import { resolveMycoHome } from '../../grove/paths.js';
import { loadGroveRecord } from '../../grove/registry.js';
import { countHostedProjects } from '../../host/hosted-projects.js';
import {
  classifyHostServeRefusalReadOnly,
  type HostServeRefusalReason,
  formatOverlayAuthority,
  resolveExternalMcpCoherence,
  resolveServedGroveBackupHealth,
  resolveServedGroveDesignationHealth,
  resolveServedGroveKeyHealthIsolated,
  type HostServeRuntime,
} from '../host-serve.js';
import type { ExternalMcpListenerControl } from './team-config.js';
import type { RouteHandler, RouteRegistrar, RouteResponse } from '../router.js';
import {
  nativePerUserLockNamespace,
  type PerUserLockNamespace,
} from '@myco/utils/per-user-lock-namespace.js';

/** TTL for the served-grove health-classifier bundle (~15s, decision-ef693c71
 *  D3). The four classifiers below run `loadMergedConfig` + secrets reads per
 *  call (`resolveServedGroveKeyHealthIsolated` in particular) — a dashboard
 *  poll must not re-walk config/disk on every request. */
export const HOST_SERVE_STATUS_CACHE_TTL_MS = 15_000;

export interface HostServeStatusRouteDeps {
  /** This machine's resolved host-serve runtime, or `null` when this machine
   *  is not a Team Host (or is disabled/misconfigured) — the SAME value
   *  `team-config.ts`'s `teamWriteDeps.hostServe` carries. */
  hostServe: HostServeRuntime | null;
  mycoHome?: string;
  /** The live external-MCP listener's bound state — `null` (never probed)
   *  when no live listener was threaded into these deps, mirroring
   *  `team-config.ts`'s `ExternalMcpStatusBody.bound`. */
  externalMcp?: { listener: Pick<ExternalMcpListenerControl, 'isBound'> };
  /** Is the overlay listener actually bound? `serving` alone is config-
   *  derived and survives every bind failure (EADDRINUSE, EMFILE, bad
   *  address) — E1 §7 gate 4 requires success to mean a BOUND listener.
   *  `null` when no live server was threaded in (tests, degraded wiring). */
  overlayListenerBound?: () => boolean;
  /** Daemon process start stamp (ISO) — the enable job's restart
   *  discriminator (E1 §4.1 rev 6): Phase 2 must observe a DIFFERENT value
   *  than its pre-restart snapshot, or the poll can succeed against the
   *  dying pre-restart process (a 15s cache makes this the common case). */
  startedAt?: () => string;
  /** Test seam: override the machine-config load (default the real loader). */
  loadMachineConfig?: typeof loadMachineConfig;
  /** Test seam: current-time source, for TTL determinism. */
  now?: () => number;
  /** Test seam: override the cache TTL (default {@link HOST_SERVE_STATUS_CACHE_TTL_MS}). */
  ttlMs?: number;
  lockNamespace?: PerUserLockNamespace;
}

/** Why serving is off, as the STATUS ROUTE reports it: the config
 *  classifier's refusal reasons plus 'restart_pending' — config is valid
 *  NOW but this process booted before it was written, i.e. the enable
 *  flow's normal pre-restart window. */
type NotServingReason = HostServeRefusalReason | 'restart_pending';

interface HostServeStatusBody {
  serving: true;
  /** Observed listener bind — `serving && overlay_listener_bound` is the
   *  ONLY honest success condition (gate 4); `null` = not probeable. */
  overlay_listener_bound: boolean | null;
  /** Restart discriminator (see {@link HostServeStatusRouteDeps.startedAt}). */
  started_at: string | null;
  served_grove_id: string | null;
  served_grove_name: string | null;
  /** Registered rows under the served Grove's `hosted/` synthetic-root namespace
   *  — the member-attached projects this host has admitted via registration-on-
   *  ingest (E-4 W2 T1). Zero when undesignated/dangling (no served grove). */
  hosted_project_count: number;
  /** The full `<overlay-ip>:<port>` authority members dial — not a bare IP.
   *  Composed by the one producer (`formatOverlayAuthority`). */
  overlay_address: string;
  host_id: string | null;
  label: string | null;
  external_mcp: {
    enabled: boolean;
    port: number;
    bound: boolean | null;
    token_present: boolean;
  };
  bearer_present: boolean;
  health: {
    designation: string;
    backup: string;
    key: string;
    mcp_coherence: string;
  };
}

/**
 * Process-global invalidation epoch for the served-grove status cache. Bumped by
 * {@link invalidateHostServeStatusCache} when a state change must be reflected
 * before the TTL would otherwise expire — the detach-pull deregistering a stub
 * project (Phase F T3), so `hosted_project_count` is honest immediately rather than
 * up to `HOST_SERVE_STATUS_CACHE_TTL_MS` stale. Each handler closure remembers the
 * epoch it cached at and treats a mismatch as a miss.
 */
let statusCacheEpoch = 0;

/** Force the next `GET /api/host-serve/status` to recompute (drops every closure's
 *  cached bundle via the epoch check). Idempotent and cheap. */
export function invalidateHostServeStatusCache(): void {
  statusCacheEpoch += 1;
}

/**
 * `GET /api/host-serve/status` handler. The served-grove classifier bundle
 * (health.*, external_mcp.token_present) is cached for `ttlMs` inside this
 * closure — one cache per daemon process, matching every other TTL-cached
 * probe in this route family (`host-membership.ts`'s health handler). Never
 * triggered by a timer: a cache miss/expiry is only ever populated by an
 * actual incoming request. A bump of the process-global epoch
 * ({@link invalidateHostServeStatusCache}) also drops the cache early.
 */
export function createHostServeStatusHandler(deps: HostServeStatusRouteDeps): RouteHandler {
  const loadConfig = deps.loadMachineConfig ?? loadMachineConfig;
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? HOST_SERVE_STATUS_CACHE_TTL_MS;
  const lockNamespace = deps.lockNamespace ?? nativePerUserLockNamespace;
  const mycoHome = deps.mycoHome ?? resolveMycoHome();

  let cache: { body: HostServeStatusBody; expiresAt: number; epoch: number } | null = null;

  // The not-serving REASON is cached like the serving body (same TTL, same
  // epoch): this is the Phase-2 poll's hot path, and the classification
  // walks the Grove registry when a designation is set. READ-ONLY by
  // construction — the classifier never resolves the bearer, because bearer
  // resolution is mint-if-absent and a GET must never persist a machine
  // secret (diff review C4). The live fields (listener bind, started_at)
  // are NOT cached — they are the poll's whole point.
  let notServingReasonCache: { reason: NotServingReason; expiresAt: number; epoch: number } | null = null;
  const notServingBody = (): Record<string, unknown> => {
    let reason: NotServingReason;
    if (notServingReasonCache && now() < notServingReasonCache.expiresAt && notServingReasonCache.epoch === statusCacheEpoch) {
      reason = notServingReasonCache.reason;
    } else {
      try {
        // `null` = config valid NOW but this process booted before it was
        // written: the enable flow's normal pre-restart window. (Best-effort
        // naming — a transient boot failure that has since cleared also
        // reads as restart_pending; the Phase-2 discriminator, not this
        // label, is what decides completion.)
        const refusal = classifyHostServeRefusalReadOnly({ machineConfig: loadConfig(mycoHome), mycoHome });
        reason = refusal ?? 'restart_pending';
      } catch {
        reason = 'disabled';
      }
      notServingReasonCache = { reason, expiresAt: now() + ttlMs, epoch: statusCacheEpoch };
    }
    return {
      serving: false,
      not_serving_reason: reason,
      overlay_listener_bound: deps.overlayListenerBound ? deps.overlayListenerBound() : null,
      started_at: deps.startedAt ? deps.startedAt() : null,
    };
  };

  return async (): Promise<RouteResponse> => {
    const runtime = deps.hostServe;
    if (!runtime) return { status: 200, body: notServingBody() };

    if (cache && now() < cache.expiresAt && cache.epoch === statusCacheEpoch) {
      return { status: 200, body: cache.body };
    }

    const machine = loadConfig(mycoHome);
    const servedGroveId = runtime.servedGroveId ?? null;
    const servedGroveName = servedGroveId ? (loadGroveRecord(servedGroveId, mycoHome)?.name ?? null) : null;

    const designation = resolveServedGroveDesignationHealth(machine, mycoHome);
    const backup = resolveServedGroveBackupHealth(machine, mycoHome);
    const key = resolveServedGroveKeyHealthIsolated(machine, mycoHome, lockNamespace);
    const mcpCoherence = resolveExternalMcpCoherence(machine, mycoHome);

    const existingToken = readSecrets(mycoHome)[HOST_EXTERNAL_MCP_TOKEN_SECRET];

    const body: HostServeStatusBody = {
      serving: true,
      overlay_listener_bound: deps.overlayListenerBound ? deps.overlayListenerBound() : null,
      started_at: deps.startedAt ? deps.startedAt() : null,
      served_grove_id: servedGroveId,
      served_grove_name: servedGroveName,
      hosted_project_count: servedGroveId ? countHostedProjects(servedGroveId, mycoHome) : 0,
      overlay_address: formatOverlayAuthority(runtime.overlayAddress, runtime.overlayPort),
      host_id: runtime.hostId ?? null,
      label: runtime.label ?? null,
      external_mcp: {
        enabled: machine.daemon.external_mcp.enabled,
        port: machine.daemon.external_mcp.port,
        bound: deps.externalMcp ? deps.externalMcp.listener.isBound : null,
        token_present: Boolean(existingToken && existingToken.trim()),
      },
      bearer_present: Boolean(runtime.bearer && runtime.bearer.trim()),
      health: {
        designation: designation.kind,
        backup: backup.kind,
        key: key.kind,
        mcp_coherence: mcpCoherence.kind,
      },
    };
    cache = { body, expiresAt: now() + ttlMs, epoch: statusCacheEpoch };
    return { status: 200, body };
  };
}

/** Register the host-serve status route on the daemon server. */
export function registerHostServeStatusRoute(server: RouteRegistrar, deps: HostServeStatusRouteDeps): void {
  server.registerRoute('GET', '/api/host-serve/status', createHostServeStatusHandler(deps));
}
