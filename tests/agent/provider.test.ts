/**
 * Tests for provider environment variable management.
 *
 * vi.stubEnv / vi.unstubAllEnvs() are used for all env manipulation to avoid
 * race conditions with other test files running in vitest's threads pool.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  getProviderEnvVars,
  buildPhaseEnv,
} from '@myco/agent/provider.js';
import type { ProviderConfig } from '@myco/agent/types.js';

// ---------------------------------------------------------------------------
// Constants matching the implementation (used in assertions)
// ---------------------------------------------------------------------------

const ENV_ANTHROPIC_BASE_URL = 'ANTHROPIC_BASE_URL';
const ENV_ANTHROPIC_AUTH_TOKEN = 'ANTHROPIC_AUTH_TOKEN';
const ENV_ANTHROPIC_API_KEY = 'ANTHROPIC_API_KEY';
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_LMSTUDIO_URL = 'http://localhost:1234';
const OLLAMA_AUTH_TOKEN = 'ollama';
const LMSTUDIO_AUTH_TOKEN = 'lmstudio';

// ---------------------------------------------------------------------------
// Env cleanup
// ---------------------------------------------------------------------------

// Restore all env stubs after each test so mutations don't bleed between tests
// or across parallel threads that share process.env.
afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// getProviderEnvVars
// ---------------------------------------------------------------------------

describe('getProviderEnvVars', () => {
  it('returns correct vars for ollama with default URL', () => {
    const provider: ProviderConfig = { type: 'ollama' };
    const vars = getProviderEnvVars(provider);

    expect(vars).toEqual({
      [ENV_ANTHROPIC_BASE_URL]: DEFAULT_OLLAMA_URL,
      [ENV_ANTHROPIC_AUTH_TOKEN]: OLLAMA_AUTH_TOKEN,
      [ENV_ANTHROPIC_API_KEY]: '',
    });
  });

  it('returns correct vars for ollama with custom URL', () => {
    const provider: ProviderConfig = { type: 'ollama', baseUrl: 'http://my-ollama:11434' };
    const vars = getProviderEnvVars(provider);

    expect(vars[ENV_ANTHROPIC_BASE_URL]).toBe('http://my-ollama:11434');
    expect(vars[ENV_ANTHROPIC_AUTH_TOKEN]).toBe(OLLAMA_AUTH_TOKEN);
  });

  it('returns correct vars for lmstudio', () => {
    const provider: ProviderConfig = { type: 'lmstudio' };
    const vars = getProviderEnvVars(provider);

    expect(vars).toEqual({
      [ENV_ANTHROPIC_BASE_URL]: DEFAULT_LMSTUDIO_URL,
      [ENV_ANTHROPIC_AUTH_TOKEN]: LMSTUDIO_AUTH_TOKEN,
      [ENV_ANTHROPIC_API_KEY]: '',
    });
  });

  it('returns correct vars for lmstudio with custom apiKey', () => {
    const provider: ProviderConfig = { type: 'lmstudio', apiKey: 'my-lmstudio-key' };
    const vars = getProviderEnvVars(provider);

    expect(vars[ENV_ANTHROPIC_AUTH_TOKEN]).toBe('my-lmstudio-key');
    expect(vars[ENV_ANTHROPIC_API_KEY]).toBe('');
  });

  it('returns correct vars for lmstudio with custom baseUrl', () => {
    const provider: ProviderConfig = {
      type: 'lmstudio',
      baseUrl: 'http://my-lmstudio:1234',
    };
    const vars = getProviderEnvVars(provider);

    expect(vars[ENV_ANTHROPIC_BASE_URL]).toBe('http://my-lmstudio:1234');
  });

  it('returns empty object for cloud', () => {
    const provider: ProviderConfig = { type: 'cloud' };
    const vars = getProviderEnvVars(provider);

    expect(vars).toEqual({});
  });

  it('returns empty object for unknown provider type', () => {
    // Cast to bypass type checking — testing the default branch of the switch
    const provider = { type: 'unknown' } as unknown as ProviderConfig;
    const vars = getProviderEnvVars(provider);

    expect(vars).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// buildPhaseEnv — pure env builder (no process.env mutation)
// ---------------------------------------------------------------------------

describe('buildPhaseEnv', () => {
  it('returns undefined when no provider is given (SDK uses process.env)', () => {
    const result = buildPhaseEnv();
    expect(result).toBeUndefined();
  });

  it('returns undefined when provider is undefined', () => {
    const result = buildPhaseEnv(undefined);
    expect(result).toBeUndefined();
  });

  it('cloud provider returns undefined (no overrides needed)', () => {
    const result = buildPhaseEnv({ type: 'cloud' });
    expect(result).toBeUndefined();
  });

  it('ollama provider overrides ANTHROPIC env vars', () => {
    const result = buildPhaseEnv({ type: 'ollama' });

    expect(result[ENV_ANTHROPIC_BASE_URL]).toBe(DEFAULT_OLLAMA_URL);
    expect(result[ENV_ANTHROPIC_AUTH_TOKEN]).toBe(OLLAMA_AUTH_TOKEN);
    expect(result[ENV_ANTHROPIC_API_KEY]).toBe('');
    // Still has base env vars
    expect(result['PATH']).toBe(process.env['PATH']);
  });

  it('ollama with custom URL uses custom URL', () => {
    const result = buildPhaseEnv({ type: 'ollama', baseUrl: 'http://custom:11434' });

    expect(result[ENV_ANTHROPIC_BASE_URL]).toBe('http://custom:11434');
  });

  it('lmstudio provider overrides ANTHROPIC env vars', () => {
    const result = buildPhaseEnv({ type: 'lmstudio' });

    expect(result[ENV_ANTHROPIC_BASE_URL]).toBe(DEFAULT_LMSTUDIO_URL);
    expect(result[ENV_ANTHROPIC_AUTH_TOKEN]).toBe(LMSTUDIO_AUTH_TOKEN);
  });

  it('lmstudio with custom apiKey uses it as auth token', () => {
    const result = buildPhaseEnv({ type: 'lmstudio', apiKey: 'my-key' });

    expect(result[ENV_ANTHROPIC_AUTH_TOKEN]).toBe('my-key');
  });

  it('does NOT mutate process.env', () => {
    const originalBaseUrl = process.env[ENV_ANTHROPIC_BASE_URL];

    buildPhaseEnv({ type: 'ollama' });

    // process.env should be unchanged
    expect(process.env[ENV_ANTHROPIC_BASE_URL]).toBe(originalBaseUrl);
  });
});
