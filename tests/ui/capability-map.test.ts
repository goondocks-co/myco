import { describe, expect, it } from 'bun:test';
import { buildCapabilityChips } from '../../packages/myco/ui/src/lib/capability-map';
import type { SymbiontInfo } from '../../packages/myco/ui/src/hooks/use-symbionts';

function makeSymbiont(overrides: Partial<SymbiontInfo> = {}): SymbiontInfo {
  return {
    name: 'test',
    displayName: 'Test',
    binary: 'test',
    enabled: true,
    detected: true,
    globallyInstalled: true,
    supportsSessionStartInjection: false,
    supportsPromptSubmitInjection: false,
    supportsSessions: false,
    supportsCanopyInjection: false,
    supportsSubagentStartInjection: false,
    supportsPlanCapture: false,
    supportsSkills: false,
    supportsMcp: false,
    ...overrides,
  };
}

describe('buildCapabilityChips', () => {
  it('returns only the OKF (CLI) chip for a symbiont that supports nothing else', () => {
    // The OKF chip is universal — every symbiont either supports MCP tool
    // calls or falls back to the CLI, so it's the one chip that always
    // renders even when every other capability flag is false.
    expect(buildCapabilityChips(makeSymbiont())).toEqual([
      {
        id: 'okf',
        label: 'OKF (CLI)',
        to: '/okf',
        tone: 'outline',
        title: 'This symbiont falls back to the myco CLI / reading the OKF markdown directly',
      },
    ]);
  });

  it('emits the Sessions chip when supportsSessions is true', () => {
    const chips = buildCapabilityChips(makeSymbiont({ name: 'claude-code', supportsSessions: true }));
    const sessions = chips.find((c) => c.id === 'sessions');
    expect(sessions).toBeDefined();
    expect(sessions?.label).toBe('Sessions');
    expect(sessions?.to).toBe('/sessions?agent=claude-code');
  });

  it('URL-encodes the agent name in the Sessions chip target', () => {
    const chips = buildCapabilityChips(makeSymbiont({ name: 'foo bar', supportsSessions: true }));
    const sessions = chips.find((c) => c.id === 'sessions');
    expect(sessions?.to).toBe('/sessions?agent=foo%20bar');
  });

  it('emits BOTH Cortex Instructions and Cortex Digest from sessionStartInjection', () => {
    const chips = buildCapabilityChips(makeSymbiont({ supportsSessionStartInjection: true }));
    expect(chips.map((c) => c.id)).toContain('cortex-instructions');
    expect(chips.map((c) => c.id)).toContain('cortex-digest');
  });

  it('Cortex Spores chip is gated on supportsSessions (not on a dedicated field)', () => {
    expect(buildCapabilityChips(makeSymbiont({ supportsSessions: false })).find((c) => c.id === 'cortex-spores'))
      .toBeUndefined();
    expect(buildCapabilityChips(makeSymbiont({ supportsSessions: true })).find((c) => c.id === 'cortex-spores'))
      .toBeDefined();
  });

  it('Cortex Spores chip points at /mycelium?tab=spores', () => {
    const chips = buildCapabilityChips(makeSymbiont({ supportsSessions: true }));
    const spores = chips.find((c) => c.id === 'cortex-spores');
    expect(spores?.to).toBe('/mycelium?tab=spores');
  });

  it('Cortex Canopy chip points at /cortex?tab=canopy', () => {
    const chips = buildCapabilityChips(makeSymbiont({ supportsCanopyInjection: true }));
    const canopy = chips.find((c) => c.id === 'cortex-canopy');
    expect(canopy?.to).toBe('/cortex?tab=canopy');
  });

  it('Subagent context chip points at the Cortex instructions tab', () => {
    const chips = buildCapabilityChips(makeSymbiont({ supportsSubagentStartInjection: true }));
    const subagent = chips.find((c) => c.id === 'cortex-subagent');
    expect(subagent?.label).toBe('Subagent context');
    expect(subagent?.to).toBe('/cortex?tab=instructions');
  });

  it('Plans chip combines agent + has_plan=true', () => {
    const chips = buildCapabilityChips(makeSymbiont({ name: 'cursor', supportsPlanCapture: true }));
    const plans = chips.find((c) => c.id === 'plans');
    expect(plans?.to).toBe('/sessions?agent=cursor&has_plan=true');
  });

  it('MCP chip shows sage tone + plain label when mcpActive is true', () => {
    const chips = buildCapabilityChips(makeSymbiont({ supportsMcp: true, mcpActive: true }));
    const mcp = chips.find((c) => c.id === 'mcp');
    expect(mcp?.label).toBe('MCP');
    expect(mcp?.tone).toBe('sage');
  });

  it('MCP chip shows outline tone + "(quiet)" suffix when mcpActive is false', () => {
    const chips = buildCapabilityChips(makeSymbiont({ supportsMcp: true, mcpActive: false }));
    const mcp = chips.find((c) => c.id === 'mcp');
    expect(mcp?.label).toBe('MCP (quiet)');
    expect(mcp?.tone).toBe('outline');
  });

  it('omits the MCP chip when supportsMcp is false', () => {
    const chips = buildCapabilityChips(makeSymbiont({ supportsMcp: false, mcpActive: true }));
    expect(chips.find((c) => c.id === 'mcp')).toBeUndefined();
  });

  it('emits chips in the locked display order', () => {
    const chips = buildCapabilityChips(makeSymbiont({
      name: 'claude-code',
      supportsSessions: true,
      supportsSessionStartInjection: true,
      supportsCanopyInjection: true,
      supportsSubagentStartInjection: true,
      supportsPlanCapture: true,
      supportsSkills: true,
      supportsMcp: true,
      mcpActive: true,
    }));
    expect(chips.map((c) => c.id)).toEqual([
      'sessions',
      'cortex-instructions',
      'cortex-digest',
      'cortex-canopy',
      'cortex-subagent',
      'cortex-spores',
      'plans',
      'skills',
      'mcp',
      'okf',
    ]);
  });

  it('every chip id is unique within a symbiont', () => {
    const chips = buildCapabilityChips(makeSymbiont({
      supportsSessions: true,
      supportsSessionStartInjection: true,
      supportsCanopyInjection: true,
      supportsPlanCapture: true,
      supportsSkills: true,
      supportsMcp: true,
    }));
    const ids = chips.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  describe('OKF chip — symbiont-derived only', () => {
    it('shows "OKF tools" (sage) when the symbiont supports MCP', () => {
      const chips = buildCapabilityChips(makeSymbiont({ supportsMcp: true, mcpActive: true }));
      const okf = chips.find((c) => c.id === 'okf');
      expect(okf).toBeDefined();
      expect(okf?.label).toBe('OKF tools');
      expect(okf?.tone).toBe('sage');
      expect(okf?.to).toBe('/okf');
    });

    it('shows the CLI-fallback chip (outline) when the symbiont does not support MCP', () => {
      const chips = buildCapabilityChips(makeSymbiont({ supportsMcp: false }));
      const okf = chips.find((c) => c.id === 'okf');
      expect(okf).toBeDefined();
      expect(okf?.label).toBe('OKF (CLI)');
      expect(okf?.tone).toBe('outline');
      expect(okf?.to).toBe('/okf');
    });

    it('never uses the ochre tone reserved for genuine warnings', () => {
      const withMcp = buildCapabilityChips(makeSymbiont({ supportsMcp: true }));
      const withoutMcp = buildCapabilityChips(makeSymbiont({ supportsMcp: false }));
      expect(withMcp.find((c) => c.id === 'okf')?.tone).not.toBe('ochre');
      expect(withoutMcp.find((c) => c.id === 'okf')?.tone).not.toBe('ochre');
    });
  });
});
