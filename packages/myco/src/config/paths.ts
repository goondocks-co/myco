/**
 * Canonical dotted-path constants for `MycoConfig`.
 *
 * Centralized here so renames flow through one location instead of being
 * hunted across schema, focus mappings, scoped-settings UI, and the
 * collective settings allowlist. Each constant is a `const` literal, so
 * it satisfies `ConfigPath` (the `DotPaths<MycoConfig>` union used by
 * `ScopedField` and `useScopedConfig().setField`) without losing the
 * literal type narrowing the typed surface relies on.
 *
 * Usage: import the relevant block and pass the constant as the path.
 *
 *   import { CORTEX_PATHS } from '@myco/config/paths';
 *
 *   <ScopedField path={CORTEX_PATHS.spores.injectOnPromptSubmit} … />
 *
 * Naming: dotted path mirrors the schema; the JS key is camelCase for
 * ergonomic consumption. The `as const` narrows the value type so
 * compile-time `ConfigPath` checks still apply.
 */

export const CORTEX_PATHS = {
  enabled: 'cortex.enabled',
  instructions: {
    injectOnSessionStart: 'cortex.instructions.inject_on_session_start',
    injectOnSubagentStart: 'cortex.instructions.inject_on_subagent_start',
  },
  digest: {
    tier: 'cortex.digest.tier',
    injectOnSessionStart: 'cortex.digest.inject_on_session_start',
  },
  spores: {
    injectOnPromptSubmit: 'cortex.spores.inject_on_prompt_submit',
    maxPerPrompt: 'cortex.spores.max_per_prompt',
  },
  canopy: {
    injectOnPreToolUse: 'cortex.canopy.inject_on_pre_tool_use',
    minFileBytes: 'cortex.canopy.min_file_bytes',
    refresh: {
      backgroundEnabled: 'cortex.canopy.refresh.background_enabled',
      backgroundPeriodMinutes: 'cortex.canopy.refresh.background_period_minutes',
    },
    exclude: {
      defaultPatterns: 'cortex.canopy.exclude.default_patterns',
      patterns: 'cortex.canopy.exclude.patterns',
    },
  },
} as const;

export const AGENT_PATHS = {
  scheduledTasksEnabled: 'agent.scheduled_tasks_enabled',
  eventTasksEnabled: 'agent.event_tasks_enabled',
  summaryBatchInterval: 'agent.summary_batch_interval',
  runRetentionDays: 'agent.run_retention_days',
} as const;

export const NOTIFICATIONS_PATHS = {
  enabled: 'notifications.enabled',
  systemNotifications: 'notifications.system_notifications',
  defaultMode: 'notifications.default_mode',
  retentionDays: 'notifications.retention_days',
} as const;

export const SKILLS_PATHS = {
  confidenceThreshold: 'skills.confidence_threshold',
  usageStaleDays: 'skills.usage_stale_days',
} as const;

export const TEAM_PATHS = {
  intervalMinutes: 'team.interval_minutes',
} as const;
