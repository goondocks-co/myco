/**
 * Team Host membership lifecycle — the daemon-API half of consolidation Task
 * D-2. `myco join`/`leave`/`attach`/`detach` (PR #667) shipped CLI-only,
 * calling `host/member-overlay.ts` and `host/attach-command.ts` directly
 * in-process. Chris's PR #667 review direction: membership "should frankly
 * be only the UI and API, with the CLI being a secondary fallback." This
 * module is that API — a thin wrapper over the SAME orchestration functions,
 * so the Team page (and, going forward, the CLI) both drive one code path.
 *
 *   POST /api/host-membership/join     — wraps {@link joinHost}
 *   POST /api/host-membership/leave    — wraps {@link leaveHost}
 *   POST /api/host-membership/attach   — wraps {@link attachCommand}
 *   POST /api/host-membership/detach   — wraps {@link detachCommand}
 *   GET  /api/host-membership/status   — read-only companion (see below)
 *   GET  /api/host-membership/health   — live reachability + protocol-skew
 *                                         probe (see below)
 *
 * All six are `localhost-only` (`host/routing.ts` ROUTE_RULES): every one
 * mutates or reads this MEMBER machine's own local registry/team-home state
 * (`~/.myco-team/hosts/*`) and, for join/leave, provisions a per-user
 * LaunchAgent — machine-local admin actions with no Grove/project scope to
 * proxy, and never meaningful to answer on another machine's behalf.
 *
 * The GET status route is not named in the task brief's "four new routes"
 * enumeration, but the Team page cannot render "hosts joined, per-project
 * attach state" (task brief item 2/3) without a read surface — `/api/groves`
 * only lists LOCALLY-registered projects (an attached project has no local
 * Grove row, by the never-materialize invariant), and the existing
 * `/api/team-host/drain-health` (Task C-5) reports drain counters, not attach
 * refs. Added here as the obvious read companion to the four mutation
 * routes — same capability, same stamp, no new state (a straight
 * `readHostRegistry()` projection) — rather than blocking on it.
 *
 * The GET health route (Team Host E-4 W1 Task T4) is the member-side half of
 * decision-ef693c71 (D3: on-demand probe, ~15s TTL cache, bounded
 * concurrency, never background-polled) — it gives the Team page a live
 * reachability + protocol-skew signal for every joined host without the
 * dashboard shelling to `myco doctor`. See its own section below for the
 * probe/cache design.
 *
 * Wire bodies use snake_case, matching the rest of the API
 * (`content-claims-materialize.ts`, `drain-health.ts`); the orchestration
 * functions underneath use camelCase options objects, so each handler maps
 * between the two explicitly.
 */
import { loadProjectManifest } from '../../config/project-manifest.js';
import { HOST_MIN_COMPAT_VERSION, HOST_PROTOCOL_VERSION } from '../../constants.js';
import { resolveMycoHome, resolveProjectVaultDir } from '../../grove/paths.js';
import { resolveAttachRefHomeGroveId } from '../../grove/registry.js';
import {
  attachCommand,
  detachCommand,
  type AttachOptions,
  type BeginDetachResidency,
  type BeginResidencyAttach,
  type DetachOptions,
} from '../../host/attach-command.js';
import { resolveTeamHostHintState, teamHostHintMessage } from '../../host/hint.js';
import { joinHost, leaveHost, type JoinOptions } from '../../host/member-overlay.js';
import type { ResidencyStatus } from '../../host/residency-transition.js';
import { membershipErrorCode } from '../../host/membership-error.js';
import { readHostRegistry, recordHostProtocolVersion, type HostRecord } from '../../host/registry.js';
import type { DaemonLogger } from '../logger.js';
import type { RouteHandler, RouteRegistrar, RouteResponse } from '../router.js';
import { errorBody } from './error-envelope.js';
import {
  nativePerUserLockNamespace,
  type PerUserLockNamespace,
} from '@myco/utils/per-user-lock-namespace.js';

