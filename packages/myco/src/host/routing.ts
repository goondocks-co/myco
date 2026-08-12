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
 *   - `team-write` → proxy to host (server-mode design spec §6): a member's Team
 *                 page writes the SERVED grove's team config/secrets through its
 *                 own daemon, which proxies to the host exactly like `serve`/
 *                 `collect`. Kept as its own stamp (not folded into `serve`)
 *                 because both dispatch chokepoints below give it an EXPLICIT
 *                 case — the whole point of this table is that a route can never
 *                 silently inherit `serve`'s behavior by omission.
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
import type { GroveProjectId } from '../grove/ids.js';
import { scopePolicyForPath } from '../config/scope.js';
import { isGroveEraId } from '../grove/ids.js';
import { getHostMembershipSnapshot, resolveAttachMembership } from './registry.js';
import {
  nativePerUserLockNamespace,
  type PerUserLockNamespace,
} from '@myco/utils/per-user-lock-namespace.js';
import { ROUTED_DETACH_ARTIFACT_PATH, ROUTED_DETACH_COMPLETE_PATH, ROUTED_RESIDENCY_ROWS_PATH } from './residency-journal.js';
import { isValidHostUrl } from './host-url.js';

/** The scope-map stamp a route carries. See the module docstring. */
export type RouteStamp = 'serve' | 'collect' | 'degrade' | 'config-lock' | 'config-carve' | 'team-write' | 'localhost-only';

/** The capability + stamp for a matched route, handed to the proxy so it can
 *  key the collector contract / flush ordering without re-classifying. */
export interface RouteClassification {
  capability: string;
  stamp: RouteStamp;
}

/** Everything the host proxy (Task 1.3) needs to forward one request. */
export interface RemoteTarget {
  /** `null` for a HOST-CARRIER target (E1 §5.3): the request is addressed
   *  to a host, not a project — the host derives its served grove itself,
   *  and `buildForwardHeaders` omits the project header entirely rather
   *  than stamping a fabricated id the host would refuse. */
  projectId: GroveProjectId | null;
  /** Grove id from the attach record — the hosted Grove's identity, not a local row. */
  groveId: string;
  /**
   * This project's member-local checkout root, carried from `AttachRef.root`
   * (`host/registry.ts`). Per-request — NOT the daemon's bootstrap-anchor
   * project root — so a multi-project member's collect-time root-relative
   * matching (e.g. `capture/plan-drain.ts` `noteCollect`) scopes to the
   * project the request is actually about. Absent for attach records
   * created before `root` was added to `AttachRef`.
   */
  root?: string;
  host: {
    host_id: string;
    label: string;
    /** The host's public HTTPS origin — the whole dial input. See
     *  `HostRecord.host_url`. */
    host_url: string;
    protocol_version: number;
  };
  /** Host bearer, read from the host record's secrets.env. Swapped in for the
   *  caller's local bearer before forwarding; never observable by the caller. */
  bearer: string;
}

/** The wire-facing host fields a {@link RemoteTarget} carries — the subset of a
 *  host record the transport reads. */
export type RemoteHostDescriptor = RemoteTarget['host'];

/** A host record as the transport reads it — the input side of
 *  {@link hostDescriptorFor}. `host_url` is optional HERE and required on the
 *  descriptor: that difference is the projection's whole job. */
export interface DialableHostRecord {
  host_id: string;
  label: string;
  host_url?: string;
  protocol_version: number;
}

/**
 * The ONE record→target projection of a host's wire fields.
 *
 * Every {@link RemoteTarget} builder — the capture/residency drains, the proxy's
 * attach and host-carrier paths — must route through here. A transport field
 * added or removed belongs in this function alone; inlining the object literal
 * at a call site puts the transport contract in more than one place, and the
 * drains have no compile-time link to each other that would catch the drift.
 *
 * Returns **null** for a record with no usable `host_url`. That record is not a
 * degraded target to try anyway — it carries no address at all, and the
 * nullable return is what forces each caller to say what it does about that
 * (refuse the route, skip the drain entry, render "re-join required") instead
 * of dialing `undefined` and reporting a network failure for a data problem.
 */
