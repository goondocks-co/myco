import { OllamaBackend } from '../../intelligence/ollama.js';
import { LmStudioBackend } from '../../intelligence/lm-studio.js';
import type { RouteRequest, RouteResponse } from '../router.js';

const MODEL_LIST_TIMEOUT_MS = 5000;

/** Well-known Anthropic models — no list API available locally. */
const ANTHROPIC_MODELS = ['claude-sonnet-4-5-20250514', 'claude-haiku-4-5-20251001'];

export async function handleGetModels(req: RouteRequest): Promise<RouteResponse> {
  const provider = req.query.provider;

  if (!provider) {
    return { status: 400, body: { error: 'provider query parameter required' } };
  }

  let models: string[] = [];

  try {
    if (provider === 'ollama') {
      const backend = new OllamaBackend({ base_url: req.query.base_url });
      models = await backend.listModels(MODEL_LIST_TIMEOUT_MS);
    } else if (provider === 'lm-studio') {
      const backend = new LmStudioBackend({ base_url: req.query.base_url });
      models = await backend.listModels(MODEL_LIST_TIMEOUT_MS);
    } else if (provider === 'anthropic') {
      models = ANTHROPIC_MODELS;
    }
  } catch {
    // Provider unreachable — return empty list
  }

  return { body: { provider, models } };
}
