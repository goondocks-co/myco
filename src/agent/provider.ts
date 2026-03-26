import type { ProviderConfig } from './types.js';

// ---------------------------------------------------------------------------
// Named constants — env var names and default values
// ---------------------------------------------------------------------------

const ENV_ANTHROPIC_BASE_URL = 'ANTHROPIC_BASE_URL';
const ENV_ANTHROPIC_AUTH_TOKEN = 'ANTHROPIC_AUTH_TOKEN';
const ENV_ANTHROPIC_API_KEY = 'ANTHROPIC_API_KEY';
const ENV_OLLAMA_NUM_CTX = 'OLLAMA_NUM_CTX';
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_LMSTUDIO_URL = 'http://localhost:1234';
const OLLAMA_AUTH_TOKEN = 'ollama';
const LMSTUDIO_AUTH_TOKEN = 'lmstudio';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build an env object for a phase's query() call.
 *
 * Returns `undefined` when no provider override is needed (SDK defaults to
 * `process.env`). Only creates a new object when overrides are required,
 * avoiding unnecessary copies of the full process.env.
 */
export function buildPhaseEnv(provider?: ProviderConfig): Record<string, string | undefined> | undefined {
  if (!provider || provider.type === 'cloud') return undefined;
  return { ...process.env, ...getProviderEnvVars(provider) };
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
        ...(provider.contextLength ? { [ENV_OLLAMA_NUM_CTX]: String(provider.contextLength) } : {}),
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
