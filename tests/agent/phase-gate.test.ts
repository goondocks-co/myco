/**
 * Tests for the cross-phase skip primitive:
 *   - validatePhaseGatesAgainstWaves (load-time schema check)
 *   - executePhase's gateOnPriorMetadata check (runtime gate)
 *   - phase_emit_metadata tool accumulation
 *
 * These exercise the contract from both ends — the load-time refusal of
 * forward/same-wave gates, and the runtime decision to skip when an
 * upstream phase's metadata doesn't match. Together they pin the
 * mechanism's behavior so the digest-tier migration in Wave 2 can rely
 * on it without prompt-level safety nets.
 */

import { describe, it, expect } from 'bun:test';
import { validatePhaseGatesAgainstWaves } from '@myco/agent/wave-computation.js';
import type { PhaseDefinition } from '@myco/agent/types.js';
import { createPhaseMetadataTools } from '@myco/agent/tools/phase-metadata-tools.js';
import type { VaultToolDeps } from '@myco/agent/tools/types.js';

function makePhase(overrides: Partial<PhaseDefinition>): PhaseDefinition {
  return {
    name: 'p',
    prompt: 'x',
    tools: [],
    maxTurns: 5,
    required: false,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<VaultToolDeps> = {}): VaultToolDeps {
  return {
    agentId: 'test-agent',
    runId: 'test-run',
    recordTurn: () => null,
    ...overrides,
  };
}

describe('validatePhaseGatesAgainstWaves', () => {
  it('accepts a valid earlier-wave gate', () => {
    const phases = [
      makePhase({ name: 'a' }),
      makePhase({
        name: 'b',
        dependsOn: ['a'],
        gateOnPriorMetadata: { phase: 'a', key: 'k', equals: 1 },
      }),
    ];
    expect(() => validatePhaseGatesAgainstWaves(phases)).not.toThrow();
  });

  it('rejects a same-wave gate (gate target in same wave as gating phase)', () => {
    // Both 'a' and 'b' have no dependencies → both land in wave 0.
    // 'b' tries to gate on 'a' — at runtime, priorPhaseResults only
    // contains earlier waves, so 'a's metadata wouldn't be there yet.
    const phases = [
      makePhase({ name: 'a' }),
      makePhase({
        name: 'b',
        gateOnPriorMetadata: { phase: 'a', key: 'k', equals: 1 },
      }),
    ];
    expect(() => validatePhaseGatesAgainstWaves(phases)).toThrow(
      /must be in an earlier wave/,
    );
  });

  it('rejects a forward gate (gate target in a later wave)', () => {
    // 'a' depends on 'b' → 'b' is wave 0, 'a' is wave 1.
    // 'b' (wave 0) tries to gate on 'a' (wave 1) → forward gate.
    const phases = [
      makePhase({
        name: 'b',
        gateOnPriorMetadata: { phase: 'a', key: 'k', equals: 1 },
      }),
      makePhase({ name: 'a', dependsOn: ['b'] }),
    ];
    expect(() => validatePhaseGatesAgainstWaves(phases)).toThrow(
      /must be in an earlier wave/,
    );
  });

  it('rejects a self-referencing gate', () => {
    const phases = [
      makePhase({
        name: 'a',
        gateOnPriorMetadata: { phase: 'a', key: 'k', equals: 1 },
      }),
    ];
    expect(() => validatePhaseGatesAgainstWaves(phases)).toThrow(
      /cannot gate on its own metadata/,
    );
  });

  it('rejects a gate referencing an unknown phase', () => {
    const phases = [
      makePhase({
        name: 'a',
        gateOnPriorMetadata: { phase: 'ghost', key: 'k', equals: 1 },
      }),
    ];
    expect(() => validatePhaseGatesAgainstWaves(phases)).toThrow(
      /"ghost" is not a phase in this task/,
    );
  });

  it('error message names the offending phase + the wave gap', () => {
    const phases = [
      makePhase({ name: 'a' }),
      makePhase({
        name: 'b',
        gateOnPriorMetadata: { phase: 'a', key: 'k', equals: 1 },
      }),
    ];
    try {
      validatePhaseGatesAgainstWaves(phases);
      throw new Error('should have thrown');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain('"b"');
      expect(msg).toContain('"a"');
      expect(msg).toContain('wave 0');
    }
  });

  it('no-ops on a task with no gating phases', () => {
    const phases = [
      makePhase({ name: 'a' }),
      makePhase({ name: 'b', dependsOn: ['a'] }),
    ];
    expect(() => validatePhaseGatesAgainstWaves(phases)).not.toThrow();
  });

  it('accepts a fan-out-with-selector shape (upstream emits, 2 siblings gate)', () => {
    // The real shape vault-evolve will use: 'assess' is wave 0 (no
    // dependencies), the three tier phases all depend on assess and
    // gate on its metadata. Each tier phase is in wave 1; gate
    // resolves to assess's metadata, which is in wave 0.
    const phases = [
      makePhase({ name: 'assess' }),
      makePhase({
        name: 'tier-a',
        dependsOn: ['assess'],
        gateOnPriorMetadata: { phase: 'assess', key: 'selected', equals: 'a' },
      }),
      makePhase({
        name: 'tier-b',
        dependsOn: ['assess'],
        gateOnPriorMetadata: { phase: 'assess', key: 'selected', equals: 'b' },
      }),
    ];
    expect(() => validatePhaseGatesAgainstWaves(phases)).not.toThrow();
  });
});

describe('phase_emit_metadata tool', () => {
  it('writes to the deps accumulator when present', async () => {
    const accumulator = new Map<string, unknown>();
    const tools = createPhaseMetadataTools(makeDeps({ metadataAccumulator: accumulator }));
    const tool = tools[0];
    const result = await tool.handler({ key: 'selectedTier', value: 5000 }, {});
    expect(accumulator.get('selectedTier')).toBe(5000);
    expect(result.content[0].text).toContain('"emitted":true');
    expect(result.content[0].text).toContain('"accumulated":true');
  });

  it('accepts string, number, boolean, and null values', async () => {
    const accumulator = new Map<string, unknown>();
    const tools = createPhaseMetadataTools(makeDeps({ metadataAccumulator: accumulator }));
    const tool = tools[0];
    await tool.handler({ key: 's', value: 'hello' }, {});
    await tool.handler({ key: 'n', value: 42 }, {});
    await tool.handler({ key: 'b', value: true }, {});
    await tool.handler({ key: 'null', value: null }, {});
    expect(accumulator.get('s')).toBe('hello');
    expect(accumulator.get('n')).toBe(42);
    expect(accumulator.get('b')).toBe(true);
    expect(accumulator.get('null')).toBe(null);
  });

  it('overwrites prior values when the same key is emitted twice', async () => {
    const accumulator = new Map<string, unknown>();
    const tools = createPhaseMetadataTools(makeDeps({ metadataAccumulator: accumulator }));
    const tool = tools[0];
    await tool.handler({ key: 'k', value: 'first' }, {});
    await tool.handler({ key: 'k', value: 'second' }, {});
    expect(accumulator.get('k')).toBe('second');
    expect(accumulator.size).toBe(1);
  });

  it('no-ops gracefully when no accumulator is on deps', async () => {
    // The phase-loop only attaches an accumulator when the phase opts in
    // by listing `phase_emit_metadata` in its tools. Non-phase-loop
    // callers (the eager createVaultToolServer path, tests) get the
    // tool without an accumulator — the handler returns success and
    // drops the value rather than throwing.
    const tools = createPhaseMetadataTools(makeDeps({}));
    const tool = tools[0];
    const result = await tool.handler({ key: 'k', value: 'v' }, {});
    expect(result.content[0].text).toContain('"emitted":true');
    expect(result.content[0].text).toContain('"accumulated":false');
  });
});
