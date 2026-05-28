/**
 * Zod schemas for agent definition and task YAML validation.
 *
 * These schemas are shared between the loader (which validates YAML files)
 * and any other code that needs to parse or validate task/agent config.
 */

import { z } from 'zod/v4';
import { SCHEDULABLE_POWER_STATES } from '@myco/constants.js';

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

/** Current schema version for task config structures. */
export const CURRENT_TASK_SCHEMA_VERSION = 1;

export const HarnessIdSchema = z.string().min(1);
export const ReasoningLevelSchema = z.enum(['low', 'default', 'high']);

// ---------------------------------------------------------------------------
// Shared sub-schemas
// ---------------------------------------------------------------------------

/** Schema for API provider configuration. */
export const ProviderConfigSchema = z.object({
  type: z.enum(['anthropic', 'ollama', 'lmstudio', 'openai', 'openrouter', 'openai-compatible']),
  localBackend: z.enum(['ollama', 'lmstudio']).optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
  reasoningMap: z.object({
    low: z.string().optional(),
    default: z.string().optional(),
    high: z.string().optional(),
  }).optional(),
  contextLength: z.number().optional(),
});

/** Schema for execution configuration overrides. */
export const ExecutionConfigSchema = z.object({
  harness: HarnessIdSchema.optional(),
  model: z.string().optional(),
  reasoningLevel: ReasoningLevelSchema.optional(),
  maxTurns: z.number().optional(),
  timeoutSeconds: z.number().optional(),
  provider: ProviderConfigSchema.optional(),
});

/** Schema for a single context query entry. */
export const ContextQuerySchema = z.object({
  tool: z.string(),
  queryTemplate: z.string(),
  limit: z.number(),
  purpose: z.string(),
  required: z.boolean(),
});

// ---------------------------------------------------------------------------
// Agent definition schema
// ---------------------------------------------------------------------------

/** Schema for agent.yaml agent definition files. */
export const AgentDefinitionSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  model: z.string(),
  maxTurns: z.number(),
  timeoutSeconds: z.number(),
  systemPromptPath: z.string(),
  tools: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Task schemas
// ---------------------------------------------------------------------------

/** Schema for orchestrator configuration on a task definition. */
export const OrchestratorConfigSchema = z.object({
  enabled: z.boolean(),
  model: z.string().optional(),
  reasoningLevel: ReasoningLevelSchema.optional(),
  maxTurns: z.number().optional(),
});

/** Pre-condition identifiers for scheduled task auto-runs. */
const PreConditionSchema = z.enum([
  'has-unprocessed-batches',
  'has-active-skills',
  'has-approved-candidates',
  'has-skill-survey-evidence',
  'has-pending-canopy-rows',
]);

/**
 * Accelerator names dispatch into domain-owned count functions in
 * daemon/task-scheduling.ts. Naming convention: `<domain>-<entity>`.
 * Adding a new accelerator: register a count function in the domain
 * package, add to the dispatch table, add the name here.
 */
export const AcceleratorNameSchema = z.enum([
  'canopy-pending-describe',
  'unprocessed-settled-batches',
]);
export type AcceleratorName = z.infer<typeof AcceleratorNameSchema>;

/**
 * Adaptive accelerator config. Tier divisors are 1× / 4× / 12×
 * applied to intervalSeconds; PowerManager's tick rate is the real
 * lower bound on actual fire rate, so effective intervals below the
 * tick just mean "gate clears every tick." Thresholds live in YAML
 * per-task because work-unit semantics differ (50 canopy rows ≪ 50
 * unprocessed prompt batches in real cost).
 */
export const AcceleratorConfigSchema = z.object({
  name: AcceleratorNameSchema,
  thresholds: z.object({
    steady: z.number().int().nonnegative(),
    accelerated: z.number().int().nonnegative(),
  }),
});
export type AcceleratorConfig = z.infer<typeof AcceleratorConfigSchema>;

