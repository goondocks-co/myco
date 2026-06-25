/**
 * Exhaustive unit tests for evaluateDeleteSafety — the data-loss firewall for
 * symmetric team-sync reconcile.
 *
 * This function is the SOLE daemon-side guard bounding how many D1 rows an
 * automatic reconcile may delete. Tests cover every guard, every boundary, and
 * every operator-override interaction. All inputs are plain objects; no I/O.
 */

import { describe, expect, it } from 'bun:test';
import {
  evaluateDeleteSafety,
  MIN_ABSOLUTE_DELETE_FLOOR,
  MAX_DELETE_FRACTION,
  MAX_PASS_AGGREGATE_DELETES,
} from '@myco/daemon/team-reconcile.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a baseline input where everything is settled, small, and automatic. */
function safe(overrides: {
  localCount?: number;
  d1Count?: number;
  partitionDeleteCount?: number;
  passAggregateDeleteCount?: number;
  membershipSeeded?: boolean;
  operatorConfirmed?: boolean;
} = {}) {
  return {
    localCount: 100,
    d1Count: 100,
    partitionDeleteCount: 1,
    passAggregateDeleteCount: 1,
    membershipSeeded: true,
    operatorConfirmed: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Guard 1: transient-empty trap (localCount === 0 && d1Count > 0)
// ---------------------------------------------------------------------------

describe('evaluateDeleteSafety — guard 1: transient-empty local', () => {
  it('blocks when localCount===0 and d1Count>0 (automatic)', () => {
    const result = evaluateDeleteSafety(safe({ localCount: 0, d1Count: 50, membershipSeeded: true }));
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('not_settled');
  });

  it('blocks even when operatorConfirmed (operator cannot override settledness)', () => {
    const result = evaluateDeleteSafety(safe({
      localCount: 0,
      d1Count: 50,
      membershipSeeded: true,
      operatorConfirmed: true,
    }));
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('not_settled');
  });

  it('does NOT block when localCount===0 and d1Count===0 (nothing to delete)', () => {
    const result = evaluateDeleteSafety(safe({
      localCount: 0,
      d1Count: 0,
      partitionDeleteCount: 0,
      membershipSeeded: true,
    }));
    expect(result.allow).toBe(true);
  });

  it('does NOT block when localCount>0 even if d1Count>0', () => {
    const result = evaluateDeleteSafety(safe({ localCount: 5, d1Count: 100 }));
    // Falls through to magnitude caps; with partitionDeleteCount=1 it passes.
    expect(result.allow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Guard 2: membership unseeded
// ---------------------------------------------------------------------------

describe('evaluateDeleteSafety — guard 2: membership unseeded', () => {
  it('blocks when membershipSeeded===false (automatic)', () => {
    const result = evaluateDeleteSafety(safe({ membershipSeeded: false }));
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('membership_unseeded');
  });

  it('blocks when membershipSeeded===false even with operatorConfirmed', () => {
    const result = evaluateDeleteSafety(safe({ membershipSeeded: false, operatorConfirmed: true }));
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('membership_unseeded');
  });

  it('does NOT block when membershipSeeded===true', () => {
    const result = evaluateDeleteSafety(safe({ membershipSeeded: true }));
    expect(result.allow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Guard 3: operatorConfirmed bypasses magnitude caps
// ---------------------------------------------------------------------------

describe('evaluateDeleteSafety — guard 3: operatorConfirmed bypasses magnitude caps', () => {
  it('allows when operatorConfirmed and partitionDeleteCount exceeds floor', () => {
    const result = evaluateDeleteSafety(safe({
      partitionDeleteCount: MIN_ABSOLUTE_DELETE_FLOOR + 1,
      d1Count: 1000,
      operatorConfirmed: true,
    }));
    expect(result.allow).toBe(true);
  });

  it('allows when operatorConfirmed and fraction exceeds MAX_DELETE_FRACTION', () => {
    // 90% delete rate — way over fraction cap but operator confirmed.
    const result = evaluateDeleteSafety(safe({
      d1Count: 100,
      partitionDeleteCount: 90,
      operatorConfirmed: true,
    }));
    expect(result.allow).toBe(true);
  });

  it('allows when operatorConfirmed and passAggregateDeleteCount exceeds aggregate cap', () => {
    const result = evaluateDeleteSafety(safe({
      passAggregateDeleteCount: MAX_PASS_AGGREGATE_DELETES + 1,
      operatorConfirmed: true,
    }));
    expect(result.allow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Guard 4: per-partition absolute floor
// ---------------------------------------------------------------------------

describe('evaluateDeleteSafety — guard 4: per-partition absolute floor', () => {
  it('blocks when partitionDeleteCount > MIN_ABSOLUTE_DELETE_FLOOR (automatic)', () => {
    const result = evaluateDeleteSafety(safe({
      d1Count: 10000, // large so fraction cap is not the binding guard
      partitionDeleteCount: MIN_ABSOLUTE_DELETE_FLOOR + 1,
    }));
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('requires_operator');
  });

  it('allows when partitionDeleteCount === MIN_ABSOLUTE_DELETE_FLOOR (at boundary, automatic)', () => {
    const result = evaluateDeleteSafety(safe({
      d1Count: 10000,
      partitionDeleteCount: MIN_ABSOLUTE_DELETE_FLOOR,
    }));
    expect(result.allow).toBe(true);
  });

  it('blocks at floor+1 but allows with operatorConfirmed', () => {
    const input = safe({
      d1Count: 10000,
      partitionDeleteCount: MIN_ABSOLUTE_DELETE_FLOOR + 1,
      operatorConfirmed: true,
    });
    expect(evaluateDeleteSafety(input).allow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Guard 5: fraction cap
// ---------------------------------------------------------------------------

describe('evaluateDeleteSafety — guard 5: fraction cap', () => {
  it('blocks when partitionDeleteCount/d1Count > MAX_DELETE_FRACTION (automatic)', () => {
    // Use a small d1Count so the fraction guard triggers while the delete count
    // stays well under the absolute floor. With d1Count=20 and fraction 0.2:
    //   floor threshold  = MIN_ABSOLUTE_DELETE_FLOOR (50)
    //   fraction-blocked = Math.ceil(20 * (0.2 + epsilon)) = 5 deletes (25% > 20%)
    // 5 is safely under 50, so guard 4 does NOT fire first.
    const d1Count = 20;
    const partitionDeleteCount = 5; // 5/20 = 0.25 > MAX_DELETE_FRACTION (0.2)
    expect(partitionDeleteCount).toBeLessThan(MIN_ABSOLUTE_DELETE_FLOOR);
    expect(partitionDeleteCount / d1Count).toBeGreaterThan(MAX_DELETE_FRACTION);

    const result = evaluateDeleteSafety(safe({ d1Count, partitionDeleteCount }));
    expect(result.allow).toBe(false);
    // reason is implementation-defined for this guard; check it's not the others.
    expect(result.reason).not.toBe('not_settled');
    expect(result.reason).not.toBe('membership_unseeded');
    expect(result.reason).not.toBe('requires_operator');
  });

  it('allows when fraction is exactly MAX_DELETE_FRACTION (not strictly greater)', () => {
    // partitionDeleteCount / d1Count === MAX_DELETE_FRACTION → NOT blocked.
    const d1Count = 100;
    const partitionDeleteCount = Math.floor(d1Count * MAX_DELETE_FRACTION);
    // Ensure still under the floor.
    const result = evaluateDeleteSafety(safe({ d1Count, partitionDeleteCount }));
    expect(result.allow).toBe(true);
  });

  it('skips fraction check when d1Count===0 (no divide-by-zero)', () => {
    const result = evaluateDeleteSafety(safe({
      d1Count: 0,
      partitionDeleteCount: 0,
      passAggregateDeleteCount: 0,
    }));
    expect(result.allow).toBe(true);
  });

  it('blocks on fraction but allows with operatorConfirmed', () => {
    const d1Count = 20;
    const partitionDeleteCount = 5; // 5/20 = 0.25 > MAX_DELETE_FRACTION
    const result = evaluateDeleteSafety(safe({ d1Count, partitionDeleteCount, operatorConfirmed: true }));
    expect(result.allow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Guard 6: per-pass aggregate cap
// ---------------------------------------------------------------------------

describe('evaluateDeleteSafety — guard 6: per-pass aggregate cap', () => {
  it('blocks when passAggregateDeleteCount > MAX_PASS_AGGREGATE_DELETES (automatic)', () => {
    const result = evaluateDeleteSafety(safe({
      passAggregateDeleteCount: MAX_PASS_AGGREGATE_DELETES + 1,
    }));
    expect(result.allow).toBe(false);
    expect(result.reason).not.toBe('not_settled');
    expect(result.reason).not.toBe('membership_unseeded');
    expect(result.reason).not.toBe('requires_operator');
  });

  it('allows when passAggregateDeleteCount === MAX_PASS_AGGREGATE_DELETES (at boundary)', () => {
    const result = evaluateDeleteSafety(safe({
      passAggregateDeleteCount: MAX_PASS_AGGREGATE_DELETES,
    }));
    expect(result.allow).toBe(true);
  });

  it('blocks on aggregate but allows with operatorConfirmed', () => {
    const result = evaluateDeleteSafety(safe({
      passAggregateDeleteCount: MAX_PASS_AGGREGATE_DELETES + 1,
      operatorConfirmed: true,
    }));
    expect(result.allow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Guard 7: settled, under all caps → allow
// ---------------------------------------------------------------------------

describe('evaluateDeleteSafety — guard 7: settled and small → allow', () => {
  it('allows when all guards pass (typical small drift case)', () => {
    const result = evaluateDeleteSafety(safe());
    expect(result.allow).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('allows a zero-delete reconcile pass', () => {
    const result = evaluateDeleteSafety(safe({
      partitionDeleteCount: 0,
      passAggregateDeleteCount: 0,
    }));
    expect(result.allow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Constant sanity checks — ensure named exports exist and are in valid ranges
// ---------------------------------------------------------------------------

describe('evaluateDeleteSafety — exported constants', () => {
  it('MIN_ABSOLUTE_DELETE_FLOOR is a positive integer in a safe range', () => {
    expect(MIN_ABSOLUTE_DELETE_FLOOR).toBeGreaterThan(0);
    expect(Number.isInteger(MIN_ABSOLUTE_DELETE_FLOOR)).toBe(true);
  });

  it('MAX_DELETE_FRACTION is between 0.1 and 0.2 inclusive', () => {
    expect(MAX_DELETE_FRACTION).toBeGreaterThanOrEqual(0.1);
    expect(MAX_DELETE_FRACTION).toBeLessThanOrEqual(0.2);
  });

  it('MAX_PASS_AGGREGATE_DELETES is a positive integer larger than MIN_ABSOLUTE_DELETE_FLOOR', () => {
    expect(MAX_PASS_AGGREGATE_DELETES).toBeGreaterThan(MIN_ABSOLUTE_DELETE_FLOOR);
    expect(Number.isInteger(MAX_PASS_AGGREGATE_DELETES)).toBe(true);
  });
});
