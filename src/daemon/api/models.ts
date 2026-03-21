import { OllamaBackend } from '../../intelligence/ollama.js';
import { LmStudioBackend } from '../../intelligence/lm-studio.js';
import type { RouteRequest, RouteResponse } from '../router.js';

const MODEL_LIST_TIMEOUT_MS = 5000;

/** Well-known Anthropic models — no list API available locally. */
const ANTHROPIC_MODELS = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
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
function filterLlmModels(models: string[]): string[] {
  return models.filter((m) => {
    const name = m.toLowerCase();
    return !EMBEDDING_PATTERNS.some((p) => name.includes(p));
  });
}

export async function handleGetModels(req: RouteRequest): Promise<RouteResponse> {
  const provider = req.query.provider;
  const type = req.query.type; // 'llm' | 'embedding' | undefined (all)

  if (!provider) {
    return { status: 400, body: { error: 'provider query parameter required' } };
  }

  let models: string[] = [];

  try {
    if (provider === 'ollama') {
      const backend = new OllamaBackend({ base_url: req.query.base_url });
      models = await backend.listModels(MODEL_LIST_TIMEOUT_MS);
    } else if (provider === 'lm-studio' || provider === 'openai-compatible') {
      const backend = new LmStudioBackend({ base_url: req.query.base_url });
      models = await backend.listModels(MODEL_LIST_TIMEOUT_MS);
    } else if (provider === 'anthropic') {
      models = ANTHROPIC_MODELS;
    }
  } catch {
    // Provider unreachable — return empty list
  }

  // Filter by type if requested
  if (type === 'embedding') {
    models = filterEmbeddingModels(models);
  } else if (type === 'llm') {
    models = filterLlmModels(models);
  }

  return { body: { provider, models } };
}
