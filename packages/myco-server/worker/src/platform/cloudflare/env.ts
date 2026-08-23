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

/** The bindings `wrangler.toml` declares, exactly as the Worker receives them. */
export interface CloudflareBindings extends OwnerBindings {
  MYCO_DB: RelationalStore;
  BUCKET: BlobStore;
  SOURCE_LIMIT: RateLimiter;
  TOKEN_LIMIT: RateLimiter;
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
  return {
    name: 'cloudflare',
    requiredBindings: REQUIRED_BINDINGS,
    missingBindings: () =>
      REQUIRED_BINDINGS.filter((name) => (bindings as unknown as Record<string, unknown>)[name] === undefined),
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
export function serverEnvFromBindings(bindings: CloudflareBindings): ServerEnv {
  return {
    platform: cloudflarePlatform(bindings),
    db: bindings.MYCO_DB,
    blobs: bindings.BUCKET,
    sourceLimit: bindings.SOURCE_LIMIT,
    tokenLimit: bindings.TOKEN_LIMIT,
    secrets: {
      OWNER_GITHUB_ID: bindings.OWNER_GITHUB_ID,
      GITHUB_CLIENT_ID: bindings.GITHUB_CLIENT_ID,
      GITHUB_CLIENT_SECRET: bindings.GITHUB_CLIENT_SECRET,
      SESSION_SECRET: bindings.SESSION_SECRET,
    },
  };
}

export { cloudflareSourceOf };
