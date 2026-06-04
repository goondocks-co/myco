import { describe, it, expect } from 'bun:test';
import { buildCapabilityBadges } from '../../packages/myco/ui/src/lib/capability-badges';

describe('buildCapabilityBadges', () => {
  it('shows Capture-only when all opt-in capabilities are off', () => {
    const badges = buildCapabilityBadges({ cortex: false, canopy: false, skills: false, vault_evolution: false });
    expect(badges.map((b) => b.label)).toEqual(['Capture-only']);
  });
  it('shows an enabled badge per on capability, sage tone', () => {
    const badges = buildCapabilityBadges({ cortex: true, canopy: false, skills: true, vault_evolution: false });
    const labels = badges.map((b) => b.label);
    expect(labels).toContain('Cortex');
    expect(labels).toContain('Skills');
    expect(labels).not.toContain('Canopy');
    expect(badges.find((b) => b.label === 'Cortex')!.tone).toBe('sage');
  });
});
