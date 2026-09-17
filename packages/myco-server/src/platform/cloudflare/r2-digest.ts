/**
 * How R2 says it refused bytes for their digest. Both the Deployment's own object store and the recovery staging
 * store hand it the digest a write must match, so both recognise a refusal by this one rule.
 */
import type { BlobFailureClassifier } from '../../core/adapters.js';

/** The R2 error code for a digest that did not match the received bytes. */
export const R2_BAD_DIGEST_CODE = 10037;

/** R2 reports a digest rejection by its error code, and by its own wording when a code is absent. */
export const classifyR2BlobFailure: BlobFailureClassifier = (message) =>
  message.includes(`(${R2_BAD_DIGEST_CODE})`) || /checksum you specified did not match/i.test(message) ? 'digest' : null;

/** Whether a thrown store failure is that refusal. */
export const r2RefusedDigest = (error: unknown): boolean =>
  classifyR2BlobFailure(error instanceof Error ? error.message : String(error)) === 'digest';
