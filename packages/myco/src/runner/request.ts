import { abortable } from '@myco/utils/abortable.js';

/** Maximum request time, or time without response progress during a release download. */
export const RUNNER_REQUEST_TIMEOUT_MS = 30_000;
export const RUNNER_POLL_INTERVAL_MS = 2_000;
export const RUNNER_CONTACT_RECORD_MS = RUNNER_POLL_INTERVAL_MS * 5;

/** One bounded request; a result that arrives after the caller stopped waiting goes to `discarded`, its one owner. */
export function runnerRequest<T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, discarded?: (late: T) => void | Promise<void>): Promise<T> {
  const bounded = runnerRequestSignal(signal);
  return abortable(bounded, () => work(bounded), discarded);
}

/** A request deadline joined to the lifetime of its caller. */
export function runnerRequestSignal(signal?: AbortSignal, timeoutMs = RUNNER_REQUEST_TIMEOUT_MS): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal === undefined ? [] : [signal])]);
}
