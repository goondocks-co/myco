import type { BlobFailureClassifier, BlobStoreFailure, ErrorClass, ErrorClassifier } from './core/adapters.js';

export type { BlobStoreFailure, ErrorClass };

/** Raised when the database reports a schema version other than this build's. */
export class SchemaMismatchError extends Error {
  constructor(readonly expected: number, readonly found: string | null) {
    super('schema version mismatch');
    this.name = 'SchemaMismatchError';
  }
}

/** Raised when a storage adapter breaks its contract, such as a batch answering with a different number of results than the statements handed to it. It classifies as a storage failure on every target. */
export class StorageContractError extends Error {
  constructor(detail: string) {
    super(`storage contract violated: ${detail}`);
    this.name = 'StorageContractError';
  }
}

/** Raised when the presented token is found revoked between its authentication and a write that requires it live. */
export class TokenRevokedError extends Error {
  constructor(readonly tokenId: string) {
    super('token revoked');
    this.name = 'TokenRevokedError';
  }
}

/**
 * The broad cause of a failure. Platform-independent causes are decided here;
 * a storage error only this platform can recognise is deferred to its own
 * classifier, so no hosting product's error vocabulary appears in shared code.
 */
export function classify(err: unknown, platform?: ErrorClassifier): ErrorClass {
  if (err instanceof SyntaxError || err instanceof RangeError) return 'parse';
  if (err instanceof SchemaMismatchError) return 'schema';
  if (err instanceof TokenRevokedError) return 'revoked';
  if (err instanceof StorageContractError) return 'db';
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('member_tokens_quota')) return 'quota';
  if (/constraint failed|SQLITE_CONSTRAINT/i.test(message)) return 'constraint';
  return platform?.(message) ?? 'unknown';
}

/**
 * How a blob store put failed: the received bytes did not match the declared
 * digest, or something else. Every store reports a mismatch in its own wording,
 * so recognising one is entirely the platform's job — shared code matches no
 * message text of its own, and an unrecognised failure is `other`.
 */
export function classifyBlobStore(err: unknown, platform?: BlobFailureClassifier): BlobStoreFailure {
  const message = err instanceof Error ? err.message : String(err);
  return platform?.(message) ?? 'other';
}

/** The fixed reasons telemetry may carry, and the `code` every terminal refusal answers with beside its `reason`; a caller's text never becomes one. */
export const CLASSIFIERS = [
  'refused', 'parse', 'quota', 'body_cap', 'blob_cap', 'content_length', 'media_type', 'digest_mismatch', 'empty_body',
  'blob_absent', 'no_project', 'offset_gap', 'offset_overlap', 'identity_mismatch', 'no_machine_identity', 'blob_length_mismatch',
  'unknown_kind', 'unknown_field', 'id_grammar', 'clock_skew', 'event_id_conflict', 'projection_conflict',
  'refresh_too_early', 'lineage_expired',
  'enrollment_unknown', 'enrollment_used', 'enrollment_expired', 'enrollment_revoked', 'identity_claimed',
  'project_archived',
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
