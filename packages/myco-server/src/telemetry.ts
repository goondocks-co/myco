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
  if (/constraint failed|SQLITE_CONSTRAINT/i.test(message)) return 'constraint';
  return platform?.(message) ?? 'unknown';
}

const IDENTIFIER = '[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)?';
const CONSTRAINT_FAILURE = new RegExp(`\\b(UNIQUE|NOT NULL|CHECK|FOREIGN KEY|PRIMARY KEY) constraint failed(?:: (${IDENTIFIER}(?:, ${IDENTIFIER})*)(?=$|:))?`);
const CHECK_FAILURE = /\bCHECK constraint failed: ([^:]{1,200})(?=$|:)/;

/**
 * The failed constraint's kind and what the message names of the schema: 'UNIQUE: t.a, t.b',
 * 'FOREIGN KEY', or for a CHECK its expression, 'CHECK: role IN (...)'. A CHECK expression is the
 * schema's own DDL text, never row data. Nothing past the message's next colon is kept, a CHECK
 * expression over 200 characters is dropped, and any other list followed by more text is dropped.
 */
export function constraintDetail(err: unknown): string | undefined {
  const message = err instanceof Error ? err.message : String(err);
  const check = CHECK_FAILURE.exec(message);
  if (check !== null) return `CHECK: ${check[1]!.trim()}`;
  const match = CONSTRAINT_FAILURE.exec(message);
  if (match === null) return undefined;
  return match[2] !== undefined && match[2].length <= 200 ? `${match[1]}: ${match[2]}` : match[1];
}

const SAFE_ERROR_NAMES = new Set(['Error', 'TypeError', 'SyntaxError', 'RangeError', 'AbortError', 'TimeoutError', 'DataCloneError', 'Stalled']);

/** Error telemetry carries only an allowlisted name and a classifier, never exception text. */
export function failureTelemetry(error: unknown, platform?: ErrorClassifier): { error_class: ErrorClass; error_reason: string } {
  const category = classify(error, platform);
  const name = error instanceof Error && SAFE_ERROR_NAMES.has(error.name) ? error.name : 'Unknown';
  return { error_class: category, error_reason: `${name}:${category}` };
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

/** The fixed reasons telemetry may carry, and the `code` every terminal refusal answers with beside its `reason`; a caller's text never becomes one. None refuses capture for volume (#1416). */
export const CLASSIFIERS = [
  'refused', 'parse', 'body_cap', 'blob_cap', 'content_length', 'media_type', 'digest_mismatch', 'empty_body',
  'blob_absent', 'no_project', 'offset_gap', 'offset_overlap', 'identity_mismatch', 'no_machine_identity', 'blob_length_mismatch',
  'unknown_kind', 'unknown_field', 'id_grammar', 'clock_skew', 'event_id_conflict', 'projection_conflict',
  'refresh_too_early', 'lineage_expired', 'stale',
  // #1420 — a credential minted not to rotate asked to
  'non_rotating',
  // #1448 — a member credential asked to link GitHub once the Deployment has a linked admin
  'link_requires_admin',
  'enrollment_unknown', 'enrollment_used', 'enrollment_expired', 'enrollment_revoked', 'identity_claimed',
  // #1158 join UX
  'enrollment_no_project',
  'project_archived',
  'run_scope', 'no_run', 'project_mismatch',
  // #1147 — transcript-first ingest
  'session_tombstoned', 'transcript_replaced', 'record_identity_scheme_unsupported',
  // #1151 — worker mode
  'not_admin',
  // #1148 — bounded import
  'import_disabled',
  // a field outside its declared shape or bound
  'invalid_field',
  // A run field outside the retained channel.
  'field_retired',
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

/** Emits a structured event. Values are classifiers, server-issued identifiers, the ids a member named its Project and sessions by, or digests of caller identity — never a request body, path, or address. */
export function emit(event: TelemetryEvent): void {
  console.log(JSON.stringify(event));
}
