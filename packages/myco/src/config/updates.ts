import type { MycoConfig, EmbeddingProviderConfig, TaskProviderOverride, PhaseOverride } from './schema.js';
import { setAtPath } from '../utils/dot-path.js';

/**
 * Minimal shape required by `withTaskConfig`. Both `MycoConfig` and `GroveConfig`
 * satisfy this interface, removing the need for `as unknown as MycoConfig` casts
 * at Grove-tier call sites.
 */
export interface WithTaskConfigShape {
  agent: { tasks?: Record<string, TaskProviderOverride> } & Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Set a value at a dot-separated path, returning a new config object.
 * Creates intermediate objects along the path as needed.
 */
export function withValue(config: MycoConfig, dotPath: string, value: unknown): MycoConfig {
  const clone = structuredClone(config) as MycoConfig & Record<string, unknown>;
  setAtPath(clone, dotPath, value);
  return clone as MycoConfig;
}

/**
 * Reject patch payloads that contain keys outside the helper's known set.
 *
 * Why this exists: Zod's default object mode strips unknown keys silently.
 * A `withX` helper that spreads `{ ...current, ...updates }` will pass
 * unknown keys to the schema, which strips them, and the writer returns
 * 200 OK with the unknown field silently discarded. The UI then refreshes
 * and shows the original value with no error — the canopy-describe params
 * save bug. This guard turns silent drops into loud 400s at the helper
 * boundary, before Zod ever sees the payload.
 *
 * Pattern: every patch-shaped helper (`withTaskConfig`, `withEmbedding`,
 * `withContext`, future ones) declares its known keys and calls this
 * before applying the patch. New fields require updating both the helper
 * and its allowlist together — the allowlist is the source of truth for
 * what the helper supports.
 */
export function assertKnownKeys<T extends object>(
  helperName: string,
  update: object,
  allowed: ReadonlySet<keyof T>,
): void {
  for (const key of Object.keys(update)) {
    if (!allowed.has(key as keyof T)) {
      throw new Error(
        `${helperName}: unknown field '${key}'. Allowed: ${[...allowed].join(', ')}`,
      );
    }
  }
}

/** Provider override shape used in task config updates. Null means delete. */
interface ProviderInput {
  type: 'anthropic' | 'ollama' | 'lmstudio' | 'openai' | 'openrouter' | 'openai-compatible';
  local_backend?: 'ollama' | 'lmstudio';
  model?: string;
  reasoning_map?: Partial<Record<'low' | 'default' | 'high', string>>;
  base_url?: string;
  context_length?: number;
}

/** Phase override input. Null fields mean delete. */
interface PhaseInput {
  provider?: ProviderInput | null;
  model?: string | null;
  maxTurns?: number | null;
}

interface ScheduleAcceleratorInput {
  name: 'canopy-pending-describe' | 'unprocessed-settled-batches';
  thresholds: {
    steady: number;
    accelerated: number;
  };
}

interface ScheduleInput {
  enabled?: boolean;
  intervalSeconds?: number;
  runIn?: ('active' | 'idle' | 'sleep')[];
  preCondition?: 'has-unprocessed-batches' | 'has-active-skills' | 'has-approved-candidates' | 'has-skill-survey-evidence' | 'has-pending-canopy-rows';
  accelerator?: ScheduleAcceleratorInput | null;
}

/** Input shape for task config updates. Null values mean "delete this field". */
export interface TaskConfigUpdate {
  provider?: ProviderInput | null;
  harness?: string | null;
  model?: string | null;
  maxTurns?: number | null;
  timeoutSeconds?: number | null;
  phases?: Record<string, PhaseInput | null> | null;
  schedule?: ScheduleInput | null;
  params?: Record<string, string | number | boolean> | null;
}

/**
 * Fields handled by `withTaskConfig`. Every entry here must have a matching
 * branch in withTaskConfig and a corresponding optional field on
 * TaskProviderOverrideSchema. Used by withTaskConfig itself to detect and
 * reject unknown keys at the boundary, so a stale UI payload (or a renamed
 * field) fails loudly instead of silently dropping the value to disk.
 */
const TASK_CONFIG_UPDATE_KEYS: ReadonlySet<keyof TaskConfigUpdate> = new Set([
  'provider',
  'harness',
  'model',
  'maxTurns',
  'timeoutSeconds',
  'phases',
  'schedule',
  'params',
]);

/**
 * Apply partial task config updates, returning a new config object.
 * Null values delete fields. Empty task entries and phase maps are cleaned up.
 */
export function withTaskConfig<T extends WithTaskConfigShape>(
  config: T,
  taskId: string,
  update: TaskConfigUpdate,
): T {
  assertKnownKeys<TaskConfigUpdate>('withTaskConfig', update, TASK_CONFIG_UPDATE_KEYS);

  const tasks = { ...(config.agent.tasks ?? {}) };
  const entry: TaskProviderOverride = { ...(tasks[taskId] ?? {}) };

  // Apply top-level fields
  if ('provider' in update) {
    if (update.provider === null) {
      delete entry.provider;
    } else if (update.provider !== undefined) {
      entry.provider = { ...update.provider };
    }
  }

  if ('harness' in update) {
    if (update.harness === null) delete entry.harness;
    else if (update.harness !== undefined) entry.harness = update.harness;
  }

  if ('model' in update) {
    if (update.model === null) delete entry.model;
    else if (update.model !== undefined) entry.model = update.model;
  }

  if ('maxTurns' in update) {
    if (update.maxTurns === null) delete entry.maxTurns;
    else if (update.maxTurns !== undefined) entry.maxTurns = update.maxTurns;
  }

  if ('timeoutSeconds' in update) {
    if (update.timeoutSeconds === null) delete entry.timeoutSeconds;
    else if (update.timeoutSeconds !== undefined) entry.timeoutSeconds = update.timeoutSeconds;
  }

  // Handle schedule
  if ('schedule' in update) {
    if (update.schedule === null) {
      delete entry.schedule;
    } else if (update.schedule !== undefined) {
      const { accelerator, ...scheduleUpdate } = update.schedule;
      const schedule = { ...entry.schedule, ...scheduleUpdate };
      if ('accelerator' in update.schedule) {
        if (accelerator === null) delete schedule.accelerator;
        else if (accelerator !== undefined) schedule.accelerator = accelerator;
      }
      entry.schedule = schedule;
    }
  }

  // Handle params (per-task scalar overrides like batch_size)
  if ('params' in update) {
    if (update.params === null) {
      delete entry.params;
    } else if (update.params !== undefined) {
      entry.params = { ...entry.params, ...update.params };
    }
  }

  // Apply phase overrides
  if ('phases' in update) {
    if (update.phases === null) {
      delete entry.phases;
    } else if (update.phases !== undefined) {
      const phases: Record<string, PhaseOverride> = { ...(entry.phases ?? {}) };

      for (const [phaseName, phaseValue] of Object.entries(update.phases)) {
        if (phaseValue === null) {
          delete phases[phaseName];
        } else {
          const pe: PhaseOverride = { ...(phases[phaseName] ?? {}) };
          if ('provider' in phaseValue) {
            if (phaseValue.provider === null) delete pe.provider;
            else if (phaseValue.provider !== undefined) pe.provider = { ...phaseValue.provider };
          }
          if ('model' in phaseValue) {
            if (phaseValue.model === null) delete pe.model;
            else if (phaseValue.model !== undefined) pe.model = phaseValue.model;
          }
          if ('maxTurns' in phaseValue) {
            if (phaseValue.maxTurns === null) delete pe.maxTurns;
            else if (phaseValue.maxTurns !== undefined) pe.maxTurns = phaseValue.maxTurns;
          }
          phases[phaseName] = pe;
        }
      }

      // Clean up empty phases map
      if (Object.keys(phases).length === 0) {
        delete entry.phases;
      } else {
        entry.phases = phases;
      }
    }
  }

  // Clean up empty task entry
  if (Object.keys(entry).length === 0) {
    delete tasks[taskId];
  } else {
    tasks[taskId] = entry;
  }

  return {
    ...config,
    agent: {
      ...config.agent,
      tasks: Object.keys(tasks).length > 0 ? tasks : undefined,
    },
  } as T;
}

/**
 * Allowlist for `withEmbedding`. Mirrors `EmbeddingProviderSchema` —
 * keep in sync when adding fields.
 */
const EMBEDDING_UPDATE_KEYS: ReadonlySet<keyof EmbeddingProviderConfig> = new Set([
  'provider',
  'model',
  'base_url',
  'run_in_deep_sleep',
]);

/**
 * Merge partial embedding updates into config, returning a new config object.
 */
export function withEmbedding(
  config: MycoConfig,
  updates: Partial<EmbeddingProviderConfig>,
): MycoConfig {
  assertKnownKeys<EmbeddingProviderConfig>('withEmbedding', updates, EMBEDDING_UPDATE_KEYS);
  return {
    ...config,
    embedding: { ...config.embedding, ...updates },
  };
}

// `withContext` was removed in config_version 8 — all Cortex settings
// (instructions, digest, spores, canopy) now live under `cortex.*`.
// Use the scoped-settings patch endpoint or `updateConfig` directly to
// modify any cortex.* field; tests can build patches inline rather than
// going through a bespoke helper.
