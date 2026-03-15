import { z } from 'zod';

const LocalIntelligenceSchema = z.object({
  provider: z.enum(['ollama', 'lm-studio']).default('ollama'),
  embedding_model: z.string().default('nomic-embed-text'),
  summary_model: z.string().default('gpt-oss'),
  base_url: z.string().url().default('http://localhost:11434'),
});

const CloudIntelligenceSchema = z.object({
  summary_model: z.string().default('claude-haiku-4-5-20251001'),
  embedding_provider: z.enum(['voyage']).default('voyage'),
});

const IntelligenceSchema = z.object({
  backend: z.enum(['local', 'cloud']),
  local: LocalIntelligenceSchema.optional(),
  cloud: CloudIntelligenceSchema.optional(),
  context_window: z.number().int().positive().default(8192),
});

const DaemonSchema = z.object({
  log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  grace_period: z.number().int().positive().default(30),
  max_log_size: z.number().int().positive().default(5_242_880),
});

const CaptureSchema = z.object({
  transcript_paths: z.array(z.string()).default([]),
  artifact_watch: z.array(z.string()).default([
    'docs/superpowers/specs/',
    '.claude/plans/',
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
  layers: ContextLayersSchema.default({}),
});

const TeamSchema = z.object({
  enabled: z.boolean().default(false),
  user: z.string().default(''),
  sync: z.enum(['git', 'obsidian-sync', 'manual']).default('git'),
});

export const MycoConfigSchema = z.object({
  version: z.literal(1),
  intelligence: IntelligenceSchema,
  daemon: DaemonSchema.default({}),
  capture: CaptureSchema.default({}),
  context: ContextSchema.default({}),
  team: TeamSchema.default({}),
});

export type MycoConfig = z.infer<typeof MycoConfigSchema>;
