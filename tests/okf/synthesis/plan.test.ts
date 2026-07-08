import { describe, expect, it } from 'bun:test';
import { MAX_PLANNED_PAGES, validateWikiPlan, type WikiPagePlan, type WikiPlan } from '@myco/okf/synthesis/plan.js';

function page(over: Partial<WikiPagePlan> = {}): WikiPagePlan {
  return {
    path: 'concepts/overview',
    type: 'concept',
    title: 'Overview',
    rationale: 'Synthesizes the entry points.',
    sourceRefs: ['spore-1'],
    ...over,
  };
}

function plan(over: Partial<WikiPlan> = {}): WikiPlan {
  return {
    generatedAt: '2026-07-06T12:00:00Z',
    sinceRef: 'abc123',
    pages: [page()],
    ...over,
  };
}

describe('validateWikiPlan', () => {
  it('accepts a focused plan carrying openQuestions', () => {
    const p = plan({
      pages: [
        page({ path: 'concepts/overview', openQuestions: ['Is the daemon single-writer?'] }),
        page({ path: 'architecture/data-flow', type: 'overview' }),
      ],
    });
    expect(validateWikiPlan(p)).toEqual([]);
  });

  it('rejects duplicate paths, naming the offending path', () => {
    const errors = validateWikiPlan(plan({ pages: [page({ path: 'a/b' }), page({ path: 'a/b' })] }));
    expect(errors.some((e) => e.includes('duplicate') && e.includes('a/b'))).toBe(true);
  });

  it('rejects an absolute path (not OKF-slug-safe)', () => {
    const errors = validateWikiPlan(plan({ pages: [page({ path: '/etc/passwd' })] }));
    expect(errors.some((e) => e.includes('/etc/passwd'))).toBe(true);
  });

  it('rejects a traversal path (not OKF-slug-safe)', () => {
    const errors = validateWikiPlan(plan({ pages: [page({ path: '../escape' })] }));
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an empty type', () => {
    const errors = validateWikiPlan(plan({ pages: [page({ type: '' })] }));
    expect(errors.some((e) => e.includes('empty type'))).toBe(true);
  });

  it('rejects a reserved basename with and without the .md suffix, in any folder', () => {
    for (const badPath of ['guides/index', 'guides/index.md', 'log', 'log.md', 'a/b/index']) {
      const errors = validateWikiPlan(plan({ pages: [page({ path: badPath })] }));
      expect(errors.some((e) => e.includes('reserved basename') && e.includes(badPath))).toBe(true);
    }
  });

  it('accepts a page whose name merely contains a reserved word (indexing, log-viewer)', () => {
    const p = plan({ pages: [page({ path: 'concepts/indexing' }), page({ path: 'subsystems/log-viewer' })] });
    expect(validateWikiPlan(p)).toEqual([]);
  });

  it('rejects a plan over the MAX_PLANNED_PAGES cap', () => {
    const pages = Array.from({ length: MAX_PLANNED_PAGES + 1 }, (_, i) => page({ path: `concepts/p-${i}` }));
    const errors = validateWikiPlan(plan({ pages }));
    expect(errors.some((e) => e.includes(String(MAX_PLANNED_PAGES)))).toBe(true);
  });

  it('accepts exactly MAX_PLANNED_PAGES pages (boundary)', () => {
    const pages = Array.from({ length: MAX_PLANNED_PAGES }, (_, i) => page({ path: `concepts/p-${i}` }));
    expect(validateWikiPlan(plan({ pages }))).toEqual([]);
  });

  it('collects ALL violations rather than early-returning on the first', () => {
    const p = plan({
      pages: [
        page({ path: '/absolute', type: '' }), // both slug-unsafe AND empty type
        page({ path: 'dup' }),
        page({ path: 'dup' }), // duplicate
      ],
    });
    const errors = validateWikiPlan(p);
    expect(errors.length).toBeGreaterThanOrEqual(3);
    expect(errors.some((e) => e.includes('/absolute'))).toBe(true);
    expect(errors.some((e) => e.includes('empty type'))).toBe(true);
    expect(errors.some((e) => e.includes('duplicate') && e.includes('dup'))).toBe(true);
  });
});
