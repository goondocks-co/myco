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
 */
export async function runScopedAction<T extends object>(
  endpoint: string,
  req: RouteRequest,
  inflight: ActionInflightRegistry,
  run: (scope: ActionScope) => Promise<Array<PerGroveResultBase & T>>,
): Promise<RouteResponse> {
  let scope: ActionScope;
  try {
    scope = resolveActionScope({ body: req.body, requestContext: req.requestContext });
  } catch (err) {
    if (err instanceof InvalidActionScopeError) {
      return { status: 400, body: { error: 'invalid_scope', message: err.message } };
    }
    throw err;
  }

  const key = `${endpoint}:${actionScopeKey(scope)}`;
  return inflight.run(key, async (): Promise<RouteResponse> => {
    const results = await run(scope);
    const ok = results.filter((r) => r.ok).length;
    const failed = results.length - ok;
    const body: DispatchResult<T> = { scope, results, summary: { ok, failed } };
    return { body };
  });
}
