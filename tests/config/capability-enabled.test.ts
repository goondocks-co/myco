import { describe, it, expect } from 'bun:test';
import {
  CAPABILITIES,
  capabilityEnabled,
  effectiveTaskScheduleEnabled,
  isCaptureOnly,
} from '../../packages/myco/src/config/capabilities';
import { CAPABILITY_IDS, type CapabilityId } from '../../packages/myco/src/config/scope';
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

describe('capabilityEnabled — okf defaultEnabled semantics', () => {
  it('okf is disabled on a schema-parsed default config (Zod default false)', () => {
    expect(capabilityEnabled(defaults(), 'okf')).toBe(false);
  });

  it('okf resolves DISABLED when the whole block is absent (defaultEnabled branch)', () => {
    // A parse-built config always materializes okf.enabled === false, which
    // exercises the Zod default, not defaultEnabled — delete the block so
    // getAtPath returns undefined and the defaultEnabled fallback decides.
    const cfg = defaults();
    delete (cfg as unknown as Record<string, unknown>).okf;
    expect(capabilityEnabled(cfg, 'okf')).toBe(false);
  });

  it('all four legacy capabilities still resolve absent gates to ENABLED', () => {
    const cfg = defaults();
    const raw = cfg as unknown as Record<string, unknown>;
    delete raw.cortex;
    delete raw.skills;
    delete raw.vault_evolution;
    expect(capabilityEnabled(cfg, 'cortex')).toBe(true);
    expect(capabilityEnabled(cfg, 'canopy')).toBe(true);
    expect(capabilityEnabled(cfg, 'skills')).toBe(true);
    expect(capabilityEnabled(cfg, 'vault_evolution')).toBe(true);
  });

  it('anti-drift: every capability resolves defaults to its declared defaultEnabled', () => {
    for (const id of CAPABILITY_IDS as readonly CapabilityId[]) {
      expect(capabilityEnabled(defaults(), id)).toBe(CAPABILITIES[id].defaultEnabled ?? true);
    }
  });

  it('explicit okf.enabled true/false wins over the default', () => {
    const on = defaults();
    on.okf.enabled = true;
    expect(capabilityEnabled(on, 'okf')).toBe(true);
    const off = defaults();
    off.okf.enabled = false;
    expect(capabilityEnabled(off, 'okf')).toBe(false);
  });
});

describe('effectiveTaskScheduleEnabled — okf-maintain gating', () => {
  it('is false while okf is disabled even with the YAML schedule enabled', () => {
    // Passing yamlScheduleEnabled=true is load-bearing: the task YAML ships
    // schedule.enabled: true, so a false here would prove nothing.
    expect(effectiveTaskScheduleEnabled(defaults(), 'okf-maintain', true)).toBe(false);
  });

  it('is true once okf is enabled', () => {
    const cfg = defaults();
    cfg.okf.enabled = true;
    expect(effectiveTaskScheduleEnabled(cfg, 'okf-maintain', true)).toBe(true);
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
