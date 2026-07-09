/**
 * Team Host — the member-side routing decision.
 *
 * `classifyRoute` is the single function both inbound dispatch chokepoints call
 * (the router path in `daemon/server.ts`, the raw `/mcp` path in `mcp/http.ts`).
 * Given a request's method, pathname, and resolved project id, it decides —
 * WITHOUT any Grove/DB resolution — whether the request is served locally,
 * proxied to the host that serves the project, or refused with a uniform
 * degradation payload.
 *
 * The classification encodes the per-route stamps from the Team Host scope-map
 * audit (`docs/superpowers/specs/2026-07-07-team-host-scope-map.md` §1) as a
 * table, not scattered conditionals:
 *
 *   - `serve`   → proxy to host (knowledge/viewing/host-run intelligence).
 *   - `collect` → proxy to host (origin-side capture; the collector contract
 *                 lives in the proxy, Task 1.3 — from here it is a proxy hand-off).
 *   - `degrade` → central refusal: the capability is OFF for hosted projects
 *                 in v1 (Canopy, git provenance).
 *   - `config-lock` → central refusal: a write to host-authoritative shared
 *                 config; the host is config-authoritative for attached projects.
 *   - `config-carve` → member-side per-tier config handling (routing-layer §6.3):
 *                 machine/project/personal tiers resolve from the member's own
 *                 disk, the grove tier is host-sourced, and a personal override of
 *                 a grove-tier (shared-capability) leaf is refused. Neither a plain
 *                 proxy (which would resolve the member's machine tier from the
 *                 host) nor a plain local read (an attached project has no local
 *                 Grove row to resolve against) is correct; the member assembles.
 *   - `localhost-only` → served locally (operator control plane / local-install
 *                 management); never crosses the overlay.
 *
 * A route with no explicit rule defaults to `serve`: proxying to the host is the
 * dominant, invariant-preserving behavior (it never opens a local Grove DB), and
 * the host is authoritative for what it will and won't serve. The explicit rules
 * are therefore precisely the "do NOT plainly proxy this" decisions — refuse it,
 * keep it local, or mark it capture. A NEW localhost-only, degrade, or
 * config-lock route MUST be added here, or it will proxy to the host.
 *
 * The whole table is consulted ONLY for projects the machine-global host/attach
 * registry says are attached. A non-attached project (the overwhelming common
 * case) short-circuits to `{ kind: 'local' }` before the table is touched, so a
 * machine with no hosts pays only one `fs.existsSync` (the registry's empty-set
 * fast path) and behaves byte-for-byte as today.
 */
import { HOST_BEARER_SECRET } from '../constants.js';
import type { GroveProjectId } from '../grove/ids.js';
import { scopePolicyForPath } from '../config/scope.js';
import { readHostSecrets, resolveAttach } from './registry.js';

/** The scope-map stamp a route carries. See the module docstring. */
export type RouteStamp = 'serve' | 'collect' | 'degrade' | 'config-lock' | 'config-carve' | 'localhost-only';

/** The capability + stamp for a matched route, handed to the proxy so it can
 *  key the collector contract / flush ordering without re-classifying. */
export interface RouteClassification {
  capability: string;
  stamp: RouteStamp;
}

/** Everything the host proxy (Task 1.3) needs to forward one request. */
export interface RemoteTarget {
  projectId: GroveProjectId;
  /** Grove id from the attach record — the hosted Grove's identity, not a local row. */
  groveId: string;
  host: {
    host_id: string;
    label: string;
    overlay_address: string;
    protocol_version: number;
    /** When set, the proxy dials through the local userspace-tailscaled HTTP
     *  CONNECT proxy (`--outbound-http-proxy-listen`) at `127.0.0.1:<proxy_port>`
     *  instead of a direct TCP connect to `overlay_address`. */
    proxy_port?: number;
  };
  /** Host bearer, read from the host record's secrets.env. Swapped in for the
   *  caller's local bearer before forwarding; never observable by the caller. */
  bearer: string;
}

/** The uniform refusal envelope. One shape; two transport serializers
 *  ({@link refusalJson} for router routes, {@link refusalMcpBody} for `/mcp`). */
export interface RefusalPayload {
  /** HTTP status for the router-route serializer. */
  status: number;
  /** Stable machine-readable code (also carried as `data.code` on the wire for `/mcp`). */
  error: string;
  /** The capability this refusal names, when the refusal is capability-scoped. */
  capability?: string;
  message: string;
  retryable: boolean;
}

