import { ApiError } from './api';

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
