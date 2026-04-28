import { describe, it, expect } from 'vitest';
import { PhaseDefinitionSchema } from './schemas.js';

describe('PhaseDefinitionSchema — map mode', () => {
  const baseFreeForm = {
    name: 'evolve',
    prompt: 'do work',
    tools: ['vault_recall'],
    maxTurns: 20,
    required: true,
  };

  it('accepts a free-form phase without mode', () => {
    expect(PhaseDefinitionSchema.safeParse(baseFreeForm).success).toBe(true);
  });

  it('accepts a valid map-mode phase', () => {
    const phase = {
      name: 'describe',
      prompt: 'unused',
      tools: [],
      maxTurns: 60,
      required: true,
      mode: 'map',
      perItemMaxTurns: 1,
      perItemTimeoutSeconds: 30,
      onItemError: 'skip',
      source: { tool: 'canopy_describe_next', args: { limit: 10 }, itemsPath: 'entries' },
      item: { prompt: 'describe {{ item.path }}' },
      sink: { tool: 'canopy_describe_write', argMap: { path: '{{ item.path }}' } },
    };
    expect(PhaseDefinitionSchema.safeParse(phase).success).toBe(true);
  });

  it('rejects mode: map without source', () => {
    const phase = { ...baseFreeForm, mode: 'map' };
    const result = PhaseDefinitionSchema.safeParse(phase);
    expect(result.success).toBe(false);
  });

  it('rejects perItemMaxTurns: 0', () => {
    const phase = {
      name: 'x', prompt: '', tools: [], maxTurns: 1, required: true,
      mode: 'map',
      perItemMaxTurns: 0,
      source: { tool: 't', args: {}, itemsPath: 'entries' },
      item: { prompt: 'p' },
      sink: { tool: 's', argMap: {} },
    };
    expect(PhaseDefinitionSchema.safeParse(phase).success).toBe(false);
  });

  it('defaults onItemError to "skip" when omitted', () => {
    const phase = {
      name: 'x', prompt: '', tools: [], maxTurns: 1, required: true,
      mode: 'map',
      perItemMaxTurns: 1,
      source: { tool: 't', args: {}, itemsPath: 'entries' },
      item: { prompt: 'p' },
      sink: { tool: 's', argMap: {} },
    };
    const parsed = PhaseDefinitionSchema.parse(phase);
    expect(parsed.onItemError).toBe('skip');
  });
});