export type RouteDecision =
  | { kind: 'local' }
  | { kind: 'remote'; target: RemoteTarget; classification: RouteClassification }
  | { kind: 'degraded'; refusal: RefusalPayload }
  | { kind: 'config_locked'; refusal: RefusalPayload }
  | { kind: 'config_carve'; target: RemoteTarget; classification: RouteClassification };

/**
 * Refusal for a capability that is unavailable for hosted (attached) projects.
 * Design of record: `capability_unavailable_hosted`, HTTP 409 (this project's
 * configuration makes the capability unavailable).
 */
export function hostedCapabilityUnavailable(capability: string): RefusalPayload {
  return {
    status: 409,
    error: 'capability_unavailable_hosted',
    capability,
    message: `${capability} is unavailable for projects served by a host in this version.`,
    retryable: false,
  };
}

/**
 * Refusal for a write to host-authoritative shared configuration. The member
 * daemon structurally refuses local overrides of shared-capability config; the
 * host is config-authoritative for attached projects.
 */
export function configHostAuthoritative(capability: string): RefusalPayload {
  return {
    status: 409,
    error: 'config_host_authoritative',
    capability,
    message:
      'This project is served by a host. Shared configuration is managed on the host; edit it there.',
    retryable: false,
  };
}

/**
 * Refusal for a route the host serves on its localhost only and never over the
 * overlay — the operator/machine-local control plane (scope-map §1d) and the
 * member-assembled config carve (§6.3), both of which are never a valid overlay
 * surface. Uses the SAME 404 `not_found` body the host-serve lifecycle refusal
 * emits (`daemon/host-serve.ts` `overlayLifecycleRefused`) so a member sees one
 * uniform "not served over the overlay" shape.
 */
export function overlayLocalhostOnlyRefusal(): RefusalPayload {
  return {
    status: 404,
    error: 'not_found',
    message: 'This route is served on localhost only, not over the overlay.',
    retryable: false,
  };
}

/**
 * The refinement of Task 1.2's coarse `PUT /api/config/scoped` config-lock
 * (routing-layer §6.2/§6.3). A scoped-config write to an attached project may
 * carry `scope: 'project' | 'local'`; neither scope writes the grove tier
 * directly, so the whole-route lock was too broad — machine/project/personal
 * writes resolve locally and must proceed. The one write this surface CAN still
 * make against host-authoritative config is a **personal (local.yaml) override
 * of a grove-homed shared-capability leaf** (e.g. `skills`, `vault_evolution`,
 * `agent`, `maintenance`, whose `overridableBy` includes `local`). That crosses
 * the shared/host boundary and is refused; everything else proceeds locally.
 *
 * Discrimination is registry-driven: a leaf whose canonical home tier is
 * `grove` is shared/host-authoritative. Reuses the SAME `SCOPE_REGISTRY` that
 * drives the tier merge and the scoped-write scope gate, so the lock cannot
 * drift from the tier model. `paths` are the value-INTRODUCING leaves only
 * (patch leaves + addToList paths); clears/removeFromList stay exempt exactly
 * as the scope gate leaves them exempt, so stale residue remains deletable.
 *
 * Returns the `config_host_authoritative` refusal when any path is grove-homed,
 * else `null` (the write proceeds locally). An unknown path (registry throws)
 * is NOT grove-homed here — the existing scoped-write scope gate already fails
 * such a path closed with a 400, so this gate need not double-refuse it.
 */
export function groveTierWriteRefusal(paths: string[]): RefusalPayload | null {
  for (const p of paths) {
    let home: string | undefined;
    try {
      home = scopePolicyForPath(p).home;
    } catch {
      continue;
    }
    if (home === 'grove') return configHostAuthoritative(CONFIG);
  }
  return null;
}

/** Serialize a refusal for a router route: `{ status, body }`. */
export function refusalJson(payload: RefusalPayload): { status: number; body: Record<string, unknown> } {
  const { status, ...body } = payload;
  return { status, body };
}

/**
 * Serialize a refusal into the JSON-RPC envelope the `/mcp` layer uses for
 * structured soft-fails (the `legacy_vault` precedent: code `-32004`, a
 * `data.code` discriminator) so MCP clients render a friendly message instead
 * of `tool_call_failed`.
 */
export function refusalMcpBody(payload: RefusalPayload): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    error: {
      code: -32004,
      message: payload.message,
      data: { code: payload.error, capability: payload.capability },
    },
    id: null,
  });
}

