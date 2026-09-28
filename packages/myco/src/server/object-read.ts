/**
 * What a failed object read says about trying it again.
 *
 * A source adapter that knows its failure's class throws an `ObjectReadError` that carries it: an HTTP 5xx or 429 is
 * transient, a 404 or a refused credential is not. Otherwise only the failures a transfer produces by itself count as
 * transient: a timeout or abort, and a connection that was reset, refused or closed. Anything else is permanent, so a
 * digest or size mismatch, a disk error or an unknown fault fails at once rather than being retried.
 */
export class ObjectReadError extends Error {
  readonly transient: boolean;

  constructor(message: string, options: { transient: boolean; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ObjectReadError';
    this.transient = options.transient;
  }
}

/**
 * The connection-level failure codes Bun's and Node's fetch report for a transfer that did not complete. Bun reports
 * `ConnectionRefused` for a refused connection and for a name that did not resolve alike.
 */
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH',
  'ConnectionClosed', 'ConnectionRefused', 'FailedToOpenSocket', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
]);
/** How far down a chain of causes a failure is looked for: Node's `fetch failed` carries its socket error one level down. */
const CAUSE_DEPTH = 3;

/** Whether an HTTP status answers a read that may succeed when asked again. */
export const transientStatus = (status: number): boolean => status === 429 || (status >= 500 && status <= 599);

/** Whether a failed read may succeed when tried again, judged by the failure or any cause it carries. */
export function transientReadFailure(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth <= CAUSE_DEPTH; depth += 1) {
    if (current instanceof ObjectReadError) return current.transient;
    if (typeof current !== 'object' || current === null) return false;
    const { name, code, cause } = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (name === 'TimeoutError' || name === 'AbortError') return true;
    if (typeof code === 'string' && TRANSIENT_NETWORK_CODES.has(code)) return true;
    current = cause;
  }
  return false;
}
