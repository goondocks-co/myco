/**
 * The Cloudflare adapter: bindings in, `ServerEnv` out.
 *
 * This file and its siblings are the ONLY place in the server where a Cloudflare
 * product, header, or error string may be named. The bindings keep the names
 * `wrangler.toml` declares — renaming them would force a binding change on a live
 * deployment for no architectural gain — and the mapping to product vocabulary
 * happens here.
 */
import type {
  BlobFailureClassifier, BlobStore, ErrorClassifier, OwnerBindings,
  PlatformDescriptor, RateLimiter, RelationalStore, ServerEnv,
} from '../../core/adapters.js';
import { cloudflareSourceOf } from './source.js';
import { CLOCK_MANUAL, CLOCK_NAME, type DeploymentClock } from './deployment-clock.js';
import { markRecordedLaunch } from '../../core/runs.js';
import { wrappingKeyFromText } from '../wrapping-key.js';
import { cloudflareVectorStore, type VectorIndex } from './vectors.js';
import { cloudflareEmbeddingProvider, type EmbeddingBinding } from './embedding.js';

/** The bindings `wrangler.toml` declares, exactly as the Worker receives them. */
export interface CloudflareBindings extends OwnerBindings {
  VECTORIZE?: VectorIndex;
  AI?: EmbeddingBinding;
  MYCO_DB: RelationalStore;
  BUCKET: BlobStore;
  SOURCE_LIMIT: RateLimiter;
  TOKEN_LIMIT: RateLimiter;
  /**
   * The Secrets Store binding holding the secret wrapping key.
   *
   * Not in `REQUIRED_BINDINGS`: a deployment that never stores a Deployment secret
   * serves every other route without one, and the failure should land on the first
   * attempt to seal or open rather than refusing unrelated traffic at boot.
   */
  SECRET_WRAP_KEY?: { get(): Promise<string> };
  /** The Deployment's clock: one Durable Object holding the next wake. Absent under a configuration that declares none. */
  CLOCK?: DurableObjectNamespace<DeploymentClock>;
  /** `record`: a launch that records the run and starts nothing — the parity harness's runtime, never an operator's. */
  HARNESS_LAUNCH_MODE?: string;
  /** `manual` for a Deployment whose clock ticks only when a caller asks; accepted only beside a recording runtime. */
  CLOCK_MODE?: string;
  /** The origin this Deployment is reached at, rendered into the deploy config from the deployment record. */
  MYCO_ORIGIN?: string;
  /** The container fleet's size, rendered into the deploy config beside `max_instances` from the same record. */
  MYCO_FLEET?: string;
}

// Compile-time proof that the platform's own types satisfy the adapter interfaces.
type AssertAssignable<A, B extends A> = B;
export type _RelationalSatisfies = AssertAssignable<RelationalStore, D1Database>;
export type _RateLimitSatisfies = AssertAssignable<RateLimiter, RateLimit>;
export type _BlobStoreSatisfies = AssertAssignable<BlobStore, R2Bucket>;
export type _VectorStoreSatisfies = AssertAssignable<VectorIndex, VectorizeIndex>;
export type _EmbeddingSatisfies = AssertAssignable<EmbeddingBinding, Ai>;

/** Every binding the Worker requires to serve a request. */
export const REQUIRED_BINDINGS = ['MYCO_DB', 'BUCKET', 'SOURCE_LIMIT', 'TOKEN_LIMIT'] as const;

/** D1 reports its own failures with a `D1_ERROR` prefix; nothing else does. */
export const classifyD1Error: ErrorClassifier = (message) => (message.startsWith('D1_ERROR') ? 'db' : null);

/** The R2 error code for a digest that did not match the received bytes. */
export const R2_BAD_DIGEST_CODE = 10037;

/** R2 reports a digest rejection by its error code, and by its own wording when a code is absent. */
export const classifyR2BlobFailure: BlobFailureClassifier = (message) =>
  message.includes(`(${R2_BAD_DIGEST_CODE})`) || /checksum you specified did not match/i.test(message) ? 'digest' : null;

