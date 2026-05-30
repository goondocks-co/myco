import { describe, it, expect } from 'bun:test';
import { computeDrift } from '../../../packages/myco/src/daemon/api/team-connect.js';

describe('computeDrift', () => {
  it('reports per-table delta as cloud minus local', () => {
    const drift = computeDrift({ spores: 10, plans: 2 }, { spores: 12, plans: 2 });
    expect(drift.find((d) => d.table === 'spores')).toEqual({ table: 'spores', local: 10, cloud: 12, delta: 2 });
    expect(drift.find((d) => d.table === 'plans')).toEqual({ table: 'plans', local: 2, cloud: 2, delta: 0 });
  });
  it('handles tables present on only one side', () => {
    const drift = computeDrift({ spores: 5 }, { sessions: 3 });
    expect(drift.find((d) => d.table === 'spores')).toEqual({ table: 'spores', local: 5, cloud: 0, delta: -5 });
    expect(drift.find((d) => d.table === 'sessions')).toEqual({ table: 'sessions', local: 0, cloud: 3, delta: 3 });
  });
  it('returns empty array for empty inputs', () => {
    expect(computeDrift({}, {})).toEqual([]);
  });
});
