/**
 * Unit tests for the shared executionOverrides provider traversal helper.
 *
 * `transformProviderOverrides` is the structural walker reused by both
 * `sanitizeExecutionOverrides` (inbound) and `scrubExecutionOverrides`
 * (outbound). These tests exercise the walker directly so behavior that
 * matters to both call sites (no-mutation, phase traversal, null-means-
 * delete) stays pinned independent of either transform.
 */
import { describe, it, expect } from 'bun:test';
import { transformProviderOverrides } from '@myco/daemon/api/schemas/execution-overrides-traversal';

describe('transformProviderOverrides', () => {
  it('returns null for null input', () => {
    expect(transformProviderOverrides(null, (p) => p)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(transformProviderOverrides(undefined, (p) => p)).toBeNull();
  });

  it('applies the transform to the top-level provider', () => {
    const input = {
      provider: { type: 'openai', baseUrl: 'https://evil.example', apiKey: 'sk-abc' },
    };
    const out = transformProviderOverrides(input, (provider) => {
      const { apiKey: _drop, ...rest } = provider;
      return rest;
    });
    expect(out).toEqual({
      provider: { type: 'openai', baseUrl: 'https://evil.example' },
    });
  });

  it('applies the transform to every phase provider', () => {
    const input = {
      phases: {
        research: {
          model: 'gpt-4o',
          provider: { type: 'openai', apiKey: 'sk-phase-1' },
        },
        compose: {
          provider: { type: 'openrouter', apiKey: 'sk-phase-2', baseUrl: 'https://x' },
        },
      },
    };
    const out = transformProviderOverrides(input, (provider) => {
      const { apiKey: _drop, ...rest } = provider;
      return rest;
    });
    expect(out).toEqual({
      phases: {
        research: {
          model: 'gpt-4o',
          provider: { type: 'openai' },
        },
        compose: {
          provider: { type: 'openrouter', baseUrl: 'https://x' },
        },
      },
    });
  });

  it('removes the provider field when the transform returns null', () => {
    const input = {
      provider: { type: 'anthropic' },
      phases: {
        research: { provider: { type: 'openai' }, model: 'gpt-4o' },
        compose: { provider: { type: 'openai' } },
      },
    };
    const out = transformProviderOverrides(input, () => null);
    expect(out).toEqual({
      phases: {
        research: { model: 'gpt-4o' },
        compose: {},
      },
    });
    expect(out).not.toHaveProperty('provider');
  });

  it('does not mutate the input (frozen top level and phases)', () => {
    const providerObj = { type: 'openai', apiKey: 'sk-abc', baseUrl: 'https://x' };
    const phaseObj = { provider: { type: 'openrouter', apiKey: 'sk-xyz' }, model: 'm' };
    const input = {
      harness: 'openai-agents',
      provider: providerObj,
      phases: { compose: phaseObj },
    };
    Object.freeze(input);
    Object.freeze(input.provider);
    Object.freeze(input.phases);
    Object.freeze(phaseObj);
    Object.freeze(phaseObj.provider);

    // Transform would otherwise try to delete .apiKey — proves we clone.
    const out = transformProviderOverrides(input, (p) => {
      const { apiKey: _drop, ...rest } = p;
      return rest;
    });

    // Input unchanged
    expect(providerObj).toEqual({ type: 'openai', apiKey: 'sk-abc', baseUrl: 'https://x' });
    expect(phaseObj.provider).toEqual({ type: 'openrouter', apiKey: 'sk-xyz' });

    // Output has apiKey stripped
    expect(out).toEqual({
      harness: 'openai-agents',
      provider: { type: 'openai', baseUrl: 'https://x' },
      phases: { compose: { provider: { type: 'openrouter' }, model: 'm' } },
    });
  });

  it('preserves unrelated top-level and per-phase fields', () => {
    const input = {
      harness: 'claude-sdk',
      reasoningLevel: 'high',
      model: 'claude-opus',
      provider: { type: 'anthropic' },
      phases: {
        research: {
          reasoningLevel: 'low',
          maxTurns: 12,
          provider: { type: 'openai' },
        },
        plainPhase: {
          model: 'gpt-4o',
        },
      },
    };
    const out = transformProviderOverrides(input, (p) => ({ ...p, tagged: true }));
    expect(out).toEqual({
      harness: 'claude-sdk',
      reasoningLevel: 'high',
      model: 'claude-opus',
      provider: { type: 'anthropic', tagged: true },
      phases: {
        research: {
          reasoningLevel: 'low',
          maxTurns: 12,
          provider: { type: 'openai', tagged: true },
        },
        plainPhase: {
          model: 'gpt-4o',
        },
      },
    });
  });

  it('leaves non-object phases untouched (defensive)', () => {
    // Shouldn't happen per schema, but the helper shouldn't throw.
    const input = {
      phases: {
        weird: null as unknown as Record<string, unknown>,
      },
    };
    const out = transformProviderOverrides(input, (p) => p);
    expect(out).toEqual({ phases: { weird: null } });
  });
});
