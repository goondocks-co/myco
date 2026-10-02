/**
 * The serializable half of the settings contract: the targets a Deployment runs on, the effective answer the
 * settings surface gives for every leaf, and the embedding providers and models each target offers.
 *
 * The server resolves every value; the dashboard renders what the server answers and reads this module only for
 * the words and shapes, never to compute a default of its own.
 */

/** Where a Deployment runs: a Cloudflare Worker, or the self-hosted Bun server. */
export const DEPLOYMENT_TARGETS = ['cloudflare', 'bun'] as const;
export type DeploymentTarget = typeof DEPLOYMENT_TARGETS[number];

export const TARGET_LABELS: Readonly<Record<DeploymentTarget, string>> = { cloudflare: 'Cloudflare', bun: 'Self-hosted' };

/**
 * Where a leaf stands on this Deployment. `active`: the effective value is in use. `inactive`: it is valid but
 * something else keeps it from acting (a prerequisite, a higher-precedence override). `not-applicable`: this target
 * does not offer it, and a stored value is ignored. `invalid`: the stored value breaks the leaf's rule and is ignored.
 * `unknown`: the server cannot tell.
 */
export type SettingState = 'active' | 'inactive' | 'not-applicable' | 'invalid' | 'unknown';

/**
 * Where the effective value comes from: the stored value, the leaf's default, a per-task override, the platform the
 * Deployment runs on, a derived constant, nothing at all (`unset`), or nowhere usable because the stored value is
 * invalid.
 */
export type SettingSource = 'configured' | 'default' | 'task-override' | 'platform' | 'derived' | 'unset' | 'invalid';

/** The effective answer for one leaf, as the consumer that acts on it resolves it. */
export interface EffectiveSetting {
  /** What is stored, or null when nothing is. */
  stored: unknown;
  /** What the consumer acts on, or null when nothing is in effect. */
  effective: unknown;
  source: SettingSource;
  state: SettingState;
  /** Why the leaf is not active, or what the effective value means, in the reader's words. */
  reason: string | null;
  /** The targets this leaf applies to. */
  appliesTo: readonly DeploymentTarget[];
  /** Changes whenever the stored value is written or reset. */
  revision: string;
}

/** One embedding model as a target offers it, and why it cannot be chosen now, if it cannot. */
export interface EmbeddingModelChoice {
  id: string;
  dimensions: number | null;
  refusal: string | null;
  /** Whether Switch embedding model can move search to this model: true where `refusal` holds it only because search holds results. */
  rebuilds: boolean;
}

/**
 * A switch of the embedding model under way: the model search moves to, the one it keeps answering with until every
 * source holds a vector under the new one, how far the new vectors have come, and why it is paused, if it is.
 */
export interface EmbeddingSwitchStatus {
  id: string;
  provider: EmbeddingProviderId;
  providerLabel: string;
  model: string;
  dimensions: number | null;
  /** The model search answers with meanwhile, or null when none is in use. */
  from: { model: string; dimensions: number | null } | null;
  state: 'building' | 'paused';
  /** Why the switch is paused, or why its model is held off until `retryAt`, in the reader's words. */
  reason: string | null;
  /** While building, the instant the new model is asked again after it failed, or null. */
  retryAt: number | null;
  /** Why a building switch has not moved for a while, or null while it moves. */
  stalled: string | null;
  /**
   * Sources done under the new model (built, or skipped as unreadable), and every source search covers in Projects that
   * are not archived, the ones added meanwhile included.
   */
  done: number;
  total: number;
  /** Sources the new model could not read, which count as done, with each reason and how many it covers. */
  skipped: { count: number; reasons: Array<{ reason: string; count: number }> };
  startedAt: number;
  /** The tokens the new model is estimated to read, and what that costs where the provider publishes a price. */
  estimatedTokens: number;
  estimatedUsd: number | null;
}

/** What switching search to a model would read and cost, answered before an admin confirms it. */
export interface EmbeddingSwitchEstimate {
  provider: EmbeddingProviderId;
  model: string;
  sources: number;
  estimatedTokens: number;
  /** Null where the provider publishes no price. */
  estimatedUsd: number | null;
}

