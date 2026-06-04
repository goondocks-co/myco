import { describe, it, expect } from 'bun:test';
import { buildCapabilityBadges } from '../../packages/myco/ui/src/lib/capability-badges';
import { CAPABILITIES } from '../../packages/myco/src/config/capabilities';
import type { CapabilityId } from '../../packages/myco/src/config/scope';

/** All capabilities on — the default schema state. */
const ALL_ON: Record<CapabilityId, boolean> = Object.fromEntries(
  (Object.keys(CAPABILITIES) as CapabilityId[]).map((id) => [id, true]),
) as Record<CapabilityId, boolean>;

/** All capabilities off — a newly admitted capture-only project. */
const ALL_OFF: Record<CapabilityId, boolean> = Object.fromEntries(
  (Object.keys(CAPABILITIES) as CapabilityId[]).map((id) => [id, false]),
) as Record<CapabilityId, boolean>;

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

  describe('Groves card — project.capabilities consumption', () => {
    it('a capture-only project (all off) yields exactly one Capture-only badge', () => {
      const badges = buildCapabilityBadges(ALL_OFF);
      expect(badges).toHaveLength(1);
      expect(badges[0].id).toBe('capture-only');
      expect(badges[0].label).toBe('Capture-only');
      expect(badges[0].tone).toBe('outline');
    });

    it('a fully-enabled project yields one badge per capability key, no Capture-only', () => {
      const badges = buildCapabilityBadges(ALL_ON);
      const ids = badges.map((b) => b.id);
      expect(ids).not.toContain('capture-only');
      for (const capId of Object.keys(CAPABILITIES) as CapabilityId[]) {
        expect(ids).toContain(capId);
      }
    });

    it('cortex=false silences only the Cortex badge; others remain', () => {
      const gates = { ...ALL_ON, cortex: false };
      const badges = buildCapabilityBadges(gates);
      const ids = badges.map((b) => b.id);
      expect(ids).not.toContain('cortex');
      expect(ids).not.toContain('capture-only');
      expect(ids).toContain('canopy');
      expect(ids).toContain('skills');
      expect(ids).toContain('vault_evolution');
    });
  });
});
