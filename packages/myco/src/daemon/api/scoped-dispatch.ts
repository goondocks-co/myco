/**
 * Shared scaffolding for scope-aware action endpoints (database
 * maintenance, embedding actions). Each endpoint resolves an
 * `ActionScope` from the request body, runs the action under in-flight
 * coalescing keyed on `${endpoint}:${actionScopeKey(scope)}`, and
 * aggregates per-Grove results into a `{ scope, results, summary }`
 * envelope. Three helpers below isolate that boilerplate so individual
 * endpoint files only own the per-action work.
 *
 * Backup is intentionally NOT a consumer here — its shape is different
 * (sync, listGroves-driven, legacy fallback path) and the abstraction
 * cost would outweigh the dedup.
 */

import { errorMessage } from '@myco/utils/error-message.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import {
  resolveActionScope,
  actionScopeKey,
  InvalidActionScopeError,
  type ActionScope,
} from './action-scope.js';
import type { ActionInflightRegistry } from './action-inflight.js';
import {
  isProjectPaused,
  isProjectPausedInGrove,
  listGroves,
  listRegisteredProjects,
  type ProjectPauseStatus,
} from '@myco/grove/registry.js';
import { listWriteBlockedProjectIds } from '@myco/grove/project-lease.js';
import { pausedErrorResponse, type PausedInfo } from './error-envelope.js';

/** Wire shape every per-Grove action result extends. */
export interface PerGroveResultBase {
  grove_id: string;
  grove_slug: string;
  ok: boolean;
  error?: string;
}

/** Standard envelope for scoped-action responses. */
export interface DispatchResult<T> {
  scope: ActionScope;
  results: Array<PerGroveResultBase & T>;
  summary: { ok: number; failed: number };
}

/**
 * Keys reserved by the `PerGroveResultBase` envelope. A result body
 * that returns one of these would silently overwrite the wrapper's
 * own status fields (`ok`, `error`, `grove_id`, `grove_slug`), which
 * is always a bug — flag it at the type level instead of letting the
 * spread merge silently corrupt the response shape.
 */
export type PerGroveEnvelopeKey = 'ok' | 'error' | 'grove_id' | 'grove_slug';

/**
 * Constraint applied to bodies passed into `wrapPerGroveResult`. A body
 * that declares one of the reserved envelope keys (`ok`, `error`,
 * `grove_id`, `grove_slug`) would silently shadow the wrapper's own
 * status fields when spread; the mapped-key inline constraint on
 * `wrapPerGroveResult` (and any per-endpoint dispatcher that re-uses
 * this shape) lights that up at the call site instead.
 */
export type WrappablePerGroveBody = object & {
  [K in PerGroveEnvelopeKey]?: never;
};

/**
 * Wrap a per-Grove action body in the standard try/catch + tagging
 * shape. On success the body's return value is spread into the result
 * row; on throw the row carries `{ ok: false, error: errorMessage(err) }`.
 *
 * `T` is constrained so the body can't declare an `ok`, `error`,
 * `grove_id`, or `grove_slug` field — otherwise the spread would
 * silently overwrite the envelope's own status.
 */
export async function wrapPerGroveResult<T extends object & { [K in PerGroveEnvelopeKey]?: never }>(
  groveId: string,
  groveSlug: string,
  fn: () => Promise<T> | T,
): Promise<PerGroveResultBase & T> {
  try {
    const value = await fn();
    return { grove_id: groveId, grove_slug: groveSlug, ok: true, ...value } as PerGroveResultBase & T;
  } catch (err) {
    return {
      grove_id: groveId,
      grove_slug: groveSlug,
      ok: false,
      error: errorMessage(err),
    } as PerGroveResultBase & T;
  }
}

