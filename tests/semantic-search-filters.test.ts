import { describe, expect, it } from 'bun:test';
import { matchesSemanticSearchFilters } from '@myco/semantic-search-filters.js';

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
