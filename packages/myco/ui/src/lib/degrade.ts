import type { UseQueryResult } from '@tanstack/react-query';
import { ApiError } from './api';
import type { ProjectSelection } from './selection';

/**
 * Team Host route degradation (`host/routing.ts` `hostedCapabilityUnavailable`):
 * an attached (hosted) project refuses a `degrade`-stamped route with a 409
 * carrying `{ error: 'capability_unavailable_hosted', capability, message,
 * retryable: false }`. This is the ONE shape every degraded route uses — the
 * plan-of-record's "ONE uniform plain-language 'unavailable for hosted
 * projects' state" starts with detecting it uniformly here, rather than each
 * hook/component re-deriving its own check against `ApiError.body`.
 */
export interface HostedDegradedInfo {
  /** The capability name the route refused (`host/routing.ts`'s per-route
   *  `capability` constant, e.g. "Git provenance", "Code intelligence (Canopy)"). */
  capability: string;
  /** Server-authored message, present for completeness — callers should
   *  generally prefer the uniform copy (see `hostedUnavailableMessage`) over
   *  rendering this verbatim, to keep every degraded surface reading the same. */
  message: string;
}

/** True when `err` is the uniform hosted-capability-degraded refusal. Safe to
 *  call on anything (a thrown value, a query's `error`, `null`/`undefined`). */
export function hostedDegradedInfo(err: unknown): HostedDegradedInfo | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const body = err.body as { error?: unknown; capability?: unknown; message?: unknown } | undefined;
  if (body?.error !== 'capability_unavailable_hosted') return null;
  return {
    capability: typeof body.capability === 'string' && body.capability.length > 0 ? body.capability : 'This feature',
    message: typeof body.message === 'string' ? body.message : '',
  };
}

/** The ONE plain-language sentence every degraded surface renders — copy
 *  doctrine (decision-6a2ccfac): outcome vocabulary, no mechanism jargon
 *  ("degrade", "capability_unavailable_hosted", "stamp"). */
export function hostedUnavailableMessage(info: HostedDegradedInfo): string {
  return `${info.capability} isn't available for projects hosted on a Team Host yet.`;
}

/** Read a plain-string `error` code off an `ApiError` body (the shape both
 *  refusals below use: `{ error: 'unknown_tenancy', ... }`). Returns null for
 *  the object-`{code}` form or a bodyless error — precise by construction. */
function refusalCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const error = (body as { error?: unknown }).error;
  return typeof error === 'string' ? error : null;
}

/**
 * True when `err` is an ATTACHED project's pre-first-capture tenancy refusal:
 * the Team Host 404s knowledge reads with `{ error: 'unknown_tenancy' }`
 * (`daemon/server.ts` / `mcp/http.ts`, T1) until the first forwarded capture
 * registers the project host-side, and a residual attached-config carve can
 * 500 with `{ error: 'attached_config_failed' }` (`daemon/attached-config.ts`,
 * T3). Both mean "this attached project isn't known yet", not "the daemon is
 * unreachable" — the BEHAVE-LIKE-LOCAL decision maps them to the same
 * zero-state a brand-new local project shows.
 *
 * PRECISION IS LOAD-BEARING. This matches ONLY when the active selection is an
 * attached project AND the wire shape is exactly one of those two refusals. A
 * genuine host outage (`host_unreachable` 503, `host_auth_rejected` 502, a
 * relay 5xx, a network error that never became an `ApiError`), any OTHER 404,
 * and every refusal on a NON-attached project all return false — so real
 * outages keep today's real error presentation instead of being silently
 * flipped into a fake empty page.
 */
export function isAttachedTenancyPending(
  err: unknown,
  selection: ProjectSelection | null | undefined,
): boolean {
  if (!selection?.project.attached) return false;
  if (!(err instanceof ApiError)) return false;
  const code = refusalCode(err.body);
  if (err.status === 404 && code === 'unknown_tenancy') return true;
  if (err.status === 500 && code === 'attached_config_failed') return true;
  return false;
}

/**
 * The ONE shared error→empty mapping for the attached pre-first-capture window
 * (BEHAVE-LIKE-LOCAL). When a query's error is an attached-tenancy refusal
 * (`isAttachedTenancyPending`), resolve the query to its EMPTY shape (the same
 * zero-stats object / empty list a fresh local project renders) instead of an
 * error state, so every affected page reuses its existing local zero-state
 * copy rather than "Failed to connect to daemon".
 *
 * The query is left in its real error state internally — this only rewrites the
 * RESULT the component reads. Callers pair it with the two suppression knobs
 * (`retry: false` + `refetchInterval: false` on the classified refusal,
 * `use-git-identity.ts` pattern); `refetchOnWindowFocus`/`refetchOnMount`/
 * `retryOnMount` stay at their defaults so a later real refetch (once T1's
 * registration lands) repopulates the page.
 *
 * `empty` may be a value or a builder taking the (guaranteed-attached)
 * selection — used by the stats hook, whose zero-object carries the selection's
 * project/grove identity.
 */
export function resolveAttachedEmpty<T>(
  result: UseQueryResult<T>,
  selection: ProjectSelection | null | undefined,
  empty: T | ((selection: ProjectSelection) => T),
): UseQueryResult<T> {
  if (!result.isError || !isAttachedTenancyPending(result.error, selection)) {
    return result;
  }
  const value =
    typeof empty === 'function'
      ? (empty as (s: ProjectSelection) => T)(selection as ProjectSelection)
      : empty;
  return {
    ...result,
    data: value,
    error: null,
    isError: false,
    isSuccess: true,
    isLoadingError: false,
    isRefetchError: false,
    status: 'success',
  } as UseQueryResult<T>;
}
