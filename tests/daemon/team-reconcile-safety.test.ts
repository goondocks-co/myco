/**
 * Unit tests for evaluateDeleteSafety — the settledness firewall for symmetric
 * team-sync reconcile.
 *
 * The reconcile path is a FULLY AUTOMATIC backstop, so this gate is purely
 * machine-decidable: there is NO operator override and NO magnitude cap. Delete
 * blast radius is bounded elsewhere by cross-pass drift stability (see
 * team-reconcile-partition.test.ts). What remains here are the two settledness
 * guards, which block unconditionally. All inputs are plain objects; no I/O.
 */

import { describe, expect, it } from 'bun:test';
import { evaluateDeleteSafety } from '@myco/daemon/team-reconcile.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a baseline input where everything is settled. */
function safe(overrides: {
  localCount?: number;
  d1Count?: number;
  membershipSeeded?: boolean;
} = {}) {
  return {
    localCount: 100,
    d1Count: 100,
    membershipSeeded: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Guard 1: transient-empty trap (localCount === 0 && d1Count > 0)
// ---------------------------------------------------------------------------

describe('evaluateDeleteSafety — guard 1: transient-empty local', () => {
  it('blocks when localCount===0 and d1Count>0', () => {
    const result = evaluateDeleteSafety(safe({ localCount: 0, d1Count: 50 }));
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('not_settled');
  });

  it('blocks regardless of how large d1Count is (no magnitude escape hatch)', () => {
    const result = evaluateDeleteSafety(safe({ localCount: 0, d1Count: 100_000 }));
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('not_settled');
  });

  it('does NOT block when localCount===0 and d1Count===0 (nothing to delete)', () => {
    const result = evaluateDeleteSafety(safe({ localCount: 0, d1Count: 0 }));
    expect(result.allow).toBe(true);
  });

  it('does NOT block when localCount>0 even if d1Count>0', () => {
    const result = evaluateDeleteSafety(safe({ localCount: 5, d1Count: 100 }));
    expect(result.allow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Guard 2: membership unseeded
// ---------------------------------------------------------------------------

describe('evaluateDeleteSafety — guard 2: membership unseeded', () => {
  it('blocks when membershipSeeded===false', () => {
    const result = evaluateDeleteSafety(safe({ membershipSeeded: false }));
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('membership_unseeded');
  });

  it('blocks even when local and d1 counts are large and equal', () => {
    const result = evaluateDeleteSafety(safe({
      localCount: 10_000,
      d1Count: 10_000,
      membershipSeeded: false,
    }));
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('membership_unseeded');
  });

  it('does NOT block when membershipSeeded===true', () => {
    const result = evaluateDeleteSafety(safe({ membershipSeeded: true }));
    expect(result.allow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No magnitude caps / no operator gate: any settled drift is allowed
// ---------------------------------------------------------------------------

describe('evaluateDeleteSafety — no magnitude/operator gate', () => {
  it('allows a settled partition with a huge D1 surplus (no fraction cap)', () => {
    // local 1, D1 100_000 — a 99.999% would-be delete rate is NOT blocked here;
    // cross-pass drift stability (not this gate) bounds blast radius.
    const result = evaluateDeleteSafety(safe({ localCount: 1, d1Count: 100_000 }));
    expect(result.allow).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('allows a settled partition with thousands of would-be deletes (no floor)', () => {
    const result = evaluateDeleteSafety(safe({ localCount: 50, d1Count: 5_050 }));
    expect(result.allow).toBe(true);
  });

  it('exposes no operator/magnitude reason — only settledness reasons exist', () => {
    // A blocked result is only ever one of the two settledness reasons.
    const blocked = [
      evaluateDeleteSafety(safe({ localCount: 0, d1Count: 1 })),
      evaluateDeleteSafety(safe({ membershipSeeded: false })),
    ];
    for (const r of blocked) {
      expect(r.allow).toBe(false);
      expect(['not_settled', 'membership_unseeded']).toContain(r.reason);
    }
  });
});

// ---------------------------------------------------------------------------
// Settled → allow
// ---------------------------------------------------------------------------

describe('evaluateDeleteSafety — settled → allow', () => {
  it('allows a settled, seeded partition', () => {
    const result = evaluateDeleteSafety(safe());
    expect(result.allow).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});