export function hostDescriptorFor(record: DialableHostRecord): RemoteHostDescriptor | null {
  if (!isValidHostUrl(record.host_url)) return null;
  return {
    host_id: record.host_id,
    label: record.label,
    host_url: record.host_url,
    protocol_version: record.protocol_version,
  };
}

/** The refusal a host with no usable address produces. Non-retryable: no
 *  amount of retrying supplies an address the record does not have. */
export function hostAddressUnusable(label: string): RefusalPayload {
  return {
    status: 409,
    error: 'host_address_unusable',
    message: `Host "${label}" has no usable address on this member — re-join the host to record its public URL.`,
    retryable: false,
  };
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
  /** `target` is null when the host has no usable address: the grove tier is
   *  unavailable, exactly as it is when the host is unreachable, and the
   *  handler takes its existing degrade path rather than dialing. */
  | {
    kind: 'config_carve';
    /** Null when the host has no usable address: the grove tier is unavailable,
     *  exactly as it is when the host is unreachable, and the handler takes its
     *  existing degrade path rather than dialing. */
    target: RemoteTarget | null;
    /** The attached project + its host, resolvable WITHOUT a dial — the
     *  member-side tiers need these even when `target` is null. */
    attach: { projectId: GroveProjectId; host: { host_id: string; label: string } };
    classification: RouteClassification;
  };

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
 * Refusal for a route the host serves on its localhost only and never to remote
 * team members — the operator/machine-local admin routes (scope-map §1d) and the
 * member-assembled config carve (§6.3), neither of which is a valid remote
 * surface. Uses the SAME 404 `not_found` body the host-serve lifecycle refusal
 * emits (`daemon/host-serve.ts` `overlayLifecycleRefused`) so a member sees one
 * uniform "not served remotely" shape.
 */
export function overlayLocalhostOnlyRefusal(): RefusalPayload {
  return {
    status: 404,
    error: 'not_found',
    message: 'This route is served on localhost only, not to remote team members.',
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
 *
 * `id` must echo the request's JSON-RPC id whenever the caller has parsed the
 * request body (the host-proxy `/mcp` peek path has): the MCP SDK's
 * `JSONRPCMessageSchema` accepts a string/number response id but REJECTS
 * `id: null`, so a refusal that fails to echo it throws a ZodError inside SDK
 * clients before any friendly-message classification. The `null` default is
 * correct only where no request id is knowable — an unparseable request, or a
 * transport-level refusal written before any body read.
 */
export function refusalMcpBody(payload: RefusalPayload, id: string | number | null = null): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    error: {
      code: -32004,
      message: payload.message,
      data: { code: payload.error, capability: payload.capability },
    },
    id,
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
const CONTENT_MATERIALIZE = 'Content materialization';
const TEAM_WRITE = 'Team configuration';
const DIAGNOSTICS = 'Diagnostic export';

/**
 * The stamp table — every rule here is a route whose attached-project behavior
 * is something OTHER than plain proxy-to-host. Everything not listed defaults to
 * `serve`. Rows mirror the scope-map §1 sections; families are matched by prefix
 * where the whole family shares a stamp.
 *
 * Exported so the route-stamp completeness guard
 * (`tests/meta/route-stamp-completeness.test.ts`) can enumerate every rule and
 * assert each one actually wins `matchRouteRule` for at least one registered
 * route — a rule that wins for none is a stale entry no live route depends on.
 */
export const ROUTE_RULES: readonly RouteRule[] = [
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
  // Routed residency-rows ingest — the host RECEIVE side of a with-history attach
  // (Phase F T2). When a project attaches to a host WITH its local history, the
  // member drains that project's rows (`host/residency-drain.ts`) one allow-listed
  // table per request to this route; the host applies them to its served Grove DB
  // under the per-table residency apply rules. Origin-side capture, so `collect`:
  // it rides the overlay bearer/version gate, registers the hosted project on the
  // first batch (the collect-stamped registration-on-ingest seam), and is served
  // locally on the host, proxied from a member.
  { method: 'POST', pattern: ROUTED_RESIDENCY_ROWS_PATH, stamp: 'collect', capability: COLLECTION },
  // Routed residency-pull — the host RECEIVE side of a DETACH (Phase F T3). A
  // detaching member pages its own rows back from the host here. Same overlay
  // data-plane family as residency-rows: bearer/version gated, proxied from the
  // member, served locally on the host. `collect` (not `serve`): mechanically
  // identical to serve for member-proxy + host-serve-locally, it keeps the whole
  // residency transport family in one place and lets the registration-on-ingest
  // seam harmlessly ensure the project row resolves. The route's own side effects
  // (claim release, stub deregister) are the collector contract for this leg.
  // 410 tombstone for the RETIRED page-pull detach (guidance for old members
  // mid-detach) — stamped so the completeness gate sees no silent fall-through.
  { method: 'POST', pattern: '/routed-capture/residency-pull', stamp: 'collect', capability: COLLECTION },
  { method: 'POST', pattern: ROUTED_DETACH_ARTIFACT_PATH, stamp: 'collect', capability: COLLECTION },
  { method: 'POST', pattern: ROUTED_DETACH_COMPLETE_PATH, stamp: 'collect', capability: COLLECTION },

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

  // --- team-write: the served grove's team config/secrets (server-mode design
  //     spec §6). Proxied to the host exactly like `serve`/`collect` — the
  //     host is authoritative for the served grove's shared config, so a
  //     member's Team page writes reach it over the SAME overlay proxy path. ---
  { method: 'GET', pattern: '/api/team/config', stamp: 'team-write', capability: TEAM_WRITE },
  { method: 'PUT', pattern: '/api/team/config', stamp: 'team-write', capability: TEAM_WRITE },
  { method: 'PUT', pattern: '/api/team/secrets/:provider', stamp: 'team-write', capability: TEAM_WRITE },
  { method: 'DELETE', pattern: '/api/team/secrets/:provider', stamp: 'team-write', capability: TEAM_WRITE },
  { method: 'POST', pattern: '/api/team/mcp-token/rotate', stamp: 'team-write', capability: TEAM_WRITE },
  // Task 10: external read-only MCP toggle/status (server-mode design spec §7).
  { method: 'GET', pattern: '/api/team/external-mcp', stamp: 'team-write', capability: TEAM_WRITE },
  { method: 'PUT', pattern: '/api/team/external-mcp/toggle', stamp: 'team-write', capability: TEAM_WRITE },
  // Per-task table (spec §6.3): the bespoke `/api/agent/tasks/:id/config` is
  // config-lock stamped above, so the Team page's per-task overrides reach
  // the served grove through this parallel team-write pair instead.
  { method: 'GET', pattern: '/api/team/agent-tasks/:id/config', stamp: 'team-write', capability: TEAM_WRITE },
  { method: 'PUT', pattern: '/api/team/agent-tasks/:id/config', stamp: 'team-write', capability: TEAM_WRITE },

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
  // Power state describes THIS daemon's own scheduler — which machine is
  // awake, and what is holding it there. Never serve it to an attached
  // member: they would read the host's power state and conclude their own
  // machine was awake. Same reasoning as /ready and the daemon intent routes.
  { method: 'GET', pattern: '/api/power', stamp: 'localhost-only', capability: HOST_ADMIN },
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

  // --- localhost-only: diagnostic export bundles (`daemon/api/diagnostics.ts`).
  //     Operator-diagnostic tooling, not knowledge serving — a bundle packages
  //     the host's OWN environment/doctor/audit state plus windowed session,
  //     agent-run, and daemon-log rows for whichever Grove the operator names,
  //     for support/debugging outside Myco entirely. Mirrors backup's stamp
  //     (`/api/backups` above, `/api/backup` degraded): an enrolled member must
  //     never be able to trigger an export of, list, or download a bundle for
  //     ANY Grove this host owns over the overlay — the download route in
  //     particular hands back the bundle's raw bytes (session content,
  //     transcripts, prompt hashes), so leaving it to the `serve` default would
  //     let a bearer-holding member exfiltrate another Grove's diagnostic data
  //     wholesale. ---
  { method: 'POST', pattern: '/api/diagnostics/export', stamp: 'localhost-only', capability: DIAGNOSTICS },
  { method: 'GET', pattern: '/api/diagnostics/exports', stamp: 'localhost-only', capability: DIAGNOSTICS },
  { method: 'GET', pattern: '/api/diagnostics/export/:file/download', stamp: 'localhost-only', capability: DIAGNOSTICS },

  // --- localhost-only: content-claim MATERIALIZATION, the disk-write step
  //     (design: docs/superpowers/specs/2026-07-09-content-claim-system-design.md
  //     §4). This is the ONE route in the content-claims family that is NOT
  //     `serve`: the other five (list/create/refresh/release/published) mutate
  //     Grove-DB rows the host legitimately owns, so they proxy for an attached
  //     project. This route writes the CALLING member's own working tree —
  //     proxying it to the host would violate B1 (the host never writes a
  //     member tree). Served on whichever daemon received the request; for an
  //     attached project the handler dials the host directly (mirroring
  //     `attached-config.ts`'s grove-tier fetch) for the claim/content state
  //     instead of proxying the request wholesale. ---
  { method: 'POST', pattern: '/api/content-claims/:id/materialize', stamp: 'localhost-only', capability: CONTENT_MATERIALIZE },

  // --- localhost-only: content-claim FILE-STATUS, the member disk-truth read
  //     (design: docs/superpowers/specs/2026-07-10-publication-coupling-okf-disposition-design.md
  //     §2(b)). Read-only sibling of materialize above, sharing its capability
  //     stamp: it checks presence in the CALLING member's own working tree, so
  //     proxying it to the host would answer with the wrong machine's disk. ---
  { method: 'POST', pattern: '/api/content-claims/file-status', stamp: 'localhost-only', capability: CONTENT_MATERIALIZE },

  // --- localhost-only: Team Host member drain health (consolidation Task
  //     C-5, `daemon/api/drain-health.ts`). Reports THIS machine's own
  //     outbound transcript/plan/event-replay drain state to every host it
  //     has joined — machine-local diagnostic data with no Grove/project
  //     scope, never meaningful to answer on another machine's behalf. ---
  { method: 'GET', pattern: '/api/team-host/drain-health', stamp: 'localhost-only', capability: HOST_ADMIN },

  // --- localhost-only: Team Host MEMBERSHIP lifecycle (consolidation Task
  //     D-2, `daemon/api/host-membership.ts`). join/leave/attach/detach mutate
  //     THIS machine's own local registry/team-home (`~/.myco-team/hosts/*`)
  //     and, for join/leave, provision a per-user LaunchAgent — member-machine
  //     admin actions with no Grove/project scope to proxy. `status` is the
  //     read-only companion (host list + attach refs + affiliation hint) the
  //     Team page polls; same posture, no new state. ---
  // --- localhost-only: Team Host ADMINISTRATION (E1 §4, `daemon/api/
  //     host-admin.ts`). enable/disable run the plain hostEnable/hostDisable
  //     orchestration as an in-daemon job (progress-tracked, restart
  //     deferred to a detached child); mint-join-key is the explicit member
  //     onboarding mint (unprivileged post-re-scope). All mutate THIS
  //     machine's own hosting state — no Grove/project scope to proxy,
  //     same posture as the membership family below. ---
  { method: 'POST', pattern: '/api/host-admin/enable', stamp: 'localhost-only', capability: HOST_ADMIN },
  { method: 'POST', pattern: '/api/host-admin/disable', stamp: 'localhost-only', capability: HOST_ADMIN },
  { method: 'POST', pattern: '/api/host-admin/mint-join-key', stamp: 'localhost-only', capability: HOST_ADMIN },
  // Operator-only, like the rest of the family: listing members and revoking
  // access are things the person AT the host does. A missing rule here would
  // default to `serve` and publish the member roster to the team surface.
  { method: 'GET', pattern: '/api/host-admin/members', stamp: 'localhost-only', capability: HOST_ADMIN },
  { method: 'POST', pattern: '/api/host-admin/revoke', stamp: 'localhost-only', capability: HOST_ADMIN },

  { method: 'POST', pattern: '/api/host-membership/join', stamp: 'localhost-only', capability: HOST_ADMIN },
  { method: 'POST', pattern: '/api/host-membership/leave', stamp: 'localhost-only', capability: HOST_ADMIN },
  { method: 'POST', pattern: '/api/host-membership/attach', stamp: 'localhost-only', capability: HOST_ADMIN },
  { method: 'POST', pattern: '/api/host-membership/detach', stamp: 'localhost-only', capability: HOST_ADMIN },
  { method: 'GET', pattern: '/api/host-membership/status', stamp: 'localhost-only', capability: HOST_ADMIN },
  // Member-side live reachability + protocol-skew probe (Team Host E-4 W1
  // Task T4, decision-ef693c71 D3). Reports on THIS machine's own view of
  // every host it has joined — never proxied, never meaningful to answer on
  // another machine's behalf, same posture as the mutation routes above.
  { method: 'GET', pattern: '/api/host-membership/health', stamp: 'localhost-only', capability: HOST_ADMIN },
  // Residency-transition progress + Cancel (Phase F T6). Both read/mutate THIS
  // machine's own journal + local state (an in-flight project move), never
  // proxied, same posture as the membership routes above.
  { method: 'GET', pattern: '/api/host-membership/residency-status', stamp: 'localhost-only', capability: HOST_ADMIN },
  { method: 'POST', pattern: '/api/host-membership/residency-abort', stamp: 'localhost-only', capability: HOST_ADMIN },

  // --- localhost-only: Team Host operator-side serving status (Task T4,
  //     decision-ef693c71 D3). Reports THIS machine's OWN host-serve
  //     enablement/runtime state (host-serve.ts) — machine-scoped, no
  //     project/Grove tenancy header to proxy against, and never meaningful
  //     to answer on behalf of another machine. Unlike the served grove's
  //     team-write config surface (`/api/team/*`, which a NON-host member
  //     reaches by proxy), this route answers "is THIS box serving at all"
  //     and is therefore never a valid overlay surface — a bearer-holding
  //     member has no business asking a host about its own serving posture
  //     over the connection that posture gates. ---
  { method: 'GET', pattern: '/api/host-serve/status', stamp: 'localhost-only', capability: HOST_ADMIN },
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
  // Content claims (Team Host WS2) — the publication-lock surface over
  // DB-resident skills (design:
  // docs/superpowers/specs/2026-07-09-content-claim-system-design.md §3). A
  // claim is a lock the Grove's ACTIVE-partial unique index enforces
  // transactionally on ONE database, so an attached project's member must
  // reach the host's authoritative claim state over the overlay — a local
  // Grove serves the identical routes locally (classifyRoute short-circuits
  // before this table is ever consulted). Knowledge/viewing + host-run
  // mutation, so serve.
  'GET /api/content-claims',
  'POST /api/content-claims',
  'POST /api/content-claims/:id/refresh',
  'POST /api/content-claims/:id/release',
  'POST /api/content-claims/:id/published',
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
 *  new machine/maintenance route over the overlay.
 *
 *  `rules` defaults to the production {@link ROUTE_RULES} table; every production
 *  caller omits it. The optional param exists so the ROUTE_RULES staleness gate
 *  (same test file) can run a synthetic rules+routes fixture through this SAME
 *  precedence logic — the staleness predicate must never reimplement it. */
export function matchRouteRule(method: string, pathname: string, rules: readonly RouteRule[] = ROUTE_RULES): RouteRule | undefined {
  const candidates = rules.filter((rule) => rule.method === method);
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
}, lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace): RouteDecision {
  if (!input.projectId) return { kind: 'local' };

  const attach = resolveAttachMembership(input.projectId, lockNamespace);
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
      // NOT refused when the host has no address — and the difference from the
      // three below is the point. `config-carve` is member-side ASSEMBLY: the
      // machine/project/personal tiers resolve from this member's own disk and
      // only the grove tier is host-sourced, so a missing address makes ONE
      // tier unavailable. That is the same situation as an unreachable host,
      // which this handler already degrades (grove → defaults, once-warn).
      // Refusing outright would break a purely local config read because a
      // remote tier could not be fetched.
      return {
        kind: 'config_carve',
        target: remoteTargetFor(input.projectId, attach),
        attach: {
          projectId: input.projectId,
          host: { host_id: attach.host.host_id, label: attach.host.label },
        },
        classification,
      };
    case 'team-write':
    case 'serve':
    case 'collect': {
      // These three CARRY the project's data, so a host with no usable address
      // is refused rather than served: the project's Grove lives on the host,
      // and answering from an empty local one would look like success to a user
      // whose data is simply out of reach.
      const target = remoteTargetFor(input.projectId, attach);
      if (!target) {
        return { kind: 'degraded', refusal: hostAddressUnusable(attach.host.label) };
      }
      // `team-write` is named alongside them deliberately (server-mode design
      // spec §6): a member Team page write proxies to the host exactly as
      // serve/collect do.
      return { kind: 'remote', target, classification };
    }
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
 *   - `team-write` → `null`: served locally, same as `serve`/`collect` — the host
 *     is authoritative for the served grove's team config/secrets and answers a
 *     bearer-holding member's write directly. This switch only decides overlay
 *     ADMISSION by route class; the grove CONSTRAINT ("only for the served
 *     grove, never any other Grove this host owns") is enforced downstream by
 *     `servedGroveRefusal` (Task 2), the SAME chokepoint serve/collect rely on
 *     — so admitting the route class here never widens which Grove it can touch.
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
    case 'team-write':
      // Admitted (served locally on the host) — see the docstring above for
      // why this is safe: the servedGroveRefusal chokepoint (Task 2) is what
      // actually constrains WHICH grove a team-write request may touch.
      return null;
    case 'serve':
    case 'collect':
      return null;
  }
}

/**
 * Resolve the `x-myco-host-id` carrier (E1 §5.3 rev 6) into a routing
 * target. An explicit carrier is what makes a joined host with ZERO attached
 * projects configurable: with nothing to route on, `classifyRoute`
 * short-circuits to local and the write lands on the member's own daemon.
 *
 * Grove selection, three states (absent ≠ null — the wire and the copy
 * must keep them apart):
 *   - `served_grove_id` present  → use it (never the stale side: the
 *     mismatch flag treats it as the reference value).
 *   - ABSENT (pre-designation host record) → fall back to any attach
 *     ref's grove — those hosts are configurable TODAY via the ref
 *     carrier, and refusing them would be a regression (review RC5-3).
 *     Refuse `host_predates_served_grove` only when no ref exists either,
 *     and say the remedy honestly: a re-join needs an OPERATOR-minted key.
 *   - explicit `null` (host reports it serves NO grove) → refuse with
 *     designate-storage copy; re-joining cannot fix that state.
 */
export function resolveHostCarrierTarget(
  hostId: string,
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): { kind: 'target'; target: RemoteTarget } | { kind: 'refusal'; refusal: RefusalPayload } {
  // Shape-validate BEFORE the registry read: a malformed id (garbage, or a
  // traversal attempt) otherwise throws HostJoinStateCorruptError out of the
  // path resolver — a 500 that reflects the caller's raw string into the
  // body and an ERROR log, on the newest attack-surface header. Traversal
  // itself is blocked deeper (assertGroveEraId), but the refusal belongs
  // here, typed, as the same 404 an unknown well-formed id gets.
  if (!isGroveEraId(hostId, 'host')) {
    return {
      kind: 'refusal',
      refusal: {
        status: 404,
        error: 'unknown_host',
        message: 'No joined host with that id on this machine.',
        retryable: false,
      },
    };
  }
  const snapshot = getHostMembershipSnapshot(hostId, lockNamespace);
  if (!snapshot) {
    return {
      kind: 'refusal',
      refusal: {
        status: 404,
        error: 'unknown_host',
        message: `No joined host with id ${hostId} on this machine.`,
        retryable: false,
      },
    };
  }
  const { record, bearer } = snapshot;
  let groveId: string | undefined;
  if (typeof record.served_grove_id === 'string' && record.served_grove_id) {
    groveId = record.served_grove_id;
  } else if (record.served_grove_id === null) {
    return {
      kind: 'refusal',
      refusal: {
        status: 409,
        error: 'host_serves_no_grove',
        message: `Host "${record.label}" reports it serves no team storage — the host operator must designate storage (re-run enable on the host). Re-joining does not change this.`,
        retryable: false,
      },
    };
  } else {
    // Absent: legacy pre-designation record. Any attach ref's grove works —
    // that is exactly how these hosts are configured today.
    groveId = record.projects[0]?.grove_id;
    if (!groveId) {
      return {
        kind: 'refusal',
        refusal: {
          status: 409,
          error: 'host_predates_served_grove',
          message: `Host "${record.label}" predates served-grove designation and has no attached projects to infer it from. `
            + 'Re-join this host with a NEW one-time key minted by the host operator.',
          retryable: false,
        },
      };
    }
  }
  const host = hostDescriptorFor(record);
  if (!host) {
    return { kind: 'refusal', refusal: hostAddressUnusable(record.label) };
  }
  return {
    kind: 'target',
    target: {
      projectId: null,
      groveId,
      host,
      bearer,
    },
  };
}

/**
 * The one guard for {@link RemoteTarget.projectId}'s nullability: attach-
 * scoped channels (capture drains, residency, buffer writes) require a
 * project, and a host-carrier target (`projectId: null`, E1 §5.3) reaching
 * one is a programming error — the carrier admits only team-write routes.
 * Fail loud; a silent `String(null)` puts `x-myco-project-id: "null"` on
 * the wire, a caller-asserted tenancy id that resolves nowhere.
 */
export function requireProjectScopedTarget(target: RemoteTarget, channel: string): GroveProjectId {
  if (target.projectId === null) {
    throw new Error(`${channel} requires a project-scoped target; host-carrier targets carry none.`);
  }
  return target.projectId;
}

/** Assemble the {@link RemoteTarget} a host round-trip needs from the attach
 *  record, reading the host bearer from the host record's secrets.env. Shared by
 *  the `remote` (proxy) and `config_carve` (member-assembled merged read, which
 *  host-sources only the grove tier) decisions, and by the content-claim
 *  materialize handler's direct dial for an attached project's claim/content
 *  state (`daemon/api/content-claims-materialize.ts`). */
export function remoteTargetFor(
  projectId: GroveProjectId,
  attach: {
    host: DialableHostRecord;
    ref: { grove_id: string; root?: string };
    bearer: string;
  },
): RemoteTarget | null {
  const host = hostDescriptorFor(attach.host);
  if (!host) return null;
  return {
    projectId,
    groveId: attach.ref.grove_id,
    root: attach.ref.root,
    host,
    bearer: attach.bearer,
  };
}
