import { describe, expect, it } from 'bun:test';
import {
  matchesSemanticSearchFilters,
  FILTERABLE_KEY_REGISTRY,
  VECTOR_PARTITION_KEYS,
  VECTOR_COLUMN_KEYS,
  VECTOR_INDEXED_KEYS,
  FILTERABLE_DOMAIN_KEYS,
} from '@myco/semantic-search-filters.js';

describe('filterable-key registry invariants', () => {
  it('has no duplicate keys', () => {
    const keys = FILTERABLE_KEY_REGISTRY.map((k) => k.key);
    expect(keys.length).toBe(new Set(keys).size);
  });

  it('indexed keys (partition + column) are the union, and a subset of all filterable keys', () => {
    expect([...VECTOR_INDEXED_KEYS].sort()).toEqual([...VECTOR_PARTITION_KEYS, ...VECTOR_COLUMN_KEYS].sort());
    for (const k of VECTOR_INDEXED_KEYS) expect(FILTERABLE_DOMAIN_KEYS.has(k)).toBe(true);
  });

  it('the store supports exactly one partition key (tenancy)', () => {
    expect(VECTOR_PARTITION_KEYS.length).toBe(1);
  });

  it('every registry key has a single recognized strategy', () => {
    for (const spec of FILTERABLE_KEY_REGISTRY) {
      expect(['partition', 'column', 'postKnn']).toContain(spec.strategy);
    }
  });
});

describe('matchesSemanticSearchFilters', () => {
  it('matches equality filters against embedding metadata', () => {
    expect(matchesSemanticSearchFilters(
      { status: 'active', observation_type: 'decision', session_id: 'sess-1' },
      { status: 'active', observation_type: 'decision' },
    )).toBe(true);
  });

  it('matches created_at range filters', () => {
    expect(matchesSemanticSearchFilters(
      { created_at: 100 },
      { created_at_gte: 90, created_at_lt: 120 },
    )).toBe(true);
    expect(matchesSemanticSearchFilters(
      { created_at: 100 },
      { created_at_gt: 100 },
    )).toBe(false);
  });

  it('rejects missing created_at when a time bound is requested', () => {
    expect(matchesSemanticSearchFilters(
      { status: 'active' },
      { created_at_gte: 10 },
    )).toBe(false);
  });
});
