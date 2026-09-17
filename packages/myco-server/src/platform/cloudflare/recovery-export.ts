/**
 * The Cloudflare side of the recovery producer: the provider's export API, the signed download, and the staging
 * store. The account credential reaches exactly one origin, the provider's own API, and is carried by nothing else:
 * a signed download URL is fetched without it, and no caller can name the account, the database or the host, which
 * come from the Deployment's own bindings.
 */
import type {
  AttemptPart, ExportAnswer, PortFailure, ProducerPorts, RangeAnswer,
} from '../../core/recovery-producer.js';
import { PRODUCER_LIMITS, stagedSqlKey, TransientProducerFailure } from '../../core/recovery-producer.js';
import { readHostedRecoveryConfiguration, STAGING_OBJECTS_DIRECTORY, stagingPath, type HostedRecoveryConfiguration } from '../../core/recovery-staging.js';
import { discardStoredBody, streamStoredObject } from '../../core/stored-object.js';
import { r2RefusedDigest } from './r2-digest.js';

/** The one origin an account credential is sent to. */
export const CLOUDFLARE_API_ORIGIN = 'https://api.cloudflare.com';

/** The name this target writes into a staging manifest; the reader's schema accepts it. */
export const STAGING_TARGET = 'cloudflare';

/** The provider's floor for every multipart part but the last; a smaller one is refused at completion. */
export const R2_MINIMUM_PART_BYTES = 5 * 1024 * 1024;

/** The bindings that name what a hosted recovery records about this Deployment, all rendered from its deployment record. */
export interface RecoveryConfigurationBindings {
  MYCO_RECOVERY_CONFIGURATION?: string;
  MYCO_RECOVERY_ACCOUNT_ID?: string;
  MYCO_RECOVERY_DATABASE_ID?: string;
  MYCO_FLEET?: string;
  MYCO_ORIGIN?: string;
}

/**
 * This Deployment's recorded configuration, from its own bindings: the rendered configuration, read by the one
 * recovery configuration reader and held to every setting the runtime binds on its own. Those are the account and
 * database the export names, the fleet dispatch counts against (`MYCO_FLEET`), and the origin runs call back to
 * (`MYCO_ORIGIN`, the recorded URL's origin). All are rendered from one deployment record, so a configuration that
 * disagrees with any of them is stale and records nothing.
 */
export function boundRecoveryConfiguration(bindings: RecoveryConfigurationBindings): { ok: true; configuration: HostedRecoveryConfiguration } | { ok: false; reason: string } {
  const rendered = bindings.MYCO_RECOVERY_CONFIGURATION;
  if (rendered === undefined || rendered === '') {
    return { ok: false, reason: 'this Deployment carries no recovery configuration; update it so its deploy config renders one' };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(rendered); } catch { return { ok: false, reason: 'this Deployment\'s recovery configuration is not readable; update it so its deploy config renders one' }; }
  const read = readHostedRecoveryConfiguration(parsed);
  if (!read.ok) return read;
  if (read.configuration.accountId !== bindings.MYCO_RECOVERY_ACCOUNT_ID || read.configuration.databaseId !== bindings.MYCO_RECOVERY_DATABASE_ID) {
    return { ok: false, reason: 'this Deployment\'s recovery configuration names another account or database than its export target' };
  }
  const recordedFleet = read.configuration.fleet === undefined ? undefined : String(read.configuration.fleet);
  if (recordedFleet !== bindings.MYCO_FLEET) {
    return { ok: false, reason: 'this Deployment\'s recovery configuration names another fleet than the one it runs with' };
  }
  let recordedOrigin: string | undefined;
  try { recordedOrigin = read.configuration.url === undefined ? undefined : new URL(read.configuration.url).origin; } catch {
    return { ok: false, reason: 'this Deployment\'s recovery configuration names an address that is not a URL' };
  }
  if (recordedOrigin !== bindings.MYCO_ORIGIN) {
    return { ok: false, reason: 'this Deployment\'s recovery configuration names another address than the one it runs at' };
  }
  return read;
}