/** A provider a target offers, with its models and endpoint. */
export interface EmbeddingProviderChoice {
  id: EmbeddingProviderId;
  label: string;
  models: EmbeddingModelChoice[];
  defaultModel: string;
  customModels: boolean;
  endpoint: { editable: boolean; url: string | null };
  credential: 'openrouter' | 'openai' | null;
}

/** What the embedding picker offers on a Deployment: each provider and model, and what the search index holds. */
export interface EmbeddingChoices {
  target: DeploymentTarget;
  providers: EmbeddingProviderChoice[];
  /** The selection search uses now, or null when it matches words only. */
  selection: { provider: EmbeddingProviderId; model: string; endpoint: string | null; dimensions: number | null } | null;
  reason: string | null;
  /** The models whose vectors the index holds, with their dimensions. */
  held: Array<{ model: string; dimensions: number | null }>;
  /** The most dimensions one vector may have in the index. */
  capacity: number;
  /** Whether the model may change now: true only while search holds no results, since a change rebuilds it. */
  switchable: boolean;
  /** The switch of the embedding model under way, or null. */
  switch: EmbeddingSwitchStatus | null;
}

/** The embedding providers Myco can compute vectors with. */
export const EMBEDDING_PROVIDERS = ['workers-ai', 'openrouter', 'ollama', 'lmstudio', 'openai-compatible', 'openai'] as const;
export type EmbeddingProviderId = typeof EMBEDDING_PROVIDERS[number];

export interface EmbeddingModelOption {
  id: string;
  /** How many dimensions each vector has. */
  dimensions: number;
  /** What the provider charges, in US dollars, per million input tokens, where it publishes a price. */
  usdPerMillionTokens?: number;
}

export interface EmbeddingProviderSpec {
  label: string;
  /** The targets that offer this provider. */
  targets: readonly DeploymentTarget[];
  /** The models offered, the default first. */
  models: readonly EmbeddingModelOption[];
  defaultModel: string;
  /** Whether a model outside `models` may be named: a local server runs whatever was loaded into it. */
  customModels: boolean;
  /**
   * The request shape: `workers-ai` through the platform binding, `ollama` to `<endpoint>/api/embed`, `openai` to
   * `<endpoint>/embeddings`.
   */
  api: 'workers-ai' | 'ollama' | 'openai';
  /** The endpoint: fixed (`editable: false`), or one an admin may set, with its default (null: one must be set). */
  endpoint: { editable: false; url: string | null } | { editable: true; url: string | null };
  /** The Deployment key slot the provider's fixed endpoint receives, or null. */
  credential: 'openrouter' | 'openai' | null;
  /** The name a platform-bound provider's vectors are partitioned under, beside the model alone. */
  partition?: string;
}

/**
 * Targets whose earlier releases sent a fixed-endpoint provider's requests to a stored endpoint of the admin's
 * choosing, without its key. Such a stored endpoint is still honoured there, reported invalid, until it is reset.
 */
export const LEGACY_ENDPOINT_TARGETS: readonly DeploymentTarget[] = ['bun'];

/** The default embedding provider of each target; null means none until an admin chooses one. */
export const DEFAULT_EMBEDDING_PROVIDER: Readonly<Record<DeploymentTarget, EmbeddingProviderId | null>> = { cloudflare: 'workers-ai', bun: null };

/**
 * Embedding providers and models. Model ids and dimensions follow each provider's published catalogue, as cited in
 * `EMBEDDING_CATALOGUE_SOURCES`.
 */
