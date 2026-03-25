/**
 * Tests for the orchestrator module.
 *
 * The prompt template file is mocked via vi.mock('node:fs') so tests never
 * touch the real filesystem. Each test suite exercises one exported function.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock node:fs so readFileSync returns a controlled template
// ---------------------------------------------------------------------------

vi.mock('node:fs', () => ({
  default: {
    readFileSync: vi.fn(),
    existsSync: vi.fn(() => true),
  },
  readFileSync: vi.fn(),
  existsSync: vi.fn(() => true),
}));

import fs from 'node:fs';

// Import after mocks are registered
import {
  composeOrchestratorPrompt,
  parseOrchestratorPlan,
  applyDirectives,
} from '@myco/agent/orchestrator.js';
import type { PhaseDefinition, OrchestratorPhaseDirective } from '@myco/agent/types.js';
import type { ContextQueryResult } from '@myco/agent/context-queries.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimal orchestrator template with all three placeholders. */
const TEST_TEMPLATE = `VAULT:\n{{vault_state}}\nPHASES:\n{{phase_definitions}}\nCONTEXT:\n{{context_results}}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePhase(overrides: Partial<PhaseDefinition> = {}): PhaseDefinition {
  return {
    name: 'extract',
    prompt: 'Extract observations from unprocessed batches.',
    tools: ['vault_search'],
    maxTurns: 10,
    required: false,
    ...overrides,
  };
}

function makeContextResult(overrides: Partial<ContextQueryResult> = {}): ContextQueryResult {
  return {
    tool: 'vault_unprocessed',
    purpose: 'Check batch backlog',
    data: [{ id: 1 }],
    ...overrides,
  };
}

function makeDirective(overrides: Partial<OrchestratorPhaseDirective> = {}): OrchestratorPhaseDirective {
  return {
    name: 'extract',
    skip: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reset mocks between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fs.readFileSync).mockReturnValue(TEST_TEMPLATE);
});

// ---------------------------------------------------------------------------
// composeOrchestratorPrompt
// ---------------------------------------------------------------------------

describe('composeOrchestratorPrompt', () => {
  it('substitutes vault state into the template', () => {
    const result = composeOrchestratorPrompt('14 unprocessed batches', [], []);
    expect(result).toContain('14 unprocessed batches');
  });

  it('substitutes phase definitions into the template', () => {
    const phases = [makePhase({ name: 'extract', maxTurns: 15, required: true })];
    const result = composeOrchestratorPrompt('state', phases, []);
    expect(result).toContain('**extract**');
    expect(result).toContain('maxTurns: 15');
    expect(result).toContain('required: true');
  });

  it('substitutes context results into the template', () => {
    const results = [makeContextResult({ tool: 'vault_unprocessed', purpose: 'backlog check' })];
    const result = composeOrchestratorPrompt('state', [], results);
    expect(result).toContain('vault_unprocessed');
    expect(result).toContain('backlog check');
  });

  it('shows "No context queries configured." when context results are empty', () => {
    const result = composeOrchestratorPrompt('state', [], []);
    expect(result).toContain('No context queries configured.');
  });

  it('shows phase name, maxTurns, and required flag in the phase list', () => {
    const phases = [
      makePhase({ name: 'graph', maxTurns: 5, required: false }),
    ];
    const result = composeOrchestratorPrompt('state', phases, []);
    expect(result).toContain('**graph**');
    expect(result).toContain('maxTurns: 5');
    expect(result).toContain('required: false');
  });

  it('truncates long phase prompts to 100 chars with ellipsis', () => {
    const longPrompt = 'A'.repeat(200);
    const phases = [makePhase({ prompt: longPrompt })];
    const result = composeOrchestratorPrompt('state', phases, []);
    // Should have 100 'A's followed by '...'
    expect(result).toContain('A'.repeat(100) + '...');
    // Should NOT contain 101 'A's followed by '...'
    expect(result).not.toContain('A'.repeat(101) + '...');
  });

  it('does not add ellipsis when prompt fits within 100 chars', () => {
    const shortPrompt = 'Short prompt.';
    const phases = [makePhase({ prompt: shortPrompt })];
    const result = composeOrchestratorPrompt('state', phases, []);
    expect(result).toContain('Short prompt.');
    expect(result).not.toContain('Short prompt....');
  });

  it('includes error text for context results with errors', () => {
    const results = [
      makeContextResult({ tool: 'vault_spores', error: 'DB unavailable', data: null }),
    ];
    const result = composeOrchestratorPrompt('state', [], results);
    expect(result).toContain('Error: DB unavailable');
  });

  it('replaces all three placeholders', () => {
    const result = composeOrchestratorPrompt('vault-state-text', [makePhase()], [makeContextResult()]);
    expect(result).not.toContain('{{vault_state}}');
    expect(result).not.toContain('{{phase_definitions}}');
    expect(result).not.toContain('{{context_results}}');
  });
});

// ---------------------------------------------------------------------------
// parseOrchestratorPlan
// ---------------------------------------------------------------------------

describe('parseOrchestratorPlan', () => {
  it('parses a valid JSON response with phases array', () => {
    const response = JSON.stringify({
      phases: [{ name: 'extract', skip: false }],
      reasoning: 'Run all phases.',
    });
    const plan = parseOrchestratorPlan(response, []);
    expect(plan.phases).toHaveLength(1);
    expect(plan.phases[0].name).toBe('extract');
    expect(plan.reasoning).toBe('Run all phases.');
  });

  it('extracts JSON from a markdown ```json code block', () => {
    const response = '```json\n{"phases":[{"name":"consolidate","skip":true,"skipReason":"no spores"}],"reasoning":"skip consolidate"}\n```';
    const plan = parseOrchestratorPlan(response, []);
    expect(plan.phases).toHaveLength(1);
    expect(plan.phases[0].name).toBe('consolidate');
    expect(plan.phases[0].skip).toBe(true);
  });

  it('falls back to run-all plan on malformed JSON', () => {
    const phases = [makePhase({ name: 'extract' }), makePhase({ name: 'graph' })];
    const plan = parseOrchestratorPlan('not valid json {{{', phases);
    expect(plan.phases).toHaveLength(2);
    expect(plan.phases.every((p) => p.skip === false)).toBe(true);
    expect(plan.reasoning).toMatch(/could not be parsed/i);
  });

  it('falls back to run-all plan when phases array is missing', () => {
    const response = JSON.stringify({ reasoning: 'all good' }); // no phases field
    const phases = [makePhase({ name: 'extract' })];
    const plan = parseOrchestratorPlan(response, phases);
    expect(plan.phases).toHaveLength(1);
    expect(plan.phases[0].name).toBe('extract');
    expect(plan.phases[0].skip).toBe(false);
    expect(plan.reasoning).toMatch(/missing phases/i);
  });

  it('falls back to run-all plan on empty string', () => {
    const phases = [makePhase({ name: 'digest' })];
    const plan = parseOrchestratorPlan('', phases);
    expect(plan.phases).toHaveLength(1);
    expect(plan.phases[0].name).toBe('digest');
    expect(plan.phases[0].skip).toBe(false);
  });

  it('falls back to run-all plan when phases is not an array', () => {
    const response = JSON.stringify({ phases: 'not-an-array', reasoning: 'bad' });
    const phases = [makePhase({ name: 'extract' })];
    const plan = parseOrchestratorPlan(response, phases);
    expect(plan.phases).toHaveLength(1);
    expect(plan.phases[0].skip).toBe(false);
  });

  it('returns empty phases array in run-all plan when no phases defined', () => {
    const plan = parseOrchestratorPlan('bad json', []);
    expect(plan.phases).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// applyDirectives
// ---------------------------------------------------------------------------

describe('applyDirectives', () => {
  it('passes phases through unchanged when no matching directives exist', () => {
    const phases = [
      makePhase({ name: 'extract' }),
      makePhase({ name: 'graph' }),
    ];
    const result = applyDirectives(phases, []);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('extract');
    expect(result[1].name).toBe('graph');
  });

  it('skips non-required phases when directive has skip: true', () => {
    const phases = [
      makePhase({ name: 'extract', required: false }),
      makePhase({ name: 'graph', required: false }),
    ];
    const directives = [makeDirective({ name: 'extract', skip: true })];
    const result = applyDirectives(phases, directives);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('graph');
  });

  it('refuses to skip required phases — keeps them and logs a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const phases = [makePhase({ name: 'extract', required: true })];
    const directives = [makeDirective({ name: 'extract', skip: true, skipReason: 'nothing to do' })];
    const result = applyDirectives(phases, directives);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('extract');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('extract'));
    warnSpy.mockRestore();
  });

  it('applies maxTurns override from directive', () => {
    const phases = [makePhase({ name: 'extract', maxTurns: 10 })];
    const directives = [makeDirective({ name: 'extract', skip: false, maxTurns: 25 })];
    const result = applyDirectives(phases, directives);
    expect(result[0].maxTurns).toBe(25);
  });

  it('does not override maxTurns when directive has no maxTurns', () => {
    const phases = [makePhase({ name: 'extract', maxTurns: 10 })];
    const directives = [makeDirective({ name: 'extract', skip: false })];
    const result = applyDirectives(phases, directives);
    expect(result[0].maxTurns).toBe(10);
  });

  it('appends contextNotes to phase prompt under ## Orchestrator Guidance', () => {
    const phases = [makePhase({ name: 'extract', prompt: 'Original prompt.' })];
    const directives = [
      makeDirective({ name: 'extract', skip: false, contextNotes: '14 unprocessed batches.' }),
    ];
    const result = applyDirectives(phases, directives);
    expect(result[0].prompt).toContain('Original prompt.');
    expect(result[0].prompt).toContain('## Orchestrator Guidance');
    expect(result[0].prompt).toContain('14 unprocessed batches.');
  });

  it('does not append guidance section when contextNotes is absent', () => {
    const phases = [makePhase({ name: 'extract', prompt: 'Original prompt.' })];
    const directives = [makeDirective({ name: 'extract', skip: false })];
    const result = applyDirectives(phases, directives);
    expect(result[0].prompt).toBe('Original prompt.');
    expect(result[0].prompt).not.toContain('## Orchestrator Guidance');
  });

  it('preserves phase order when directives do not reorder', () => {
    const phases = [
      makePhase({ name: 'extract' }),
      makePhase({ name: 'consolidate' }),
      makePhase({ name: 'graph' }),
      makePhase({ name: 'digest' }),
    ];
    const directives = [makeDirective({ name: 'graph', skip: false, maxTurns: 8 })];
    const result = applyDirectives(phases, directives);
    expect(result.map((p) => p.name)).toEqual(['extract', 'consolidate', 'graph', 'digest']);
  });

  it('handles directive for unknown phase name gracefully (ignores it)', () => {
    const phases = [makePhase({ name: 'extract' })];
    const directives = [makeDirective({ name: 'nonexistent', skip: true })];
    const result = applyDirectives(phases, directives);
    // Phase list unchanged; unknown directive silently ignored
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('extract');
  });

  it('applies multiple directives in a single call', () => {
    const phases = [
      makePhase({ name: 'extract', maxTurns: 10, required: false }),
      makePhase({ name: 'graph', maxTurns: 5, required: false }),
      makePhase({ name: 'digest', maxTurns: 3, required: false }),
    ];
    const directives = [
      makeDirective({ name: 'extract', skip: false, maxTurns: 20 }),
      makeDirective({ name: 'graph', skip: true }),
      makeDirective({ name: 'digest', skip: false, contextNotes: 'Regenerate all tiers.' }),
    ];
    const result = applyDirectives(phases, directives);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('extract');
    expect(result[0].maxTurns).toBe(20);
    expect(result[1].name).toBe('digest');
    expect(result[1].prompt).toContain('Regenerate all tiers.');
  });
});
