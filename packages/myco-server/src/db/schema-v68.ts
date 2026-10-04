/** Deployment leaves that have no running consumer. */
export const V68_RETIRED_SETTINGS = [
  'agent.event_tasks_enabled',
  'agent.harness',
  'agent.model',
  'agent.provider.base_url',
  'agent.provider.context_length',
  'agent.provider.effort_map.default.effort',
  'agent.provider.effort_map.default.verbosity',
  'agent.provider.effort_map.high.effort',
  'agent.provider.effort_map.high.verbosity',
  'agent.provider.effort_map.low.effort',
  'agent.provider.effort_map.low.verbosity',
  'agent.provider.local_backend',
  'agent.provider.model',
  'agent.provider.reasoning_map.default',
  'agent.provider.reasoning_map.high',
  'agent.provider.reasoning_map.low',
  'agent.provider.thinking_budget_map.default',
  'agent.provider.thinking_budget_map.high',
  'agent.provider.thinking_budget_map.low',
  'agent.provider.type',
  'agent.reasoningLevel',
  'agent.semantic_write_check_enabled',
  'agent.summary_batch_interval',
  'cortex.canopy.exclude.default_patterns',
  'cortex.digest.inject_on_session_start',
  'cortex.digest.tier',
  'notifications.retention_days',
  'skills.confidence_threshold',
  'skills.usage_stale_days',
] as const;

const retiredKeys = V68_RETIRED_SETTINGS.map((leaf) => `'${leaf}'`).join(', ');

/** Copy and verify every original row before removing it from active settings. */
export const V68_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS retired_deployment_settings (
     leaf       TEXT PRIMARY KEY,
     value      TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     updated_by TEXT NOT NULL,
     retired_at INTEGER NOT NULL)`,
  `INSERT OR IGNORE INTO retired_deployment_settings (leaf, value, updated_at, updated_by, retired_at)
     SELECT leaf, value, updated_at, updated_by, unixepoch() * 1000
       FROM deployment_settings WHERE leaf IN (${retiredKeys})`,
  `DROP TABLE IF EXISTS _v68_guard_retired_settings`,
  `CREATE TABLE _v68_guard_retired_settings (ok INTEGER NOT NULL CHECK (ok = 1))`,
  `INSERT INTO _v68_guard_retired_settings (ok)
     SELECT CASE WHEN NOT EXISTS (
       SELECT 1 FROM deployment_settings AS live
       WHERE live.leaf IN (${retiredKeys}) AND NOT EXISTS (
         SELECT 1 FROM retired_deployment_settings AS saved
         WHERE saved.leaf = live.leaf AND saved.value = live.value
           AND saved.updated_at = live.updated_at AND saved.updated_by = live.updated_by
       )
     ) THEN 1 ELSE 0 END`,
  `DROP TABLE _v68_guard_retired_settings`,
  `DELETE FROM deployment_settings WHERE leaf IN (${retiredKeys})`,
];
