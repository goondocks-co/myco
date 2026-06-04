import { describe, it, expect } from 'bun:test';
import { CAPABILITY_IDS } from '../../packages/myco/src/config/scope';
import { MycoConfigSchema } from '../../packages/myco/src/config/schema';

describe('capability ids', () => {
  it('declares the four capability ids', () => {
    expect([...CAPABILITY_IDS].sort()).toEqual(['canopy', 'cortex', 'skills', 'vault_evolution']);
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
