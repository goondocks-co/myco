import { describe, it, expect } from 'bun:test';
import { capabilityEnabled, isCaptureOnly } from '../../packages/myco/src/config/capabilities';
import { MycoConfigSchema } from '../../packages/myco/src/config/schema';
import type { MycoConfig } from '../../packages/myco/src/config/schema';

function defaults(): MycoConfig {
  return MycoConfigSchema.parse({ version: 3 });
}

describe('capabilityEnabled', () => {
  it('returns true by default for all capabilities (master gate defaults on)', () => {
    const cfg = defaults();
    expect(capabilityEnabled(cfg, 'cortex')).toBe(true);
    expect(capabilityEnabled(cfg, 'canopy')).toBe(true);
    expect(capabilityEnabled(cfg, 'skills')).toBe(true);
    expect(capabilityEnabled(cfg, 'vault_evolution')).toBe(true);
  });

  it('returns false when the master gate is explicitly false', () => {
    const cfg = defaults();
    cfg.cortex.enabled = false;
    expect(capabilityEnabled(cfg, 'cortex')).toBe(false);
  });

  it('returns false when cortex.canopy.enabled is false', () => {
    const cfg = defaults();
    cfg.cortex.canopy.enabled = false;
    expect(capabilityEnabled(cfg, 'canopy')).toBe(false);
  });

  it('returns false when skills.enabled is false', () => {
    const cfg = defaults();
    cfg.skills.enabled = false;
    expect(capabilityEnabled(cfg, 'skills')).toBe(false);
  });

  it('returns false when vault_evolution.enabled is false', () => {
    const cfg = defaults();
    cfg.vault_evolution.enabled = false;
    expect(capabilityEnabled(cfg, 'vault_evolution')).toBe(false);
  });

  it('returns false when config is null (fail-closed)', () => {
    expect(capabilityEnabled(null, 'cortex')).toBe(false);
    expect(capabilityEnabled(null, 'canopy')).toBe(false);
    expect(capabilityEnabled(null, 'skills')).toBe(false);
    expect(capabilityEnabled(null, 'vault_evolution')).toBe(false);
  });

  it('returns false when config is undefined (fail-closed)', () => {
    expect(capabilityEnabled(undefined, 'cortex')).toBe(false);
  });
});

describe('isCaptureOnly', () => {
  it('returns false when all capabilities are on (default)', () => {
    expect(isCaptureOnly(defaults())).toBe(false);
  });

  it('returns true when all capability master gates are off', () => {
    const cfg = defaults();
    cfg.cortex.enabled = false;
    cfg.cortex.canopy.enabled = false;
    cfg.skills.enabled = false;
    cfg.vault_evolution.enabled = false;
    expect(isCaptureOnly(cfg)).toBe(true);
  });

  it('returns false when at least one capability is on', () => {
    const cfg = defaults();
    cfg.cortex.enabled = false;
    cfg.cortex.canopy.enabled = false;
    cfg.skills.enabled = false;
    // vault_evolution still on
    expect(isCaptureOnly(cfg)).toBe(false);
  });

  it('returns true when config is null (fail-closed → all caps off)', () => {
    expect(isCaptureOnly(null)).toBe(true);
  });
});
