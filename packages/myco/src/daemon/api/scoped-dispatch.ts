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
