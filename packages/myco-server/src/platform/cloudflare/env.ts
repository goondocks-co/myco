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
import type { HarnessContainer } from './harness-container.js';
import { CLOCK_MANUAL, CLOCK_NAME, type DeploymentClock } from './deployment-clock.js';
import { markRecordedLaunch } from '../../core/runs.js';
import { wrappingKeyFromText } from '../wrapping-key.js';

/** The bindings `wrangler.toml` declares, exactly as the Worker receives them. */
export interface CloudflareBindings extends OwnerBindings {
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
  /** The harness container namespace; absent in local dev and the parity harness, where the probe answers a refusal. */
  HARNESS?: DurableObjectNamespace<HarnessContainer>;
  /** The Deployment's clock: one Durable Object holding the next wake. Absent under a configuration that declares none. */
  CLOCK?: DurableObjectNamespace<DeploymentClock>;
  /** `record`: a launch that records the run and starts nothing — the parity harness's runtime, never an operator's. Refused beside a real runtime. */
  HARNESS_LAUNCH_MODE?: string;
  /** `manual` for a Deployment whose clock ticks only when a caller asks; refused beside a runtime that runs real containers. */
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
        label: bindings.HARNESS_LAUNCH_MODE === 'record' ? 'Harness runtime — recording, starts no container' : 'Harness runtime',
        present: !absent('HARNESS') || bindings.HARNESS_LAUNCH_MODE === 'record',
        operatorNames: ['HARNESS'],
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
  if (bindings.HARNESS_LAUNCH_MODE === 'record' && bindings.HARNESS !== undefined) {
    throw new Error('HARNESS_LAUNCH_MODE=record is refused beside a bound HARNESS: a Deployment records launches or runs them, never both');
  }
  if (bindings.CLOCK_MODE === CLOCK_MANUAL && bindings.HARNESS !== undefined) {
    throw new Error('CLOCK_MODE=manual is refused beside a bound HARNESS: a Deployment that starts runtimes keeps its own clock');
  }
  return {
    ...(bindings.HARNESS_LAUNCH_MODE === 'record' && bindings.HARNESS === undefined ? { harnessLaunch: recordingLaunch(bindings) } : {}),
    ...(bindings.MYCO_ORIGIN === undefined || bindings.MYCO_ORIGIN === '' ? {} : { origin: bindings.MYCO_ORIGIN }),
    ...(fleetOf(bindings.MYCO_FLEET) === null ? {} : { fleet: fleetOf(bindings.MYCO_FLEET)! }),
    // The runtime hands every request a deferral, and the work rides it past the
    // answer. A caller that supplies none has asked for the answer alone: nothing
    // starts, so no work of one request can outlive it unobserved.
    ...(bindings.HARNESS === undefined ? {} : {
      harnessLaunch: async (spec: { runId: string; timeoutSeconds: number; envVars: Record<string, string> }): Promise<void> => {
        const namespace = bindings.HARNESS!;
        await namespace.get(namespace.idFromName(spec.runId)).launch(spec);
      },
      harnessProbe: async (runId: string, timeoutSeconds: number): Promise<Record<string, unknown>> => {
        // One Durable Object per run, keyed by the run id; inlined so the shared
        // test graph never loads the containers package's workerd-only imports.
        const namespace = bindings.HARNESS!;
        const stub = namespace.get(namespace.idFromName(runId));
        await stub.beginRun(runId, timeoutSeconds);
        const answered = await stub.fetch('http://harness/probe');
        // A start failure arrives as a text/plain response, and that text is
        // the one line saying why; it must reach the caller, never a parser.
        const text = await answered.text();
        let container: unknown = text;
        try { container = JSON.parse(text); } catch { /* the text stands */ }
        return { held: true, status: answered.status, ok: answered.ok, container };
      },
      harnessEnd: async (runId: string): Promise<void> => {
        const namespace = bindings.HARNESS!;
        await namespace.get(namespace.idFromName(runId)).endRun();
      },
    }),
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