/** Schedule configuration for automatic task execution via PowerManager. */
export const TaskScheduleSchema = z.object({
  /** Whether auto-run is enabled for this task. */
  enabled: z.boolean().default(false),
  /** Seconds between runs. */
  intervalSeconds: z.number().int().positive(),
  /** PowerManager states where this task runs. */
  runIn: z.array(z.enum([...SCHEDULABLE_POWER_STATES])).min(1),
  /** Optional pre-condition check before running. */
  preCondition: PreConditionSchema.optional(),
  /**
   * Optional adaptive accelerator. When declared, the scheduler queries
   * the registered count function and shortens the effective interval
   * during backlog according to the declared thresholds.
   */
  accelerator: AcceleratorConfigSchema.optional(),
  /**
   * Hard ceiling on completed-or-failed runs of this task per
   * (grove, project) tuple in the trailing 24 hours. When the count is
   * at-or-above the ceiling, the scheduler will not dispatch another run
   * until the oldest run rolls out of the window. Pairs with `accelerator`:
   * the accelerator decides cadence within the day, the ceiling caps the
   * day. Omit to leave run frequency bounded only by `intervalSeconds`.
   */
  maxRunsPerDay: z.number().int().positive().optional(),
});

// ---------------------------------------------------------------------------
// Map phase sub-schemas
// ---------------------------------------------------------------------------

const MapPhaseSourceSchema = z.object({
  tool: z.string().min(1),
  args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  itemsPath: z.string().min(1),
});

const MapPhaseItemSchema = z.object({
  prompt: z.string().min(1),
  readTools: z.array(z.string()).optional(),
});

const MapPhaseSinkSchema = z.object({
  tool: z.string().min(1),
  argMap: z.record(z.string(), z.string()).default({}),
});

/** Phase-level preCondition kinds. See PhasePreConditionKind in types.ts. */
const PhasePreConditionSchema = z.enum([
  'has-recent-spore-activity',
  'has-recent-consolidatable-spores',
]);

/** Schema for a single phase within a phased task pipeline. */
export const PhaseDefinitionSchema = z.object({
  name: z.string(),
  prompt: z.string(),
  tools: z.array(z.string()),
  maxTurns: z.number(),
  model: z.string().optional(),
  reasoningLevel: ReasoningLevelSchema.optional(),
  required: z.boolean(),
  dependsOn: z.array(z.string()).optional(),
  provider: ProviderConfigSchema.optional(),
  skipPriorContext: z.boolean().optional(),
  readOnly: z.boolean().optional(),
  preCondition: PhasePreConditionSchema.optional(),

  // --- Map mode -------------------------------------------------------------
  mode: z.enum(['agent', 'map']).optional(),
  perItemMaxTurns: z.number().int().positive().optional(),
  perItemTimeoutSeconds: z.number().int().positive().optional(),
  onItemError: z.enum(['skip', 'abort']).optional().default('skip'),
  source: MapPhaseSourceSchema.optional(),
  item: MapPhaseItemSchema.optional(),
  sink: MapPhaseSinkSchema.optional(),
}).refine(
  (p) => p.mode !== 'map' || (p.source && p.item && p.sink),
  { message: 'mode: map requires source, item, and sink blocks' },
);

/** Schema for task YAML files in tasks/. */
export const AgentTaskSchema = z.object({
  name: z.string(),
  displayName: z.string(),
  description: z.string(),
  agent: z.string(),
  prompt: z.string(),
  isDefault: z.boolean(),
  toolOverrides: z.array(z.string()).optional(),
  model: z.string().optional(),
  reasoningLevel: ReasoningLevelSchema.optional(),
  maxTurns: z.number().optional(),
  timeoutSeconds: z.number().optional(),
  phases: z.array(PhaseDefinitionSchema).optional(),
  execution: ExecutionConfigSchema.optional(),
  contextQueries: z.record(z.string(), z.array(ContextQuerySchema)).optional(),
  schemaVersion: z.number().optional(),
  orchestrator: OrchestratorConfigSchema.optional(),
  schedule: TaskScheduleSchema.optional(),
  /** Task-specific params with defaults. */
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
