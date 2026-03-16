import { PROVIDER_DETECT_TIMEOUT_MS } from '../constants.js';
import { OllamaBackend } from '../intelligence/ollama.js';
import { LmStudioBackend } from '../intelligence/lm-studio.js';

interface ProviderResult {
  available: boolean;
  models: string[];
}

interface DetectResult {
  ollama: ProviderResult;
  'lm-studio': ProviderResult;
  anthropic: ProviderResult;
}

async function detectProvider(
  backend: { isAvailable(): Promise<boolean>; listModels(timeoutMs?: number): Promise<string[]> },
): Promise<ProviderResult> {
  const available = await backend.isAvailable();
  if (!available) return { available: false, models: [] };
  const models = await backend.listModels(PROVIDER_DETECT_TIMEOUT_MS);
  return { available: true, models };
}

export async function run(_args: string[]): Promise<void> {
  const ollama = new OllamaBackend();
  const lmStudio = new LmStudioBackend();

  const [ollamaResult, lmStudioResult] = await Promise.all([
    detectProvider(ollama),
    detectProvider(lmStudio),
  ]);

  const result: DetectResult = {
    ollama: ollamaResult,
    'lm-studio': lmStudioResult,
    anthropic: { available: !!process.env.ANTHROPIC_API_KEY, models: [] },
  };

  console.log(JSON.stringify(result, null, 2));
}