/**
 * Resolve an `ActionScope` from a request, run the per-scope action
 * inside in-flight coalescing, and wrap the per-Grove results in the
 * standard envelope. The caller's `run` callback decides how the scope
 * maps to per-Grove work (single Grove vs fan-out).
 *
 * G5 (all-groves confirmation gate): when the resolved scope is
 * `kind: 'all-groves'`, the request body must carry an explicit
 * `confirmation_token` matching the daemon-issued token (the same
 * MYCO_DAEMON_AUTH the auth header carries). This prevents a single
 * misclick from fanning a destructive batch op (vacuum, reindex,
 * integrity-check) across every registered Grove — the caller has to
 * make a deliberate "yes, all of them" assertion.
 */
export interface RunScopedActionOptions {
  /**
   * Default scope kind when the request body omits `scope`. See
   * `ResolveActionScopeOptions.defaultKind` — set to `'grove'` for
   * endpoints whose data plane is whole-Grove (backup, vacuum,
   * optimize, etc.) so the implicit default doesn't fall into the
   * `'project'` arm. (P2 #36)
   */
  defaultKind?: 'project' | 'grove';
  /**
   * How wide this endpoint's writes actually reach — NOT how wide the
   * caller's requested scope is. The two are independent, and conflating
   * them is a data-loss bug: `embedding/rebuild` accepts `kind:'project'`
   * and then runs `UPDATE <table> SET embedded = 0` with no WHERE across
   * every project-scoped table in the Grove, so a project-scoped REQUEST
   * performs a Grove-wide WRITE.
   *
   * `'grove-wide'` (the default) makes a `project` scope admit under the
   * Grove rule — every leased project in that Grove blocks it, not just
   * the one named in the request. Declare `'project-narrow'` only when
   * every write the endpoint performs really is filtered to
   * `scope.project_id`; that claim is a review obligation the gate cannot
   * check for you, which is why the safe value is the default.
   */
  dataPlane?: 'project-narrow' | 'grove-wide';
}

export async function runScopedAction<T extends object>(
  endpoint: string,
  req: RouteRequest,
  inflight: ActionInflightRegistry,
  run: (scope: ActionScope) => Promise<Array<PerGroveResultBase & T>>,
  options: RunScopedActionOptions = {},
): Promise<RouteResponse> {
  let scope: ActionScope;
  try {
    scope = resolveActionScope({
      body: req.body,
      requestContext: req.requestContext,
      defaultKind: options.defaultKind,
    });
  } catch (err) {
    if (err instanceof InvalidActionScopeError) {
      return { status: 400, body: { error: 'invalid_scope', message: err.message } };
    }
    throw err;
  }

  if (scope.kind === 'all-groves') {
    const rejection = checkAllGrovesConfirmation(req.body);
    if (rejection) return rejection;
  }

  const admissionRefusal = checkActionWriteAdmission(scope, options.dataPlane ?? 'grove-wide');
  if (admissionRefusal) return admissionRefusal;

  const key = `${endpoint}:${actionScopeKey(scope)}`;
  return inflight.run(key, async (): Promise<RouteResponse> => {
    let results: Array<PerGroveResultBase & T>;
    try {
      results = await run(scope);
    } catch (err) {
      // Endpoints can throw `InvalidActionScopeError` from inside their
      // run callback when a wire-level scope kind isn't supported by
      // their data plane (e.g. database maintenance rejecting `project`).
      if (err instanceof InvalidActionScopeError) {
        return { status: 400, body: { error: 'invalid_scope', message: err.message } };
      }
      throw err;
    }
    const ok = results.filter((r) => r.ok).length;
    const failed = results.length - ok;
    const body: DispatchResult<T> = { scope, results, summary: { ok, failed } };
    return { body };
  });
}

