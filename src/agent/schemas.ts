/**
 * Zod schemas for agent definition and task YAML validation.
 *
 * These schemas are shared between the loader (which validates YAML files)
 * and any other code that needs to parse or validate task/agent config.
 */

import { z } from 'zod/v4';

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

/** Current schema version for task config structures. */
export const CURRENT_TASK_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Shared sub-schemas
// ---------------------------------------------------------------------------

/** Schema for API provider configuration. */
export const ProviderConfigSchema = z.object({
  type: z.enum(['cloud', 'ollama', 'lmstudio']),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  model: z.string().optional(),
});

/** Schema for execution configuration overrides. */
export const ExecutionConfigSchema = z.object({
  model: z.string().optional(),
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
  maxTurns: z.number().optional(),
});

/** Schema for a single phase within a phased task pipeline. */
export const PhaseDefinitionSchema = z.object({
  name: z.string(),
  prompt: z.string(),
  tools: z.array(z.string()),
  maxTurns: z.number(),
  model: z.string().optional(),
  required: z.boolean(),
  dependsOn: z.array(z.string()).optional(),
  provider: ProviderConfigSchema.optional(),
  skipPriorContext: z.boolean().optional(),
});

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
  maxTurns: z.number().optional(),
  timeoutSeconds: z.number().optional(),
  phases: z.array(PhaseDefinitionSchema).optional(),
  execution: ExecutionConfigSchema.optional(),
  contextQueries: z.record(z.string(), z.array(ContextQuerySchema)).optional(),
  schemaVersion: z.number().optional(),
  orchestrator: OrchestratorConfigSchema.optional(),
});