/**
 * The single deps bag `registerHostMembershipRoutes` threads to every handler
 * factory in this module (mirroring `team-config.ts`'s `TeamConfigRouteDeps`
 * pattern) — extends {@link HostMembershipHealthRouteDeps} (declared in the
 * health section below) so the health route's own test seams travel through
 * the same bag rather than needing a disjoint second parameter.
 */
export interface HostMembershipRouteDeps extends HostMembershipHealthRouteDeps {
  /** Test seam: override the orchestration functions (default the real ones). */
  join?: typeof joinHost;
  leave?: typeof leaveHost;
  attach?: typeof attachCommand;
  detach?: typeof detachCommand;
  mycoHome?: string;
  logger?: DaemonLogger;
  /** Test seam: platform for the capability fields (default process.platform). */
  platform?: NodeJS.Platform;
  /**
   * DAEMON-ONLY (Phase F): the residency transition to run when an attach
   * targets a project that still has local Grove data. Built in `daemon/main.ts`
   * (it needs a Grove DB) and threaded through so the attach handler is the only
   * production caller that can move existing history onto a host. Absent in
   * tests / non-daemon wiring, where a with-history attach still refuses.
   */
  beginResidency?: BeginResidencyAttach;
  /**
   * DAEMON-ONLY (Phase F): the detach transition to run when a detach should
   * pull this machine's data back before flipping to local. Built in
   * `daemon/main.ts`; absent in tests / non-daemon wiring, where a detach is the
   * plain mapping flip.
   */
  beginDetachResidency?: BeginDetachResidency;
  /**
   * DAEMON-ONLY (Phase F): read a project's residency-transition status for the
   * Team page progress surface. Built in `daemon/main.ts`; absent in tests /
   * non-daemon wiring, where the status route answers `{in_flight:false}`.
   */
  residencyStatus?: (projectId: string) => ResidencyStatus;
  /**
   * DAEMON-ONLY (Phase F): abort an in-flight residency transition. Built in
   * `daemon/main.ts`; throws a coded membership error the route maps to the wire.
   */
  residencyAbort?: (projectId: string) => { ok: true };
  /**
   * Evicts a host's cached health entry (and any in-flight probe) on a
   * successful leave — `registerHostMembershipRoutes` wires this to the
   * health handler's own `evictHost` so the two factories share ONE cache
   * instance without a new module. Left unset, a leave has no effect on the
   * health cache (a directly-constructed `createHostMembershipLeaveHandler`
   * in isolation, e.g. in tests, is a no-op here — matching every other
   * optional test seam in this deps bag).
   */
  evictHealthCache?: (hostId: string) => void;
}

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const JOIN_OPTION_STRING_FIELDS = [
  'server_url',
  'hostname',
  'overlay_address',
  'bearer',
  'host_id',
  'label',
] as const;

function invalidJoinOption(body: Record<string, unknown>): string | null {
  for (const field of JOIN_OPTION_STRING_FIELDS) {
    if (Object.hasOwn(body, field) && typeof body[field] !== 'string') return field;
  }
  if (Object.hasOwn(body, 'protocol_version')
    && (typeof body.protocol_version !== 'number' || !Number.isFinite(body.protocol_version))) {
    return 'protocol_version';
  }
  return null;
}

/** Render a thrown orchestration error as a uniform 400. The envelope's
 *  `code` prefers the error's stable membership code (`membership-error.ts` —
 *  `project_registered_locally`, `not_joined`, `protocol_mismatch`, …) so the
 *  Team page can map known failures to its own outcome copy
 *  (`ui/src/lib/membership-copy.ts`) instead of rendering the CLI-voiced
 *  message ("run `myco detach`…", "…task A2…") verbatim in a browser. The
 *  message still travels: the CLI wrappers print it (right voice for a
 *  terminal), and the UI falls back to it for uncoded failures. */
function failure(fallbackCode: string, err: unknown): RouteResponse {
  const message = err instanceof Error ? err.message : String(err);
  return { status: 400, body: errorBody(membershipErrorCode(err) ?? fallbackCode, message) };
}