/**
 * Write admission for the action-scope family (embedding actions,
 * database maintenance, release-provenance reconcile).
 *
 * These endpoints resolve their scope from the request BODY, not from the
 * request path, so `requestContext.projectId` is absent and the central
 * per-project HTTP write gate in `daemon/server.ts` never fires for them.
 * Admission is therefore consulted here rather than in each handler.
 *
 * CAVEAT, stated because it is load-bearing and easy to assume away: this
 * is NOT a funnel every action endpoint is forced through. Routing here is
 * a convention, not a structural guarantee — `api/database.ts`'s
 * `dispatchVacuum` resolves its own scope and calls `inflight.run` directly
 * for a single-Grove scope, reaching admission only on its all-groves
 * fall-through. That is harmless today (VACUUM writes no project-scoped
 * rows, and the file is classified `no-project-writes`), but an endpoint
 * copied from that shape inherits a silent bypass. Any registry entry
 * classified `gated-upstream` is asserting its own routing, and that
 * assertion is a review obligation — the mechanism pin only proves this
 * gate EXISTS, not that a given endpoint reaches it.
 *
 * Refusal is decided by the endpoint's DATA PLANE, not by the requested
 * scope kind — see `RunScopedActionOptions.dataPlane`. A `project`-scoped
 * request to a grove-wide endpoint writes every project's rows in that
 * Grove, so it is admitted under the Grove rule.
 *
 *   - `project` scope, `project-narrow` plane — that project's lease only.
 *   - `project` scope, `grove-wide` plane     — the Grove rule below.
 *   - `grove`                                 — a leased project is registered in the
 *                    target Grove, OR is registered in no Grove at all. The
 *                    second case is not paranoia: a project
 *                    mid-residency-transition is deregistered from every Grove
 *                    while its lease is held, so "which Grove owns it" is
 *                    unanswerable and the only safe answer is to refuse.
 *   - `all-groves`                            — any project holds a lease.
 *
 * Two enumerations are unioned because each is blind where the other
 * sees: the lease directory finds projects registered nowhere (the
 * mid-transition case), while the Grove registry finds the legacy in-row
 * `projects.toml` pause that `isProjectPaused` still honors during the
 * upgrade window but that leaves no file in the lease directory.
 *
 * An unreadable lease counts as held throughout (G4).
 *
 * Deliberately NOT in scope here: the action-scope authority question
 * (a body-supplied scope is caller-asserted rather than authenticated).
 * That is Pattern 4 / release-hardening, tracked separately.
 */
