import { CONTENT_STATEMENT_LIMIT } from '../core/content-budget.js';
import { PARSER_VERSION } from './parse.js';
import { FLIP_WORK_FIELDS, type FlipEnvelope, type FlipWorkload } from './view-flip-work.js';

/**
 * Whole-flip transactions measured on the largest synthetic session (1,000 turns, 106 MB, 10,000 records) with the
 * merged writer, 2026-10-27. Each store keeps its own wall time and the digest of its recorded observation. A flip
 * may spend the content budget's statements and three times the measured round trips.
 */
const OBSERVED = {
  native: { wallMs: 188, statements: 58, roundTrips: 7, digest: '019792f049c10b36753c6ed5cfd5f57393dd71a94ac1c976b9dcb5e6f4446b90' },
  remote: { wallMs: 507, statements: 58, roundTrips: 7, digest: 'f50a236f3840c0baaa6b4151c2bdea7df091827a0d3f8c783b57f74aedfb8264' },
} as const;
const MEASURED_ROWS = 8000,
  MEASURED_INLINE_BYTES = 37_382_508,
  MEASURED_BLOB_REFERENCES = 8000;

/** Every dimension is admitted up to the largest one the measured flip carried for its metric. */
function measuredWorkload(): FlipWorkload {
  return Object.fromEntries(
    FLIP_WORK_FIELDS.map((field) => [
      field,
      field === 'fts_writes'
        ? 0
        : field.endsWith('_inline_bytes') || field === 'checkpoint_bytes'
          ? MEASURED_INLINE_BYTES
          : field.endsWith('_blob_references')
            ? MEASURED_BLOB_REFERENCES
            : MEASURED_ROWS,
    ]),
  );
}

/** The production flip admission for one store and profile. */
export function productionFlipEnvelope(store: 'native' | 'remote', profile: 'serial' | 'parallel'): FlipEnvelope {
  const observed = OBSERVED[store];
  return {
    store,
    profile,
    reserveFraction: 0.1,
    measurement: {
      store,
      profile,
      source: `synthetic long-tail flip, ${observed.statements} statements and ${observed.roundTrips} round trips, 2026-10-27`,
      sourceDigest: observed.digest,
      observedAt: Date.UTC(2026, 9, 27),
      parserVersion: PARSER_VERSION,
      workload: measuredWorkload(),
      wallMs: observed.wallMs,
      statements: CONTENT_STATEMENT_LIMIT,
      roundTrips: observed.roundTrips * 3,
      rowsRead: null,
      rowsWritten: null,
      cpuMs: null,
    },
  };
}
