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
  it('classifies the Team page as machine-wide despite its grove-bound route', () => {
    expect(scopeForPath('/g/default/team')).toBe('machine');
    expect(scopeForPath('/g/default/team?tab=sync')).toBe('machine');
  });
  it('still classifies a normal grove page as grove and a project page as project', () => {
    expect(scopeForPath('/g/default')).toBe('grove');
    expect(scopeForPath('/g/default/p/myco/sessions')).toBe('project');
  });
});
