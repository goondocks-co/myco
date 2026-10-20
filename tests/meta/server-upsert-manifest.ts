import type { UpsertDeclaration } from './server-upsert-inventory.js';
/** Every literal conflict-update occurrence, in source order within its owner. */
export const RECONCILED_UPSERTS: Record<string, UpsertDeclaration[]> = {
  'auth/members-admin.ts#nameMemberFromLogin': [
    { tables: ['schema_meta'], order: 'monotonic' },
  ],
  'core/backup.ts#claimRestoreTable': [
    { tables: ['backup_restore_progress'], order: 'monotonic' },
  ],
  'core/canopy.ts#writeCanopyMap': [
    { tables: ['canopy_maps'], order: 'writer-revision' },
  ],
  'core/embedding/reconcile.ts#passOver': [
    { tables: ['embedding_source_failures'], order: 'writer-revision' },
  ],
  'core/embedding/reconcile.ts#writeSource': [
    { tables: ['embedding_cursors'], order: 'writer-revision' },
    { tables: ['embedding_receipts'], order: 'writer-revision' },
  ],
  'core/embedding/work-state.ts#recordedWork': [
    { tables: ['embedding_work_state'], order: 'writer-revision' },
  ],
  'core/harness-health.ts#recordProvisionedHarnessReport': [
    { tables: ['machine_harness_reports'], order: 'monotonic' },
  ],
  'core/machine-settings.ts#machineBlockFor': [
    { tables: ['machine_settings_snapshots'], order: 'writer-revision' },
  ],
  'core/machine-settings.ts#setMachineLeaf': [
    { tables: ['machine_settings'], order: 'writer-revision' },
  ],
  'core/model-catalogs.ts#recordModelCatalog': [
    { tables: ['worker_model_catalogs', 'runner_model_catalogs'], order: 'reporter-stamp' },
  ],
  'core/release-provenance.ts#<module>': [
    { tables: ['knowledge_release_state'], order: 'keyed-immutable' },
  ],
  'core/runner-updates.ts#runnerUpdateReportStatements': [
    { tables: ['runner_update_reports'], order: 'reporter-stamp' },
  ],
  'core/runs.ts#upsertAgent': [
    { tables: ['agents'], order: 'monotonic' },
  ],
  'core/secrets.ts#put': [
    { tables: ['deployment_secrets'], order: 'writer-revision' },
  ],
  'core/settings.ts#resetRecord': [
    { tables: ['deployment_setting_resets'], order: 'writer-revision' },
  ],
  'core/settings.ts#setCapability': [
    { tables: ['project_capabilities'], order: 'writer-revision' },
  ],
  'core/settings.ts#setLeaf': [
    { tables: ['deployment_settings'], order: 'writer-revision' },
    { tables: ['deployment_settings'], order: 'writer-revision' },
  ],
  'core/settings.ts#setTaskTier': [
    { tables: ['deployment_settings'], order: 'writer-revision' },
    { tables: ['deployment_settings'], order: 'writer-revision' },
  ],
  'core/settings.ts#writeEmbedding': [
    { tables: ['deployment_settings'], order: 'writer-revision' },
    { tables: ['deployment_setting_resets'], order: 'writer-revision' },
  ],
  'core/settings.ts#writeSwitchedEmbedding': [
    { tables: ['deployment_settings'], order: 'writer-revision' },
    { tables: ['deployment_setting_resets'], order: 'writer-revision' },
  ],
  'core/storage-cleanup.ts#omissions': [
    { tables: ['storage_cleanup_omissions'], order: 'monotonic' },
  ],
  'core/worker-contacts.ts#runnerContactStatement': [
    { tables: ['runner_contacts'], order: 'monotonic' },
  ],
  'core/worker-contacts.ts#runnerObservationStatement': [
    { tables: ['runner_observations'], order: 'monotonic' },
  ],
  'core/worker-contacts.ts#workerContactStatement': [
    { tables: ['worker_contacts'], order: 'monotonic' },
  ],
  'db/read-budget-session-statements.ts#<module>': [
    { tables: ['session_read_facts'], order: 'monotonic' },
    { tables: ['session_read_facts'], order: 'monotonic' },
    { tables: ['session_read_facts'], order: 'monotonic' },
    { tables: ['session_read_facts'], order: 'monotonic' },
    { tables: ['project_session_counts'], order: 'monotonic' },
    { tables: ['project_session_counts'], order: 'monotonic' },
    { tables: ['project_session_counts'], order: 'monotonic' },
  ],
  'db/read-budget-session-statements.ts#contribution': [
    { tables: ['session_read_facts'], order: 'monotonic' },
  ],
  'db/read-budget-session-statements.ts#sessionPresent': [
    { tables: ['session_read_facts'], order: 'monotonic' },
  ],
  'db/schema-v20.ts#newSourceRevision': [
    { tables: ['embedding_versions'], order: 'monotonic' },
  ],
  'db/schema.ts#<module>': [
    { tables: ['embedding_versions'], order: 'monotonic' },
  ],
  'ingest/events.ts#planEventWrite': [
    { tables: ['sessions'], order: 'event-rank' },
  ],
  'ingest/projections.ts#plan': [
    { tables: ['plans'], order: 'event-rank' },
  ],
  'ingest/projections.ts#prompt': [
    { tables: ['prompt_batches'], order: 'event-rank' },
  ],
  'ingest/projections.ts#sessionCommit': [
    { tables: ['knowledge_git_provenance'], order: 'event-rank' },
  ],
  'ingest/projections.ts#toolCall': [
    { tables: ['tool_calls'], order: 'monotonic' },
  ],
  'ingest/projections.ts#transcriptSegment': [
    { tables: ['transcripts'], order: 'monotonic' },
  ],
  'ingest/uncaptured.ts#recordUncapturedStatement': [
    { tables: ['uncaptured_roots'], order: 'monotonic' },
  ],
  'platform/bun/vectors.ts#upsert': [
    { tables: ['local_vectors'], order: 'keyed-immutable' },
  ],
  'platform/cloudflare/recovery-producer-object.ts#checkpoint': [
    { tables: ['objects'], order: 'writer-revision' },
  ],
};