export function cloudflarePlatform(bindings: CloudflareBindings): PlatformDescriptor {
  const absent = (name: string): boolean =>
    (bindings as unknown as Record<string, unknown>)[name] === undefined;

  return {
    name: 'cloudflare',
    capabilities: () => [
      { capability: 'relational-store', label: 'Project storage', present: !absent('MYCO_DB'), operatorNames: ['MYCO_DB'] },
      { capability: 'blob-store', label: 'Blob storage', present: !absent('BUCKET'), operatorNames: ['BUCKET'] },
      {
        capability: 'rate-limiting',
        label: 'Request rate limiting',
        // Both limiters, one capability: a deployment holding one of them
        // cannot meter what the other covers, so it is not partly capable.
        present: !absent('SOURCE_LIMIT') && !absent('TOKEN_LIMIT'),
        operatorNames: ['SOURCE_LIMIT', 'TOKEN_LIMIT'],
      },
      {
        capability: 'harness-runtime',
        label: bindings.HARNESS_LAUNCH_MODE === 'record' ? 'Harness runtime — recording, starts nothing' : 'Harness runtime',
        // A worker attaches with a member credential, so there is no binding an
        // operator sets and none that can be reported missing.
        present: bindings.HARNESS_LAUNCH_MODE === 'record',
        operatorNames: [],
      },
    ],
    classifyError: classifyD1Error,
    classifyBlobFailure: classifyR2BlobFailure,
  };
}

/**
 * Maps the Worker's bindings onto the product vocabulary the core speaks.
 *
 * Secrets are picked out by name rather than spread: only the four the owner
 * surface needs reach the core, so a binding added to this deployment for any
 * other purpose never lands on the object every handler receives.
 */
/** What the runtime hands a request for work that outlives its answer. */
export interface DeferredWork {
  waitUntil(promise: Promise<unknown>): void;
}

/** The recording launch: the run row is stamped as launched by a recorder and nothing starts. A test double for the parity Worker, never a Deployment's runtime. */
function recordingLaunch(bindings: CloudflareBindings): ServerEnv['harnessLaunch'] {
  return async (spec) => { await markRecordedLaunch(bindings.MYCO_DB, spec.runId); };
}

/** The fleet as the config states it, or null for an absent or malformed value: a bound that cannot be read is no bound. */
function fleetOf(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

export function serverEnvFromBindings(bindings: CloudflareBindings, deferred?: DeferredWork): ServerEnv {
  // A clock that ticks only when asked runs no scheduled work of its own, which
  // is serviceable for a recording deployment and silent breakage for any other.
  if (bindings.CLOCK_MODE === CLOCK_MANUAL && bindings.HARNESS_LAUNCH_MODE !== 'record') {
    throw new Error('CLOCK_MODE=manual is accepted only beside HARNESS_LAUNCH_MODE=record: a Deployment that serves keeps its own clock');
  }
  return {
    ...(bindings.VECTORIZE === undefined ? {} : { vectors: cloudflareVectorStore(bindings.VECTORIZE) }),
    embeddingProvider: async () => bindings.AI === undefined ? null : cloudflareEmbeddingProvider(bindings.AI),
    ...(bindings.HARNESS_LAUNCH_MODE === 'record' ? { harnessLaunch: recordingLaunch(bindings) } : {}),
    ...(bindings.MYCO_ORIGIN === undefined || bindings.MYCO_ORIGIN === '' ? {} : { origin: bindings.MYCO_ORIGIN }),
    ...(fleetOf(bindings.MYCO_FLEET) === null ? {} : { fleet: fleetOf(bindings.MYCO_FLEET)! }),
    // The runtime hands every request a deferral, and the work rides it past the
    // answer. A caller that supplies none has asked for the answer alone: nothing
    // starts, so no work of one request can outlive it unobserved.
    ...(bindings.CLOCK === undefined ? {} : {
      wake: async (): Promise<void> => {
        const clock = bindings.CLOCK!;
        await clock.get(clock.idFromName(CLOCK_NAME)).ensure();
      },
    }),
    afterResponse: deferred === undefined ? () => {} : (work) => deferred.waitUntil(work()),
    outbound: (input, init) => fetch(input, init),
    platform: cloudflarePlatform(bindings),
    db: bindings.MYCO_DB,
    blobs: bindings.BUCKET,
    sourceLimit: bindings.SOURCE_LIMIT,
    tokenLimit: bindings.TOKEN_LIMIT,
    // A Secrets Store binding rather than a plain secret: its only retrieval is
    // `await …get()`, which is why the core takes a handle and not a string.
    wrappingKey: wrappingKeyFromText(
      async () => bindings.SECRET_WRAP_KEY === undefined ? undefined : bindings.SECRET_WRAP_KEY.get(),
      'SECRET_WRAP_KEY',
    ),
    secrets: {
      GITHUB_CLIENT_ID: bindings.GITHUB_CLIENT_ID,
      GITHUB_CLIENT_SECRET: bindings.GITHUB_CLIENT_SECRET,
      SESSION_SECRET: bindings.SESSION_SECRET,
    },
  };
}

export { cloudflareSourceOf };
