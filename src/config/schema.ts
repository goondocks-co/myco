import { z } from 'zod';

const LlmProviderSchema = z.object({
  provider: z.enum(['ollama', 'lm-studio', 'anthropic']),
  model: z.string(),
  base_url: z.string().url().optional(),
  context_window: z.number().int().positive().default(8192),
  max_tokens: z.number().int().positive().default(1024),
});

const EmbeddingProviderSchema = z.object({
  provider: z.enum(['ollama', 'lm-studio']),
  model: z.string(),
  base_url: z.string().url().optional(),
});

const IntelligenceSchema = z.object({
  llm: LlmProviderSchema,
  embedding: EmbeddingProviderSchema,
});

const DaemonSchema = z.object({
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
});

const ContextLayersSchema = z.object({
  plans: z.number().int().nonnegative().default(200),
  sessions: z.number().int().nonnegative().default(500),
  memories: z.number().int().nonnegative().default(300),
  team: z.number().int().nonnegative().default(200),
});

const ContextSchema = z.object({
  max_tokens: z.number().int().positive().default(1200),
  layers: ContextLayersSchema.default({ plans: 200, sessions: 500, memories: 300, team: 200 }),
});

const TeamSchema = z.object({
  enabled: z.boolean().default(false),
  user: z.string().default(''),
  sync: z.enum(['git', 'obsidian-sync', 'manual']).default('git'),
});

export const MycoConfigSchema = z.object({
  version: z.literal(2),
  intelligence: IntelligenceSchema,
  daemon: DaemonSchema.default({ log_level: 'info', grace_period: 30, max_log_size: 5_242_880 }),
  capture: CaptureSchema.default({ transcript_paths: [], artifact_watch: ['.claude/plans/', '.cursor/plans/'], artifact_extensions: ['.md'], buffer_max_events: 500 }),
  context: ContextSchema.default({ max_tokens: 1200, layers: { plans: 200, sessions: 500, memories: 300, team: 200 } }),
  team: TeamSchema.default({ enabled: false, user: '', sync: 'git' }),
});

export type MycoConfig = z.infer<typeof MycoConfigSchema>;
export type LlmProviderConfig = z.infer<typeof LlmProviderSchema>;
export type EmbeddingProviderConfig = z.infer<typeof EmbeddingProviderSchema>;
