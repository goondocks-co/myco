/**
 * Unit tests for `buildExecutionOverrides` + `countOverrides` — the pure
 * helpers powering RunTaskDialog's override editor. The dialog itself has
 * no React-Testing-Library harness; the helper suite is the coverage bar.
 *
 * The helper's contract is: only emit fields that actually differ from the
 * task's effective defaults. Returning `undefined` when nothing differs is
 * load-bearing — the daemon otherwise persists an empty `{}` payload and
 * the run's audit shows a phantom "override applied" event.
 */

import { describe, expect, it } from 'vitest';
import {
  buildExecutionOverrides,
  countOverrides,
  toWireProvider,
  type EffectiveDefaults,
  type OverridesFormState,
} from '../../packages/myco/ui/src/components/agent/execution-overrides';
import type { ProviderConfig } from '../../packages/myco/ui/src/hooks/use-providers';

function baseDefaults(
  over: Partial<EffectiveDefaults> = {},
): EffectiveDefaults {
  return {
    runtime: 'claude-sdk',
    reasoningLevel: 'default',
    model: 'claude-sonnet-4-5',
    phases: [
      { name: 'extract', reasoningLevel: 'default', model: 'claude-sonnet-4-5' },
      { name: 'synthesize', reasoningLevel: 'high', model: 'claude-opus-4-7' },
    ],
    ...over,
  };
}

function emptyForm(over: Partial<OverridesFormState> = {}): OverridesFormState {
  return {
    runtime: undefined,
    reasoningLevel: undefined,
    model: undefined,
    phases: {},
    ...over,
  };
}

describe('buildExecutionOverrides', () => {
  it('returns undefined when form is empty', () => {
    expect(buildExecutionOverrides(emptyForm(), baseDefaults())).toBeUndefined();
  });

  it('returns undefined when every form field matches the default', () => {
    const form = emptyForm({
      runtime: 'claude-sdk',
      reasoningLevel: 'default',
      model: 'claude-sonnet-4-5',
      phases: {
        extract: { reasoningLevel: 'default', model: 'claude-sonnet-4-5' },
      },
    });
    expect(buildExecutionOverrides(form, baseDefaults())).toBeUndefined();
  });

  it('emits only the reasoning override when that is the only change', () => {
    const form = emptyForm({ reasoningLevel: 'high' });
    expect(buildExecutionOverrides(form, baseDefaults())).toEqual({
      reasoningLevel: 'high',
    });
  });

  it('emits only the runtime override when that is the only change', () => {
    const form = emptyForm({ runtime: 'openai-agents' });
    expect(buildExecutionOverrides(form, baseDefaults())).toEqual({
      runtime: 'openai-agents',
    });
  });

  it('emits a phase override when just one phase reasoning changes', () => {
    const form = emptyForm({
      phases: { extract: { reasoningLevel: 'low' } },
    });
    expect(buildExecutionOverrides(form, baseDefaults())).toEqual({
      phases: { extract: { reasoningLevel: 'low' } },
    });
  });

  it('emits a phase override when just one phase model changes', () => {
    const form = emptyForm({
      phases: { synthesize: { model: 'claude-haiku-4-5' } },
    });
    expect(buildExecutionOverrides(form, baseDefaults())).toEqual({
      phases: { synthesize: { model: 'claude-haiku-4-5' } },
    });
  });

  it('combines top-level + per-phase overrides into one payload', () => {
    const form = emptyForm({
      reasoningLevel: 'high',
      phases: {
        extract: { reasoningLevel: 'low' },
        synthesize: { model: 'claude-haiku-4-5' },
      },
    });
    expect(buildExecutionOverrides(form, baseDefaults())).toEqual({
      reasoningLevel: 'high',
      phases: {
        extract: { reasoningLevel: 'low' },
        synthesize: { model: 'claude-haiku-4-5' },
      },
    });
  });

  it('strips empty-string model entries (treats "" as "no override")', () => {
    const form = emptyForm({
      model: '',
      phases: { extract: { model: '   ' } },
    });
    expect(buildExecutionOverrides(form, baseDefaults())).toBeUndefined();
  });

  it('trims whitespace on model values before comparing to default', () => {
    const form = emptyForm({ model: '  claude-sonnet-4-5  ' });
    expect(buildExecutionOverrides(form, baseDefaults())).toBeUndefined();
  });

  it('retains a model override when trimmed value differs from default', () => {
    const form = emptyForm({ model: '  custom-model  ' });
    expect(buildExecutionOverrides(form, baseDefaults())).toEqual({
      model: 'custom-model',
    });
  });

  it('drops a per-phase entry when neither reasoning nor model actually differ', () => {
    const form = emptyForm({
      phases: {
        extract: { reasoningLevel: 'default', model: 'claude-sonnet-4-5' },
      },
    });
    expect(buildExecutionOverrides(form, baseDefaults())).toBeUndefined();
  });

  it('keeps a phase override for an unknown phase name (executor logs warning)', () => {
    // Unknown phase names are tolerated — the backend warns but doesn't
    // reject. The UI shouldn't silently drop them either; if someone
    // constructs the form with an unknown key, surface it on the wire.
    const form = emptyForm({
      phases: { unknown: { reasoningLevel: 'high' } },
    });
    expect(buildExecutionOverrides(form, baseDefaults())).toEqual({
      phases: { unknown: { reasoningLevel: 'high' } },
    });
  });

  it('handles defaults with no phases array (single-query tasks)', () => {
    const form = emptyForm({ reasoningLevel: 'low' });
    const defaults: EffectiveDefaults = {
      runtime: 'claude-sdk',
      reasoningLevel: 'default',
      model: 'claude-sonnet-4-5',
    };
    expect(buildExecutionOverrides(form, defaults)).toEqual({
      reasoningLevel: 'low',
    });
  });

  it('omits the phases field from the payload when no phase entries survive', () => {
    const form = emptyForm({
      reasoningLevel: 'high',
      phases: {
        extract: { reasoningLevel: 'default' }, // matches default → dropped
      },
    });
    expect(buildExecutionOverrides(form, baseDefaults())).toEqual({
      reasoningLevel: 'high',
    });
  });
});

