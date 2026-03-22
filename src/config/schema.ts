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

export const MycoConfigSchema = z.object({
  version: z.literal(3),
  config_version: z.number().int().nonnegative().default(0),
  embedding: EmbeddingProviderSchema.default(() => EmbeddingProviderSchema.parse({})),
  daemon: DaemonSchema.default(() => DaemonSchema.parse({})),
  capture: CaptureSchema.default(() => CaptureSchema.parse({})),
});

export type MycoConfig = z.infer<typeof MycoConfigSchema>;
export type EmbeddingProviderConfig = z.infer<typeof EmbeddingProviderSchema>;
