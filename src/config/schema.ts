import { z } from 'zod';

const EmbeddingProviderSchema = z.object({
  provider: z.enum(['ollama', 'openai-compatible', 'openrouter', 'openai']).default('ollama'),
  model: z.string().default('bge-m3'),
  base_url: z.string().url().optional(),
});

const DaemonSchema = z.object({
  port: z.number().int().min(1024).max(65535).nullable().default(null),
  log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  log_retention_days: z.number().int().min(1).max(365).default(30),
});

const CaptureSchema = z.object({
  transcript_paths: z.array(z.string()).default([]),
  plan_dirs: z.array(z.string()).default([]),
  artifact_extensions: z.array(z.string()).default(['.md']),
  buffer_max_events: z.number().int().positive().default(500),
});

/** Provider config shape used in both task-level and phase-level overrides. */
const ProviderOverrideSchema = z.object({
  type: z.enum(['cloud', 'ollama', 'lmstudio']),
  base_url: z.string().optional(),
  model: z.string().optional(),
  /** Context window size for local models (Ollama num_ctx, LM Studio context_length). */
  context_length: z.number().int().positive().optional(),
});

/** Per-phase overrides within a task — keyed by phase name. */
const PhaseOverrideSchema = z.object({
  provider: ProviderOverrideSchema.optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
});

/** Per-task config override — stored in myco.yaml under agent.tasks. */
const TaskProviderOverrideSchema = z.object({
  provider: ProviderOverrideSchema.optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  phases: z.record(z.string(), PhaseOverrideSchema).optional(),
});

const ContextSchema = z.object({
  /** Which digest tier to inject at session start. */
  digest_tier: z.number().int().default(5000),
  /** Enable semantic spore search on each user prompt. */
  prompt_search: z.boolean().default(true),
  /** Max spores to inject per prompt (0-10). */
  prompt_max_spores: z.number().int().min(0).max(10).default(3),
});

const AgentSchema = z.object({
  /** Whether the daemon automatically runs the agent on unprocessed batches. */
  auto_run: z.boolean().default(true),
  /** Seconds between agent timer checks. */
  interval_seconds: z.number().int().positive().default(300),
  /** Number of batches between event-driven summary triggers (0 to disable). */
  summary_batch_interval: z.number().int().min(0).default(5),
  /** Global default provider — applies to all tasks unless overridden per-task. */
  provider: ProviderOverrideSchema.optional(),
  /** Global default model — applies to all tasks unless overridden per-task. */
  model: z.string().optional(),
  /** Per-task overrides keyed by task name. */
  tasks: z.record(z.string(), TaskProviderOverrideSchema).optional(),
});

export const MycoConfigSchema = z.preprocess(
  (raw: unknown) => {
    if (raw && typeof raw === 'object' && 'curation' in raw && !('agent' in raw)) {
      const { curation, ...rest } = raw as Record<string, unknown>;
      return { ...rest, agent: curation };
    }
    return raw;
  },
  z.object({
    version: z.literal(3),
    config_version: z.number().int().nonnegative().default(0),
    embedding: EmbeddingProviderSchema.default(() => EmbeddingProviderSchema.parse({})),
    daemon: DaemonSchema.default(() => DaemonSchema.parse({})),
    capture: CaptureSchema.default(() => CaptureSchema.parse({})),
    agent: AgentSchema.default(() => AgentSchema.parse({})),
    context: ContextSchema.default(() => ContextSchema.parse({})),
  }),
);

export type MycoConfig = z.output<typeof MycoConfigSchema>;
export type EmbeddingProviderConfig = z.infer<typeof EmbeddingProviderSchema>;
export type TaskProviderOverride = z.infer<typeof TaskProviderOverrideSchema>;
export type PhaseOverride = z.infer<typeof PhaseOverrideSchema>;
export type ContextConfig = z.infer<typeof ContextSchema>;
