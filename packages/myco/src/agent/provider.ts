import type { ProviderConfig } from './types.js';
import { CLAUDE_CODE_OAUTH_TOKEN_ENV } from '@myco/providers/env.js';

// ---------------------------------------------------------------------------
// Named constants — env var names and default values
// ---------------------------------------------------------------------------

const ENV_ANTHROPIC_BASE_URL = 'ANTHROPIC_BASE_URL';
const ENV_ANTHROPIC_AUTH_TOKEN = 'ANTHROPIC_AUTH_TOKEN';
const ENV_ANTHROPIC_API_KEY = 'ANTHROPIC_API_KEY';
// The machine-level headless credential for harness Claude CLI runs
// (loaded into process.env from secrets.env by loadLayeredSecrets).
// Local providers blank it — like ANTHROPIC_API_KEY above — so the
// user's subscription token never rides along into a run pointed at a
// local endpoint.
const ENV_CLAUDE_CODE_OAUTH_TOKEN = CLAUDE_CODE_OAUTH_TOKEN_ENV;
const ENV_OLLAMA_NUM_CTX = 'OLLAMA_NUM_CTX';
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
export const DEFAULT_LMSTUDIO_URL = 'http://localhost:1234';
export const DEFAULT_OPENAI_URL = 'https://api.openai.com/v1';
export const DEFAULT_OPENROUTER_URL = 'https://openrouter.ai/api/v1';
const OLLAMA_AUTH_TOKEN = 'ollama';
const LMSTUDIO_AUTH_TOKEN = 'lmstudio';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** True for provider types that route to a locally-hosted LLM endpoint. */
export function isLocalProvider(provider?: ProviderConfig): boolean {
  if (!provider) return false;
  return provider.type === 'lmstudio'
    || provider.type === 'ollama'
    || provider.type === 'openai-compatible';
}

/**
 * Build an env object for a phase's query() call.
 *
 * Captures a SNAPSHOT of `process.env` at build (prepare) time for EVERY
 * provider type, so a phase's env is frozen when it is prepared rather than
 * resolved lazily against a possibly-mutated live `process.env` when query()
 * actually runs. The daemon does mutate env transiently elsewhere (the
 * served-grove key-health classifier family, `daemon/host-serve.ts`), so
 * returning the live object here would let such a mutation leak into a phase.
 * The isolation is now explicit at the source rather than incidental to a
 * downstream snapshot in `claude.ts`.
 *
 * Only local providers layer overrides on top of the snapshot; cloud and
 * unset providers get the bare frozen snapshot — the exact env they resolved
 * against before, now captured explicitly.
 */
export function buildPhaseEnv(provider?: ProviderConfig): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = { ...process.env };
  if (
    !provider ||
    provider.type === 'anthropic' ||
    provider.type === 'openai' ||
    provider.type === 'openrouter' ||
    provider.type === 'openai-compatible'
  ) {
    return snapshot;
  }
  return { ...snapshot, ...getProviderEnvVars(provider) };
}

/**
 * Get env vars for a provider config.
 */
export function getProviderEnvVars(provider: ProviderConfig): Record<string, string> {
  switch (provider.type) {
    case 'anthropic':
      return {};
    case 'ollama':
      return {
        [ENV_ANTHROPIC_BASE_URL]: provider.baseUrl ?? DEFAULT_OLLAMA_URL,
        [ENV_ANTHROPIC_AUTH_TOKEN]: OLLAMA_AUTH_TOKEN,
        [ENV_ANTHROPIC_API_KEY]: '',
        [ENV_CLAUDE_CODE_OAUTH_TOKEN]: '',
        ...(provider.contextLength ? { [ENV_OLLAMA_NUM_CTX]: String(provider.contextLength) } : {}),
      };
    case 'lmstudio':
      return {
        [ENV_ANTHROPIC_BASE_URL]: provider.baseUrl ?? DEFAULT_LMSTUDIO_URL,
        [ENV_ANTHROPIC_AUTH_TOKEN]: provider.apiKey ?? LMSTUDIO_AUTH_TOKEN,
        [ENV_ANTHROPIC_API_KEY]: '',
        [ENV_CLAUDE_CODE_OAUTH_TOKEN]: '',
      };
    case 'openai':
      // Remote providers: baseUrl is hardcoded so the daemon's API key
      // cannot be sent to a caller-supplied host. Key flows from env only.
      return {
        OPENAI_BASE_URL: DEFAULT_OPENAI_URL,
      };
    case 'openrouter':
      return {
        OPENAI_BASE_URL: DEFAULT_OPENROUTER_URL,
      };
    case 'openai-compatible':
      return {
        ...(provider.baseUrl ? { OPENAI_BASE_URL: provider.baseUrl } : {}),
        ...(provider.apiKey ? { OPENAI_API_KEY: provider.apiKey } : {}),
      };
    default:
      return {};
  }
}