// ---------------------------------------------------------------------------
// join / leave
// ---------------------------------------------------------------------------

export function createHostMembershipJoinHandler(deps: HostMembershipRouteDeps): RouteHandler {
  const join = deps.join ?? joinHost;
  const logger = deps.logger;
  return async (req) => {
    const body = asRecord(req.body);
    const hostRef = str(body.host_ref);
    const key = str(body.key);
    if (!hostRef) return { status: 400, body: errorBody('missing_host_ref', 'host_ref is required.') };
    if (!key) return { status: 400, body: errorBody('missing_key', 'key is required.') };
    const invalidOption = invalidJoinOption(body);
    if (invalidOption) {
      return { status: 400, body: errorBody('host_enroll_failed', `Invalid join field: ${invalidOption}.`) };
    }
    const hostId = str(body.host_id) ?? hostRef;

    const options: JoinOptions = {
      hostRef,
      key,
      serverUrl: str(body.server_url),
      hostname: str(body.hostname),
      overlayAddress: body.overlay_address as string | undefined,
      bearer: body.bearer as string | undefined,
      protocolVersion: num(body.protocol_version),
      hostId: str(body.host_id),
      label: str(body.label),
    };

    // joinHost's step-by-step progress log used to print straight to the
    // operator's terminal (the CLI called it in-process); behind the daemon
    // API it would land in the daemon's log where the operator never sees
    // it. Collect the lines and return them on the success body (`steps`)
    // so both callers can replay them — the CLI prints them after the POST
    // returns, the Team page has them available. Tee'd to the daemon log
    // too, so the daemon-side record of a join is not lost.
    // (Streaming them live — SSE/progress-token — is deliberately NOT built
    // here; noted as an E-0-era follow-up in the task report.)
    const steps: string[] = [];
    const stepLogger = (message: string): void => {
      steps.push(message);
      logger?.info('host-membership.join', message, { host_id: hostId });
    };

    try {
      const result = await join(options, { logger: stepLogger });
      return {
        status: 200,
        body: {
          host_id: result.hostId,
          overlay_address: result.overlayAddress,
          proxy_port: result.proxyPort,
          member_overlay_ip: result.memberOverlayIp,
          host_reachable: result.hostReachable,
          created: result.created,
          notes: result.notes,
          steps,
        },
      };
    } catch (err) {
      return failure('join_failed', err);
    }
  };
}

export function createHostMembershipLeaveHandler(deps: HostMembershipRouteDeps): RouteHandler {
  const leave = deps.leave ?? leaveHost;
  const evictHealthCache = deps.evictHealthCache;
  return async (req) => {
    const body = asRecord(req.body);
    const hostRef = str(body.host_ref);
    if (!hostRef) return { status: 400, body: errorBody('missing_host_ref', 'host_ref is required.') };

    try {
      const result = await leave(hostRef);
      // The health handler's TTL cache/inflight maps (below) have no
      // reference to leave — without this, a left host's stale entries
      // survive until their TTL expires, and a poll in that window can still
      // report the (now-removed) host as reachable.
      evictHealthCache?.(hostRef);
      return {
        status: 200,
        body: { removed: result.removed, tailscaled_removed: result.tailscaledRemoved, notes: result.notes },
      };
    } catch (err) {
      return failure('leave_failed', err);
    }
  };
}

// ---------------------------------------------------------------------------
// attach / detach
// ---------------------------------------------------------------------------