export const EMBEDDING_CATALOGUE: Readonly<Record<EmbeddingProviderId, EmbeddingProviderSpec>> = {
  'workers-ai': {
    label: 'Cloudflare Workers AI',
    targets: ['cloudflare'],
    models: [
      { id: '@cf/baai/bge-m3', usdPerMillionTokens: 0.012, dimensions: 1024 },
      { id: '@cf/qwen/qwen3-embedding-0.6b', usdPerMillionTokens: 0.012, dimensions: 1024 },
      { id: '@cf/baai/bge-large-en-v1.5', usdPerMillionTokens: 0.204, dimensions: 1024 },
      { id: '@cf/baai/bge-base-en-v1.5', usdPerMillionTokens: 0.067, dimensions: 768 },
      { id: '@cf/baai/bge-small-en-v1.5', usdPerMillionTokens: 0.02, dimensions: 384 },
      { id: '@cf/google/embeddinggemma-300m', dimensions: 768 },
      { id: '@cf/pfnet/plamo-embedding-1b', usdPerMillionTokens: 0.019, dimensions: 2048 },
    ],
    defaultModel: '@cf/baai/bge-m3',
    customModels: false,
    api: 'workers-ai',
    endpoint: { editable: false, url: null },
    credential: null,
    partition: 'cloudflare',
  },
  openrouter: {
    label: 'OpenRouter',
    targets: ['cloudflare', 'bun'],
    models: [
      { id: 'openai/text-embedding-3-small', usdPerMillionTokens: 0.02, dimensions: 1536 },
      { id: 'baai/bge-m3', usdPerMillionTokens: 0.01, dimensions: 1024 },
      { id: 'baai/bge-large-en-v1.5', usdPerMillionTokens: 0.01, dimensions: 1024 },
      { id: 'baai/bge-base-en-v1.5', usdPerMillionTokens: 0.005, dimensions: 768 },
      { id: 'openai/text-embedding-3-large', usdPerMillionTokens: 0.13, dimensions: 3072 },
      { id: 'openai/text-embedding-ada-002', usdPerMillionTokens: 0.1, dimensions: 1536 },
      { id: 'mistralai/mistral-embed-2312', usdPerMillionTokens: 0.1, dimensions: 1024 },
      { id: 'mistralai/codestral-embed-2505', usdPerMillionTokens: 0.15, dimensions: 1536 },
      { id: 'google/gemini-embedding-001', usdPerMillionTokens: 0.15, dimensions: 3072 },
      { id: 'qwen/qwen3-embedding-4b', usdPerMillionTokens: 0.02, dimensions: 2560 },
      { id: 'qwen/qwen3-embedding-8b', usdPerMillionTokens: 0.01, dimensions: 4096 },
      { id: 'intfloat/multilingual-e5-large', usdPerMillionTokens: 0.01, dimensions: 1024 },
      { id: 'intfloat/e5-large-v2', usdPerMillionTokens: 0.01, dimensions: 1024 },
      { id: 'intfloat/e5-base-v2', usdPerMillionTokens: 0.005, dimensions: 768 },
      { id: 'thenlper/gte-large', usdPerMillionTokens: 0.01, dimensions: 1024 },
      { id: 'thenlper/gte-base', usdPerMillionTokens: 0.005, dimensions: 768 },
      { id: 'sentence-transformers/all-mpnet-base-v2', usdPerMillionTokens: 0.005, dimensions: 768 },
      { id: 'sentence-transformers/multi-qa-mpnet-base-dot-v1', usdPerMillionTokens: 0.005, dimensions: 768 },
      { id: 'sentence-transformers/all-minilm-l12-v2', usdPerMillionTokens: 0.005, dimensions: 384 },
      { id: 'sentence-transformers/all-minilm-l6-v2', usdPerMillionTokens: 0.005, dimensions: 384 },
      { id: 'sentence-transformers/paraphrase-minilm-l6-v2', usdPerMillionTokens: 0.005, dimensions: 384 },
    ],
    defaultModel: 'openai/text-embedding-3-small',
    customModels: false,
    api: 'openai',
    endpoint: { editable: false, url: 'https://openrouter.ai/api/v1' },
    credential: 'openrouter',
  },
  ollama: {
    label: 'Ollama',
    targets: ['bun'],
    models: [
      { id: 'bge-m3', dimensions: 1024 },
      { id: 'nomic-embed-text', dimensions: 768 },
      { id: 'mxbai-embed-large', dimensions: 1024 },
      { id: 'snowflake-arctic-embed2', dimensions: 1024 },
      { id: 'qwen3-embedding:0.6b', dimensions: 1024 },
      { id: 'embeddinggemma', dimensions: 768 },
      { id: 'all-minilm', dimensions: 384 },
    ],
    defaultModel: 'bge-m3',
    customModels: true,
    api: 'ollama',
    endpoint: { editable: true, url: 'http://localhost:11434' },
    credential: null,
  },
  lmstudio: {
    label: 'LM Studio',
    targets: ['bun'],
    models: [{ id: 'text-embedding-nomic-embed-text-v1.5', dimensions: 768 }],
    defaultModel: 'text-embedding-nomic-embed-text-v1.5',
    customModels: true,
    api: 'openai',
    endpoint: { editable: true, url: 'http://localhost:1234/v1' },
    credential: null,
  },
  'openai-compatible': {
    label: 'OpenAI-compatible server',
    targets: ['bun'],
    models: [],
    defaultModel: 'bge-m3',
    customModels: true,
    api: 'openai',
    endpoint: { editable: true, url: null },
    credential: null,
  },
  openai: {
    label: 'OpenAI',
    targets: ['bun'],
    models: [
      { id: 'text-embedding-3-small', usdPerMillionTokens: 0.02, dimensions: 1536 },
      { id: 'text-embedding-3-large', usdPerMillionTokens: 0.13, dimensions: 3072 },
      { id: 'text-embedding-ada-002', usdPerMillionTokens: 0.1, dimensions: 1536 },
    ],
    defaultModel: 'text-embedding-3-small',
    customModels: false,
    api: 'openai',
    endpoint: { editable: false, url: 'https://api.openai.com/v1' },
    credential: 'openai',
  },
};

