/**
 * Tests for provider environment variable management.
 *
 * vi.stubEnv / vi.unstubAllEnvs() are used for all env manipulation to avoid
 * race conditions with other test files running in vitest's threads pool.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  applyProviderEnv,
  restoreProviderEnv,
  getProviderEnvVars,
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
// applyProviderEnv + restoreProviderEnv
// ---------------------------------------------------------------------------

describe('applyProviderEnv + restoreProviderEnv', () => {
  it('sets Ollama env vars and restores originals', () => {
    // Arrange: pre-set a known value that should be overwritten then restored
    vi.stubEnv(ENV_ANTHROPIC_BASE_URL, 'https://original-url.example.com');
    const originalBaseUrl = process.env[ENV_ANTHROPIC_BASE_URL];

    const provider: ProviderConfig = { type: 'ollama' };

    // Act: apply
    const saved = applyProviderEnv(provider);

    // Assert: env vars are set for Ollama
    expect(process.env[ENV_ANTHROPIC_BASE_URL]).toBe(DEFAULT_OLLAMA_URL);
    expect(process.env[ENV_ANTHROPIC_AUTH_TOKEN]).toBe(OLLAMA_AUTH_TOKEN);
    expect(process.env[ENV_ANTHROPIC_API_KEY]).toBe('');

    // Act: restore
    restoreProviderEnv(saved);

    // Assert: original values are restored
    expect(process.env[ENV_ANTHROPIC_BASE_URL]).toBe(originalBaseUrl);
  });

  it('sets LM Studio env vars and restores originals', () => {
    vi.stubEnv(ENV_ANTHROPIC_AUTH_TOKEN, 'original-token');
    const originalToken = process.env[ENV_ANTHROPIC_AUTH_TOKEN];

    const provider: ProviderConfig = { type: 'lmstudio' };

    const saved = applyProviderEnv(provider);

    expect(process.env[ENV_ANTHROPIC_BASE_URL]).toBe(DEFAULT_LMSTUDIO_URL);
    expect(process.env[ENV_ANTHROPIC_AUTH_TOKEN]).toBe(LMSTUDIO_AUTH_TOKEN);
    expect(process.env[ENV_ANTHROPIC_API_KEY]).toBe('');

    restoreProviderEnv(saved);

    expect(process.env[ENV_ANTHROPIC_AUTH_TOKEN]).toBe(originalToken);
  });

  it('cloud provider sets no env vars', () => {
    // Arrange: set values that should remain untouched
    vi.stubEnv(ENV_ANTHROPIC_BASE_URL, 'https://cloud-url.example.com');
    vi.stubEnv(ENV_ANTHROPIC_AUTH_TOKEN, 'cloud-token');

    const provider: ProviderConfig = { type: 'cloud' };

    const saved = applyProviderEnv(provider);

    // Assert: nothing changed
    expect(process.env[ENV_ANTHROPIC_BASE_URL]).toBe('https://cloud-url.example.com');
    expect(process.env[ENV_ANTHROPIC_AUTH_TOKEN]).toBe('cloud-token');

    // Restore is a no-op but should not throw
    restoreProviderEnv(saved);

    expect(process.env[ENV_ANTHROPIC_BASE_URL]).toBe('https://cloud-url.example.com');
    expect(process.env[ENV_ANTHROPIC_AUTH_TOKEN]).toBe('cloud-token');
  });

  it('restores undefined vars by deleting them when var was not set before apply', () => {
    // Ensure the vars are not present in the stub layer (they may or may not
    // exist in the real env — we test that after restore they are absent).
    // Note: vi.stubEnv sets a value; we can only test this for vars that were
    // genuinely absent. We rely on the saved state capturing undefined.

    // Use vars that are very unlikely to be in the real environment
    const UNLIKELY_KEY_1 = 'MYCO_TEST_PROVIDER_SENTINEL_1';
    const UNLIKELY_KEY_2 = 'MYCO_TEST_PROVIDER_SENTINEL_2';

    // Manually verify they are absent, then test applyProviderEnv saves them as undefined
    delete process.env[UNLIKELY_KEY_1];
    delete process.env[UNLIKELY_KEY_2];

    // Build a saved state manually to replicate "var not present before apply"
    const saved = {
      vars: {
        [UNLIKELY_KEY_1]: undefined,
        [UNLIKELY_KEY_2]: 'some-value',
      },
    };

    // Set them so we can verify restoration
    process.env[UNLIKELY_KEY_1] = 'was-set';
    process.env[UNLIKELY_KEY_2] = 'was-set';

    restoreProviderEnv(saved);

    // UNLIKELY_KEY_1 was undefined → should be deleted
    expect(UNLIKELY_KEY_1 in process.env).toBe(false);
    // UNLIKELY_KEY_2 had a value → should be restored to that value
    expect(process.env[UNLIKELY_KEY_2]).toBe('some-value');

    // Cleanup
    delete process.env[UNLIKELY_KEY_2];
  });

  it('applyProviderEnv captures undefined for vars not previously set', () => {
    // Use a sentinel var that is guaranteed absent
    const SENTINEL_KEY = 'MYCO_TEST_SENTINEL_APPLY_CAPTURE';
    delete process.env[SENTINEL_KEY];

    // Temporarily inject into provider env vars by testing the real Ollama path
    // with a key we know starts absent: ANTHROPIC_AUTH_TOKEN is likely unset in CI
    // We use vi.stubEnv to control the baseline cleanly.
    // Verify applyProviderEnv saves the original (undefined) and restoreProviderEnv deletes it.
    vi.unstubAllEnvs();

    // Set up: env vars absent (unstub restores them to their real values —
    // assume ANTHROPIC_AUTH_TOKEN is absent in test env)
    const originalAuthToken = process.env[ENV_ANTHROPIC_AUTH_TOKEN];

    const provider: ProviderConfig = { type: 'ollama' };
    const saved = applyProviderEnv(provider);

    // Confirm it was applied
    expect(process.env[ENV_ANTHROPIC_AUTH_TOKEN]).toBe(OLLAMA_AUTH_TOKEN);

    // Saved state should capture whatever was there before (could be undefined)
    expect(saved.vars[ENV_ANTHROPIC_AUTH_TOKEN]).toBe(originalAuthToken);

    restoreProviderEnv(saved);

    // Should be back to the original value
    expect(process.env[ENV_ANTHROPIC_AUTH_TOKEN]).toBe(originalAuthToken);
  });
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
