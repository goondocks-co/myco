import type { MycoConfig, EmbeddingProviderConfig, TaskProviderOverride, PhaseOverride } from './schema.js';

/**
 * Set a value at a dot-separated path, returning a new config object.
 * Creates intermediate objects along the path as needed.
 */
export function withValue(config: MycoConfig, dotPath: string, value: unknown): MycoConfig {
  const clone = structuredClone(config) as Record<string, unknown>;
  const segments = dotPath.split('.');
  let current: Record<string, unknown> = clone;

  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (current[segment] === undefined || current[segment] === null || typeof current[segment] !== 'object') {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }

  current[segments[segments.length - 1]] = value;

  return clone as unknown as MycoConfig;
}

/** Provider override shape used in task config updates. Null means delete. */
interface ProviderInput {
  type: 'cloud' | 'ollama' | 'lmstudio';
  model?: string;
  base_url?: string;
  context_length?: number;
}

/** Phase override input. Null fields mean delete. */
interface PhaseInput {
  provider?: ProviderInput | null;
  model?: string | null;
  maxTurns?: number | null;
}

/** Input shape for task config updates. Null values mean "delete this field". */
export interface TaskConfigUpdate {
  provider?: ProviderInput | null;
  model?: string | null;
  maxTurns?: number | null;
  timeoutSeconds?: number | null;
  phases?: Record<string, PhaseInput | null> | null;
}

/**
 * Apply partial task config updates, returning a new config object.
 * Null values delete fields. Empty task entries and phase maps are cleaned up.
 */
export function withTaskConfig(
  config: MycoConfig,
  taskId: string,
  update: TaskConfigUpdate,
): MycoConfig {
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
  };
}

/**
 * Merge partial embedding updates into config, returning a new config object.
 */
export function withEmbedding(
  config: MycoConfig,
  updates: Partial<EmbeddingProviderConfig>,
): MycoConfig {
  return {
    ...config,
    embedding: { ...config.embedding, ...updates },
  };
}
