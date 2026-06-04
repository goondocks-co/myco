import { describe, it, expect } from 'bun:test';
import { MycoConfigSchema } from '../../packages/myco/src/config/schema';
import { CAPABILITIES, capabilityForTask } from '../../packages/myco/src/config/capabilities';
import { getAtPath } from '../../packages/myco/src/utils/dot-path';

// Mirror the implementation's decision so the contract is locked even before
// the scheduler wiring; the scheduler calls the same logic.
function capabilityEnabled(config: unknown, taskName: string): boolean {
  const capId = capabilityForTask(taskName);
  if (!capId) return true;
  return getAtPath(config, CAPABILITIES[capId].masterGate) !== false;
}

describe('scheduler capability gate', () => {
  const cfg = MycoConfigSchema.parse({ version: 3 }) as Record<string, unknown>;
  it('gates vault-evolve when vault_evolution.enabled is false', () => {
    const off = MycoConfigSchema.parse({ version: 3 }) as any;
    off.vault_evolution.enabled = false;
    expect(capabilityEnabled(off, 'vault-evolve')).toBe(false);
  });
  it('allows vault-evolve when enabled (default)', () => {
    expect(capabilityEnabled(cfg, 'vault-evolve')).toBe(true);
  });
  it('allows a task with no capability (e.g. title-summary)', () => {
    expect(capabilityEnabled(cfg, 'title-summary')).toBe(true);
  });
  it('gates canopy-map when cortex.canopy.enabled is false', () => {
    const off = MycoConfigSchema.parse({ version: 3 }) as any;
    off.cortex.canopy.enabled = false;
    expect(capabilityEnabled(off, 'canopy-map')).toBe(false);
  });
});
