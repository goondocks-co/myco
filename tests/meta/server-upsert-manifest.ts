import type { UpsertDeclaration } from './server-upsert-inventory.js';
/** Every literal conflict-update occurrence, in source order within its owner. */
export const RECONCILED_UPSERTS: Record<string, UpsertDeclaration[]> = {
  'auth/members-admin.ts#nameMemberFromLogin': [
    { tables: ['schema_meta'], order: 'unverified' },
  ],
  'core/backup.ts#claimRestoreTable': [
    { tables: ['backup_restore_progress'], order: 'unverified' },
  ],
  'core/backup.ts#restoreArtifact': [
    { tables: ['backup_restore_progress'], order: 'unverified' },
  ],
  'core/canopy.ts#writeCanopyMap': [
    { tables: ['canopy_maps'], order: 'unverified' },
  ],
  'core/embedding/reconcile.ts#passOver': [
    { tables: ['embedding_source_failures'], order: 'unverified' },
  ],
  'core/embedding/reconcile.ts#writeSource': [
    { tables: ['embedding_cursors'], order: 'unverified' },
    { tables: ['embedding_receipts'], order: 'unverified' },
  ],
  'core/embedding/work-state.ts#recordedWork': [
    { tables: ['embedding_work_state'], order: 'unverified' },
  ],
  'core/harness-health.ts#recordProvisionedHarnessReport': [
    { tables: ['machine_harness_reports'], order: 'unverified' },
  ],
  'core/machine-settings.ts#machineBlockFor': [
    { tables: ['machine_settings_snapshots'], order: 'unverified' },
  ],
  'core/machine-settings.ts#setMachineLeaf': [
    { tables: ['machine_settings'], order: 'unverified' },
  ],
  'core/model-catalogs.ts#recordModelCatalog': [
    { tables: ['worker_model_catalogs', 'runner_model_catalogs'], order: 'reporter-stamp' },
  ],
  'core/release-provenance.ts#<module>': [
    { tables: ['knowledge_release_state'], order: 'unverified' },
  ],
  'core/runner-updates.ts#runnerUpdateReportStatements': [
    { tables: ['runner_update_reports'], order: 'reporter-stamp' },
  ],
  'core/runs.ts#upsertAgent': [
    { tables: ['agents'], order: 'unverified' },
  ],
  'core/secrets.ts#put': [
    { tables: ['deployment_secrets'], order: 'unverified' },
  ],
  'core/settings.ts#resetRecord': [
    { tables: ['deployment_setting_resets'], order: 'unverified' },
  ],
  'core/settings.ts#setCapability': [
    { tables: ['project_capabilities'], order: 'unverified' },
  ],
  'core/settings.ts#setLeaf': [
    { tables: ['deployment_settings'], order: 'unverified' },
    { tables: ['deployment_settings'], order: 'unverified' },
  ],
  'core/settings.ts#setTaskTier': [
    { tables: ['deployment_settings'], order: 'unverified' },
    { tables: ['deployment_settings'], order: 'unverified' },
  ],
  'core/settings.ts#writeEmbedding': [
    { tables: ['deployment_settings'], order: 'writer-revision' },
    { tables: ['deployment_setting_resets'], order: 'unverified' },
  ],
  'core/settings.ts#writeSwitchedEmbedding': [
    { tables: ['deployment_settings'], order: 'unverified' },
    { tables: ['deployment_setting_resets'], order: 'unverified' },
  ],
  'core/storage-cleanup.ts#omissions': [
    { tables: ['storage_cleanup_omissions'], order: 'unverified' },
  ],
  'core/worker-contacts.ts#runnerContactStatement': [
    { tables: ['runner_contacts'], order: 'unverified' },
  ],
  'core/worker-contacts.ts#runnerObservationStatement': [
    { tables: ['runner_observations'], order: 'unverified' },
  ],
  'core/worker-contacts.ts#workerContactStatement': [
    { tables: ['worker_contacts'], order: 'unverified' },
  ],
  'db/read-budget-session-statements.ts#<module>': [
    { tables: ['session_read_facts'], order: 'unverified' },
    { tables: ['session_read_facts'], order: 'unverified' },
    { tables: ['session_read_facts'], order: 'unverified' },
    { tables: ['session_read_facts'], order: 'unverified' },
    { tables: ['project_session_counts'], order: 'unverified' },
    { tables: ['project_session_counts'], order: 'unverified' },
    { tables: ['project_session_counts'], order: 'unverified' },
  ],
  'db/read-budget-session-statements.ts#contribution': [
    { tables: ['session_read_facts'], order: 'unverified' },
  ],
  'db/read-budget-session-statements.ts#sessionPresent': [
    { tables: ['session_read_facts'], order: 'unverified' },
  ],
  'db/schema-v20.ts#newSourceRevision': [
    { tables: ['embedding_versions'], order: 'unverified' },
  ],
  'db/schema.ts#<module>': [
    { tables: ['embedding_versions'], order: 'unverified' },
  ],
  'ingest/events.ts#planEventWrite': [
    { tables: ['sessions'], order: 'unverified' },
  ],
  'ingest/projections.ts#plan': [
    { tables: ['plans'], order: 'event-rank' },
  ],
  'ingest/projections.ts#prompt': [
    { tables: ['prompt_batches'], order: 'unverified' },
  ],
  'ingest/projections.ts#sessionCommit': [
    { tables: ['knowledge_git_provenance'], order: 'event-rank' },
  ],
  'ingest/projections.ts#toolCall': [
    { tables: ['tool_calls'], order: 'unverified' },
  ],
  'ingest/projections.ts#transcriptSegment': [
    { tables: ['transcripts'], order: 'unverified' },
  ],
  'ingest/uncaptured.ts#recordUncapturedStatement': [
    { tables: ['uncaptured_roots'], order: 'unverified' },
  ],
  'platform/bun/vectors.ts#upsert': [
    { tables: ['local_vectors'], order: 'unverified' },
  ],
  'platform/cloudflare/recovery-producer-object.ts#checkpoint': [
    { tables: ['objects'], order: 'unverified' },
  ],
};
