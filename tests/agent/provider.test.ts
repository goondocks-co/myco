/**
 * Tests for provider environment variable management.
 *
 * vi.stubEnv / vi.unstubAllEnvs() are used for all env manipulation to avoid
 * race conditions with other test files running in vitest's threads pool.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
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

  it('returns empty object for anthropic', () => {
    const provider: ProviderConfig = { type: 'anthropic' };
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
  it('returns a process.env snapshot when no provider is given (no overrides)', () => {
    const result = buildPhaseEnv();
    // A snapshot, never undefined — the SDK receives a frozen env, not the
    // live process.env resolved lazily at query() time.
    expect(result).toBeDefined();
    expect(result['PATH']).toBe(process.env['PATH']);
    // No provider means no overrides layered on top of the snapshot.
    expect(result[ENV_ANTHROPIC_BASE_URL]).toBe(process.env[ENV_ANTHROPIC_BASE_URL]);
  });

  it('returns a process.env snapshot when provider is undefined', () => {
    const result = buildPhaseEnv(undefined);
    expect(result).toBeDefined();
    expect(result['PATH']).toBe(process.env['PATH']);
  });

  it('anthropic provider returns a bare snapshot (no overrides needed)', () => {
    const result = buildPhaseEnv({ type: 'anthropic' });
    expect(result).toBeDefined();
    expect(result['PATH']).toBe(process.env['PATH']);
    // anthropic layers no overrides — the snapshot's ANTHROPIC_BASE_URL is
    // whatever process.env held, not a provider-injected value.
    expect(result[ENV_ANTHROPIC_BASE_URL]).toBe(process.env[ENV_ANTHROPIC_BASE_URL]);
  });

  it('captures a frozen snapshot — a process.env mutation AFTER the call never leaks into the returned env', () => {
    const sentinel = 'MYCO_PHASE_ENV_SNAPSHOT_SENTINEL';
    // Prove isolation for BOTH a cloud (bare-snapshot) and a local
    // (snapshot+overrides) provider: the returned object is a point-in-time
    // copy, so a later mutation of the live process.env cannot appear in it.
    const cloud = buildPhaseEnv({ type: 'anthropic' });
    const local = buildPhaseEnv({ type: 'ollama' });
    expect(cloud[sentinel]).toBeUndefined();
    expect(local[sentinel]).toBeUndefined();
    process.env[sentinel] = 'mutated-after-snapshot';
    try {
      expect(cloud[sentinel]).toBeUndefined();
      expect(local[sentinel]).toBeUndefined();
    } finally {
      delete process.env[sentinel];
    }
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
