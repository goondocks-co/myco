import { describe, it, expect } from 'bun:test';
import { CAPABILITY_IDS, scopePolicyForPath } from '../../packages/myco/src/config/scope';
import { MycoConfigSchema } from '../../packages/myco/src/config/schema';
import { CAPABILITIES } from '../../packages/myco/src/config/capabilities';
import { enumerateLeafPaths } from '../../packages/myco/src/config/leaf-paths';

describe('capability ids', () => {
  it('declares the five capability ids', () => {
    expect([...CAPABILITY_IDS].sort()).toEqual(['canopy', 'cortex', 'okf', 'skills', 'vault_evolution']);
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
  it('okf.enabled is gated by okf, project-tier home, overridable by local', () => {
    const e = scopePolicyForPath('okf.enabled');
    expect(e.gate).toBe('okf');
    expect(e.home).toBe('project');
    expect(e.overridableBy).toContain('local');
  });
});

describe('capability master-gate schema defaults', () => {
  const cfg = MycoConfigSchema.parse({ version: 3 }) as any;
  it('cortex.enabled defaults true', () => {
    expect(cfg.cortex.enabled).toBe(true);
  });
  it('cortex.canopy.enabled defaults true', () => {
    expect(cfg.cortex.canopy.enabled).toBe(true);
  });
  it('skills.enabled defaults true', () => {
    expect(cfg.skills.enabled).toBe(true);
  });
  it('vault_evolution.enabled defaults true', () => {
    expect(cfg.vault_evolution.enabled).toBe(true);
  });
  it('okf.enabled defaults FALSE — the first off-by-default capability', () => {
    expect(cfg.okf.enabled).toBe(false);
  });
});

describe('capability map', () => {
  const merged = MycoConfigSchema.parse({ version: 3 }) as Record<string, unknown>;
  const schemaLeaves = new Set(enumerateLeafPaths(merged));

  it('has one entry per capability id', () => {
    expect(Object.keys(CAPABILITIES).sort()).toEqual([...CAPABILITY_IDS].sort());
  });

  it('every master/member gate is a real schema leaf gated by that capability', () => {
    for (const cap of Object.values(CAPABILITIES)) {
      for (const path of [cap.masterGate, ...cap.memberGates]) {
        expect(schemaLeaves.has(path)).toBe(true);
        expect(scopePolicyForPath(path).gate).toBe(cap.id);
      }
    }
  });

  it('every capability lists at least one scheduled task', () => {
    for (const cap of Object.values(CAPABILITIES)) {
      // okf is mid-rebuild: okf-maintain was retired in Task 0.2 and
      // okf-synthesize doesn't land until Task 2.3 — legitimately empty
      // in between.
      if (cap.id === 'okf') continue;
      expect(cap.scheduledTasks.length).toBeGreaterThan(0);
    }
  });
});
