/**
 * Interactive init wizard for `myco init`.
 * Collects intelligence provider and embedding provider configuration
 * from the user via @inquirer/prompts.
 * The pure `buildEmbeddingConfig` and `buildAgentConfig` functions are
 * exported separately for testing.
 */
import { select, input, password } from '@inquirer/prompts';
import { OllamaBackend } from '../intelligence/ollama.js';
import { LmStudioBackend } from '../intelligence/lm-studio.js';
import { OpenRouterEmbeddingProvider } from './providers/openrouter.js';
import { OpenAIEmbeddingProvider } from './providers/openai-embeddings.js';
import {
  PROVIDER_DETECT_TIMEOUT_MS,
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
  DEFAULT_OPENAI_EMBEDDING_MODEL,
  RECOMMENDED_LOCAL_CONTEXT_WINDOW,
} from '../constants.js';
import { getPluginVersion } from '../version.js';

// --- Types ---

export interface WizardAnswers {
  // Intelligence provider
  intelligenceProvider: 'cloud' | 'ollama' | 'lmstudio';
  intelligenceModel?: string;
  intelligenceBaseUrl?: string;
  // Embedding provider
  embeddingProvider: 'ollama' | 'openrouter' | 'openai' | 'skip';
  embeddingModel?: string;
  embeddingApiKey?: string;
}

export interface EmbeddingConfig {
  provider: string;
  model: string;
}

// --- Pure functions ---

/** Convert wizard answers into a config object suitable for MycoConfigSchema embedding overrides. */
export function buildEmbeddingConfig(answers: WizardAnswers): EmbeddingConfig {
  if (answers.embeddingProvider === 'skip') {
    return {
      provider: 'ollama',
      model: DEFAULT_OLLAMA_EMBEDDING_MODEL,
    };
  }

  return {
    provider: answers.embeddingProvider,
    model: answers.embeddingModel ?? DEFAULT_OLLAMA_EMBEDDING_MODEL,
  };
}

/** Convert wizard answers into an agent config object for myco.yaml. */
export function buildAgentConfig(
  answers: WizardAnswers,
): { provider?: { type: string; base_url?: string; model?: string }; model?: string } | null {
  if (answers.intelligenceProvider === 'cloud') {
    return { provider: { type: 'cloud' } };
  }

  const provider: { type: string; base_url?: string; model?: string } = {
    type: answers.intelligenceProvider,
  };
  if (answers.intelligenceBaseUrl) provider.base_url = answers.intelligenceBaseUrl;
  if (answers.intelligenceModel) provider.model = answers.intelligenceModel;

  return {
    provider,
    model: answers.intelligenceModel,
  };
}

// --- Interactive wizard ---

/** Print the welcome banner with the current package version. */
function printBanner(): void {
  const version = getPluginVersion();
  console.log('');
  console.log(`  Myco v${version} — Collective Agent Intelligence`);
  console.log('  ─────────────────────────────────────────────');
  console.log('');
}

/** Platform-specific Ollama install instructions. */
function ollamaInstallHint(): string {
  if (process.platform === 'darwin') {
    return 'Install: brew install ollama && ollama serve';
  }
  if (process.platform === 'linux') {
    return 'Install: curl -fsSL https://ollama.com/install.sh | sh';
  }
  return 'Install: https://ollama.com/download';
}

/** Print local model context window recommendation. */
function printLocalModelTip(): void {
  console.log('');
  console.log(`  Tip: For local models, we recommend an ${RECOMMENDED_LOCAL_CONTEXT_WINDOW / 1024}K context window.`);
  console.log('  Set in myco.yaml under agent.tasks or configure via the dashboard.');
  console.log('');
}

// --- Intelligence provider step ---

