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
    expect(scopeForPath('/g/default/team')).toBe('grove');
  });
  it('classifies machine-scoped routes', () => {
    expect(scopeForPath('/settings')).toBe('machine');
    expect(scopeForPath('/logs')).toBe('machine');
    expect(scopeForPath('/groves')).toBe('machine');
    expect(scopeForPath('/')).toBe('machine');
  });
});
