import { OllamaBackend } from '../../intelligence/ollama.js';
import { LmStudioBackend } from '../../intelligence/lm-studio.js';
import {
  createLocalOpenAIBackend,
  inferLocalOpenAIBackendKind,
} from '../../intelligence/local-openai-backends.js';
import { OPENAI_API_KEY_ENV } from '../../cli/providers/openai-embeddings.js';
import { OPENROUTER_API_KEY_ENV } from '../../cli/providers/openrouter.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { DaemonLogger } from '../logger.js';

const MODEL_LIST_TIMEOUT_MS = 5000;
const REMOTE_MODELS_ENDPOINT = '/models';
const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const REMOTE_PROVIDER_TIMEOUT_MS = 5000;

/** Well-known Anthropic models — no list API available locally.
 *  Sonnet is first because it's the recommended default for all built-in
 *  tasks, and the UI auto-selects the first model when a provider is picked. */
export const ANTHROPIC_MODELS = [
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-haiku-4-5-20251001',
];

/** Patterns that indicate an embedding model (case-insensitive). */
const EMBEDDING_PATTERNS = [
  'embed', 'bge-', 'nomic-embed', 'e5-', 'gte-', 'granite-embedding',
];

/** Filter models to only include embedding models. */
function filterEmbeddingModels(models: string[]): string[] {
  return models.filter((m) => {
    const name = m.toLowerCase();
    return EMBEDDING_PATTERNS.some((p) => name.includes(p));
  });
}

/** Filter models to exclude embedding models (LLM-only). */
export function filterLlmModels(models: string[]): string[] {
  return models.filter((m) => {
    const name = m.toLowerCase();
    return !EMBEDDING_PATTERNS.some((p) => name.includes(p));
  });
}

type RemoteProviderType = 'openai' | 'openrouter';

const REMOTE_PROVIDER_DEFAULTS: Record<RemoteProviderType, string> = {
  openai: OPENAI_DEFAULT_BASE_URL,
  openrouter: OPENROUTER_DEFAULT_BASE_URL,
};

const REMOTE_PROVIDER_ENV_VARS: Record<RemoteProviderType, string> = {
  openai: OPENAI_API_KEY_ENV,
  openrouter: OPENROUTER_API_KEY_ENV,
};

function getRemoteProviderApiKey(provider: RemoteProviderType): string | undefined {
  const preferredKey = process.env[REMOTE_PROVIDER_ENV_VARS[provider]];
  if (preferredKey) return preferredKey;
  if (provider === 'openai') {
    return process.env.OPENAI_API_KEY;
  }
  return undefined;
}

async function fetchRemoteProviderModels(
  provider: RemoteProviderType,
  _baseUrl?: string,
  timeoutMs = REMOTE_PROVIDER_TIMEOUT_MS,
): Promise<string[]> {
  const apiKey = getRemoteProviderApiKey(provider);
  if (!apiKey) return [];

  // SSRF defense: remote providers carry the daemon's bearer secret, so the
  // baseUrl is locked to the hardcoded provider default. Caller-supplied
  // values (query string, executionOverrides) are intentionally ignored.
  const baseUrl = REMOTE_PROVIDER_DEFAULTS[provider];
  const response = await fetch(`${baseUrl}${REMOTE_MODELS_ENDPOINT}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`${provider} models request failed with ${response.status}`);
  }

  const data = await response.json() as { data?: Array<{ id?: string }> };
  const modelIds = (data.data ?? [])
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  return filterLlmModels(modelIds);
}

export async function handleGetModels(req: RouteRequest, logger?: DaemonLogger): Promise<RouteResponse> {
  const provider = req.query.provider;
  const type = req.query.type; // 'llm' | 'embedding' | undefined (all)
  const localBackend = req.query.local_backend;

  if (!provider) {
    return { status: 400, body: { error: 'provider query parameter required' } };
  }

  let models: string[] = [];
  let fetchError: string | undefined;

  try {
    const localBackendKind = inferLocalOpenAIBackendKind({
      type: provider === 'lm-studio' ? 'lmstudio' : provider as 'ollama' | 'lmstudio' | 'openai-compatible',
      localBackend: localBackend as 'ollama' | 'lmstudio' | undefined,
      baseUrl: req.query.base_url,
    });
    if (localBackendKind) {
      const backend = createLocalOpenAIBackend(localBackendKind, req.query.base_url);
      models = await backend.listModels(MODEL_LIST_TIMEOUT_MS);
    } else if (provider === 'anthropic') {
      models = ANTHROPIC_MODELS;
    } else if (provider === 'openai' || provider === 'openrouter') {
      // fetchRemoteProviderModels ignores caller-supplied baseUrl (SSRF
      // defense — see its implementation). Pass undefined explicitly so
      // readers don't think `req.query.base_url` reaches the fetch.
      models = await fetchRemoteProviderModels(provider, undefined, MODEL_LIST_TIMEOUT_MS);
    }
  } catch (err) {
    // Return the empty list so the UI still renders, but surface the
    // underlying reason so the caller can show "connection refused" /
    // "API key rejected" instead of an unexplained empty dropdown.
    fetchError = err instanceof Error ? err.message : String(err);
    logger?.warn(`models.${provider}.list-unavailable`, `${provider} model list unavailable`, { error: fetchError });
  }

  // Filter by type if requested
  if (type === 'embedding') {
    models = filterEmbeddingModels(models);
  } else if (type === 'llm') {
    models = filterLlmModels(models);
  }

  return {
    body: {
      provider,
      models,
      ...(fetchError ? { error: fetchError } : {}),
    },
  };
}

export {
  getRemoteProviderApiKey,
  fetchRemoteProviderModels,
};