export interface RouteRule {
  method: string;
  pattern: string;
  stamp: RouteStamp;
  capability: string;
}

const CANOPY = 'Code intelligence (Canopy)';
const GIT = 'Git provenance';
const CONFIG = 'Config administration';
const INTEL_CONFIG = 'Intelligence config';
const COLLECTION = 'Collection';
const HOST_ADMIN = 'Host administration';
const BACKUP = 'Backup and restore';
const GROVE_ADMIN = 'Grove administration';
const DB_MAINTENANCE = 'Database maintenance';
const EMBEDDING_MAINTENANCE = 'Embedding maintenance';

/**
 * The stamp table — every rule here is a route whose attached-project behavior
 * is something OTHER than plain proxy-to-host. Everything not listed defaults to
 * `serve`. Rows mirror the scope-map §1 sections; families are matched by prefix
 * where the whole family shares a stamp.
 */
const ROUTE_RULES: RouteRule[] = [
  // --- collect: origin-side capture (scope-map §1a). Proxied; the collector
  //     contract (buffer-then-drain) is the proxy's job (Task 1.3). ---
  { method: 'POST', pattern: '/events', stamp: 'collect', capability: COLLECTION },
  { method: 'POST', pattern: '/events/stop', stamp: 'collect', capability: COLLECTION },
  { method: 'POST', pattern: '/events/sync-transcript-prompts', stamp: 'collect', capability: COLLECTION },
  { method: 'POST', pattern: '/sessions/register', stamp: 'collect', capability: COLLECTION },
  { method: 'POST', pattern: '/sessions/unregister', stamp: 'collect', capability: COLLECTION },
  // Routed transcript ingest — the host RECEIVE side of routed capture
  // (capture-push §5.2, plan C2). The member drains member-local transcript
  // bytes here; the host materializes them for its miner. Origin-side capture,
  // so `collect`: served locally on the host, proxied from a member.
  { method: 'POST', pattern: '/routed-capture/transcript', stamp: 'collect', capability: COLLECTION },
  // Routed plan-content ingest — the host RECEIVE side of the plan companion push
  // (capture-push §5.5, plan C7). The member reads its member-local plan file and
  // POSTs the content here; the host runs the SAME capturePlan against its Grove DB.
  // Origin-side capture, so `collect`: served locally on the host, proxied from a member.
  { method: 'POST', pattern: '/routed-capture/plan', stamp: 'collect', capability: COLLECTION },

  // --- degrade: Code intelligence (Canopy) OFF for hosted projects v1 (§1c, §2) ---
  { method: 'POST', pattern: '/canopy/inject', stamp: 'degrade', capability: CANOPY },
  { method: 'GET', pattern: '/api/canopy/*', stamp: 'degrade', capability: CANOPY },
  { method: 'POST', pattern: '/api/canopy/*', stamp: 'degrade', capability: CANOPY },
  { method: 'GET', pattern: '/api/sessions/:id/canopy', stamp: 'degrade', capability: CANOPY },
  { method: 'GET', pattern: '/api/sessions/:id/canopy/tool-calls/:tcId/blob', stamp: 'degrade', capability: CANOPY },

  // --- degrade: Git provenance OFF for hosted projects v1 (§1c, §2) ---
  { method: 'GET', pattern: '/api/git/status', stamp: 'degrade', capability: GIT },
  { method: 'GET', pattern: '/api/release-provenance/:namespace/:recordId', stamp: 'degrade', capability: GIT },
  { method: 'POST', pattern: '/api/maintenance/release-provenance/reconcile', stamp: 'degrade', capability: GIT },

  // --- degrade: backup/restore of the Grove DB (§1c). The host owns the DB;
  //     a member does not back up a DB it doesn't hold, and restore is a
  //     host-operator action. Only the mutation trio degrades — the GET reads
  //     (/api/backups, /api/restore/status) stay localhost-only below. ---
  { method: 'POST', pattern: '/api/backup', stamp: 'degrade', capability: BACKUP },
  { method: 'POST', pattern: '/api/restore', stamp: 'degrade', capability: BACKUP },
  { method: 'POST', pattern: '/api/restore/preview', stamp: 'degrade', capability: BACKUP },

  // --- degrade: heavyweight Grove-DB / embedding MAINTENANCE mutations. The host
  //     owns the DB and runs the intelligence (design §5.6); host-run maintenance is
  //     an OPERATOR action, not a member data-plane one. Under v1 flat-trust any
  //     bearer-holding member could otherwise drive the host to re-embed or vacuum
  //     (spending the host's embedding-provider budget / CPU) — a resource-exhaustion
  //     lever. Degrade both sides: the member can't trigger it and the host refuses it
  //     over the overlay. The READ routes (GET .../status, .../details) stay `serve`
  //     (host state, read-only) and are in the serve-default manifest below. ---
  { method: 'POST', pattern: '/api/embedding/rebuild', stamp: 'degrade', capability: EMBEDDING_MAINTENANCE },
  { method: 'POST', pattern: '/api/embedding/reconcile', stamp: 'degrade', capability: EMBEDDING_MAINTENANCE },
  { method: 'POST', pattern: '/api/embedding/clean-orphans', stamp: 'degrade', capability: EMBEDDING_MAINTENANCE },
  { method: 'POST', pattern: '/api/embedding/reembed-stale', stamp: 'degrade', capability: EMBEDDING_MAINTENANCE },
  { method: 'POST', pattern: '/api/database/optimize', stamp: 'degrade', capability: DB_MAINTENANCE },
  { method: 'POST', pattern: '/api/database/vacuum', stamp: 'degrade', capability: DB_MAINTENANCE },
  { method: 'POST', pattern: '/api/database/reindex', stamp: 'degrade', capability: DB_MAINTENANCE },
  { method: 'POST', pattern: '/api/database/integrity-check', stamp: 'degrade', capability: DB_MAINTENANCE },

  // --- degrade: Grove/project lifecycle mutations on an attached Grove (§1f).
  //     Rename/delete/move/archive of a hosted Grove or its projects is
  //     host-authoritative; a member cannot mutate the host's Grove. (Creating
  //     a *local* Grove — POST /api/groves — stays localhost-only below.) ---
  { method: 'PATCH', pattern: '/api/groves/:id', stamp: 'degrade', capability: GROVE_ADMIN },
  { method: 'DELETE', pattern: '/api/groves/:id', stamp: 'degrade', capability: GROVE_ADMIN },
  { method: 'POST', pattern: '/api/groves/:id/projects/:projectId', stamp: 'degrade', capability: GROVE_ADMIN },
  { method: 'POST', pattern: '/api/groves/:id/projects/:projectId/archive', stamp: 'degrade', capability: GROVE_ADMIN },
  { method: 'POST', pattern: '/api/groves/:id/projects/:projectId/unarchive', stamp: 'degrade', capability: GROVE_ADMIN },
  { method: 'DELETE', pattern: '/api/groves/:id/projects/:projectId', stamp: 'degrade', capability: GROVE_ADMIN },

  // --- config-lock: writes to host-authoritative shared config (§1c, §6) ---
  { method: 'PUT', pattern: '/api/grove-config', stamp: 'config-lock', capability: CONFIG },
  { method: 'PUT', pattern: '/api/backup/config', stamp: 'config-lock', capability: CONFIG },
  { method: 'POST', pattern: '/api/agent/tasks', stamp: 'config-lock', capability: INTEL_CONFIG },
  { method: 'PUT', pattern: '/api/agent/tasks/:id', stamp: 'config-lock', capability: INTEL_CONFIG },
  { method: 'POST', pattern: '/api/agent/tasks/:id/copy', stamp: 'config-lock', capability: INTEL_CONFIG },
  { method: 'DELETE', pattern: '/api/agent/tasks/:id', stamp: 'config-lock', capability: INTEL_CONFIG },
  { method: 'PUT', pattern: '/api/agent/tasks/:id/config', stamp: 'config-lock', capability: INTEL_CONFIG },

  // --- config-carve: per-tier member-side config (routing-layer §6.3). The
  //     member assembles/serves these from its own machine/project/personal
  //     tiers, host-sourcing only the grove tier — a plain proxy would resolve
  //     the member's machine tier from the HOST (guardrail 3), and a plain local
  //     read has no local Grove row to resolve against. The scoped WRITE proceeds
  //     locally unless it overrides a grove-homed (shared-capability) leaf. ---
  { method: 'GET', pattern: '/api/config', stamp: 'config-carve', capability: CONFIG },
  { method: 'GET', pattern: '/api/config/merged', stamp: 'config-carve', capability: CONFIG },
  { method: 'GET', pattern: '/api/config/local', stamp: 'config-carve', capability: CONFIG },
  { method: 'PUT', pattern: '/api/config/scoped', stamp: 'config-carve', capability: CONFIG },

  // --- localhost-only: operator control plane / local-install management (§1d, §1e).
  //     Served on whichever daemon received the request; never crosses the overlay. ---
  // Readiness of THIS daemon's request pipeline (§1d) — each client probes its own
  // local daemon (`hooks/client.ts` dials 127.0.0.1/ready); members confirm host
  // reachability via the raw, bearer-gated /health, never the host's /ready.
  { method: 'GET', pattern: '/ready', stamp: 'localhost-only', capability: HOST_ADMIN },
  { method: 'GET', pattern: '/api/logs/*', stamp: 'localhost-only', capability: HOST_ADMIN },
  { method: 'GET', pattern: '/api/logs', stamp: 'localhost-only', capability: HOST_ADMIN },
  { method: 'POST', pattern: '/api/log', stamp: 'localhost-only', capability: HOST_ADMIN },
  { method: 'POST', pattern: '/api/restart', stamp: 'localhost-only', capability: HOST_ADMIN },
  { method: 'GET', pattern: '/api/daemon/intent', stamp: 'localhost-only', capability: HOST_ADMIN },
  { method: 'POST', pattern: '/api/daemon/intent/restart', stamp: 'localhost-only', capability: HOST_ADMIN },
  { method: 'DELETE', pattern: '/api/daemon/intent/restart', stamp: 'localhost-only', capability: HOST_ADMIN },
  { method: 'GET', pattern: '/api/upgrade/status', stamp: 'localhost-only', capability: HOST_ADMIN },
  { method: 'POST', pattern: '/api/upgrade/check', stamp: 'localhost-only', capability: HOST_ADMIN },
  { method: 'POST', pattern: '/api/upgrade/apply', stamp: 'localhost-only', capability: HOST_ADMIN },
  { method: 'PUT', pattern: '/api/upgrade/channel', stamp: 'localhost-only', capability: HOST_ADMIN },
  { method: 'GET', pattern: '/api/progress/:token', stamp: 'localhost-only', capability: HOST_ADMIN },
  { method: 'GET', pattern: '/api/symbionts', stamp: 'localhost-only', capability: CONFIG },
  { method: 'POST', pattern: '/api/symbionts/detect', stamp: 'localhost-only', capability: CONFIG },
  { method: 'POST', pattern: '/api/symbionts/drain-migration', stamp: 'localhost-only', capability: CONFIG },
  { method: 'PATCH', pattern: '/api/projects/:projectId/symbionts', stamp: 'localhost-only', capability: CONFIG },
  { method: 'PUT', pattern: '/api/projects/:projectId/symbionts-customization', stamp: 'localhost-only', capability: CONFIG },
  { method: 'GET', pattern: '/api/machine-config', stamp: 'localhost-only', capability: CONFIG },
  { method: 'PUT', pattern: '/api/machine-config', stamp: 'localhost-only', capability: CONFIG },
  { method: 'GET', pattern: '/api/config/plan-dirs', stamp: 'localhost-only', capability: CONFIG },
  { method: 'GET', pattern: '/api/providers/secrets', stamp: 'localhost-only', capability: HOST_ADMIN },
  { method: 'PUT', pattern: '/api/providers/secrets/:provider', stamp: 'localhost-only', capability: HOST_ADMIN },
  { method: 'DELETE', pattern: '/api/providers/secrets/:provider', stamp: 'localhost-only', capability: HOST_ADMIN },
  // Provider/model CONNECTIVITY — machine-global, never Grove data (PROVIDER_ROUTE_SCOPES
  // declares the two provider routes 'machine'). Over the overlay these are a host
  // remote-key VALIDITY ORACLE (a member learns whether the host's stored key is live)
  // and, on the local-backend path, a host-side SSRF/reachability probe to a
  // member-supplied base_url. Localhost-only: the member reads its OWN machine-tier
  // provider posture; the host never answers these over the overlay.
  { method: 'GET', pattern: '/api/providers', stamp: 'localhost-only', capability: HOST_ADMIN },
  { method: 'POST', pattern: '/api/providers/test', stamp: 'localhost-only', capability: HOST_ADMIN },
  { method: 'GET', pattern: '/api/models', stamp: 'localhost-only', capability: CONFIG },
  { method: 'POST', pattern: '/api/groves', stamp: 'localhost-only', capability: CONFIG },
  { method: 'POST', pattern: '/api/groves/:id/default', stamp: 'localhost-only', capability: 'Viewing' },
  { method: 'GET', pattern: '/api/restore/status', stamp: 'localhost-only', capability: CONFIG },
  { method: 'GET', pattern: '/api/backups', stamp: 'localhost-only', capability: CONFIG },
  { method: 'GET', pattern: '/api/notifications/registry', stamp: 'localhost-only', capability: 'Viewing' },
  // team-sync + collective clusters (§1e): machine-global connectivity, distinct
  // from team-host. Coarse localhost-only for v1 — an attached project's per-Grove
  // sync ops have no local Grove DB and fail closed; enrollment/status is machine-wide.
  { method: 'GET', pattern: '/api/team/*', stamp: 'localhost-only', capability: 'team-sync' },
  { method: 'POST', pattern: '/api/team/*', stamp: 'localhost-only', capability: 'team-sync' },
  { method: 'GET', pattern: '/api/collective/*', stamp: 'localhost-only', capability: 'collective' },
  { method: 'POST', pattern: '/api/collective/*', stamp: 'localhost-only', capability: 'collective' },
];

