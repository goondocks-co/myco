import { FLIP_WORK_FIELDS, type FlipEnvelope } from '../../packages/myco-server/src/ingest/view-flip-work.js';
import { PARSER_VERSION } from '../../packages/myco-server/src/ingest/parse.js';

/** Deterministic measurement inputs exercise admission without claiming hosted capacity. */
export function fixtureFlipEnvelope(
  target: 'native' | 'D1' | 'remote' = 'native',
  profile: 'serial' | 'parallel' = 'serial',
): FlipEnvelope {
  const store = target === 'native' ? 'native' : 'remote';
  return {
    store,
    profile,
    reserveFraction: 0.1,
    measurement: {
      store,
      profile,
      source: 'fake whole-flip calibration for contract tests',
      sourceDigest: 'a'.repeat(64),
      observedAt: 1,
      parserVersion: PARSER_VERSION,
      workload: Object.fromEntries(
        FLIP_WORK_FIELDS.map((field) => [field, field === 'fts_writes' ? 0 : 1_000_000_000]),
      ),
      wallMs: 100,
      statements: 120,
      roundTrips: 20,
      rowsRead: null,
      rowsWritten: null,
      cpuMs: null,
    },
  };
}
