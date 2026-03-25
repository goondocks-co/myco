import type { ProviderConfig } from './types.js';

// ---------------------------------------------------------------------------
// Named constants — env var names and default values
// ---------------------------------------------------------------------------

const ENV_ANTHROPIC_BASE_URL = 'ANTHROPIC_BASE_URL';
const ENV_ANTHROPIC_AUTH_TOKEN = 'ANTHROPIC_AUTH_TOKEN';
const ENV_ANTHROPIC_API_KEY = 'ANTHROPIC_API_KEY';
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_LMSTUDIO_URL = 'http://localhost:1234';
const OLLAMA_AUTH_TOKEN = 'ollama';
const LMSTUDIO_AUTH_TOKEN = 'lmstudio';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SavedEnv {
  vars: Record<string, string | undefined>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply provider env vars for a query() call.
 * Returns saved state for restoration.
 */
export function applyProviderEnv(provider: ProviderConfig): SavedEnv {
  const saved: Record<string, string | undefined> = {};
  const envVars = getProviderEnvVars(provider);
  for (const [key, value] of Object.entries(envVars)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  return { vars: saved };
}

/**
 * Restore env vars after a query() call.
 */
export function restoreProviderEnv(saved: SavedEnv): void {
  for (const [key, value] of Object.entries(saved.vars)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/**
 * Get env vars for a provider config.
 */
export function getProviderEnvVars(provider: ProviderConfig): Record<string, string> {
  switch (provider.type) {
    case 'cloud':
      return {};
    case 'ollama':
      return {
        [ENV_ANTHROPIC_BASE_URL]: provider.baseUrl ?? DEFAULT_OLLAMA_URL,
        [ENV_ANTHROPIC_AUTH_TOKEN]: OLLAMA_AUTH_TOKEN,
        [ENV_ANTHROPIC_API_KEY]: '',
      };
    case 'lmstudio':
      return {
        [ENV_ANTHROPIC_BASE_URL]: provider.baseUrl ?? DEFAULT_LMSTUDIO_URL,
        [ENV_ANTHROPIC_AUTH_TOKEN]: provider.apiKey ?? LMSTUDIO_AUTH_TOKEN,
        [ENV_ANTHROPIC_API_KEY]: '',
      };
    default:
      return {};
  }
}
