
const archiveLeaf = 'agent.tasks.extract-curate.schedule';
const schedule = '$."extract-curate".schedule';
const task = '$."extract-curate"';
const hasSchedule = `CASE WHEN json_valid(value) THEN json_type(value, '${schedule}') IS NOT NULL ELSE 1 END`;

/** The learning pause preserves owner preferences and the attempts already under lease. */
export const V102_STATEMENTS: readonly string[] = [
  `INSERT OR IGNORE INTO retired_deployment_settings (leaf,value,updated_at,updated_by,retired_at)
    SELECT '${archiveLeaf}',value,updated_at,updated_by,unixepoch()*1000
    FROM deployment_settings WHERE leaf='agent.tasks' AND ${hasSchedule}`,
  `CREATE TABLE IF NOT EXISTS _v102_guard_learning_settings (ok INTEGER NOT NULL CHECK (ok=1))`,
  `INSERT INTO _v102_guard_learning_settings(ok) SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM deployment_settings live WHERE leaf='agent.tasks' AND ${hasSchedule}
    AND NOT EXISTS (SELECT 1 FROM retired_deployment_settings saved WHERE saved.leaf='${archiveLeaf}'
      AND saved.value=live.value AND saved.updated_at=live.updated_at AND saved.updated_by=live.updated_by)
    ) THEN 1 ELSE 0 END`,
  `DROP TABLE _v102_guard_learning_settings`,
  ...['enabled','memberRunsPerDay'].map(field => `UPDATE deployment_settings
    SET value=json_set(value, '${task}.${field}', json(value -> '${schedule}.${field}')),
      write_id=lower(hex(randomblob(16)))
    WHERE leaf='agent.tasks' AND CASE WHEN json_valid(value) THEN
      json_type(value)='object' AND json_type(value, '${task}')='object'
      AND json_type(value, '${schedule}')='object'
      AND json_type(value, '${schedule}.${field}') IS NOT NULL
      AND json_type(value, '${task}.${field}') IS NULL ELSE 0 END`),
  `UPDATE deployment_settings SET value=json_remove(value, '${schedule}'),write_id=lower(hex(randomblob(16)))
    WHERE leaf='agent.tasks' AND CASE WHEN json_valid(value) THEN
      json_type(value)='object' AND json_type(value, '${task}')='object'
      AND json_type(value, '${schedule}')='object' ELSE 0 END`,
  `INSERT OR IGNORE INTO schema_meta(key,value) VALUES ('learning_paused_at',CAST(unixepoch()*1000 AS TEXT))`,
  `UPDATE member_credentials SET revoked_at=(SELECT CAST(value AS INTEGER) FROM schema_meta WHERE key='learning_paused_at'),
      revoked_by='mem_harness'
    WHERE member_id='mem_harness' AND revoked_at IS NULL AND EXISTS (
      SELECT 1 FROM agent_runs WHERE status='queued' AND task='extract-curate' AND dispatched_by=member_credentials.id)`,
  `UPDATE agent_runs SET status='skipped',
    completed_at=(SELECT CAST(value AS INTEGER) FROM schema_meta WHERE key='learning_paused_at'),
    run_context='{"reason":"learning_paused"}',held_by=NULL,dispatch_spec=NULL
    WHERE status='queued' AND task='extract-curate'`,
];
