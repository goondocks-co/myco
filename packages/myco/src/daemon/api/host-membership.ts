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
 *
 * All five are `localhost-only` (`host/routing.ts` ROUTE_RULES): every one
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
 * Wire bodies use snake_case, matching the rest of the API
 * (`content-claims-materialize.ts`, `drain-health.ts`); the orchestration
 * functions underneath use camelCase options objects, so each handler maps
 * between the two explicitly.
 */
import { loadProjectManifest } from '../../config/project-manifest.js';
import { resolveMycoHome, resolveProjectVaultDir } from '../../grove/paths.js';
import { attachCommand, detachCommand, type AttachOptions, type DetachOptions } from '../../host/attach-command.js';
import { resolveTeamHostHintState, teamHostHintMessage } from '../../host/hint.js';
import { joinHost, leaveHost, type JoinOptions } from '../../host/member-overlay.js';
import { readHostRegistry } from '../../host/registry.js';
import type { RouteHandler, RouteRegistrar, RouteResponse } from '../router.js';
import { errorBody } from './error-envelope.js';

export interface HostMembershipRouteDeps {
  /** Test seam: override the orchestration functions (default the real ones). */
  join?: typeof joinHost;
  leave?: typeof leaveHost;
  attach?: typeof attachCommand;
  detach?: typeof detachCommand;
  mycoHome?: string;
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

/** Render a thrown orchestration error as a uniform 400 — every failure mode
 *  of join/leave/attach/detach (bad input, precondition not met, provisioning
 *  failure) is something the operator acts on from the message text; there is
 *  no machine-readable discrimination a caller needs beyond "it didn't work,
 *  here's why" (the CLI wrapper prints `err.message` verbatim today). */
function failure(code: string, err: unknown): RouteResponse {
  const message = err instanceof Error ? err.message : String(err);
  return { status: 400, body: errorBody(code, message) };
}

// ---------------------------------------------------------------------------
// join / leave
// ---------------------------------------------------------------------------

export function createHostMembershipJoinHandler(deps: HostMembershipRouteDeps): RouteHandler {
  const join = deps.join ?? joinHost;
  return async (req) => {
    const body = asRecord(req.body);
    const hostRef = str(body.host_ref);
    const key = str(body.key);
    if (!hostRef) return { status: 400, body: errorBody('missing_host_ref', 'host_ref is required.') };
    if (!key) return { status: 400, body: errorBody('missing_key', 'key is required.') };

    const options: JoinOptions = {
      hostRef,
      key,
      serverUrl: str(body.server_url),
      hostname: str(body.hostname),
      overlayAddress: str(body.overlay_address),
      bearer: str(body.bearer),
      protocolVersion: num(body.protocol_version),
      hostId: str(body.host_id),
      label: str(body.label),
    };

    try {
      const result = await join(options);
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
        },
      };
    } catch (err) {
      return failure('join_failed', err);
    }
  };
}

export function createHostMembershipLeaveHandler(deps: HostMembershipRouteDeps): RouteHandler {
  const leave = deps.leave ?? leaveHost;
  return async (req) => {
    const body = asRecord(req.body);
    const hostRef = str(body.host_ref);
    if (!hostRef) return { status: 400, body: errorBody('missing_host_ref', 'host_ref is required.') };

    try {
      const result = await leave(hostRef);
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
    const groveId = str(body.grove_id);
    if (!projectRoot) return { status: 400, body: errorBody('missing_project_root', 'project_root is required.') };
    if (!groveId) return { status: 400, body: errorBody('missing_grove_id', 'grove_id is required.') };

    const options: AttachOptions = {
      projectPath: projectRoot,
      hostId: str(body.host_id),
      groveId,
      projectId: str(body.project_id),
      mycoHome,
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

    const options: DetachOptions = { projectPath: projectRoot, projectId: str(body.project_id) };

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

export function createHostMembershipStatusHandler(): RouteHandler {
  return async (req) => {
    const hosts = readHostRegistry().map((record) => ({
      host_id: record.host_id,
      label: record.label,
      overlay_address: record.overlay_address,
      proxy_port: record.proxy_port ?? null,
      protocol_version: record.protocol_version,
      created_at: record.created_at,
      projects: record.projects.map((ref) => ({
        grove_id: ref.grove_id,
        project_id: ref.project_id,
        root: ref.root ?? null,
      })),
    }));

    const projectRoot = str(req.query.project_root);
    let hint: { host_id: string; state: string; message: string } | null = null;
    if (projectRoot) {
      try {
        const manifest = loadProjectManifest(resolveProjectVaultDir(projectRoot));
        const state = resolveTeamHostHintState(manifest, manifest?.project.id);
        const message = teamHostHintMessage(state);
        if (message && (state.kind === 'not_joined' || state.kind === 'not_attached')) {
          hint = { host_id: state.hostId, state: state.kind, message };
        }
      } catch {
        // A manifest read failure is not fatal to the status read — the hint
        // simply stays null (no worse than a project with no hint at all).
      }
    }

    return { status: 200, body: { hosts, hint } };
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerHostMembershipRoutes(server: RouteRegistrar, deps: HostMembershipRouteDeps = {}): void {
  server.registerRoute('POST', '/api/host-membership/join', createHostMembershipJoinHandler(deps));
  server.registerRoute('POST', '/api/host-membership/leave', createHostMembershipLeaveHandler(deps));
  server.registerRoute('POST', '/api/host-membership/attach', createHostMembershipAttachHandler(deps));
  server.registerRoute('POST', '/api/host-membership/detach', createHostMembershipDetachHandler(deps));
  server.registerRoute('GET', '/api/host-membership/status', createHostMembershipStatusHandler());
}
