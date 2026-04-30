export interface CollectiveSettingDefinition {
  key: string;
  description: string;
  value_type: 'boolean' | 'integer' | 'number' | 'enum';
  example: unknown;
  minimum?: number;
  maximum?: number;
  enum_values?: string[];
}

const DIGEST_TIERS = [1500, 3000, 5000, 7500, 10000] as const;

// NOTE: keep these key strings in sync with `CORTEX_PATHS` and friends in
// `packages/myco/src/config/paths.ts`. The Cloudflare worker ships as a
// standalone package and can't import from the daemon source tree, so the
// path strings are inlined. A future cross-package paths module would
// remove the duplication; for now the rename pattern is pinned here.
export const COLLECTIVE_SETTING_DEFINITIONS: CollectiveSettingDefinition[] = [
  {
    key: 'agent.scheduled_tasks_enabled',
    description: 'Enable or disable PowerManager-scheduled agent tasks across connected nodes.',
    value_type: 'boolean',
    example: true,
  },
  {
    key: 'agent.event_tasks_enabled',
    description: 'Enable or disable event-driven agent tasks such as title and summary generation.',
    value_type: 'boolean',
    example: true,
  },
  {
    key: 'cortex.spores.inject_on_prompt_submit',
    description: 'Control whether prompt-submit spore injection is enabled for node context.',
    value_type: 'boolean',
    example: true,
  },
  {
    key: 'cortex.spores.max_per_prompt',
    description: 'Bound the number of spores injected per user prompt.',
    value_type: 'integer',
    example: 3,
    minimum: 0,
    maximum: 10,
  },
  {
    key: 'cortex.digest.tier',
    description: 'Select which digest tier should be used by myco_cortex op=digest and session-start digest injection.',
    value_type: 'integer',
    example: 5000,
  },
  {
    key: 'team.interval_minutes',
    description: 'Control the local team-sync poll interval in minutes.',
    value_type: 'integer',
    example: 15,
    minimum: 1,
    maximum: 1440,
  },
  {
    key: 'skills.confidence_threshold',
    description: 'Set the confidence threshold for auto-generating skill candidates.',
    value_type: 'number',
    example: 0.7,
    minimum: 0,
    maximum: 1,
  },
  {
    key: 'skills.usage_stale_days',
    description: 'Mark skills as stale after this many unused days.',
    value_type: 'integer',
    example: 30,
    minimum: 1,
  },
  {
    key: 'notifications.enabled',
    description: 'Enable or disable notifications globally.',
    value_type: 'boolean',
    example: true,
  },
  {
    key: 'notifications.system_notifications',
    description: 'Allow browser/system notifications on connected nodes.',
    value_type: 'boolean',
    example: false,
  },
  {
    key: 'notifications.default_mode',
    description: 'Choose the default display mode for notifications.',
    value_type: 'enum',
    example: 'banner',
    enum_values: ['banner', 'summary'],
  },
];

const DEFINITIONS_BY_KEY = new Map(
  COLLECTIVE_SETTING_DEFINITIONS.map((definition) => [definition.key, definition]),
);

export function getCollectiveSettingDefinition(key: string): CollectiveSettingDefinition | null {
  return DEFINITIONS_BY_KEY.get(key) ?? null;
}

export function validateCollectiveSetting(
  key: string,
  value: unknown,
): { ok: true; definition: CollectiveSettingDefinition } | { ok: false; error: string } {
  const definition = getCollectiveSettingDefinition(key);
  if (!definition) {
    return {
      ok: false,
      error: `Unsupported setting key "${key}". Allowed keys: ${COLLECTIVE_SETTING_DEFINITIONS.map((entry) => entry.key).join(', ')}`,
    };
  }

  switch (definition.value_type) {
    case 'boolean':
      if (typeof value !== 'boolean') {
        return { ok: false, error: `${key} must be a boolean` };
      }
      return { ok: true, definition };
    case 'integer':
      if (!Number.isInteger(value)) {
        return { ok: false, error: `${key} must be an integer` };
      }
      if (key === 'cortex.digest.tier' && !DIGEST_TIERS.includes(value as (typeof DIGEST_TIERS)[number])) {
        return { ok: false, error: `${key} must be one of ${DIGEST_TIERS.join(', ')}` };
      }
      if (definition.minimum !== undefined && (value as number) < definition.minimum) {
        return { ok: false, error: `${key} must be >= ${definition.minimum}` };
      }
      if (definition.maximum !== undefined && (value as number) > definition.maximum) {
        return { ok: false, error: `${key} must be <= ${definition.maximum}` };
      }
      return { ok: true, definition };
    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return { ok: false, error: `${key} must be a number` };
      }
      if (definition.minimum !== undefined && value < definition.minimum) {
        return { ok: false, error: `${key} must be >= ${definition.minimum}` };
      }
      if (definition.maximum !== undefined && value > definition.maximum) {
        return { ok: false, error: `${key} must be <= ${definition.maximum}` };
      }
      return { ok: true, definition };
    case 'enum':
      if (typeof value !== 'string' || !definition.enum_values?.includes(value)) {
        return { ok: false, error: `${key} must be one of ${(definition.enum_values ?? []).join(', ')}` };
      }
      return { ok: true, definition };
  }
}
