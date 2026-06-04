import { describe, it, expect } from 'bun:test';
import { CAPABILITY_IDS, scopePolicyForPath } from '../../packages/myco/src/config/scope';
import { MycoConfigSchema } from '../../packages/myco/src/config/schema';

describe('capability ids', () => {
  it('declares the four capability ids', () => {
    expect([...CAPABILITY_IDS].sort()).toEqual(['canopy', 'cortex', 'skills', 'vault_evolution']);
  });
});

describe('capability gate annotations', () => {
  it('cortex.enabled is gated by cortex', () => {
    expect(scopePolicyForPath('cortex.enabled').gate).toBe('cortex');
  });
  it('cortex.canopy.enabled is gated by canopy (longest-prefix wins)', () => {
    expect(scopePolicyForPath('cortex.canopy.enabled').gate).toBe('canopy');
  });
  it('skills.enabled is gated by skills', () => {
    expect(scopePolicyForPath('skills.enabled').gate).toBe('skills');
  });
  it('vault_evolution.enabled is gated by vault_evolution and overridable by local', () => {
    const e = scopePolicyForPath('vault_evolution.enabled');
    expect(e.gate).toBe('vault_evolution');
    expect(e.home).toBe('grove');
    expect(e.overridableBy).toContain('local');
  });
});

describe('capability master-gate schema defaults', () => {
  const cfg = MycoConfigSchema.parse({ version: 3 }) as any;
  it('cortex.canopy.enabled defaults true', () => {
    expect(cfg.cortex.canopy.enabled).toBe(true);
  });
  it('skills.enabled defaults true', () => {
    expect(cfg.skills.enabled).toBe(true);
  });
  it('vault_evolution.enabled defaults true', () => {
    expect(cfg.vault_evolution.enabled).toBe(true);
  });
});