describe('countOverrides', () => {
  it('is 0 when nothing differs', () => {
    expect(countOverrides(emptyForm(), baseDefaults())).toBe(0);
  });

  it('counts each top-level change', () => {
    const form = emptyForm({
      runtime: 'openai-agents',
      reasoningLevel: 'high',
      model: 'custom-model',
    });
    expect(countOverrides(form, baseDefaults())).toBe(3);
  });

  it('counts each per-phase field separately', () => {
    const form = emptyForm({
      phases: {
        extract: { reasoningLevel: 'low', model: 'alt-model' },
        synthesize: { reasoningLevel: 'low' },
      },
    });
    expect(countOverrides(form, baseDefaults())).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Rich-provider tests (Task F: provider/per-phase-provider/maxTurns overrides)
// ---------------------------------------------------------------------------

describe('buildExecutionOverrides — provider/maxTurns overrides', () => {
  const lmStudio: ProviderConfig = {
    runtime: 'claude-sdk',
    type: 'lmstudio',
    base_url: 'http://localhost:1234',
    model: 'qwen3-30b',
  };
  const ollama: ProviderConfig = {
    runtime: 'claude-sdk',
    type: 'ollama',
    base_url: 'http://localhost:11434',
    model: 'qwen3:30b',
  };

  function defaultsWithProvider(
    over: Partial<EffectiveDefaults> = {},
  ): EffectiveDefaults {
    return {
      runtime: 'claude-sdk',
      reasoningLevel: 'default',
      model: 'qwen3-30b',
      provider: lmStudio,
      phases: [
        { name: 'extract', reasoningLevel: 'default', model: 'qwen3-30b', provider: lmStudio, maxTurns: 12 },
        { name: 'synthesize', reasoningLevel: 'high', model: 'qwen3-30b', provider: lmStudio, maxTurns: 15 },
      ],
      ...over,
    };
  }

  it('returns undefined when provider matches the default structurally', () => {
    const form = emptyForm({ provider: { ...lmStudio } });
    expect(buildExecutionOverrides(form, defaultsWithProvider())).toBeUndefined();
  });

  it('emits only the provider override when the user switches LM Studio → Ollama', () => {
    const form = emptyForm({ provider: ollama });
    const out = buildExecutionOverrides(form, defaultsWithProvider());
    expect(out).toEqual({
      provider: toWireProvider(ollama),
    });
  });

  it('emits a per-phase provider override when only one phase differs', () => {
    const form = emptyForm({
      phases: {
        extract: { provider: ollama },
      },
    });
    const out = buildExecutionOverrides(form, defaultsWithProvider());
    expect(out).toEqual({
      phases: {
        extract: { provider: toWireProvider(ollama) },
      },
    });
  });

  it('emits a per-phase maxTurns override when the value differs from the phase YAML default', () => {
    const form = emptyForm({
      phases: {
        extract: { maxTurns: 25 },
      },
    });
    const out = buildExecutionOverrides(form, defaultsWithProvider());
    expect(out).toEqual({
      phases: {
        extract: { maxTurns: 25 },
      },
    });
  });

  it('drops a per-phase maxTurns entry when the value equals the phase YAML default', () => {
    const form = emptyForm({
      phases: {
        extract: { maxTurns: 12 }, // matches defaults
      },
    });
    expect(buildExecutionOverrides(form, defaultsWithProvider())).toBeUndefined();
  });

  it('combines top-level provider override + per-phase maxTurns + per-phase provider in one payload', () => {
    const form = emptyForm({
      provider: ollama,
      phases: {
        extract: { maxTurns: 25 },
        synthesize: { provider: lmStudio }, // differs from default lmstudio? no, same
      },
    });
    const out = buildExecutionOverrides(form, defaultsWithProvider());
    // synthesize's provider matches default → dropped
    expect(out).toEqual({
      provider: toWireProvider(ollama),
      phases: {
        extract: { maxTurns: 25 },
      },
    });
  });

  it('converts snake_case provider to camelCase wire shape on the top-level override', () => {
    const form = emptyForm({ provider: ollama });
    const out = buildExecutionOverrides(form, defaultsWithProvider());
    expect(out?.provider).toMatchObject({
      type: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'qwen3:30b',
      runtime: 'claude-sdk',
    });
  });

  it('converts snake_case provider to camelCase wire shape on per-phase overrides', () => {
    const form = emptyForm({
      phases: {
        extract: { provider: ollama },
      },
    });
    const out = buildExecutionOverrides(form, defaultsWithProvider());
    expect(out?.phases?.extract?.provider).toMatchObject({
      type: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'qwen3:30b',
    });
  });

  it('counts top-level provider + per-phase provider + per-phase maxTurns', () => {
    const form = emptyForm({
      provider: ollama,
      phases: {
        extract: { provider: ollama, maxTurns: 25 },
      },
    });
    expect(countOverrides(form, defaultsWithProvider())).toBe(3);
  });
});

describe('toWireProvider', () => {
  it('returns undefined for undefined input', () => {
    expect(toWireProvider(undefined)).toBeUndefined();
  });

  it('renames snake_case keys to camelCase', () => {
    const snake: ProviderConfig = {
      runtime: 'claude-sdk',
      type: 'lmstudio',
      local_backend: 'lmstudio',
      base_url: 'http://localhost:1234',
      model: 'qwen3-30b',
      reasoning_map: { default: 'qwen3-30b', high: 'qwen3-30b' },
      context_length: 32768,
    };
    expect(toWireProvider(snake)).toEqual({
      runtime: 'claude-sdk',
      type: 'lmstudio',
      localBackend: 'lmstudio',
      baseUrl: 'http://localhost:1234',
      model: 'qwen3-30b',
      reasoningMap: { default: 'qwen3-30b', high: 'qwen3-30b' },
      contextLength: 32768,
    });
  });

  it('omits empty/zero optional fields', () => {
    const sparse: ProviderConfig = { type: 'anthropic' };
    expect(toWireProvider(sparse)).toEqual({ type: 'anthropic' });
  });
});