function checkActionWriteAdmission(
  scope: ActionScope,
  dataPlane: 'project-narrow' | 'grove-wide',
): RouteResponse | null {
  // The named project is always consulted directly. This is the only arm
  // that sees a legacy in-row pause on a project whose lease file does not
  // exist, so it runs even when the Grove rule runs below.
  if (scope.kind === 'project') {
    const info = pauseInfoFor(scope.project_id);
    if (info) return pausedErrorResponse(scope.project_id, info);
    if (dataPlane === 'project-narrow') return null;
  }

  let leased: string[];
  try {
    leased = listWriteBlockedProjectIds();
  } catch {
    // The lease directory itself could not be read. Same posture as an
    // unreadable individual record: undetermined is not unheld, so refuse
    // the whole grove-wide action rather than run it half-blind.
    return pausedErrorResponse('(unknown)', {
      reason: 'lease directory unreadable',
      since: 0,
      owner_op: 'unknown',
      grove_id: null,
    });
  }

  // The Grove this action's writes can reach: the requested Grove for both
  // `grove` and (grove-wide-plane) `project` scopes; every Grove for
  // `all-groves`.
  const targetGrove = scope.kind === 'all-groves' ? null : scope.grove_id;

  const blocked: { projectId: string; info: PausedInfo }[] = [];
  const seen = new Set<string>();
  const consider = (projectId: string, info: PausedInfo | null): void => {
    if (!info || seen.has(projectId)) return;
    // Blocked by a leased project registered in the target Grove — or
    // registered in NO Grove, because a project mid-residency-transition
    // is deregistered from every Grove while its lease is held, making
    // "which Grove owns it" unanswerable.
    if (targetGrove !== null && info.grove_id !== null && info.grove_id !== targetGrove) return;
    seen.add(projectId);
    blocked.push({ projectId, info });
  };

  // Enumeration 1 — the lease directory. Sees projects registered nowhere.
  for (const projectId of leased) {
    consider(projectId, pauseInfoFor(projectId)); // null = released between listing and read
  }

  // Enumeration 2 — the Grove registry. Sees the legacy in-row
  // `projects.toml` pause, which leaves no file in the lease directory and
  // is therefore invisible to enumeration 1.
  for (const grove of targetGrove === null ? listGroves() : [{ id: targetGrove }]) {
    let projects: { project_id: string }[];
    try {
      projects = listRegisteredProjects(grove.id);
    } catch {
      continue; // unknown/unreadable Grove — enumeration 1 still applies
    }
    for (const project of projects) {
      if (seen.has(project.project_id)) continue;
      let info: PausedInfo | null;
      try {
        const status = isProjectPausedInGrove(grove.id, project.project_id);
        info = status.paused
          ? { reason: status.reason, since: status.since, owner_op: status.owner_op, grove_id: status.grove_id }
          : null;
      } catch {
        info = { reason: 'lease record unreadable', since: 0, owner_op: 'unknown', grove_id: grove.id };
      }
      consider(project.project_id, info);
    }
  }
  if (blocked.length === 0) return null;

  // Same `project_paused` discriminator as every other writer-side gate;
  // the extra id list only tells a fan-out caller how many projects it
  // has to wait on.
  const [first, ...rest] = blocked;
  const response = pausedErrorResponse(first.projectId, first.info);
  return rest.length === 0
    ? response
    : {
        status: response.status,
        body: { ...response.body, blocked_project_ids: blocked.map((b) => b.projectId) },
      };
}

/**
 * The pause record blocking writes to a project, or null when writes are
 * admitted. An unreadable lease synthesizes a record rather than
 * returning null — unreadable is not unheld (G4).
 */
function pauseInfoFor(projectId: string): PausedInfo | null {
  let status: ProjectPauseStatus;
  try {
    status = isProjectPaused(projectId);
  } catch {
    return {
      reason: 'lease record unreadable',
      since: 0,
      owner_op: 'unknown',
      grove_id: null,
    };
  }
  if (!status.paused) return null;
  return {
    reason: status.reason,
    since: status.since,
    owner_op: status.owner_op,
    grove_id: status.grove_id,
  };
}

/**
 * Verify the request body's `confirmation_token` against the daemon's
 * bearer (MYCO_DAEMON_AUTH). Returns a 403 RouteResponse when the
 * token is missing or wrong; null when the request is authorized to
 * fan out across every Grove.
 *
 * The check intentionally fails-closed when no token is configured
 * (env unset). A daemon that doesn't know what its own bearer is can't
 * verify anything; treat that as "refuse the destructive batch op
 * until the operator restarts the daemon properly."
 */
function checkAllGrovesConfirmation(body: unknown): RouteResponse | null {
  const expected = process.env.MYCO_DAEMON_AUTH ?? '';
  const presented = readConfirmationToken(body);
  if (!expected) {
    return {
      status: 403,
      body: {
        error: 'all_groves_confirmation_required',
        message: 'Daemon has no bearer token configured; cannot authorize all-Groves fan-out',
      },
    };
  }
  if (!presented || !timingSafeStringEqual(presented, expected)) {
    return {
      status: 403,
      body: {
        error: 'all_groves_confirmation_required',
        message: 'all-Groves actions require a confirmation_token in the request body',
      },
    };
  }
  return null;
}

function readConfirmationToken(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const value = (body as Record<string, unknown>).confirmation_token;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < length; i += 1) {
    const ai = i < a.length ? a.charCodeAt(i) : 0;
    const bi = i < b.length ? b.charCodeAt(i) : 0;
    mismatch |= ai ^ bi;
  }
  return mismatch === 0;
}
