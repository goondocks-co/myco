/**
 * A catalog of the models a worker listed, as the worker sends it and the Deployment keeps it: one rule on both
 * sides, bounded, offering only models the harness's settings accept; and the presets a catalog makes available.
 */
import { describe, expect, it } from 'bun:test';
import { MAX_CATALOG_MODELS, MAX_CATALOG_MODEL_BYTES, offeredPresets, parseModelCatalog } from '@goondocks/myco-shared/execution-profile';

const source = { kind: 'command' as const, command: 'opencode models' };
const signIn = 'worker-login' as const;

describe('a model catalog', () => {
  it('keeps each model the harness\'s settings accept once, with only the facts it holds', () => {
    expect(parseModelCatalog({ harness: 'opencode', source, signIn, fetchedAt: 5, models: [
      { id: 'openrouter/~anthropic/claude-opus-latest', provider: 'openrouter', resolvesTo: 'openrouter/~anthropic/claude-opus-latest', efforts: ['high', 'high', ''] },
      { id: 'no-provider-model' },
      { id: 'openai/gpt-6', label: 'GPT-6', isDefault: 'yes', upgrade: 'openai/gpt-6' },
      { id: 'openai/gpt-6', label: 'a repeat' },
      { id: 'openai/has\nnewline' },
      'not an entry',
    ] })).toEqual({ harness: 'opencode', source, signIn, fetchedAt: 5, models: [
      { id: 'openrouter/~anthropic/claude-opus-latest', label: 'openrouter/~anthropic/claude-opus-latest', provider: 'openrouter', efforts: ['high'] },
      { id: 'openai/gpt-6', label: 'GPT-6' },
    ] });
  });

  it('is refused where it names no harness whose models Settings sets, no source or no listing time', () => {
    expect(parseModelCatalog({ harness: 'cursor', source, signIn, fetchedAt: 5, models: [] })).toBeNull();
    expect(parseModelCatalog({ harness: 'opencode', source: { kind: 'guess', command: 'x' }, signIn, fetchedAt: 5, models: [] })).toBeNull();
    expect(parseModelCatalog({ harness: 'opencode', source, signIn, fetchedAt: 0, models: [] })).toBeNull();
    expect(parseModelCatalog({ harness: 'opencode', source, signIn, fetchedAt: 5 })).toBeNull();
    expect(parseModelCatalog({ harness: 'opencode', source, signIn: 'deployment', fetchedAt: 5, models: [] })).toBeNull();
  });

  it('cuts a list past its bounds and says it was cut', () => {
    const many = Array.from({ length: MAX_CATALOG_MODELS + 5 }, (_, n) => ({ id: `openrouter/m-${n}` }));
    const counted = parseModelCatalog({ harness: 'opencode', source, signIn, fetchedAt: 5, models: many })!;
    expect({ models: counted.models.length, truncated: counted.truncated }).toEqual({ models: MAX_CATALOG_MODELS, truncated: true });
    const long = Array.from({ length: 800 }, (_, n) => ({ id: `openrouter/m-${n}`, label: 'x'.repeat(120), efforts: Array.from({ length: 16 }, (_, e) => `effort-${e}`) }));
    const sized = parseModelCatalog({ harness: 'opencode', source, signIn, fetchedAt: 5, models: long })!;
    expect(sized.truncated).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(sized.models)).length).toBeLessThanOrEqual(MAX_CATALOG_MODEL_BYTES);
    expect(parseModelCatalog({ harness: 'opencode', source, signIn, fetchedAt: 5, models: many.slice(0, 3) })).not.toHaveProperty('truncated');
  });
});

describe('the presets a catalog offers', () => {
  const PRESET_MODELS = ['openrouter/~anthropic/claude-haiku-latest', 'openrouter/~anthropic/claude-sonnet-latest', 'openrouter/~anthropic/claude-opus-latest'];
  const listing = (ids: string[], harness = 'opencode') => ({ harness, models: ids.map((id) => ({ id, label: id })) });

  it('offers a preset only where a catalog of its harness lists every one of its models', () => {
    expect(offeredPresets('opencode', [listing(PRESET_MODELS)]).map((preset) => preset.id)).toEqual(['openrouter-claude-latest']);
    expect(offeredPresets('opencode', [listing(PRESET_MODELS.slice(0, 2)), listing(PRESET_MODELS.slice(2))]).map((preset) => preset.id)).toEqual(['openrouter-claude-latest']);
  });

  it('offers none where the provider is not listed, a model is missing, or the catalog is another harness\'s', () => {
    expect(offeredPresets('opencode', [listing(['openai/gpt-6', 'github-copilot/claude-opus-5.5'])])).toEqual([]);
    expect(offeredPresets('opencode', [listing(PRESET_MODELS.slice(1))])).toEqual([]);
    expect(offeredPresets('opencode', [listing(PRESET_MODELS, 'codex')])).toEqual([]);
    expect(offeredPresets('codex', [listing(PRESET_MODELS, 'codex')])).toEqual([]);
  });
});