/** Select a model from a local provider (Ollama or LM Studio). */
async function selectLocalIntelligenceModel(
  backend: OllamaBackend | LmStudioBackend,
  providerName: string,
): Promise<{ model?: string; baseUrl?: string }> {
  const available = await backend.isAvailable();

  if (!available) {
    console.log('');
    console.log(`  ${providerName} is not running.`);
    if (providerName === 'Ollama') {
      console.log(`  ${ollamaInstallHint()}`);
    } else {
      console.log('  Start LM Studio and enable the local server.');
    }
    console.log('');

    const action = await select({
      message: `${providerName} is not available. What would you like to do?`,
      choices: [
        { name: `Retry (after starting ${providerName})`, value: 'retry' },
        { name: 'Continue without selecting a model', value: 'skip' },
      ],
    });

    if (action === 'retry') {
      return selectLocalIntelligenceModel(backend, providerName);
    }
    return {};
  }

  const models = await backend.listModels(PROVIDER_DETECT_TIMEOUT_MS);

  let model: string;

  if (models.length > 0) {
    model = await select({
      message: `Select an intelligence model from ${providerName}:`,
      choices: [
        ...models.map((m) => ({ name: m, value: m })),
        { name: 'Enter model name manually', value: '__manual__' },
      ],
      default: models[0],
    });
  } else {
    console.log(`  No models found in ${providerName}.`);
    model = '__manual__';
  }

  if (model === '__manual__') {
    model = await input({
      message: 'Model name:',
    });
  }

  printLocalModelTip();

  return { model: model || undefined };
}

/** Run the intelligence provider selection step. */
async function selectIntelligenceProvider(): Promise<Pick<WizardAnswers, 'intelligenceProvider' | 'intelligenceModel' | 'intelligenceBaseUrl'>> {
  const provider = await select<'cloud' | 'ollama' | 'lmstudio'>({
    message: 'How should Myco run intelligence tasks (extraction, summarization)?',
    choices: [
      { name: 'Cloud (Claude) — fast, requires Anthropic API key in env', value: 'cloud' },
      { name: 'Ollama (local, free)', value: 'ollama' },
      { name: 'LM Studio (local)', value: 'lmstudio' },
    ],
    default: 'cloud',
  });

  if (provider === 'cloud') {
    return { intelligenceProvider: 'cloud' };
  }

  if (provider === 'ollama') {
    const backend = new OllamaBackend();
    const result = await selectLocalIntelligenceModel(backend, 'Ollama');
    return {
      intelligenceProvider: 'ollama',
      intelligenceModel: result.model,
    };
  }

  // LM Studio
  const backend = new LmStudioBackend();
  const result = await selectLocalIntelligenceModel(backend, 'LM Studio');
  return {
    intelligenceProvider: 'lmstudio',
    intelligenceModel: result.model,
    intelligenceBaseUrl: result.baseUrl,
  };
}

// --- Embedding provider step ---

/** Prompt the user to select an embedding model from Ollama. */
async function selectOllamaEmbeddingModel(): Promise<Pick<WizardAnswers, 'embeddingProvider' | 'embeddingModel'>> {
  const backend = new OllamaBackend();
  const available = await backend.isAvailable();

  if (!available) {
    console.log('');
    console.log(`  Ollama is not running. ${ollamaInstallHint()}`);
    console.log('');

    const action = await select({
      message: 'Ollama is not available. What would you like to do?',
      choices: [
        { name: 'Retry (after starting Ollama)', value: 'retry' },
        { name: 'Switch to a cloud provider', value: 'switch' },
        { name: 'Skip embedding setup', value: 'skip' },
      ],
    });

    if (action === 'retry') {
      return selectOllamaEmbeddingModel();
    }
    if (action === 'switch') {
      return selectCloudEmbeddingProvider();
    }
    return { embeddingProvider: 'skip' };
  }

  const models = await backend.listModels(PROVIDER_DETECT_TIMEOUT_MS);
  const embeddingModels = models.filter(
    (m) => m.includes('bge') || m.includes('embed') || m.includes('nomic'),
  );

  let embeddingModel: string;

  if (embeddingModels.length > 0) {
    embeddingModel = await select({
      message: 'Select an embedding model:',
      choices: [
        ...embeddingModels.map((m) => ({ name: m, value: m })),
        { name: 'Enter model name manually', value: '__manual__' },
      ],
      default: embeddingModels.includes(DEFAULT_OLLAMA_EMBEDDING_MODEL)
        ? DEFAULT_OLLAMA_EMBEDDING_MODEL
        : embeddingModels[0],
    });
  } else {
    console.log(`  No embedding models found. Pull one first: ollama pull ${DEFAULT_OLLAMA_EMBEDDING_MODEL}`);
    embeddingModel = '__manual__';
  }

  if (embeddingModel === '__manual__') {
    embeddingModel = await input({
      message: 'Embedding model name:',
      default: DEFAULT_OLLAMA_EMBEDDING_MODEL,
    });
  }

  return { embeddingProvider: 'ollama', embeddingModel };
}

