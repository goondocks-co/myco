import { describe, expect, it } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import {
  buildCanopySearchPath,
  buildSearchPath,
  getSemanticSince,
} from '../../packages/myco/ui/src/hooks/use-search';

vi.useFakeTimers();
vi.setSystemTime(new Date('2026-04-19T12:00:00Z'));

describe('buildSearchPath', () => {
  it('builds a basic search path without semantic filters', () => {
    expect(buildSearchPath('vault', 'fts')).toBe('/search?q=vault&mode=fts');
  });

  it('includes semantic filters when provided', () => {
    expect(buildSearchPath('sqlite', 'semantic', {
      namespace: 'spores',
      observationType: 'decision',
      recentWindow: '7d',
    })).toBe(`/search?q=sqlite&mode=semantic&namespace=spores&observation_type=decision&since=${getSemanticSince('7d')}`);
  });

  it('omits semantic filters set to all/any', () => {
    expect(buildSearchPath('sqlite', 'semantic', {
      namespace: 'all',
      observationType: 'all',
      recentWindow: 'any',
    })).toBe('/search?q=sqlite&mode=semantic');
  });
});

describe('buildCanopySearchPath', () => {
  it('routes through the search endpoint with type=canopy', () => {
    expect(buildCanopySearchPath('zod schema')).toBe(
      '/search?q=zod+schema&type=canopy',
    );
  });

  it('forwards a language filter when provided', () => {
    expect(buildCanopySearchPath('embed manager', { language: 'typescript' })).toBe(
      '/search?q=embed+manager&type=canopy&language=typescript',
    );
  });
});