export interface ExportTarget {
  accountId: string;
  databaseId: string;
  tables: readonly string[];
  /** The credential, held only here and sent only to `CLOUDFLARE_API_ORIGIN`. */
  token: string;
  /** Test-only: a stand-in for the provider API, refused outside a test runtime. */
  apiOrigin?: string;
}

export interface StagingBucket {
  put(key: string, body: ReadableStream<Uint8Array> | Uint8Array, options?: { httpMetadata?: { contentType?: string }; sha256?: string }): Promise<{ size: number } | null>;
  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>;
  head(key: string): Promise<{ size: number } | null>;
  createMultipartUpload(key: string): Promise<{ uploadId: string }>;
  resumeMultipartUpload(key: string, uploadId: string): {
    uploadPart(part: number, body: ReadableStream<Uint8Array> | Uint8Array): Promise<{ etag: string }>;
    complete(parts: Array<{ partNumber: number; etag: string }>): Promise<{ size: number }>;
    abort(): Promise<void>;
  };
}

/**
 * Only a recording runtime may name an export origin of its own, and only over loopback. An operator's Deployment
 * records no runtime of that kind, so no configuration, request or caller can send the account credential anywhere
 * but the provider.
 */
export function exportApiOrigin(target: ExportTarget, testRoutesEnabled: boolean): string {
  if (target.apiOrigin === undefined || target.apiOrigin === '') return CLOUDFLARE_API_ORIGIN;
  const origin = new URL(target.apiOrigin);
  const loopback = origin.hostname === '127.0.0.1' || origin.hostname === 'localhost' || origin.hostname === '[::1]';
  if (!testRoutesEnabled || !loopback) throw new Error('a recovery export origin other than the provider API is refused');
  return origin.origin;
}

const digestOf = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
};

/** Whether a provider failure is worth another attempt rather than ending this one. */
export const transientStatus = (status: number): boolean => status === 408 || status === 429 || status >= 500;

/**
 * A failure as facts alone. The producer is told what kind of failure happened and with what status, and never a
 * message: a provider's text, an exception and a signed URL all reach this boundary and none of them may pass it.
 */
const failure = (cause: PortFailure['cause'], status: number | null, transient: boolean): PortFailure => ({ cause, status, transient });

/** A request or an answer that did not arrive whole is worth another attempt. */
const TRANSPORT = failure('transport', null, true);

/**
 * How the provider and its stores name a failure that is worth another attempt: a request that did not land, a body
 * that stopped mid-answer, a store answering its own overload. Their wording is matched here and nowhere else, and a
 * failure this does not recognise ends the attempt rather than being retried without end.
 */
const WORTH_ANOTHER = /\b(408|429|500|502|503|504)\b|internal error|service unavailable|too many requests|slow down|timeout|timed out|connection|reset|disconnect|aborted|network|stream/i;

/** True for a failure reading an answer that had already begun; a malformed body is the provider's answer, not a fault. */
const interrupted = (error: unknown): boolean => !(error instanceof SyntaxError);

/**
 * Runs one call to the staging store, spending a transient attempt on a failure worth another rather than ending the
 * attempt. A refusal this does not recognise, and every deterministic refusal of its own, still ends it.
 */
async function stored<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (error instanceof TransientProducerFailure) throw error;
    if (WORTH_ANOTHER.test(detail)) throw new TransientProducerFailure(failure('storage', null, true));
    throw error;
  }
}

/**
 * Where a staged object's bytes are read from: the Deployment's own object store, which a recovery copies out of and
 * never writes to.
 */
export interface SourceObjects {
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>;
}

