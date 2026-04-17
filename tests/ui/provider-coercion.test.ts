/**
 * Unit tests for `provider-coercion.ts` — shared provider-config shape
 * conversion between the wire (camelCase), UI-internal (snake_case), and
 * narrow TaskRow shapes. Consolidates coverage that used to live inline in
 * `rerun-prefill.ts`, `execution-overrides.ts`, and `RunTaskDialog.tsx`.
 */

import { describe, expect, it } from 'vitest';
import {
  KNOWN_PROVIDER_TYPES,
  fromTaskRowProvider,
  fromWireProvider,
  toWireProvider,
} from '../../packages/myco/ui/src/components/agent/provider-coercion';
import type { ProviderConfig } from '../../packages/myco/ui/src/hooks/use-providers';

describe('KNOWN_PROVIDER_TYPES', () => {
  it('includes the canonical provider types', () => {
    expect(KNOWN_PROVIDER_TYPES).toContain('anthropic');
    expect(KNOWN_PROVIDER_TYPES).toContain('ollama');
    expect(KNOWN_PROVIDER_TYPES).toContain('openai');
    expect(KNOWN_PROVIDER_TYPES).toContain('openai-compatible');
  });
});

describe('toWireProvider', () => {
  it('returns undefined for undefined input', () => {
    expect(toWireProvider(undefined)).toBeUndefined();
  });

  it('preserves all populated fields, converting to camelCase', () => {
    const ui: ProviderConfig = {
      type: 'openai',
      runtime: 'openai-agents',
      local_backend: 'ollama',
      base_url: 'http://localhost:11434',
      model: 'gpt-5',
      reasoning_map: { low: 'gpt-4', default: 'gpt-5', high: 'gpt-5-thinking' },
      context_length: 128000,
    };
    expect(toWireProvider(ui)).toEqual({
      type: 'openai',
      runtime: 'openai-agents',
      localBackend: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'gpt-5',
      reasoningMap: { low: 'gpt-4', default: 'gpt-5', high: 'gpt-5-thinking' },
      contextLength: 128000,
    });
  });

  it('drops absent optional fields rather than emitting undefined properties', () => {
    const wire = toWireProvider({ type: 'anthropic' });
    expect(wire).toEqual({ type: 'anthropic' });
    expect(Object.keys(wire!)).toEqual(['type']);
  });
});

describe('fromWireProvider', () => {
  it('returns undefined for undefined input', () => {
    expect(fromWireProvider(undefined)).toBeUndefined();
  });

  it('converts camelCase wire shape to snake_case UI shape', () => {
    const wire = {
      type: 'openai',
      runtime: 'openai-agents',
      localBackend: 'ollama' as const,
      baseUrl: 'http://localhost:11434',
      model: 'gpt-5',
      reasoningMap: { low: 'gpt-4', default: 'gpt-5', high: 'gpt-5-thinking' },
      contextLength: 128000,
    };
    expect(fromWireProvider(wire)).toEqual({
      type: 'openai',
      runtime: 'openai-agents',
      local_backend: 'ollama',
      base_url: 'http://localhost:11434',
      model: 'gpt-5',
      reasoning_map: { low: 'gpt-4', default: 'gpt-5', high: 'gpt-5-thinking' },
      context_length: 128000,
    });
  });

  it('coerces unknown provider type to openai-compatible', () => {
    const out = fromWireProvider({ type: 'gemini', model: 'gemini-pro' });
    expect(out?.type).toBe('openai-compatible');
    expect(out?.model).toBe('gemini-pro');
  });

  it('drops unknown runtime strings', () => {
    const out = fromWireProvider({ type: 'anthropic', runtime: 'bogus' });
    expect(out?.runtime).toBeUndefined();
  });

  it('preserves known runtime strings', () => {
    expect(fromWireProvider({ type: 'anthropic', runtime: 'claude-sdk' })?.runtime).toBe(
      'claude-sdk',
    );
    expect(fromWireProvider({ type: 'openai', runtime: 'openai-agents' })?.runtime).toBe(
      'openai-agents',
    );
  });

  it('drops absent optional fields', () => {
    const out = fromWireProvider({ type: 'anthropic' });
    expect(out).toEqual({ type: 'anthropic' });
  });
});

describe('fromTaskRowProvider', () => {
  it('returns undefined for undefined input', () => {
    expect(fromTaskRowProvider(undefined)).toBeUndefined();
  });

  it('narrows the partial TaskRow shape to a ProviderConfig', () => {
    const out = fromTaskRowProvider({
      type: 'anthropic',
      model: 'claude-sonnet-4-5',
      reasoning_map: { low: 'claude-haiku', default: 'claude-sonnet-4-5', high: 'claude-opus' },
    });
    expect(out).toEqual({
      type: 'anthropic',
      model: 'claude-sonnet-4-5',
      reasoning_map: { low: 'claude-haiku', default: 'claude-sonnet-4-5', high: 'claude-opus' },
    });
  });

  it('coerces unknown type to openai-compatible', () => {
    const out = fromTaskRowProvider({ type: 'custom-llm', model: 'my-model' });
    expect(out?.type).toBe('openai-compatible');
    expect(out?.model).toBe('my-model');
  });
});

describe('round-trip fromWireProvider → toWireProvider', () => {
  it('preserves the full provider shape', () => {
    const wire = {
      type: 'openai',
      runtime: 'openai-agents',
      localBackend: 'lmstudio' as const,
      baseUrl: 'http://localhost:1234',
      model: 'some-model',
      reasoningMap: { low: 'low-m', default: 'def-m', high: 'high-m' },
      contextLength: 64000,
    };
    const ui = fromWireProvider(wire);
    const backToWire = toWireProvider(ui);
    expect(backToWire).toEqual(wire);
  });
});
