import { sha256Hex } from '@myco/canopy/hash.js';
import type { OkfBundleInclude, OkfSporeStatusFilter } from './types.js';

/**
 * Deterministic probe-fingerprint inputs — the SAME shape `bundle.ts`'s
 * `computeProbeFingerprint` hashes from a live `gather()` result and
 * persists as `probe_fingerprint` on publish.
 *
 * Keep this hashed shape IDENTICAL to what bundle.ts feeds in — changing key
 * names or the payload shape silently invalidates every persisted
 * `probe_fingerprint`, which would make every project look "due" once
 * (harmless) but is still worth avoiding.
 */
export interface OkfProbeFingerprintInputs {
  sporeCount: number;
  maxSporeUpdate: number;
  canopyCount: number;
  maxCanopyUpdate: number;
  conceptCount: number;
  mapHash: string | null;
  include: OkfBundleInclude;
  sporeStatus: OkfSporeStatusFilter;
}

/**
 * Pure hash function used by `bundle.ts` to compute `probe_fingerprint`
 * from a live `gather()` result at publish time.
 */
export function computeOkfProbeFingerprint(inputs: OkfProbeFingerprintInputs): string {
  return sha256Hex(
    JSON.stringify({
      spore_count: inputs.sporeCount,
      canopy_count: inputs.canopyCount,
      concept_count: inputs.conceptCount,
      max_spore_update: inputs.maxSporeUpdate,
      max_canopy_update: inputs.maxCanopyUpdate,
      map_hash: inputs.mapHash,
      include: inputs.include,
      spore_status: inputs.sporeStatus,
    }),
  );
}