export function createHostMembershipAttachHandler(deps: HostMembershipRouteDeps): RouteHandler {
  const attach = deps.attach ?? attachCommand;
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  return async (req) => {
    const body = asRecord(req.body);
    const projectRoot = str(body.project_root);
    if (!projectRoot) return { status: 400, body: errorBody('missing_project_root', 'project_root is required.') };

    // host_id is NOT validated here — attachCommand itself validates it, and
    // its own message is richer (names the resolved host; the missing-hostId
    // case falls back to the manifest's affiliation hint before failing).
    // Duplicating a shallower check here would only produce a worse error for
    // the same input. There is no grove_id to accept: attachCommand sources
    // the Grove from the joined host's own self-report (`served_grove_id`),
    // never a caller-supplied value. `local_grove_id` is a DIFFERENT Grove
    // concept (the member's own local Grove, E-4 local-view requirement) and
    // IS accepted from the caller — also NOT validated here, for the same
    // reason as host_id: attachCommand validates it (coded
    // `unknown_local_grove`) or defaults it via a pure read when omitted.
    const options: AttachOptions = {
      projectPath: projectRoot,
      hostId: str(body.host_id),
      projectId: str(body.project_id),
      localGroveId: str(body.local_grove_id),
      mycoHome,
      beginResidency: deps.beginResidency,
    };

    try {
      const result = attach(options);
      return {
        status: 200,
        body: {
          project_id: result.projectId,
          grove_id: result.groveId,
          host_id: result.hostId,
          host_label: result.hostLabel,
          root: result.root,
          already_attached: result.alreadyAttached,
          notes: result.notes,
        },
      };
    } catch (err) {
      return failure('attach_failed', err);
    }
  };
}

export function createHostMembershipDetachHandler(deps: HostMembershipRouteDeps): RouteHandler {
  const detach = deps.detach ?? detachCommand;
  return async (req) => {
    const body = asRecord(req.body);
    const projectRoot = str(body.project_root);
    if (!projectRoot) return { status: 400, body: errorBody('missing_project_root', 'project_root is required.') };

    const options: DetachOptions = {
      projectPath: projectRoot,
      projectId: str(body.project_id),
      beginDetachResidency: deps.beginDetachResidency,
      allowNoPull: body.allow_no_pull === true,
    };

    try {
      const result = detach(options);
      return {
        status: 200,
        body: { project_id: result.projectId, detached_from_host_id: result.detachedFromHostId },
      };
    } catch (err) {
      return failure('detach_failed', err);
    }
  };
}

// ---------------------------------------------------------------------------
// status (read-only companion — see module docstring)
// ---------------------------------------------------------------------------

