import { z } from 'zod';

const LlmProviderSchema = z.object({
  provider: z.enum(['ollama', 'lm-studio', 'anthropic', 'openai-compatible']).default('ollama'),
  model: z.string().default('qwen3.5'),
  base_url: z.string().url().optional(),
  context_window: z.number().int().positive().default(8192),
  max_tokens: z.number().int().positive().default(1024),
});

const EmbeddingProviderSchema = z.object({
  provider: z.enum(['ollama', 'lm-studio', 'openai-compatible']).default('ollama'),
  model: z.string().default('bge-m3'),
  base_url: z.string().url().optional(),
});

const IntelligenceSchema = z.object({
  llm: LlmProviderSchema.default(() => LlmProviderSchema.parse({})),
  embedding: EmbeddingProviderSchema.default(() => EmbeddingProviderSchema.parse({})),
});

const DaemonSchema = z.object({
  port: z.number().int().min(1024).max(65535).nullable().default(null),
  log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  grace_period: z.number().int().positive().default(30),
  max_log_size: z.number().int().positive().default(5_242_880),
});

const CaptureSchema = z.object({
  transcript_paths: z.array(z.string()).default([]),
  artifact_watch: z.array(z.string()).default([
    '.claude/plans/',
    '.cursor/plans/',
  ]),
  artifact_extensions: z.array(z.string()).default(['.md']),
  buffer_max_events: z.number().int().positive().default(500),
  /** Max output tokens for spore/observation extraction per batch. */
  extraction_max_tokens: z.number().int().positive().default(2048),
  /** Max output tokens for session summary generation. Higher = richer summaries for digest. */
  summary_max_tokens: z.number().int().positive().default(1024),
  /** Max output tokens for session title generation. */
  title_max_tokens: z.number().int().positive().default(32),
  /** Max output tokens for artifact classification. */
  classification_max_tokens: z.number().int().positive().default(1024),
});

const ContextLayersSchema = z.object({
  plans: z.number().int().nonnegative().default(200),
  sessions: z.number().int().nonnegative().default(500),
  spores: z.number().int().nonnegative().default(300),
  team: z.number().int().nonnegative().default(200),
});

const ContextSchema = z.object({
  max_tokens: z.number().int().positive().default(1200),
  layers: ContextLayersSchema.default({ plans: 200, sessions: 500, spores: 300, team: 200 }),
});

const TeamSchema = z.object({
  enabled: z.boolean().default(false),
  user: z.string().default(''),
  sync: z.enum(['git', 'obsidian-sync', 'manual']).default('git'),
});

const DigestIntelligenceSchema = z.object({
  provider: z.enum(['ollama', 'lm-studio', 'anthropic', 'openai-compatible']).nullable().default(null),
  model: z.string().nullable().default(null),
  base_url: z.string().nullable().default(null),
  context_window: z.number().int().positive().default(32768),
  /** Keep model loaded between digest cycles. Ollama duration string (e.g., "30m") or null for provider default. */
  keep_alive: z.string().nullable().default('30m'),
  /** Whether to offload KV cache to GPU. false = use system RAM (safer for large contexts). */
  gpu_kv_cache: z.boolean().default(false),
});

const DigestMetabolismSchema = z.object({
  active_interval: z.number().int().positive().default(900),
  cooldown_intervals: z.array(z.number().int().positive()).default([1800, 3600, 7200]),
  dormancy_threshold: z.number().int().positive().default(14400),
});

const DigestSubstrateSchema = z.object({
  max_notes_per_cycle: z.number().int().positive().default(50),
});

const ConsolidationSchema = z.object({
  enabled: z.boolean().default(false),
  /** Max output tokens for consolidation LLM synthesis. */
  max_tokens: z.number().int().positive().default(2048),
});

const PipelineRetrySchema = z.object({
  transient_max: z.number().int().positive().default(3),
  backoff_base_seconds: z.number().int().positive().default(30),
});

const PipelineCircuitBreakerSchema = z.object({
  failure_threshold: z.number().int().positive().default(3),
  cooldown_seconds: z.number().int().positive().default(300),
  max_cooldown_seconds: z.number().int().positive().default(3600),
});

const PipelineSchema = z.object({
  retention_days: z.number().int().positive().default(30),
  batch_size: z.number().int().positive().default(5),
  tick_interval_seconds: z.number().int().positive().default(30),
  retry: PipelineRetrySchema.default(() => PipelineRetrySchema.parse({})),
  circuit_breaker: PipelineCircuitBreakerSchema.default(() => PipelineCircuitBreakerSchema.parse({})),
});

const DigestSchema = z.object({
  enabled: z.boolean().default(true),
  tiers: z.array(z.number().int().positive()).default([1500, 3000, 5000, 7500]),
  inject_tier: z.number().int().positive().nullable().default(3000),
  intelligence: DigestIntelligenceSchema.default(() => DigestIntelligenceSchema.parse({})),
  metabolism: DigestMetabolismSchema.default(() => DigestMetabolismSchema.parse({})),
  substrate: DigestSubstrateSchema.default(() => DigestSubstrateSchema.parse({})),
  consolidation: ConsolidationSchema.default(() => ConsolidationSchema.parse({})),
});

export const MycoConfigSchema = z.object({
  version: z.literal(2),
  /** Tracks which migrations have been applied. Managed automatically. */
  config_version: z.number().int().nonnegative().default(0),
  intelligence: IntelligenceSchema.default(() => IntelligenceSchema.parse({})),
  daemon: DaemonSchema.default(() => DaemonSchema.parse({})),
  capture: CaptureSchema.default(() => CaptureSchema.parse({})),
  context: ContextSchema.default(() => ContextSchema.parse({})),
  team: TeamSchema.default(() => TeamSchema.parse({})),
  digest: DigestSchema.default(() => DigestSchema.parse({})),
  pipeline: PipelineSchema.default(() => PipelineSchema.parse({})),
});

export type MycoConfig = z.infer<typeof MycoConfigSchema>;
export type LlmProviderConfig = z.infer<typeof LlmProviderSchema>;
export type EmbeddingProviderConfig = z.infer<typeof EmbeddingProviderSchema>;
export type DigestConfig = z.infer<typeof DigestSchema>;
export type DigestIntelligenceConfig = z.infer<typeof DigestIntelligenceSchema>;
export type PipelineConfig = z.infer<typeof PipelineSchema>;
