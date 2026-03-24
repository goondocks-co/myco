import { z } from 'zod';

const EmbeddingProviderSchema = z.object({
  provider: z.enum(['ollama', 'openai-compatible']).default('ollama'),
  model: z.string().default('bge-m3'),
  base_url: z.string().url().optional(),
});

const DaemonSchema = z.object({
  port: z.number().int().min(1024).max(65535).nullable().default(null),
  log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

const CaptureSchema = z.object({
  transcript_paths: z.array(z.string()).default([]),
  artifact_watch: z.array(z.string()).default(['.claude/plans/', '.cursor/plans/']),
  artifact_extensions: z.array(z.string()).default(['.md']),
  buffer_max_events: z.number().int().positive().default(500),
});

const AgentSchema = z.object({
  /** Whether the daemon automatically runs the agent on unprocessed batches. */
  auto_run: z.boolean().default(true),
  /** Seconds between agent timer checks. */
  interval_seconds: z.number().int().positive().default(300),
  /** Number of batches between event-driven summary triggers (0 to disable). */
  summary_batch_interval: z.number().int().min(0).default(5),
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
  }),
);

export type MycoConfig = z.output<typeof MycoConfigSchema>;
export type EmbeddingProviderConfig = z.infer<typeof EmbeddingProviderSchema>;