/** Where each provider's model list, dimensions and prices were read from, and when. */
export const EMBEDDING_CATALOGUE_SOURCES: Readonly<Partial<Record<EmbeddingProviderId, { url: string; read: string; dimensions: string; prices: string }>>> = {
  'workers-ai': {
    url: 'https://developers.cloudflare.com/workers-ai/models/?tasks=Text+Embeddings',
    read: '2026-10-02',
    dimensions: 'https://developers.cloudflare.com/ai-search/configuration/models/supported-models/ and each model card (plamo-embedding-1b: huggingface.co/pfnet/plamo-embedding-1b)',
    prices: 'https://developers.cloudflare.com/workers-ai/platform/pricing/ (embeddinggemma-300m is not priced there)',
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1/embeddings/models',
    read: '2026-10-02',
    dimensions: 'each model’s published card; models whose dimensions are unpublished are not offered',
    prices: 'the same listing, pricing.prompt per token',
  },
  openai: {
    url: 'https://developers.openai.com/api/docs/pricing',
    read: '2026-10-02',
    dimensions: 'each model’s published card',
    prices: 'https://developers.openai.com/api/docs/pricing (standard input)',
  },
};

export const isEmbeddingProvider = (value: unknown): value is EmbeddingProviderId =>
  (EMBEDDING_PROVIDERS as readonly unknown[]).includes(value);

/** The dimensions of a provider's model, or null when the catalogue does not know them. */
export function embeddingDimensions(provider: EmbeddingProviderId, model: string): number | null {
  return EMBEDDING_CATALOGUE[provider].models.find((m) => m.id === model)?.dimensions ?? null;
}

/** What a provider charges per million input tokens for a model, or null where it publishes no price. */
export function embeddingPrice(provider: EmbeddingProviderId, model: string): number | null {
  return EMBEDDING_CATALOGUE[provider].models.find((m) => m.id === model)?.usdPerMillionTokens ?? null;
}

/** The providers a target offers, in catalogue order. */
export const embeddingProvidersFor = (target: DeploymentTarget): EmbeddingProviderId[] =>
  EMBEDDING_PROVIDERS.filter((id) => EMBEDDING_CATALOGUE[id].targets.includes(target));