/**
 * The serve-default MANIFEST — every registered router route that INTENTIONALLY
 * uses the `serve` default (not listed in {@link ROUTE_RULES}). `ROUTE_RULES` is
 * deliberately the "do NOT plainly proxy this" exceptions table; this is its
 * complement — the genuine knowledge/viewing/host-run-intelligence routes that
 * SHOULD proxy to the host and serve over the overlay. Together the two sets are
 * the complete route manifest (the scope-map's 176/176), and the completeness
 * guard (`tests/meta/route-stamp-completeness.test.ts`) asserts every registered
 * router route is in exactly one of them — so a NEW route can never silently fall
 * through to `serve` and become overlay-exposed without a deliberate decision
 * recorded HERE (serve) or in `ROUTE_RULES` (a non-serve stamp).
 *
 * Keyed `"<METHOD> <registered pattern>"`, matching the registration site's
 * literal method + path exactly (including `:param` / trailing `/*`).
 */
export const SERVE_DEFAULT_ROUTES: ReadonlySet<string> = new Set<string>([
  // Knowledge injection (hook-driven; host-owned Cortex/digest) — scope-map §1b.
  'POST /context',
  'POST /context/resume',
  'POST /context/prompt',
  'POST /context/subagent',
  'GET /api/cortex/instructions',
  'POST /api/cortex/instructions/refresh',
  'POST /api/cortex/prompt-builder',
  'GET /api/cortex/prompt-builder/:runId',
  // Host grove-tier config READ — the one host surface the member's config carve
  // dials (host-sources the grove tier); read-only, so serve. The PUT is config-lock.
  'GET /api/grove-config',
  'GET /api/backup/config',
  // Knowledge / viewing reads + proxied writes on host-owned Grove data.
  'GET /api/stats',
  'GET /api/groves', // §1f: local+attached merge is a known follow-up; read/viewing
  'GET /api/groves/:id/projects',
  'GET /api/sessions',
  'GET /api/sessions/:id',
  'GET /api/sessions/:id/impact',
  'POST /api/sessions/:id/complete',
  'DELETE /api/sessions/:id',
  'DELETE /api/plans/:id',
  'PATCH /api/plans/:id',
  'GET /api/sessions/:id/batches',
  'GET /api/batches/:id/activities',
  'GET /api/sessions/:id/attachments',
  'GET /api/sessions/:id/plans',
  'GET /api/skill-candidates',
  'GET /api/skill-candidates/:id',
  'PUT /api/skill-candidates/:id',
  'GET /api/skill-records',
  'GET /api/skill-records/:id',
  'DELETE /api/skill-candidates/:id',
  'DELETE /api/skill-records/:id',
  'GET /api/spores',
  'GET /api/spores/:id',
  'GET /api/entities',
  'GET /api/graph/seeds',
  'GET /api/graph',
  'GET /api/graph/:id',
  'GET /api/digest',
  'GET /api/digest/revisions',
  'POST /api/digest/revisions/:id/restore',
  'GET /api/g/:groveId/p/:projectId/attachments/:filename',
  'GET /api/attachments/:filename',
  'GET /api/search',
  'GET /api/activity',
  'GET /api/projects/activity',
  // Intelligence — the host RUNS the brain for members (design §5.6); triggering a
  // host agent run and reading its audit IS the Team Host data plane, so serve.
  // (Distinct from the DB/embedding MAINTENANCE mutations degraded above.)
  'POST /api/agent/run',
  'GET /api/agent/runs',
  'GET /api/agent/runs/:id',
  'POST /api/agent/runs/:id/resume',
  'GET /api/agent/runs/:id/reports',
  'GET /api/agent/runs/:id/turns',
  'GET /api/agent/runs/:id/write-intents',
  'GET /api/agent/runs/:id/audit',
  'GET /api/agent/runs/:id/events',
  // Shared task-def READS (the WRITE CRUD is config-lock above).
  'GET /api/agent/tasks',
  'GET /api/agent/tasks/:id',
  'GET /api/agent/tasks/:id/yaml',
  'GET /api/agent/tasks/:id/config',
  // Embedding / database / maintenance READS (state only; the mutations degrade above).
  'GET /api/embedding/status',
  'GET /api/embedding/details',
  'GET /api/database/details',
  'GET /api/maintenance/summary',
  'GET /api/groves/:id/maintenance',
  // Notification records live in the host Grove DB (Viewing) — read + proxied mutate.
  'GET /api/notifications',
  'POST /api/notifications',
  'PATCH /api/notifications/:id',
  'POST /api/notifications/dismiss-all',
  'POST /api/notifications/mark-all-read',
  'GET /api/notifications/unread-count',
  // OKF (Open Knowledge Format) — the project wiki lives in the host Grove DB
  // (tenant-scoped, knowledge-serving); rebase-integrated with the residency
  // stamps. Reads + Grove-data contributions serve from the host for attached
  // projects. (OKF generation is DB-only; a host disk-write would be caught by
  // the B1 overlay-origin gate, same as skills.)
  'POST /api/okf/acknowledge',
  'GET /api/okf/status',
  'POST /api/okf/validate',
  'GET /api/okf/pages',
  'POST /api/okf/concepts',
  'POST /api/okf/concepts/supersede',
  'GET /api/okf/pages/*',
]);

