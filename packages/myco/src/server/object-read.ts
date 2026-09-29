import { CommandFailed, CommandTimedOut, commandFailureDetail } from './runner.js';

/**
 * What a failed read from a source says about trying it again.
 *
 * A source adapter that knows its failure's class throws an `ObjectReadError` that carries it: an HTTP 5xx or 429 is
 * transient, a 404 or a refused credential is not. Otherwise only the failures a transfer produces by itself count as
 * transient: a timeout or abort, a connection that was reset, refused or closed, and a compressed body that could not be
 * decoded because it was cut short. A provider command (Wrangler) that exits non-zero is judged by what it printed
 * (`transientProviderOutput`), and one that answered nothing inside its window is transient. Anything else is permanent,
 * so a digest or size mismatch, a disk error or an unknown fault fails at once rather than being retried.
 */
export class ObjectReadError extends Error {
  readonly transient: boolean;
  /** The Cloudflare API error codes the answer carried, where it came from the API itself rather than a provider command. */
  readonly apiCodes: readonly string[];

  constructor(message: string, options: { transient: boolean; cause?: unknown; apiCodes?: readonly string[] }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ObjectReadError';
    this.transient = options.transient;
    this.apiCodes = options.apiCodes ?? [];
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
/**
 * The failure codes a fetch reports for a compressed response body it could not decode, which is how a connection lost
 * inside a `content-encoding: gzip` body surfaces. Bun 1.3 throws a plain `Error` whose `code` is `ZlibError` (gzip and
 * deflate), `BrotliDecompressionError` or `ZstdDecompressionError`; Node's zlib reports `Z_DATA_ERROR` or `Z_BUF_ERROR`
 * as the cause of its fetch failure. Retrying one cannot admit corrupt bytes: a copy is accepted only once its size and
 * digest hold.
 */
const TRUNCATED_BODY_CODES = new Set(['ZlibError', 'BrotliDecompressionError', 'ZstdDecompressionError', 'Z_DATA_ERROR', 'Z_BUF_ERROR']);
/** How far down a chain of causes a failure is looked for: Node's `fetch failed` carries its socket error one level down. */
const CAUSE_DEPTH = 3;

/** Whether an HTTP status answers a read that may succeed when asked again. */
export const transientStatus = (status: number): boolean => status === 429 || (status >= 500 && status <= 599);

/**
 * Cloudflare API error codes, as Wrangler prints them (`[code: NNNN]`), that answer a request which may succeed when sent
 * again. R2's error table lists 10001 (internal error), 10043 (service unavailable) and 10058 (too many requests) with
 * "retry"; 10002 is Cloudflare's generic unexpected internal error. 7403 refuses the account, and D1 also answers it
 * for an account and credential that other requests succeed with (cloudflare/workers-sdk#15774), so it is retried inside
 * the same bound and reported as a possible credential fault when it persists. 10000 (authentication error) is not
 * here: it fails at once.
 */
const TRANSIENT_API_CODES = new Set(['7403', '10001', '10002', '10043', '10058']);
/** Cloudflare API error codes that refuse the account or its credential. */
const ACCOUNT_REFUSAL_CODES = new Set(['7403', '10000']);
const API_CODE = /\[code: (\d+)\]/g;
/**
 * What a provider command prints for a failure that may pass when the command runs again: Node's `fetch failed` for a
 * request that lost its connection or its name lookup; undici's own connect, header and body timeouts; a presigned
 * download or an API answer with an HTTP 5xx or 429 (`status code: 503`, `-> 502 Bad Gateway`); an API answer carrying
 * `Retry-After`; and the D1 failures Cloudflare documents as "Retry the operation" (`Debug D1`), including an export
 * the database reset under.
 */
const TRANSIENT_OUTPUT: readonly RegExp[] = [
  /\bfetch failed\b/,
  /\b(?:Connect|Headers|Body) Timeout Error\b/,
  /\bTimeoutError\b/,
  /status code: (?:5\d\d|429)\b/,
  /-> (?:5\d\d|429)\b/,
  /"Retry-After" header/,
  /Network connection lost/,
  /D1 DB reset because its code was updated/,
  /D1 DB storage caused object to be reset/,
  /Cannot resolve D1 DB due to transient issue on remote node/,
  /Replica disconnected from primary/,
  /D1 reset before export completed/,
];
const NETWORK_CODE_IN_TEXT = new RegExp(`\\b(?:${[...TRANSIENT_NETWORK_CODES].join('|')})\\b`);

/** The marker Wrangler opens its failure with (`✘ [ERROR] …`); the notes it prints follow that line. */
const WRANGLER_ERROR = '[ERROR]';

/**
 * The part of a failed provider command's output that states its failure: from Wrangler's `[ERROR]` line through the
 * notes after it, or the whole output when no such line was printed, as a `--json` command's error document is.
 */
const failureText = (output: string): string => {
  const at = output.indexOf(WRANGLER_ERROR);
  return at === -1 ? output : output.slice(at);
};

/** Every Cloudflare API error code a provider command's failure names. */
const apiCodes = (output: string): string[] => [...failureText(output).matchAll(API_CODE)].map((match) => match[1]!);

/** Whether a Cloudflare API error code answers a request that may succeed when sent again (`TRANSIENT_API_CODES`). */
export const transientApiCode = (code: string | number): boolean => TRANSIENT_API_CODES.has(String(code));

/** Whether the failure a provider command printed may pass when the command runs again. */
export function transientProviderOutput(output: string): boolean {
  const failure = failureText(output);
  return TRANSIENT_OUTPUT.some((pattern) => pattern.test(failure)) || NETWORK_CODE_IN_TEXT.test(failure)
    || apiCodes(output).some((code) => TRANSIENT_API_CODES.has(code));
}

/** The failure and each cause it carries, as far down as `CAUSE_DEPTH`. */
function* causes(error: unknown): Generator<unknown> {
  let current = error;
  for (let depth = 0; depth <= CAUSE_DEPTH && typeof current === 'object' && current !== null; depth += 1) {
    yield current;
    current = (current as { cause?: unknown }).cause;
  }
}

/** Whether a failed read may succeed when tried again, judged by the failure or any cause it carries. */
export function transientReadFailure(error: unknown): boolean {
  for (const current of causes(error)) {
    if (current instanceof ObjectReadError) return current.transient;
    if (current instanceof CommandTimedOut) return true;
    if (current instanceof CommandFailed) return transientProviderOutput(commandFailureDetail(current.result));
    const { name, code } = current as { name?: unknown; code?: unknown };
    if (name === 'TimeoutError' || name === 'AbortError') return true;
    if (typeof code === 'string' && (TRANSIENT_NETWORK_CODES.has(code) || TRUNCATED_BODY_CODES.has(code))) return true;
  }
  return false;
}

/** The Cloudflare API code a failed provider command refused the account or its credential with, or null. */
export function refusedAccountCode(error: unknown): string | null {
  for (const current of causes(error)) {
    if (current instanceof CommandFailed) return apiCodes(commandFailureDetail(current.result)).find((code) => ACCOUNT_REFUSAL_CODES.has(code)) ?? null;
    if (current instanceof ObjectReadError && current.apiCodes.length > 0) return current.apiCodes.find((code) => ACCOUNT_REFUSAL_CODES.has(code)) ?? null;
  }
  return null;
}