/** The producer's ports over one Deployment's own bindings. */
export function cloudflareProducerPorts(
  target: ExportTarget, bucket: StagingBucket, source: SourceObjects,
  options: { testRoutes?: boolean; now?: () => number; requestMs?: number } = {},
): ProducerPorts {
  const origin = exportApiOrigin(target, options.testRoutes === true);
  const endpoint = `${origin}/client/v4/accounts/${target.accountId}/d1/database/${target.databaseId}/export`;
  const now = options.now ?? (() => Date.now());
  /** Every provider call carries this deadline, so a request that never answers ends as a transient failure. */
  const requestMs = options.requestMs ?? PRODUCER_LIMITS.requestMs;
  const deadline = (): AbortSignal => AbortSignal.timeout(requestMs);
  return {
    now,
    async pollExport(bookmark) {
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          signal: deadline(),
          headers: { authorization: `Bearer ${target.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            output_format: 'polling',
            dump_options: { tables: [...target.tables] },
            ...(bookmark === null ? {} : { current_bookmark: bookmark }),
          }),
        });
      } catch {
        return { status: 'error', bookmark, failure: TRANSPORT };
      }
      type ExportBody = {
        success?: boolean; errors?: unknown[];
        result?: { success?: boolean; status?: string; at_bookmark?: string; error?: string; result?: { signed_url?: string } };
      };
      let body: ExportBody | null;
      try {
        body = await response.json() as ExportBody;
      } catch (error) {
        // An answer that stopped mid-body never arrived; a body that is not JSON is an answer of the provider's own.
        if (interrupted(error)) return { status: 'error', bookmark, failure: TRANSPORT };
        body = null;
      }
      if (!response.ok) return { status: 'error', bookmark, failure: failure('http', response.status, transientStatus(response.status)) };
      if (body?.success !== true || body.result === undefined) {
        return { status: 'error', bookmark, failure: failure('provider', response.status, false) };
      }
      const held = body.result;
      const at = held.at_bookmark ?? bookmark;
      // A refusal inside a success envelope: the answer is 200 and the provider's own result did not serve the
      // request. Its wording is never read or carried.
      if (held.success === false || (held.status === undefined && held.error !== undefined)) {
        return { status: 'error', bookmark, failure: failure('provider', response.status, false) };
      }
      if (held.status === 'error') return { status: 'error', bookmark: at, failure: failure('provider', null, false) };
      if (held.status === 'complete') {
        const signed = held.result?.signed_url;
        if (signed === undefined || at === null) return { status: 'error', bookmark: at, failure: failure('protocol', null, false) };
        return { status: 'complete', bookmark: at, signedUrl: signed };
      }
      if (at === null) return { status: 'error', bookmark: null, failure: failure('protocol', null, false) };
      return { status: 'running', bookmark: at };
    },
    async readRange(url, offset, length) {
      // The signed URL is a capability of its own: it is fetched with no Authorization header.
      let response: Response;
      try {
        response = await fetch(url, { signal: deadline(), headers: { range: `bytes=${offset}-${offset + length - 1}` } });
      } catch {
        return { status: 'error', failure: TRANSPORT };
      }
      if ([401, 403, 404, 410].includes(response.status)) return { status: 'gone' };
      if (response.status === 200) return { status: 'unranged' };
      if (response.status !== 206) {
        return { status: 'error', failure: failure('http', response.status, transientStatus(response.status)) };
      }
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
      if (range === null || Number(range[1]) !== offset) {
        return { status: 'error', failure: failure('protocol', response.status, false) };
      }
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch {
        // The headers arrived and the body did not, leaving the range unread, so the attempt reads it again.
        return { status: 'error', failure: TRANSPORT };
      }
      return {
        status: 'part',
        bytes,
        length: Number(range[2]) - offset + 1,
        total: Number(range[3]),
        etag: response.headers.get('etag'),
      };
    },
    async beginUpload(prefix) {
      return stored(async () => (await bucket.createMultipartUpload(stagedSqlKey(prefix))).uploadId);
    },
    async writePart(prefix, uploadId, part, body, length) {
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
      // A part that is not the length the range answered is this attempt's own failure, never a retry.
      if (bytes.byteLength !== length) throw new Error('a staged part is not the length its range answered');
      const written = await stored(() => bucket.resumeMultipartUpload(stagedSqlKey(prefix), uploadId).uploadPart(part, bytes));
      return { sha256: await digestOf(bytes), etag: written.etag };
    },
    async completeUpload(prefix, uploadId, parts: AttemptPart[]) {
      try {
        const object = await bucket.resumeMultipartUpload(stagedSqlKey(prefix), uploadId)
          .complete(parts.map((part) => ({ partNumber: part.part, etag: part.etag })));
        return { bytes: object.size };
      } catch (error) {
        // An upload the provider no longer holds is the interrupted-completion case, and the caller reconciles the
        // stored bytes against the recorded digests. Any other refusal is classified like every other store call.
        const detail = error instanceof Error ? error.message : String(error);
        if (/does not exist|NoSuchUpload|10024/i.test(detail)) return null;
        return stored(() => Promise.reject(error));
      }
    },
    async abortUpload(prefix, uploadId) {
      await stored(() => bucket.resumeMultipartUpload(stagedSqlKey(prefix), uploadId).abort());
    },
    async readStoredRange(prefix, offset, length) {
      return stored(async () => {
        const object = await bucket.get(stagedSqlKey(prefix), { range: { offset, length } });
        if (object === null) return null;
        return { sha256: await digestOf(new Uint8Array(await new Response(object.body).arrayBuffer())) };
      });
    },
    async storedSize(prefix) {
      return stored(async () => (await bucket.head(stagedSqlKey(prefix)))?.size ?? null);
    },
    async writeStagingFile(prefix, name, body, _signal) {
      await stored(() => bucket.put(`${prefix.replace(/\/$/, '')}/${name}`, new TextEncoder().encode(body), { httpMetadata: { contentType: 'application/json' } }));
    },
    async readStagingFile(prefix, name, signal) {
      return stored(async () => {
        const object = await bucket.get(`${prefix.replace(/\/$/, '')}/${name}`);
        if (object === null) return null;
        // A read the caller has stopped waiting for is released unread.
        if (signal?.aborted === true) {
          await discardStoredBody(object.body);
          return null;
        }
        return await new Response(object.body).text();
      });
    },
    async readStagedPart(prefix, offset, bytes, signal) {
      return stored(async () => {
        // A range read cannot be cancelled here, so a read the caller has stopped waiting for is released unread.
        const object = await bucket.get(stagedSqlKey(prefix), { range: { offset, length: bytes } });
        if (object === null) return null;
        if (signal.aborted) {
          await discardStoredBody(object.body);
          return null;
        }
        return new Uint8Array(await new Response(object.body).arrayBuffer());
      });
    },
    digest: (bytes) => digestOf(bytes),
    async copyObject(prefix, { key, source: sourceKey }, expected, signal) {
      return stored(async () => {
        const object = await source.get(sourceKey);
        if (object === null) return { status: 'missing' as const };
        // A source whose size is not the size its row records is refused before a byte of it is written.
        if (signal.aborted || object.size !== expected.bytes) {
          await discardStoredBody(object.body);
          if (signal.aborted) return { status: 'error' as const, failure: failure('transport', null, true) };
          return { status: 'error' as const, failure: failure('provider', null, false) };
        }
        const metered = streamStoredObject(object.body, expected.bytes, signal, expected.sha256 === null);
        // R2 takes a stream only of a declared length, so on the Worker runtime the copy is declared at its size.
        const body = typeof FixedLengthStream === 'function' ? metered.stream.pipeThrough(new FixedLengthStream(expected.bytes)) : metered.stream;
        try {
          const options = expected.sha256 === null
            ? { httpMetadata: { contentType: 'application/octet-stream' } }
            // The store holds the copy to the digest the source recorded, so a changed byte is refused at the write.
            : { httpMetadata: { contentType: 'application/octet-stream' }, sha256: expected.sha256 };
          const written = await bucket.put(stagingPath(prefix, STAGING_OBJECTS_DIRECTORY, key), body, options);
          const held = metered.result();
          if (held.overrun || !held.finished || held.bytes !== expected.bytes || written === null || written.size !== expected.bytes) {
            return { status: 'error' as const, failure: failure('provider', null, false) };
          }
          return { status: 'copied' as const, sha256: expected.sha256 ?? held.sha256!, bytes: held.bytes };
        } catch (error) {
          if (metered.result().overrun || r2RefusedDigest(error)) return { status: 'error' as const, failure: failure('provider', null, false) };
          throw error;
        } finally {
          await metered.release();
        }
      });
    },
  };
}