/** Match a concrete request pathname against a route pattern (exact, `:param`,
 *  or trailing `/*` prefix) — the same three shapes `daemon/router.ts` supports. */
function pathMatches(pattern: string, pathname: string): boolean {
  if (pattern.endsWith('/*')) {
    return pathname.startsWith(pattern.slice(0, -1));
  }
  if (pattern.includes(':')) {
    const patternSegments = pattern.split('/');
    const pathSegments = pathname.split('/');
    if (patternSegments.length !== pathSegments.length) return false;
    for (let i = 0; i < patternSegments.length; i += 1) {
      if (patternSegments[i].startsWith(':')) continue;
      if (patternSegments[i] !== pathSegments[i]) return false;
    }
    return true;
  }
  return pattern === pathname;
}

/** The matched {@link ROUTE_RULES} entry for a (method, pathname), honoring the
 *  router's exact > param > prefix precedence so a broad `/*` rule never shadows a
 *  specific one — or `undefined` when no explicit rule matches (the caller then
 *  applies the `serve` default). Exported so the route-stamp completeness guard
 *  (`tests/meta/route-stamp-completeness.test.ts`) can distinguish an EXPLICIT
 *  stamp from a serve-default fall-through — the latter is what silently exposes a
 *  new machine/maintenance route over the overlay. */
