export type ErrorClass = 'parse' | 'quota' | 'constraint' | 'schema' | 'db' | 'unknown';

/** Raised when the database reports a schema version other than this build's. */
export class SchemaMismatchError extends Error {
  constructor(readonly expected: number, readonly found: string | null) {
    super('schema version mismatch');
    this.name = 'SchemaMismatchError';
  }
}

export function classify(err: unknown): ErrorClass {
  if (err instanceof SyntaxError || err instanceof RangeError) return 'parse';
  if (err instanceof SchemaMismatchError) return 'schema';
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('member_tokens_quota')) return 'quota';
  if (/constraint failed|SQLITE_CONSTRAINT/i.test(message)) return 'constraint';
  if (message.startsWith('D1_ERROR')) return 'db';
  return 'unknown';
}

export type BlobStoreFailure = 'digest' | 'other';

/** The R2 error code for a digest that did not match the received bytes. */
export const R2_BAD_DIGEST_CODE = 10037;

/** How a blob store put failed: the received bytes did not match the declared digest (R2 error code 10037, or the observed message text), or something else. */
export function classifyBlobStore(err: unknown): BlobStoreFailure {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes(`(${R2_BAD_DIGEST_CODE})`) || /checksum you specified did not match/i.test(message)) return 'digest';
  return 'other';
}

/** The fixed reasons telemetry may carry, and the `code` every terminal refusal answers with beside its `reason`; a caller's text never becomes one. */
export const CLASSIFIERS = [
  'refused', 'parse', 'quota', 'body_cap', 'blob_cap', 'content_length', 'media_type', 'digest_mismatch', 'empty_body',
  'blob_absent', 'offset_gap', 'offset_overlap', 'identity_mismatch', 'no_machine_identity', 'blob_length_mismatch',
  'unknown_kind', 'unknown_field', 'id_grammar', 'clock_skew', 'event_id_conflict', 'projection_conflict',
] as const;
export type Classifier = (typeof CLASSIFIERS)[number];

/** The `code` and `reason` of a server-side failure: answered 503 with retry-after and retried, never a refusal. */
export const UNAVAILABLE = 'unavailable';

/** A terminal refusal of the caller's own request: the text the caller reads, and the classifier telemetry reports for it. A refusal is made with its classifier where it is decided; nothing re-derives one from its text. */
export interface Refusal {
  reason: string;
  classifier: Classifier;
}

export const refusal = (reason: string, classifier: Classifier = 'refused'): Refusal => ({ reason, classifier });

export interface TelemetryEvent {
  kind: string;
  reason?: Classifier;
  [key: string]: unknown;
}

/** Emits a structured event. Values are classifiers, server-issued identifiers, or digests of caller identity — never a request body, path, or address. */
export function emit(event: TelemetryEvent): void {
  console.log(JSON.stringify(event));
}
