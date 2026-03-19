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
  provider: z.enum(['ollama', 'lm-studio', 'anthropic']).nullable().default(null),
  model: z.string().nullable().default(null),
  base_url: z.string().nullable().default(null),
  context_window: z.number().int().positive().default(32768),
});

const DigestMetabolismSchema = z.object({
  active_interval: z.number().int().positive().default(300),
  cooldown_intervals: z.array(z.number().int().positive()).default([900, 1800, 3600]),
  dormancy_threshold: z.number().int().positive().default(7200),
});

const DigestSubstrateSchema = z.object({
  max_notes_per_cycle: z.number().int().positive().default(50),
});

const DigestSchema = z.object({
  enabled: z.boolean().default(true),
  tiers: z.array(z.number().int().positive()).default([1500, 3000, 5000, 10000]),
  inject_tier: z.number().int().positive().nullable().default(3000),
  intelligence: DigestIntelligenceSchema.default(() => DigestIntelligenceSchema.parse({})),
  metabolism: DigestMetabolismSchema.default(() => DigestMetabolismSchema.parse({})),
  substrate: DigestSubstrateSchema.default(() => DigestSubstrateSchema.parse({})),
});

export const MycoConfigSchema = z.object({
  version: z.literal(2),
  intelligence: IntelligenceSchema,
  daemon: DaemonSchema.default({ log_level: 'info', grace_period: 30, max_log_size: 5_242_880 }),
  capture: CaptureSchema.default({ transcript_paths: [], artifact_watch: ['.claude/plans/', '.cursor/plans/'], artifact_extensions: ['.md'], buffer_max_events: 500 }),
  context: ContextSchema.default({ max_tokens: 1200, layers: { plans: 200, sessions: 500, spores: 300, team: 200 } }),
  team: TeamSchema.default({ enabled: false, user: '', sync: 'git' }),
  digest: DigestSchema.default(() => DigestSchema.parse({})),
});

export type MycoConfig = z.infer<typeof MycoConfigSchema>;
export type LlmProviderConfig = z.infer<typeof LlmProviderSchema>;
export type EmbeddingProviderConfig = z.infer<typeof EmbeddingProviderSchema>;
export type DigestConfig = z.infer<typeof DigestSchema>;
export type DigestIntelligenceConfig = z.infer<typeof DigestIntelligenceSchema>;
