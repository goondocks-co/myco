import { checkLocalProvider } from '../intelligence/provider-check.js';

interface ProviderResult {
  available: boolean;
  models: string[];
}

interface DetectResult {
  ollama: ProviderResult;
  'lm-studio': ProviderResult;
  anthropic: ProviderResult;
}

export async function run(_args: string[]): Promise<void> {
  const [ollamaResult, lmStudioResult] = await Promise.all([
    checkLocalProvider('ollama'),
    checkLocalProvider('lmstudio'),
  ]);

  const result: DetectResult = {
    ollama: ollamaResult,
    'lm-studio': lmStudioResult,
    anthropic: { available: !!process.env.ANTHROPIC_API_KEY, models: [] },
  };

  console.log(JSON.stringify(result, null, 2));
}
