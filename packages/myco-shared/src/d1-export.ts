/**
 * How an answer from Cloudflare's D1 export API reads, for every caller that
 * drives one: the operator's hosted backup (`packages/myco/src/server/cloudflare-d1-export.ts`)
 * and the Deployment's recovery producer (`packages/myco-server/src/platform/cloudflare/recovery-export.ts`).
 *
 * The API is one endpoint: a request with no bookmark starts an export, and one
 * with a bookmark asks after the export it names. An export pauses the
 * database's queries while it runs, so what matters most is telling an export
 * that has ended from one whose state this answer does not settle. An export
 * has ended only where the answer says so for it — `complete` with its
 * download, `error`, or the answer that nothing is exporting at all. Every other answer, a refusal, an HTTP failure, a
 * body that is not the API's envelope, leaves the export's state unknown: it
 * may still be running, and a caller that started another beside it would run
 * two.
 */

/** An HTTP status that answers a request which may be answered when sent again. */
export const transientExportStatus = (status: number): boolean => status === 408 || status === 429 || status >= 500;

/** Cloudflare's code for a request its API refused to authenticate, which it refuses before the request does anything. */
const AUTHENTICATION_ERROR = 10000;

/**
 * The answer Cloudflare gives a bookmark whose export is no longer running: finished, its result expired, or reset.
 * It carries no code of its own (Wrangler reads it as the result's `error` text alone), so its words are what it is
 * known by. It says no export is running, which is what `ended` means to every caller: nothing runs that a new
 * export would run beside.
 */
const NOT_EXPORTING = /^\s*not currently exporting anything\.?\s*$/i;

/** How one answer from the export API reads. */
export type D1ExportReading =
  /** The export is running, followed by `bookmark`. */
  | { kind: 'running'; bookmark: string }
  /** The export completed; its SQL is at `signedUrl`. */
  | { kind: 'complete'; bookmark: string | null; signedUrl: string }
  /**
   * Cloudflare ended the export without a result. `absent` marks the answer that nothing is exporting at all, rather
   * than one that says this export failed: a caller that may start another weighs it against how lately the export
   * answered that it ran.
   */
  | { kind: 'ended'; bookmark: string | null; detail: string; absent?: true }
  /** The API refused the credential before the request did anything: nothing was started, and nothing was asked. */
  | { kind: 'refused-login'; status: number }
  /** An answer that does not settle the export's state; it may still be running. */
  | { kind: 'unknown'; bookmark: string | null; cause: 'http' | 'provider' | 'protocol'; status: number | null; transient: boolean; detail: string };

interface Envelope {
  success?: unknown;
  errors?: unknown;
  result?: { success?: unknown; status?: unknown; at_bookmark?: unknown; error?: unknown; result?: { signed_url?: unknown } | null } | null;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** The provider's own words for a refusal, from the envelope's error list. */
function errorsOf(body: Envelope | null): Array<{ code: unknown; message: unknown }> {
  return Array.isArray(body?.errors) ? body.errors.filter((e): e is { code: unknown; message: unknown } => typeof e === 'object' && e !== null) : [];
}

/**
 * Read one answer: its HTTP `status`, its `body` as parsed JSON (undefined where
 * it was not JSON), and the bookmark the request `asked` after (null for a
 * request that starts an export). A request that did not get an answer at all
 * is the caller's to read: it knows no more than an `unknown` answer does.
 */
export function readD1ExportAnswer(status: number, body: unknown, asked: string | null): D1ExportReading {
  const envelope = typeof body === 'object' && body !== null ? body as Envelope : null;
  const errors = errorsOf(envelope);
  const said = errors.map((e) => text(e.message)).filter((m): m is string => m !== undefined).join('; ');
  const resultError = text(envelope?.result?.error);
  const notExporting = [resultError, ...errors.map((e) => text(e.message))].find((m) => m !== undefined && NOT_EXPORTING.test(m));
  if (notExporting !== undefined && status !== 401) return { kind: 'ended', bookmark: asked, detail: notExporting, absent: true };
  if (status < 200 || status > 299) {
    if (status === 401 || (status === 403 && errors.some((e) => e.code === AUTHENTICATION_ERROR))) return { kind: 'refused-login', status };
    return { kind: 'unknown', bookmark: asked, cause: 'http', status, transient: transientExportStatus(status), detail: `HTTP ${status}${said === '' ? '' : `: ${said}`}` };
  }
  const held = envelope?.result;
  if (envelope?.success !== true || held === undefined || held === null) {
    return { kind: 'unknown', bookmark: asked, cause: 'provider', status, transient: false, detail: said === '' ? 'the answer was not the API\'s envelope' : said };
  }
  const at = text(held.at_bookmark) ?? asked;
  const heldStatus = text(held.status);
  const heldError = text(held.error);
  // A refusal inside a success envelope: the answer is 200 and the provider's own result did not serve the request.
  if (held.success === false || (heldStatus === undefined && heldError !== undefined)) {
    return { kind: 'unknown', bookmark: asked, cause: 'provider', status, transient: false, detail: heldError ?? (said === '' ? 'the export was not served' : said) };
  }
  if (heldStatus === 'error') return { kind: 'ended', bookmark: at, detail: heldError ?? 'the export failed' };
  if (heldStatus === 'complete') {
    const signedUrl = text(held.result?.signed_url);
    if (signedUrl === undefined) return { kind: 'unknown', bookmark: at, cause: 'protocol', status: null, transient: false, detail: 'the export was reported complete with no download' };
    return { kind: 'complete', bookmark: at, signedUrl };
  }
  if (at === null) return { kind: 'unknown', bookmark: null, cause: 'protocol', status: null, transient: false, detail: 'the export was reported running with no bookmark to follow it by' };
  return { kind: 'running', bookmark: at };
}
