import { abortable } from '@myco/utils/abortable.js';

/** Maximum request time, or time without response progress during a release download. */
export const RUNNER_REQUEST_TIMEOUT_MS = 30_000;
export const RUNNER_POLL_INTERVAL_MS = 2_000;
export const RUNNER_CONTACT_RECORD_MS = RUNNER_POLL_INTERVAL_MS * 5;

/**
 * What happens to a request's result once its caller stopped waiting. `discarded` is the one owner of a result that
 * still arrives; with `lingerMs`, the request itself is not torn down when the caller stops but may finish within
 * that many milliseconds more, for `discarded` alone. The caller is answered exactly as without it.
 */
export interface LateResult<T> { discarded: (late: T) => void | Promise<void>; lingerMs?: number }

/** One bounded request; a result that arrives after the caller stopped waiting goes to its declared owner. */
export function runnerRequest<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, late?: LateResult<T>): Promise<T> {
  const bounded = runnerRequestSignal(signal);
  const wire = late?.lingerMs === undefined ? bounded : lingering(bounded, late.lingerMs);
  return abortable(bounded, () => work(wire), late?.discarded);
}

/** A signal that aborts `ms` after `signal` does, so work it bounds may finish for cleanup once its caller stopped. */
function lingering(signal: AbortSignal, ms: number): AbortSignal {
  const ended = new AbortController();
  signal.addEventListener('abort', () => {
    runnerRequestSignal(undefined, ms).addEventListener('abort', () => ended.abort(signal.reason), { once: true });
  }, { once: true });
  return ended.signal;
}

/** A request deadline joined to the lifetime of its caller. */
export function runnerRequestSignal(signal?: AbortSignal, timeoutMs = RUNNER_REQUEST_TIMEOUT_MS): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal === undefined ? [] : [signal])]);
}
