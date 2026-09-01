/**
 * The platform adapter contract: everything the server core needs from the
 * environment it runs in, named in product terms rather than platform ones.
 *
 * Every supported deployment target is ONE server product behind these interfaces.
 * Shared code (`core/`, `ingest/`, `read/`, `api/`, `auth/`, `pipeline.ts`,
 * `routes.ts`) depends only on this file; `platform/**` and `entry/**` are the only
 * places a hosting product, a filesystem path, or a container primitive may be
 * named. `tests/myco-server/gates.test.ts` enforces that split.
 *
 * Deliberately NOT here: a deployment's binding names. On a target whose `env`
 * object IS its bindings object, each entry point maps its own inputs into a
 * `ServerEnv` rather than the core learning one platform's binding vocabulary.
 */

// ---------------------------------------------------------------------------
// Relational storage
// ---------------------------------------------------------------------------

export interface RunResult {
  results: unknown[];
  meta: { changes: number };
}

/** One parameterised statement. `bind` returns a new statement rather than mutating, so a prepared statement is reusable. */
export interface PreparedStatement {
  bind(...values: unknown[]): PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<RunResult>;
}

/** The relational store. `batch` MUST apply its statements atomically: the ingest path relies on a batch being all-or-nothing for the receipt-and-row commit point. */
export interface RelationalStore {
  prepare(sql: string): PreparedStatement;
  batch(statements: PreparedStatement[]): Promise<RunResult[]>;
}

// ---------------------------------------------------------------------------
// Blob storage
// ---------------------------------------------------------------------------

export interface StoredObject {
  size: number;
}

/** A stored object plus its bytes. */
export interface StoredObjectBody extends StoredObject {
  body: ReadableStream;
}

export interface BlobPutOptions {
  /** Hex digest the store verifies against the streamed bytes, rejecting a mismatch. */
  sha256?: string;
  httpMetadata?: { contentType?: string };
}

