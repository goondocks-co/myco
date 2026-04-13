import { describe, expect, it } from 'vitest';
import { normalizeSearchNamespace } from '@myco/daemon/api/search.js';

describe('normalizeSearchNamespace', () => {
  it('maps singular MCP type filters to semantic namespaces', () => {
    expect(normalizeSearchNamespace('session')).toBe('sessions');
    expect(normalizeSearchNamespace('spore')).toBe('spores');
    expect(normalizeSearchNamespace('plan')).toBe('plans');
    expect(normalizeSearchNamespace('artifact')).toBe('artifacts');
  });

  it('treats all as an unscoped semantic search', () => {
    expect(normalizeSearchNamespace('all')).toBeUndefined();
  });

  it('accepts already-normalized namespaces unchanged', () => {
    expect(normalizeSearchNamespace('plans')).toBe('plans');
    expect(normalizeSearchNamespace('artifacts')).toBe('artifacts');
  });
});
