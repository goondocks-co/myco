import { describe, expect, it } from 'bun:test';
import { scopeForPath } from '../../packages/myco/ui/src/lib/selection';

describe('scopeForPath', () => {
  it('classifies project-scoped routes', () => {
    expect(scopeForPath('/g/default/p/collagen-advocacy-ea55e7')).toBe('project');
    expect(scopeForPath('/g/default/p/collagen-advocacy-ea55e7/sessions')).toBe('project');
  });
  it('classifies grove-scoped routes', () => {
    expect(scopeForPath('/g/default/operations')).toBe('grove');
    expect(scopeForPath('/g/default/dashboard')).toBe('grove');
  });
  it('classifies machine-scoped routes', () => {
    expect(scopeForPath('/settings')).toBe('machine');
    expect(scopeForPath('/logs')).toBe('machine');
    expect(scopeForPath('/groves')).toBe('machine');
    expect(scopeForPath('/')).toBe('machine');
  });
  it('the Team page LIVES at machine scope now — the old grove-bound URL only redirects (E1 §5.4)', () => {
    // Rev 6 moved the route: /team is a first-class machine-scoped page, so
    // the PAGE_SCOPE_OVERRIDES special case is gone. The legacy grove URL is
    // a redirect whose momentary classification is irrelevant to nav state.
    expect(scopeForPath('/team')).toBe('machine');
  });
  it('still classifies a normal grove page as grove and a project page as project', () => {
    expect(scopeForPath('/g/default')).toBe('grove');
    expect(scopeForPath('/g/default/p/myco/sessions')).toBe('project');
  });
});