export function matchRouteRule(method: string, pathname: string): RouteRule | undefined {
  const candidates = ROUTE_RULES.filter((rule) => rule.method === method);
  const tiers: ((pattern: string) => boolean)[] = [
    (p) => !p.includes(':') && !p.endsWith('/*'),
    (p) => p.includes(':'),
    (p) => p.endsWith('/*'),
  ];
  for (const inTier of tiers) {
    for (const rule of candidates) {
      if (inTier(rule.pattern) && pathMatches(rule.pattern, pathname)) {
        return rule;
      }
    }
  }
  return undefined;
}

/** Look up the stamp for a (method, pathname), honoring the router's
 *  exact > param > prefix precedence so a broad `/*` rule never shadows a
 *  specific one. Returns the default `serve` stamp when no rule matches. */
export function classifyRouteStamp(method: string, pathname: string): RouteClassification {
  const rule = matchRouteRule(method, pathname);
  if (rule) return { capability: rule.capability, stamp: rule.stamp };
  return { capability: 'Knowledge serving', stamp: 'serve' };
}

/**
 * Decide how to dispatch one inbound request. Performs NO Grove/DB resolution.
 *
 * `projectId` is the effective project id from the cheap inbound pre-parse
 * (`resolveInboundProjectId` / URL params). A null id (daemon anchor / no
 * tenancy) is never attached, so it returns `local` without touching the
 * registry.
 */
