/**
 * Tests for the orchestrator module.
 *
 * Prompt-template loading is controlled via targeted fs spies so tests never
 * touch the real filesystem and don't poison other suites.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';

// Import after mocks are registered
import {
  composeOrchestratorPrompt,
  parseOrchestratorPlan,
  applyDirectives,
  planFromStructuredOutput,
  ORCHESTRATOR_PLAN_JSON_SCHEMA,
  resetOrchestratorPromptTemplateCacheForTests,
  resolveOrchestratorPromptTemplate,
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
  vi.spyOn(fs, 'readFileSync').mockReturnValue(TEST_TEMPLATE as never);
  vi.spyOn(fs, 'existsSync').mockReturnValue(true as never);
  resetOrchestratorPromptTemplateCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetOrchestratorPromptTemplateCacheForTests();
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

  it('falls back to the bundled prompt template for Bun virtual paths', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false as never);
    const result = resolveOrchestratorPromptTemplate('/$bunfs/root');
    expect(result).toContain('# Orchestrator');
    expect(result).toContain('{{vault_state}}');
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

  it('surfaces the underlying parser error in the fallback reasoning', () => {
    // Regression for issue #118 item 2: the catch used to swallow the
    // parser error, leaving operators with no way to tell whether the
    // planner produced malformed JSON, wrong shape, or a typo.
    const phases = [makePhase({ name: 'extract' })];
    const plan = parseOrchestratorPlan('{"phases": [invalid}', phases);
    expect(plan.reasoning).toMatch(/could not be parsed/i);
    // The parenthetical carries the parser's actual complaint — anything
    // non-empty is fine; we only care that it's no longer swallowed.
    expect(plan.reasoning).toMatch(/\(.+\)/);
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
// planFromStructuredOutput
// ---------------------------------------------------------------------------

describe('planFromStructuredOutput', () => {
  it('returns the plan unchanged when given a well-formed OrchestratorPlan object', () => {
    const structured = {
      phases: [{ name: 'extract', skip: false }],
      reasoning: 'Run all phases.',
    };
    const plan = planFromStructuredOutput(structured, []);
    expect(plan.phases).toHaveLength(1);
    expect(plan.phases[0].name).toBe('extract');
    expect(plan.reasoning).toBe('Run all phases.');
  });

  it('falls back to run-all plan when the object is missing phases', () => {
    const phases = [makePhase({ name: 'extract' })];
    const plan = planFromStructuredOutput({ reasoning: 'all good' }, phases);
    expect(plan.phases).toHaveLength(1);
    expect(plan.phases[0].name).toBe('extract');
    expect(plan.phases[0].skip).toBe(false);
    expect(plan.reasoning).toMatch(/missing phases/i);
  });

  it('falls back to run-all plan when given a non-object value', () => {
    const phases = [makePhase({ name: 'digest' })];
    expect(planFromStructuredOutput(null, phases).phases[0].name).toBe('digest');
    expect(planFromStructuredOutput('not an object', phases).phases[0].name).toBe('digest');
    expect(planFromStructuredOutput(['array', 'not', 'object'], phases).phases[0].name).toBe('digest');
  });

  it('logs a warning on shape mismatch', () => {
    const warn = vi.fn();
    const logger = { info: vi.fn(), debug: vi.fn(), warn, error: vi.fn() };
    planFromStructuredOutput({ notPhases: true }, [], logger);
    expect(warn).toHaveBeenCalledTimes(1);
    const [kind, , meta] = warn.mock.calls[0];
    expect(kind).toBe('agent.orchestrator.structured-output-shape-mismatch');
    expect(meta).toMatchObject({ received: 'object' });
  });

  it('does not log when the shape is valid', () => {
    const warn = vi.fn();
    const logger = { info: vi.fn(), debug: vi.fn(), warn, error: vi.fn() };
    planFromStructuredOutput({ phases: [], reasoning: 'ok' }, [], logger);
    expect(warn).not.toHaveBeenCalled();
  });

  it('drops a null maxTurns directive field so applyDirectives never zeroes the matched phase budget', () => {
    // Regression guard for the CRITICAL #1 finding: a harness that forgot
    // to strip OpenAI strict-mode nulls (see stripStrictNulls in
    // harness/openai.ts) would hand planFromStructuredOutput a directive
    // shaped like { skip: false, maxTurns: null, ... }. applyDirectives'
    // `directive.maxTurns !== undefined` guard passes on a `null` value,
    // and `Math.min(null, ceiling)` coerces to 0 — zeroing the phase's
    // turn budget. planFromStructuredOutput must strip the null before it
    // ever reaches applyDirectives; applyDirectives itself is untouched.
    const structured = {
      phases: [{ name: 'extract', skip: false, maxTurns: null }],
      reasoning: 'x',
    };
    const plan = planFromStructuredOutput(structured, []);
    const phases = [makePhase({ name: 'extract', maxTurns: 5 })];
    const result = applyDirectives(phases, plan.phases);
    expect(result[0].maxTurns).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// ORCHESTRATOR_PLAN_JSON_SCHEMA
// ---------------------------------------------------------------------------

describe('ORCHESTRATOR_PLAN_JSON_SCHEMA', () => {
  it('declares exactly the OrchestratorPhaseDirective fields', () => {
    const directiveProps = (ORCHESTRATOR_PLAN_JSON_SCHEMA as any).properties.phases.items.properties;
    expect(Object.keys(directiveProps).sort()).toEqual(
      ['contextNotes', 'maxTurns', 'name', 'skip', 'skipReason'].sort(),
    );
  });

  it('requires name and skip on each directive, leaves the rest optional', () => {
    const items = (ORCHESTRATOR_PLAN_JSON_SCHEMA as any).properties.phases.items;
    expect(items.required).toEqual(['name', 'skip']);
  });

  it('requires phases and reasoning at the top level', () => {
    expect((ORCHESTRATOR_PLAN_JSON_SCHEMA as any).required).toEqual(['phases', 'reasoning']);
  });

  it('disallows additional properties at both levels', () => {
    expect((ORCHESTRATOR_PLAN_JSON_SCHEMA as any).additionalProperties).toBe(false);
    expect((ORCHESTRATOR_PLAN_JSON_SCHEMA as any).properties.phases.items.additionalProperties).toBe(false);
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

  it('narrows maxTurns when directive shrinks the budget', () => {
    const phases = [makePhase({ name: 'extract', maxTurns: 35 })];
    const directives = [makeDirective({ name: 'extract', skip: false, maxTurns: 10 })];
    const result = applyDirectives(phases, directives);
    expect(result[0].maxTurns).toBe(10);
  });

  it('clamps maxTurns when directive tries to widen beyond the YAML budget', () => {
    // Orchestrator-as-narrower invariant: YAML budget is the spec; the
    // orchestrator may shrink it but never widen. Without the clamp,
    // vault-evolve's extract phase drifted from 35 to 161 turns this way.
    const phases = [makePhase({ name: 'extract', maxTurns: 35 })];
    const directives = [makeDirective({ name: 'extract', skip: false, maxTurns: 200 })];
    const result = applyDirectives(phases, directives);
    expect(result[0].maxTurns).toBe(35);
  });

  it('logs a warning when the orchestrator tries to widen a budget', () => {
    const phases = [makePhase({ name: 'extract', maxTurns: 35 })];
    const directives = [makeDirective({ name: 'extract', skip: false, maxTurns: 200 })];
    const warn = vi.fn();
    const logger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn,
      error: vi.fn(),
    };
    applyDirectives(phases, directives, logger);
    expect(warn).toHaveBeenCalledTimes(1);
    const [, msg, meta] = warn.mock.calls[0];
    expect(msg).toContain('extract');
    expect(msg).toContain('35');
    expect(msg).toContain('200');
    expect(meta).toMatchObject({ phase: 'extract', requested: 200, ceiling: 35 });
  });

  it('does not log when directive narrows or matches the YAML budget', () => {
    const phases = [makePhase({ name: 'extract', maxTurns: 35 })];
    const warn = vi.fn();
    const logger = { info: vi.fn(), debug: vi.fn(), warn, error: vi.fn() };
    applyDirectives(phases, [makeDirective({ name: 'extract', skip: false, maxTurns: 10 })], logger);
    applyDirectives(phases, [makeDirective({ name: 'extract', skip: false, maxTurns: 35 })], logger);
    expect(warn).not.toHaveBeenCalled();
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

  it('caps an oversized contextNotes at 500 chars with a truncation marker (Fix 6b regression)', () => {
    // Fix 6(b): contextNotes is LLM-authored free text with no size bound
    // from the orchestrator's own plan response, spliced into phase.prompt
    // uncapped and then feeding phasePurpose.promptExcerpt — an unbounded
    // injection surface. Must be capped the same way phase.prompt itself is
    // truncated for promptExcerpt (see phase-loop.ts).
    const phases = [makePhase({ name: 'extract', prompt: 'Original prompt.' })];
    const oversizedNotes = 'x'.repeat(600);
    const directives = [
      makeDirective({ name: 'extract', skip: false, contextNotes: oversizedNotes }),
    ];
    const result = applyDirectives(phases, directives);
    expect(result[0].prompt).toContain('Original prompt.');
    expect(result[0].prompt).toContain('## Orchestrator Guidance');
    expect(result[0].prompt).toContain('...[truncated]');
    // Exactly 500 chars of the original notes survive, followed by the marker.
    expect(result[0].prompt).toContain(`${'x'.repeat(500)}...[truncated]`);
    expect(result[0].prompt).not.toContain('x'.repeat(501));
  });

  it('does not truncate contextNotes at or under the 500-char cap', () => {
    const phases = [makePhase({ name: 'extract', prompt: 'Original prompt.' })];
    const exactNotes = 'y'.repeat(500);
    const directives = [
      makeDirective({ name: 'extract', skip: false, contextNotes: exactNotes }),
    ];
    const result = applyDirectives(phases, directives);
    expect(result[0].prompt).toContain(exactNotes);
    expect(result[0].prompt).not.toContain('...[truncated]');
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
      // Narrow within the ceiling — applied as-is.
      makeDirective({ name: 'extract', skip: false, maxTurns: 7 }),
      makeDirective({ name: 'graph', skip: true }),
      makeDirective({ name: 'digest', skip: false, contextNotes: 'Regenerate all tiers.' }),
    ];
    const result = applyDirectives(phases, directives);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('extract');
    expect(result[0].maxTurns).toBe(7);
    expect(result[1].name).toBe('digest');
    expect(result[1].prompt).toContain('Regenerate all tiers.');
  });
});