/** Prompt the user to pick between OpenRouter and OpenAI. */
async function selectCloudEmbeddingProvider(): Promise<Pick<WizardAnswers, 'embeddingProvider' | 'embeddingModel' | 'embeddingApiKey'>> {
  const provider = await select<'openrouter' | 'openai'>({
    message: 'Select a cloud embedding provider:',
    choices: [
      { name: 'OpenRouter (many models, one API key)', value: 'openrouter' },
      { name: 'OpenAI (text-embedding-3-small)', value: 'openai' },
    ],
  });

  return selectCloudEmbeddingModel(provider);
}

/** Collect API key and model for a cloud embedding provider. */
async function selectCloudEmbeddingModel(
  provider: 'openrouter' | 'openai',
): Promise<Pick<WizardAnswers, 'embeddingProvider' | 'embeddingModel' | 'embeddingApiKey'>> {
  const apiKey = await password({
    message: `Enter your ${provider === 'openrouter' ? 'OpenRouter' : 'OpenAI'} API key:`,
    mask: '*',
  });

  if (!apiKey) {
    console.log('  No API key provided. Skipping embedding setup.');
    return { embeddingProvider: 'skip' };
  }

  // Try to list models with the provided key
  let models: string[] = [];
  try {
    if (provider === 'openrouter') {
      const p = new OpenRouterEmbeddingProvider({ api_key: apiKey });
      models = await p.listModels(PROVIDER_DETECT_TIMEOUT_MS);
    } else {
      const p = new OpenAIEmbeddingProvider({ api_key: apiKey });
      models = await p.listModels(PROVIDER_DETECT_TIMEOUT_MS);
    }
  } catch {
    // Fall through to manual input
  }

  let embeddingModel: string;

  if (models.length > 0) {
    const defaultModel = provider === 'openrouter'
      ? `openai/${DEFAULT_OPENAI_EMBEDDING_MODEL}`
      : DEFAULT_OPENAI_EMBEDDING_MODEL;

    embeddingModel = await select({
      message: 'Select an embedding model:',
      choices: [
        ...models.map((m) => ({ name: m, value: m })),
        { name: 'Enter model ID manually', value: '__manual__' },
      ],
      default: models.includes(defaultModel) ? defaultModel : models[0],
    });
  } else {
    console.log('  Could not fetch model list. Enter the model ID manually.');
    embeddingModel = '__manual__';
  }

  if (embeddingModel === '__manual__') {
    const defaultModel = provider === 'openrouter'
      ? `openai/${DEFAULT_OPENAI_EMBEDDING_MODEL}`
      : DEFAULT_OPENAI_EMBEDDING_MODEL;

    embeddingModel = await input({
      message: 'Embedding model ID:',
      default: defaultModel,
    });
  }

  return {
    embeddingProvider: provider,
    embeddingModel,
    embeddingApiKey: apiKey,
  };
}

// --- Main wizard ---

/** Run the interactive init wizard. Returns intelligence and embedding configuration choices. */
export async function runWizard(): Promise<WizardAnswers> {
  printBanner();

  // Step 1: Intelligence provider
  const intelligenceAnswers = await selectIntelligenceProvider();

  // Step 2: Embedding provider
  const embeddingChoice = await select<'ollama' | 'cloud' | 'skip'>({
    message: 'How would you like to generate embeddings?',
    choices: [
      { name: 'Ollama (local, free, recommended)', value: 'ollama' },
      { name: 'Cloud provider (OpenRouter or OpenAI)', value: 'cloud' },
      { name: 'Skip for now (embeddings disabled)', value: 'skip' },
    ],
    default: 'ollama',
  });

  let embeddingAnswers: Pick<WizardAnswers, 'embeddingProvider' | 'embeddingModel' | 'embeddingApiKey'>;

  if (embeddingChoice === 'skip') {
    console.log('');
    console.log('  Skipping embedding setup. Semantic search and context injection');
    console.log('  will be disabled until you configure an embedding provider.');
    console.log('  Run `myco config` later to set one up.');
    console.log('');
    embeddingAnswers = { embeddingProvider: 'skip' };
  } else if (embeddingChoice === 'cloud') {
    embeddingAnswers = await selectCloudEmbeddingProvider();
  } else {
    embeddingAnswers = await selectOllamaEmbeddingModel();
  }

  return {
    ...intelligenceAnswers,
    ...embeddingAnswers,
  };
}