export function classifyRoute(input: {
  method: string;
  pathname: string;
  projectId: GroveProjectId | null;
}): RouteDecision {
  if (!input.projectId) return { kind: 'local' };

  const attach = resolveAttach(input.projectId);
  if (!attach) return { kind: 'local' };

  const classification = classifyRouteStamp(input.method, input.pathname);
  switch (classification.stamp) {
    case 'degrade':
      return { kind: 'degraded', refusal: hostedCapabilityUnavailable(classification.capability) };
    case 'config-lock':
      return { kind: 'config_locked', refusal: configHostAuthoritative(classification.capability) };
    case 'localhost-only':
      return { kind: 'local' };
    case 'config-carve':
      return { kind: 'config_carve', target: remoteTargetFor(input.projectId, attach), classification };
    case 'serve':
    case 'collect':
      return { kind: 'remote', target: remoteTargetFor(input.projectId, attach), classification };
  }
}

/**
 * The HOST-side overlay backstop: what a Team Host does with a request that
 * arrived on its overlay listener, keyed on the route's stamp alone (no project
 * resolution — a host serves its own Groves, so it never re-attaches).
 *
 * `classifyRoute` above is the MEMBER's gate: it refuses localhost-only/degrade/
 * config routes on the member daemon so they never leave the member. But v1 is
 * flat-trust (design §9): the shared bearer proves admission, not identity, and a
 * hostile or buggy member can craft a raw overlay request that never ran its own
 * `classifyRoute`. This function is the host's independent enforcement of the same
 * scope-map stamps, applied at the matched route so the guarantee does not rest on
 * member cooperation. It NEVER proxies — the anti-circularity guarantee holds
 * (the host serves its own Grove locally); it only decides serve-locally vs refuse:
 *
 *   - `localhost-only` → 404 (operator/machine-local control plane, scope-map §1d;
 *     includes the machine-tier `PUT/DELETE /api/providers/secrets/:provider`
 *     credential routes — the leaked-bearer credential-hijack moat).
 *   - `degrade` → the capability-unavailable-hosted refusal (409) — the capability
 *     is OFF for hosted projects (Canopy, git provenance, Grove-DB backup/restore),
 *     the SAME payload the member-side `classifyRoute` returns for `degraded`.
 *   - `config-lock` → the config-host-authoritative refusal (409) — shared config
 *     is host-operator-managed and not member-writable even directly, the SAME
 *     payload the member-side `classifyRoute` returns for `config_locked`.
 *   - `config-carve` → 404: these are member-ASSEMBLED config routes that never
 *     legitimately cross the overlay — a member resolves machine/project/personal
 *     from its own disk and host-sources ONLY the grove tier via `GET
 *     /api/grove-config` (a `serve` route, untouched here). Serving them on the
 *     host would leak the host's machine/personal config (the GETs) or WRITE the
 *     host's config (`PUT /api/config/scoped`); both are wrong, so refuse.
 *   - `serve` / `collect` → `null`: served locally, the host answering for its own
 *     Grove (unchanged behavior — the only classes the overlay is meant to carry).
 *
 * Returns the refusal to write, or `null` to serve the request locally.
 */
