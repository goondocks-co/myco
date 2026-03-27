import { OllamaBackend } from './ollama.js';
import { LmStudioBackend } from './lm-studio.js';
import { PROVIDER_DETECT_TIMEOUT_MS } from '../constants.js';

export interface ProviderStatus {
  available: boolean;
  models: string[];
}

/** Check if a local provider (Ollama or LM Studio) is reachable and list its models. */
export async function checkLocalProvider(
  type: 'ollama' | 'lmstudio',
  baseUrl?: string,
): Promise<ProviderStatus> {
  const backend = type === 'ollama'
    ? new OllamaBackend({ base_url: baseUrl })
    : new LmStudioBackend({ base_url: baseUrl });

  const available = await backend.isAvailable();
  if (!available) return { available: false, models: [] };
  const models = await backend.listModels(PROVIDER_DETECT_TIMEOUT_MS);
  return { available: true, models };
}