export function createHostMembershipStatusHandler(deps: HostMembershipRouteDeps = {}): RouteHandler {
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const lockNamespace = deps.lockNamespace ?? nativePerUserLockNamespace;
  return async (req) => {
    const hosts = readHostRegistry(lockNamespace).map((record) => {
      const servedGroveKnown = Object.hasOwn(record, 'served_grove_id');
      return {
        host_id: record.host_id,
        label: record.label,
        overlay_address: record.overlay_address,
        proxy_port: record.proxy_port ?? null,
        protocol_version: record.protocol_version,
        served_grove_id: record.served_grove_id ?? null,
        created_at: record.created_at,
        projects: record.projects.map((ref) => ({
          grove_id: ref.grove_id,
          project_id: ref.project_id,
          root: ref.root ?? null,
          // The LOCAL Grove this ref displays under (E-4 local-view
          // requirement) — RESOLVED, not the raw stored value: `ref.local_grove_id`
          // when it still names an existing local Grove, else the machine's
          // current default Grove (`resolveAttachRefHomeGroveId`,
          // `grove/registry.ts`). `null` only in the bootstrap-only case where
          // this machine has no default Grove yet.
          local_grove_id: resolveAttachRefHomeGroveId(ref, mycoHome),
          // A known designation must match every existing ref. Explicit
          // undesignation is known and therefore flags every retained ref;
          // an omitted legacy field remains unknown and cannot be compared.
          mismatch: servedGroveKnown && ref.grove_id !== record.served_grove_id
            ? ('attach_grove_mismatch' as const)
            : null,
        })),
      };
    });

    const projectRoot = str(req.query.project_root);
    let hint: { host_id: string; state: string; message: string } | null = null;
    if (projectRoot) {
      try {
        const manifest = loadProjectManifest(resolveProjectVaultDir(projectRoot));
        const state = resolveTeamHostHintState(
          manifest,
          manifest?.project.id,
          lockNamespace,
        );
        const message = teamHostHintMessage(state);
        if (message && (state.kind === 'not_joined' || state.kind === 'not_attached')) {
          hint = { host_id: state.hostId, state: state.kind, message };
        }
      } catch {
        // A manifest read failure is not fatal to the status read — the hint
        // simply stays null (no worse than a project with no hint at all).
      }
    }

    // Whether this machine can take part in a team at all. A capability, not a
    // platform string: the UI needs to know joining will work, and Windows has
    // no overlay client build, so the Join form must say so up front rather
    // than fail after the operator has already minted a one-time key.
    const platform = deps.platform ?? process.platform;
    const overlaySupported = platform === 'darwin' || platform === 'linux';
    // External MCP activation is a distinct capability that happens to share
    // the same platform set today (Unix-socket + Funnel; refused on win32 at
    // external-mcp-containment.ts). Carried separately so the External access
    // toggle never renders live on a machine where enabling can only 502 —
    // and so a future platform gaining one capability without the other
    // doesn't lie about either.
    const externalMcpSupported = platform === 'darwin' || platform === 'linux';

    return {
      status: 200,
      body: {
        hosts,
        hint,
        overlay_supported: overlaySupported,
        external_mcp_supported: externalMcpSupported,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// health (live reachability + protocol-skew probe — see module docstring)
// ---------------------------------------------------------------------------

/**
 * TTL for a per-host reachability probe result (decision-ef693c71 D3: ~15s).
 * Long enough that a Team page poll — or two callers racing the same host —
 * never stacks a second overlay dial within one refresh cycle; short enough
 * that a host coming back up is reflected within roughly one UI cycle.
 */
export const HOST_HEALTH_CACHE_TTL_MS = 15_000;

/**
 * A joined host's protocol-version posture relative to THIS member's current
 * compat window. `none` — within `[HOST_MIN_COMPAT_VERSION,
 * HOST_PROTOCOL_VERSION]`; `host_newer` — the host's recorded version is
 * ABOVE this member's window (this member needs `myco update`); `host_older`
 * — the host's recorded version is BELOW this member's minimum (that host
 * needs `myco update`).
 */
export type HostProtocolSkew = 'none' | 'host_newer' | 'host_older';

/**
 * Classify a joined host's RECORDED protocol version — `HostRecord.protocol_version`,
 * captured from the host's enrollment self-report at join time — against this
 * member's current compat window. This is a snapshot comparison, not the live
 * one: the actual per-request negotiation (`overlayVersionRejection`,
 * `daemon/host-serve.ts`) compares the member's live header against the HOST's
 * OWN current window at dial time, on the host side. A host that has since
 * upgraded or downgraded relative to what this member recorded at join shows
 * the skew here — a heads-up before the member's next real proxy call would
 * hit a 409 (or silently drift compatible) for real.
 */
export function classifyHostProtocolSkew(hostProtocolVersion: number): HostProtocolSkew {
  if (hostProtocolVersion > HOST_PROTOCOL_VERSION) return 'host_newer';
  if (hostProtocolVersion < HOST_MIN_COMPAT_VERSION) return 'host_older';
  return 'none';
}

interface HostHealthEntry {
  host_id: string;
  label: string;
  reachable: boolean | null;
  checked_at: string;
  protocol_skew: HostProtocolSkew;
}

export interface HostMembershipHealthRouteDeps {
  /** Test seam: override the reachability + live-version probe (default the real
   *  host dial). Absent until the member transport lands (PR B). */
  checkReachable?: (hostId: string) => Promise<{ reachable: boolean; protocolVersion: number | null }>;
  /** Test seam: override the registry read. */
  readRegistry?: typeof readHostRegistry;
  /** Test seam: override the probe TTL (default {@link HOST_HEALTH_CACHE_TTL_MS}). */
  ttlMs?: number;
  /** Test seam: current-time source, for TTL determinism. */
  now?: () => number;
  lockNamespace?: PerUserLockNamespace;
}

/**
 * `GET /api/host-membership/health` — live reachability + protocol-skew for
 * every joined host, request-driven only (never a timer/background job — see
 * module docstring, decision-ef693c71 D3).
 *
 * Per-host TTL cache + single-flight, both scoped to the closure returned
 * here (one instance per daemon process, matching every other route factory
 * in this module): a call within {@link HOST_HEALTH_CACHE_TTL_MS} of the last
 * probe for a host returns the cached result with NO new probe; two requests
 * that overlap a host's in-flight probe share the SAME promise rather than
 * each starting their own dial. `dialHostHealth` is already
 * individually bounded (`HOST_PROXY_CONNECT_TIMEOUT_MS`) and never throws in
 * practice, but the `catch` here is the same fail-closed shape doctor's
 * `checkTeamHostReachability` uses, so a probe that somehow rejects still
 * classifies as unreachable rather than crashing the whole fan-out.
 */
export type HostMembershipHealthHandler = RouteHandler & {
  /**
   * Evicts a host's cached entry AND cancels any in-flight probe for it
   * (family c, E-4 W2 Task 7) — called by the leave route, via
   * `registerHostMembershipRoutes`'s `evictHealthCache` wiring, so a left
   * host's stale reachability never survives past its own removal. A no-op
   * for a host with nothing cached.
   */
  evictHost(hostId: string): void;
};

export function createHostMembershipHealthHandler(deps: HostMembershipHealthRouteDeps = {}): HostMembershipHealthHandler {
  const checkReachable = deps.checkReachable ?? null;
  const lockNamespace = deps.lockNamespace ?? nativePerUserLockNamespace;
  const readRegistry = deps.readRegistry ?? (() => readHostRegistry(lockNamespace));
  const ttlMs = deps.ttlMs ?? HOST_HEALTH_CACHE_TTL_MS;
  const now = deps.now ?? Date.now;

  const cache = new Map<string, { entry: HostHealthEntry; expiresAt: number }>();
  const inflight = new Map<string, Promise<HostHealthEntry>>();

  async function probeOne(host: HostRecord): Promise<HostHealthEntry> {
    const cached = cache.get(host.host_id);
    if (cached && now() < cached.expiresAt) return cached.entry;

    const running = inflight.get(host.host_id);
    if (running) return running;

    const promise = (async (): Promise<HostHealthEntry> => {
      // Mirrors doctor's own concurrent-probe shape (`cli/doctor.ts`
      // checkTeamHostReachability): no proxy port on record means there is
      // nothing to dial — `null` ("not confirmable"), never a false negative.
      // Reachability is NOT CONFIRMABLE on this build: the probe dialed the
      // host through the member's local CONNECT proxy, and that path is gone
      // until the member transport is rebuilt on the host's public URL. `null`
      // is the honest answer — the same value a host with nothing to dial has
      // always reported — never a false negative that would read as "host down".
      let reachable: boolean | null = null;
      let observedVersion: number | null = null;
      if (checkReachable) {
        try {
          const probe = await checkReachable(host.host_id);
          reachable = probe.reachable;
          observedVersion = probe.protocolVersion;
        } catch {
          reachable = false;
        }
      }
      // Persist a host that upgraded since join (monotonic — never a probe
      // downgrade), so the residency gates classify + refuse against the host's
      // CURRENT version, not the stale join-time one. Skew is classified from the
      // effective (post-write) version.
      const effectiveVersion = observedVersion !== null
        ? recordHostProtocolVersion(host.host_id, observedVersion, lockNamespace)
        : host.protocol_version;
      return {
        host_id: host.host_id,
        label: host.label,
        reachable,
        checked_at: new Date(now()).toISOString(),
        protocol_skew: classifyHostProtocolSkew(effectiveVersion),
      };
    })();

    inflight.set(host.host_id, promise);
    try {
      const entry = await promise;
      cache.set(host.host_id, { entry, expiresAt: now() + ttlMs });
      return entry;
    } finally {
      inflight.delete(host.host_id);
    }
  }

  const handler: RouteHandler = async (): Promise<RouteResponse> => {
    const hosts = readRegistry();
    // Unbounded fan-out, no concurrency cap — accepted the same way doctor's
    // own checkTeamHostReachability accepts it: joined-host counts are small
    // and human-managed (an operator explicitly runs `myco join` per host),
    // never approaching a scale where N concurrent probes matters.
    const results = await Promise.all(hosts.map((host) => probeOne(host)));
    return { status: 200, body: { hosts: results } };
  };

  return Object.assign(handler, {
    evictHost(hostId: string): void {
      cache.delete(hostId);
      inflight.delete(hostId);
    },
  });
}

// ---------------------------------------------------------------------------
// residency-status / residency-abort (Phase F — the Team page progress + Cancel)
// ---------------------------------------------------------------------------

/**
 * `GET /api/host-membership/residency-status?project_id=<proj>` — the in-flight
 * transition for a project, or `{in_flight:false}` when none. Localhost-only
 * (`host/routing.ts` ROUTE_RULES): it reads this member machine's own journal
 * and local outbox, meaningless to answer for another machine. Without the
 * daemon capability wired (tests) it degrades to `{in_flight:false}`.
 */
export function createHostMembershipResidencyStatusHandler(deps: HostMembershipRouteDeps): RouteHandler {
  return async (req) => {
    const projectId = str(req.query.project_id);
    if (!projectId) return { status: 400, body: errorBody('missing_project_id', 'project_id is required.') };
    if (!deps.residencyStatus) return { status: 200, body: { in_flight: false } };
    return { status: 200, body: deps.residencyStatus(projectId) };
  };
}

/**
 * `POST /api/host-membership/residency-abort` `{project_id}` — abort an in-flight
 * transition, `{ok:true}` on success or a coded membership error (e.g.
 * `residency_abort_too_late`). Localhost-only, daemon-only (it restores/clears
 * local state); a caller without the capability wired gets a clean refusal.
 */
export function createHostMembershipResidencyAbortHandler(deps: HostMembershipRouteDeps): RouteHandler {
  return async (req) => {
    const body = asRecord(req.body);
    const projectId = str(body.project_id);
    if (!projectId) return { status: 400, body: errorBody('missing_project_id', 'project_id is required.') };
    if (!deps.residencyAbort) {
      return { status: 400, body: errorBody('residency_abort_unavailable', 'Aborting a residency transition requires the running daemon.') };
    }
    try {
      return { status: 200, body: deps.residencyAbort(projectId) };
    } catch (err) {
      return failure('residency_abort_failed', err);
    }
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerHostMembershipRoutes(server: RouteRegistrar, deps: HostMembershipRouteDeps = {}): void {
  // Built once so join/leave/health share the SAME health handler instance —
  // `leave` gets its `evictHealthCache` from this instance's own `evictHost`,
  // unless a caller (a test) already supplied one explicitly.
  const healthHandler = createHostMembershipHealthHandler(deps);
  const leaveDeps: HostMembershipRouteDeps = { ...deps, evictHealthCache: deps.evictHealthCache ?? healthHandler.evictHost };

  server.registerRoute('POST', '/api/host-membership/join', createHostMembershipJoinHandler(deps));
  server.registerRoute('POST', '/api/host-membership/leave', createHostMembershipLeaveHandler(leaveDeps));
  server.registerRoute('POST', '/api/host-membership/attach', createHostMembershipAttachHandler(deps));
  server.registerRoute('POST', '/api/host-membership/detach', createHostMembershipDetachHandler(deps));
  server.registerRoute('GET', '/api/host-membership/status', createHostMembershipStatusHandler(deps));
  server.registerRoute('GET', '/api/host-membership/health', healthHandler);
  server.registerRoute('GET', '/api/host-membership/residency-status', createHostMembershipResidencyStatusHandler(deps));
  server.registerRoute('POST', '/api/host-membership/residency-abort', createHostMembershipResidencyAbortHandler(deps));
}