export function overlayHostStampRefusal(method: string, pathname: string): RefusalPayload | null {
  const { capability, stamp } = classifyRouteStamp(method, pathname);
  switch (stamp) {
    case 'localhost-only':
    case 'config-carve':
      return overlayLocalhostOnlyRefusal();
    case 'degrade':
      return hostedCapabilityUnavailable(capability);
    case 'config-lock':
      return configHostAuthoritative(capability);
    case 'serve':
    case 'collect':
      return null;
  }
}

/** Assemble the {@link RemoteTarget} a host round-trip needs from the attach
 *  record, reading the host bearer from the host record's secrets.env. Shared by
 *  the `remote` (proxy) and `config_carve` (member-assembled merged read, which
 *  host-sources only the grove tier) decisions. */
function remoteTargetFor(
  projectId: GroveProjectId,
  attach: { host: { host_id: string; label: string; overlay_address: string; protocol_version: number; proxy_port?: number }; ref: { grove_id: string } },
): RemoteTarget {
  const bearer = readHostSecrets(attach.host.host_id)[HOST_BEARER_SECRET] ?? '';
  return {
    projectId,
    groveId: attach.ref.grove_id,
    host: {
      host_id: attach.host.host_id,
      label: attach.host.label,
      overlay_address: attach.host.overlay_address,
      protocol_version: attach.host.protocol_version,
      proxy_port: attach.host.proxy_port,
    },
    bearer,
  };
}