/** Content-addressed objects under project-prefixed keys. */
export interface BlobStore {
  head(key: string): Promise<StoredObject | null>;
  get(key: string): Promise<StoredObjectBody | null>;
  put(key: string, value: ReadableStream | null, options?: BlobPutOptions): Promise<StoredObject>;
  delete(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Source identity and rate limiting
// ---------------------------------------------------------------------------

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * The caller's source identity, or null when the platform cannot establish one.
 * A null identity is a server-side failure, not an anonymous caller: the core
 * answers 503 rather than admitting unmetered traffic.
 */
export type SourceIdentity = (request: Request) => string | null;

// ---------------------------------------------------------------------------
// Telemetry and error classification
// ---------------------------------------------------------------------------

/** Broad cause of a failure. It decides retryable vs terminal; `db` is any storage-layer error the adapter recognises as its own. */
export type ErrorClass = 'parse' | 'quota' | 'constraint' | 'schema' | 'db' | 'revoked' | 'unknown';

/**
 * A platform's recogniser for its own storage errors, consulted only after the
 * platform-independent causes are ruled out. Each target's driver reports failures
 * in its own vocabulary, which shared code never learns.
 */
export type ErrorClassifier = (message: string) => ErrorClass | null;

export type BlobStoreFailure = 'digest' | 'other';

/**
 * A platform's recogniser for its own blob-store digest rejection. Each store
 * reports a mismatch in its own vocabulary, which shared code never learns; a
 * message no recogniser claims classifies as a generic failure.
 */
export type BlobFailureClassifier = (message: string) => BlobStoreFailure | null;

// ---------------------------------------------------------------------------
// The environment the core runs against
// ---------------------------------------------------------------------------

/** Sign-in material, supplied at deploy. Absent, no human route answers; who may enter is a membership question. */
export interface OwnerBindings {
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
}

/**
 * The key Deployment-held secrets are sealed under.
 *
 * A HANDLE, not a value, and asynchronous on purpose: on a hosted target the key
 * arrives through a platform binding whose only retrieval is `await …get()`, so a
 * plain string field could not carry it. Per this file's own rule, anything
 * holding a resource handle rides `ServerEnv`.
 *
 * The key never rests in the store it protects. A deployment given no key must
 * fail loudly on first use — `material()` throwing by name — rather than fall back
 * to storing anything in the clear, which silently undoes the separation this
 * interface exists to create.
 */
export interface SecretWrappingKey {
  /** Raw key material for AES-256-GCM. Throws by name when the deployment has none configured. */
  material(): Promise<ArrayBuffer>;
  /**
   * Which key the material is, recorded on every sealed row.
   *
   * Recorded and not yet resolved: nothing maps a version back to key material, so
   * a deployment holds one key and rotating it makes every existing row
   * undecryptable until each credential is re-entered. The column is what a later
   * re-wrap needs to identify rows by; it does not by itself make rotation
   * non-disruptive, and #964 owns making that true.
   */
  version(): Promise<number>;
}

/**
 * A thing the Deployment can do, named the way the product names it.
 *
 * The core reports what the platform declares rather than knowing any
 * platform's binding names itself, which is why no `REQUIRED_BINDINGS` lives in
 * `api/status.ts`.
 *
 * The two targets configure the same capability under different operator names,
 * and a surface reporting those names speaks two vocabularies for one thing and
 * cannot state anything stable across targets. It also runs against this
 * repository's standing rule that surfaces name outcomes, not mechanisms.
 *
 * A capability may be present without an operator name at all: rate limiting is
 * in-process on the self-hosted target and configured per-binding on the hosted
 * one. Reporting it as a missing binding on the target that does not use
 * bindings for it would be false.
 */
export type CapabilityId = 'relational-store' | 'blob-store' | 'rate-limiting';

export interface CapabilityStatus {
  capability: CapabilityId;
  /** Product wording, identical on every target. */
  label: string;
  present: boolean;
  /** What an operator configures on THIS target; empty when nothing is configured for it. */
  operatorNames: readonly string[];
}

export interface PlatformDescriptor {
  /** Short platform name, as the deployment target calls itself. */
  name: string;
  /**
   * What this deployment can do, and which of its own names an operator would
   * fix. One entry per capability, present or not, so a surface can state the
   * same sentence on both targets.
   */
  capabilities(): CapabilityStatus[];
  /** Recognises this platform's storage errors; consulted only after the platform-independent causes are ruled out. */
  classifyError: ErrorClassifier;
  /** Recognises this platform's blob digest rejection. */
  classifyBlobFailure: BlobFailureClassifier;
}

/**
 * Everything the server core needs, assembled by a platform entry point.
 *
 * Which carrier a dependency takes: anything holding a RESOURCE HANDLE rides here,
 * where a handler reaches it through `env`. A per-deployment pure function and the
 * clock ride `ServerDeps` on `createServer`: they are fixed for the process rather
 * than owned by the environment.
 *
 * LIFETIME. An entry point may assemble this per request or once per process, and
 * the core must behave identically either way: no handler may carry state across
 * requests through `env`, and no adapter may assume it is reused. A target whose
 * storage hands out per-request handles is then free to build one each time
 * without the core noticing.
 *
 * Deploy secrets are nested rather than flattened. Flattening puts every secret in
 * lexical scope for all ~27 handlers that take a `ServerEnv`, including read
 * handlers that have no business seeing one, and welds the core's secret shape to
 * one target's binding shape.
 */
export interface ServerEnv {
  platform: PlatformDescriptor;
  db: RelationalStore;
  blobs: BlobStore;
  sourceLimit: RateLimiter;
  tokenLimit: RateLimiter;
  secrets: OwnerBindings;
  /** The key Deployment-held secrets are sealed under; supplied per target, never stored. */
  wrappingKey: SecretWrappingKey;
  /**
   * Prove the harness runtime: start a held runtime for `runId`, exchange one
   * request with it, and answer what it reported. Present only where a target
   * has one; a caller refuses rather than pretending. The `HarnessDispatcher`
   * proposal in `deferred-adapters.ts` subsumes this seam when dispatch lands.
   */
  harnessProbe?: (runId: string, timeoutSeconds: number) => Promise<Record<string, unknown>>;
  /** Launch a held harness runtime for one run, its dispatch handed as environment. Present only where a target has one. */
  harnessLaunch?: (spec: { runId: string; timeoutSeconds: number; envVars: Record<string, string> }) => Promise<void>;
  /** Release the held harness runtime of one run, letting its container stop. Present only where a target has one. */
  harnessEnd?: (runId: string) => Promise<void>;
  /** Starts `work` to finish after the answer has been sent. The work settles its own failures; nothing in the request awaits it. */
  afterResponse(work: () => Promise<void>): void;
  /** The Deployment's outbound HTTP, for a call the core makes on its own behalf. */
  outbound: typeof fetch;
}
