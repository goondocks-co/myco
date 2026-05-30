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
  it('excludes tables in the provided exclude set from drift', () => {
    // entity_mentions has local rows but is never synced to D1, so its cloud
    // copy is always 0. Without exclusion this produces a permanent delta that
    // a Rebuild can never resolve. With exclusion it is absent from the result.
    const drift = computeDrift(
      { entity_mentions: 5, spores: 2 },
      { spores: 2 },
      new Set(['entity_mentions']),
    );
    expect(drift.find((d) => d.table === 'spores')).toEqual({ table: 'spores', local: 2, cloud: 2, delta: 0 });
    expect(drift.find((d) => d.table === 'entity_mentions')).toBeUndefined();
  });
});
