import { describe, it, expect } from 'vitest';
import { scoreRelevance } from '@myco/context/relevance';
import type { IndexedNote } from '@myco/index/sqlite';

function makeNote(overrides: Partial<IndexedNote> & { created: string }): IndexedNote {
  return {
    path: 'test.md', type: 'session', id: 'test', title: 'Test',
    content: '', frontmatter: {}, ...overrides,
  };
}

describe('scoreRelevance', () => {
  it('boosts recent notes', () => {
    const recent = makeNote({ created: new Date().toISOString(), id: 'recent' });
    const old = makeNote({ created: '2025-01-01T00:00:00Z', id: 'old' });
    const scored = scoreRelevance([recent, old], {});
    expect(scored).toHaveLength(1);  // only recent has score > 0
    expect(scored[0].note.id).toBe('recent');
  });

  it('boosts notes on same branch', () => {
    const sameBranch = makeNote({
      created: new Date().toISOString(), id: 'same',
      frontmatter: { branch: 'feature/auth' },
    });
    const scored = scoreRelevance([sameBranch], { branch: 'feature/auth' });
    expect(scored[0].reason).toContain('same branch');
  });

  it('boosts notes linked to active plans', () => {
    const linked = makeNote({
      created: new Date().toISOString(), id: 'linked',
      frontmatter: { plan: '[[auth]]' },
    });
    const scored = scoreRelevance([linked], { activePlanIds: ['auth'] });
    expect(scored[0].reason).toContain('active plan');
  });
});
