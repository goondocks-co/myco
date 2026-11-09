import type { UpsertDeclaration } from './server-upsert-inventory.js';
/** Every literal conflict-update occurrence, in source order within its owner. */
export const RECONCILED_UPSERTS: Record<string, UpsertDeclaration[]> = {
  'db/schema-v728.ts#<module>': [{tables:['session_user_prompt_firsts','session_lifecycle_facts'],order:'unverified'}],
  'db/documents/dependencies.ts#<module>': [{tables:['publication_dependencies'],order:'unverified'}],
  'db/schema-vNEXT-s4b.ts#<module>': [{tables:['spore_resolution_edges'],order:'unverified'}],
  'db/spores/curation-work.ts#<module>': [{tables:['spore_curation_receipts'],order:'unverified'}],
  'db/spores/curation-discovery.ts#<module>': [{tables:['spore_curation_cursor'],order:'unverified'}],
  'db/spores/edges.ts#<module>': [{tables:['spore_resolution_edges'],order:'unverified'}],
  'db/documents/lifecycle.ts#sessionLifecycleSchema': [{tables:['session_user_prompt_firsts'],order:'unverified'}],
  'db/documents/lifecycle.ts#<module>': [{tables:['session_user_prompt_firsts'],order:'unverified'}],
  "db/schema-v731.ts#<module>": [
    { tables: ["run_head"], order: 'unverified' },
    { tables: ["run_head"], order: 'unverified' },
  ],
  "db/runs/evidence-schema.ts#<module>": [
    { tables: ["run_head"], order: 'unverified' },
    { tables: ["attempt_head"], order: 'unverified' },
  ],
  "db/runs/body-failures.ts#failureInsert": [
    { tables: ["run_body_failures"], order: 'unverified' },
  ],
  "db/runs/retention.ts#<module>": [
    { tables: ["blob_release_candidates"], order: 'unverified' },
  ],
  "db/runs/state.ts#<module>": [
    { tables: ["agents"], order: 'unverified' },
  ],
  "db/runs/steps.ts#<module>": [
    { tables: ["attempt_head"], order: 'unverified' },
  ],
  'db/documents/metadata-catchup.ts#<module>': [
    {tables:['document_metadata_progress'],order:'unverified'},
    {tables:['document_metadata_ready'],order:'unverified'},
    {tables:['document_metadata_ready'],order:'unverified'},
  ],
  "db/schema-v723.ts#<module>": [
    { tables: ["document_pin_totals"], order: 'unverified' },
    { tables: ["document_pin_totals", "document_group_pins"], order: 'unverified' },
    { tables: ["document_transcript_pins"], order: 'unverified' },
    { tables: ["document_pin_totals"], order: 'unverified' },
    { tables: ["document_pin_totals"], order: 'unverified' },
    { tables: ["document_pin_totals", "document_group_pins"], order: 'unverified' },
    { tables: ["document_transcript_pins"], order: 'unverified' },
    { tables: ["document_transcript_pins"], order: 'unverified' },
    { tables: ["document_pin_totals"], order: 'unverified' },
    { tables: ["document_transcript_pins"], order: 'unverified' },
    { tables: ["document_failure_totals"], order: 'unverified' },
    { tables: ["document_failure_head"], order: 'unverified' },
    { tables: ["document_failure_contributions"], order: 'unverified' },
    { tables: ["document_failure_contributions"], order: 'unverified' },
    { tables: ["document_failure_totals"], order: 'unverified' },
    { tables: ["document_failure_totals"], order: 'unverified' },
    { tables: ["document_failure_head"], order: 'unverified' },
    { tables: ["document_failure_contributions"], order: 'unverified' },
    { tables: ["document_failure_contributions"], order: 'unverified' },
    { tables: ["document_failure_contributions"], order: 'unverified' },
    { tables: ["document_failure_contributions"], order: 'unverified' },
    { tables: ["document_failure_totals"], order: 'unverified' },
    { tables: ["document_failure_head"], order: 'unverified' },
    { tables: ["document_failure_contributions"], order: 'unverified' },
    { tables: ["document_failure_contributions"], order: 'unverified' },
    { tables: ["document_failure_contributions"], order: 'unverified' },
    { tables: ["document_failure_contributions"], order: 'unverified' },
    { tables: ["document_rebuild_totals"], order: 'unverified' },
  ],
  'db/documents/rebuild.ts#rebuildStatements': [{tables:['document_rebuild_receipts'],order:'unverified'}],
  "db/documents/rebuild.ts#publicationRebuildSchema": [
    { tables: ["document_rebuild_totals"], order: 'unverified' },
  ],

  "db/documents/pin-schema.ts#reconcilePublicationPins": [
    { tables: ["document_transcript_pins"], order: 'unverified' },
  ],
  "db/documents/pin-schema.ts#pinGroup": [
    { tables: ["document_group_pins"], order: 'unverified' },
  ],
  "db/documents/pin-schema.ts#total": [
    { tables: ["document_pin_totals"], order: 'unverified' },
  ],
  "db/documents/failure-head.ts#reconcilePublicationFailures": [
    { tables: ["document_failure_contributions"], order: 'unverified' },
  ],
  "db/documents/failure-head.ts#delta": [
    { tables: ["document_failure_totals"], order: 'unverified' },
  ],
  "db/documents/failure-head.ts#publicationFailureSchema": [
    { tables: ["document_failure_head"], order: 'unverified' },
  ],
  "db/documents/failure-head.ts#<module>": [
    { tables: ["document_failure_head"], order: 'unverified' },
    { tables: ["document_failure_head"], order: 'unverified' },
  ],
  "db/documents/ownership.ts#<module>": [
    { tables: ["document_continuations"], order: 'unverified' },
    { tables: ["document_metadata_ready"], order: 'unverified' },
  ],

  "db/schema-v724.ts#<module>": [
    { tables: ["work_run_contribution"], order: 'unverified' },
    { tables: ["work_run_contribution", "run_output_membership"], order: 'unverified' },
    { tables: ["work_run_contribution"], order: 'unverified' },
    { tables: ["work_run_contribution", "run_output_membership"], order: 'unverified' },
    { tables: ["work_run_contribution"], order: 'unverified' },
    { tables: ["work_run_contribution", "run_output_membership"], order: 'unverified' },
    { tables: ["work_run_contribution"], order: 'unverified' },
    { tables: ["work_run_contribution", "run_output_membership"], order: 'unverified' },
    { tables: ["work_run_contribution"], order: 'unverified' },
    { tables: ["work_run_contribution", "run_output_membership"], order: 'unverified' },
    { tables: ["work_run_contribution"], order: 'unverified' },
    { tables: ["work_run_contribution", "run_output_membership"], order: 'unverified' },
    { tables: ["work_run_contribution"], order: 'unverified' },
    { tables: ["work_run_contribution", "run_output_membership"], order: 'unverified' },
    { tables: ["work_run_contribution"], order: 'unverified' },
    { tables: ["work_run_contribution", "run_output_membership"], order: 'unverified' },
    { tables: ["work_daily"], order: 'unverified' },
    { tables: ["work_daily"], order: 'unverified' },
    { tables: ["work_window_sessions"], order: 'unverified' },
    { tables: ["work_window_sessions"], order: 'unverified' },
    { tables: ["work_window_totals"], order: 'unverified' },
    { tables: ["work_window_totals"], order: 'unverified' },
  ],
  "db/runs/history-schema.ts#reconcileWork": [
    { tables: ["work_run_contribution"], order: 'unverified' },
    { tables: ["run_output_membership"], order: 'unverified' },
  ],
  "db/runs/history-schema.ts#addFact": [{ tables: ["work_daily"], order: 'unverified' }],
  "db/runs/history-schema.ts#addMembership": [{ tables: ["work_window_sessions"], order: 'unverified' }],
  "db/runs/history-schema.ts#countWindow": [{ tables: ["work_window_totals"], order: 'unverified' }],
  "db/schema-v717.ts#<module>": [
    { tables: ["document_publication_totals"], order: 'unverified' },
    { tables: ["document_publication_contributions"], order: 'unverified' },
    { tables: ["document_publication_contributions"], order: 'unverified' },
    { tables: ["document_publication_contributions"], order: 'unverified' },
    { tables: ["document_publication_contributions"], order: 'unverified' },
    { tables: ["document_publication_ready"], order: 'unverified' },
    { tables: ["document_publication_facts"], order: 'unverified' },
    { tables: ["document_publication_totals"], order: 'unverified' },
    { tables: ["document_publication_totals"], order: 'unverified' },
    { tables: ["document_publication_totals"], order: 'unverified' },
    { tables: ["document_publication_contributions"], order: 'unverified' },
    { tables: ["document_publication_contributions"], order: 'unverified' },
    { tables: ["document_publication_contributions"], order: 'unverified' },
    { tables: ["document_publication_contributions"], order: 'unverified' },
    { tables: ["document_publication_contributions"], order: 'unverified' },
    { tables: ["document_publication_contributions"], order: 'unverified' },
    { tables: ["document_publication_ready"], order: 'unverified' },
    { tables: ["document_publication_facts"], order: 'unverified' },
    { tables: ["document_publication_facts"], order: 'unverified' },
    { tables: ["document_publication_totals"], order: 'unverified' },
    { tables: ["document_publication_contributions"], order: 'unverified' },
    { tables: ["document_publication_contributions"], order: 'unverified' },
    { tables: ["document_publication_contributions"], order: 'unverified' },
    { tables: ["document_publication_contributions"], order: 'unverified' },
    { tables: ["document_publication_facts"], order: 'unverified' },
  ],
  "db/documents/contributions.ts#reconcilePublicationContributions": [
    { tables: ["document_publication_contributions"], order: 'unverified' },
  ],
  "db/documents/contributions.ts#reconcilePublicationFacts": [
    { tables: ["document_publication_facts"], order: 'unverified' },
  ],
  "db/documents/contributions.ts#delta": [
    { tables: ["document_publication_totals"], order: 'unverified' },
  ],
  "db/documents/contributions.ts#publicationContributionSchema": [
    { tables: ["document_publication_totals"], order: 'unverified' },
  ],
  'db/runs/contact-writes.ts#<module>': [
    { tables: ['worker_contacts'], order: 'unverified' },
    { tables: ['runner_contacts'], order: 'unverified' },
  ],
  "db/runs/live.ts#reconcileLive": [
    {
      "tables": [
        "run_live"
      ],
      "order": "unverified"
    }
  ],
  "db/runs/live.ts#counter": [
    {
      "tables": [
        "admission_contribution"
      ],
      "order": "unverified"
    }
  ],
  "db/runs/live.ts#due": [
    {
      "tables": [
        "task_due"
      ],
      "order": "unverified"
    }
  ],
  "db/runs/live.ts#countHead": [
    {
      "tables": [
        "task_runtime"
      ],
      "order": "unverified"
    }
  ],
  "db/schema-v719.ts#<module>": [
    {
      "tables": [
        "run_live"
      ],
      "order": "unverified"
    },
    {
      "tables": [
        "run_live"
      ],
      "order": "unverified"
    },
    {
      "tables": [
        "admission_contribution"
      ],
      "order": "unverified"
    },
    {
      "tables": [
        "admission_contribution"
      ],
      "order": "unverified"
    },
    {
      "tables": [
        "admission_contribution"
      ],
      "order": "unverified"
    },
    {
      "tables": [
        "admission_contribution"
      ],
      "order": "unverified"
    },
    {
      "tables": [
        "admission_contribution"
      ],
      "order": "unverified"
    },
    {
      "tables": [
        "admission_contribution"
      ],
      "order": "unverified"
    },
    {
      "tables": [
        "admission_contribution"
      ],
      "order": "unverified"
    },
    {
      "tables": [
        "admission_contribution"
      ],
      "order": "unverified"
    },
    {
      "tables": [
        "admission_contribution"
      ],
      "order": "unverified"
    },
    {
      "tables": [
        "task_due"
      ],
      "order": "unverified"
    },
    {
      "tables": [
        "task_runtime"
      ],
      "order": "unverified"
    },
    {
      "tables": [
        "task_runtime"
      ],
      "order": "unverified"
    },
    {
      "tables": [
        "task_runtime"
      ],
      "order": "unverified"
    },
    {
      "tables": [
        "task_runtime"
      ],
      "order": "unverified"
    }
  ],

  'db/spores/counts.ts#reconcileSporeFacts': [{ tables: ['spore_count_facts'], order: 'unverified' }],
  'db/spores/counts.ts#bump': [
    { tables: ['spore_counts'], order: 'unverified' }, { tables: ['spore_daily'], order: 'unverified' }, { tables: ['spore_session_counts'], order: 'unverified' },
  ],
  'db/schema-vNEXT-s2c.ts#claimUpsert': [{ tables: ['session_title_work'], order: 'unverified' }],
  'db/schema-vNEXT-s2c.ts#refreshReconcile': [{ tables: ['session_title_work'], order: 'unverified' }],
  'db/schema-vNEXT-s2c.ts#cohortBump': [{ tables: ['session_title_work_counts'], order: 'unverified' }],
  'db/sessions/title-work.ts#upsertSql': [{ tables: ['session_title_work'], order: 'unverified' }],
  'db/sessions/statistics-schema.ts#reconcileSessionStatistics': [{ tables: ['session_statistics'], order: 'unverified' }],
  'db/sessions/statistics-schema.ts#reconcileAttachmentCounts': [{ tables: ['session_attachment_counts'], order: 'unverified' }],
  'db/sessions/statistics-schema.ts#counterUpsert': [{ tables: ['project_session_counts'], order: 'unverified' }],
  'db/sessions/statistics-schema.ts#dayBump': [{ tables: ['project_session_days'], order: 'unverified' }],
  'db/sessions/statistics-schema.ts#<module>': [{ tables: ['session_attachment_counts'], order: 'unverified' }],
  'db/sessions/placement-schema.ts#<module>': [{ tables: ['context_placements'], order: 'unverified' }],
  'db/sessions/placement-schema.ts#dayBump': [{ tables: ['context_placement_days'], order: 'unverified' }],
  'db/plans/counts.ts#reconcilePlanFacts': [{ tables: ['plan_count_facts'], order: 'unverified' }],
  'db/plans/counts.ts#bump': [{ tables: ['plan_counts'], order: 'unverified' }],
  'db/schema-v721.ts#<module>': [
    ...Array.from({ length: 4 }, () => ({ tables: ['spore_count_facts'], order: 'unverified' as const })),
    // A trigger body holding several upserts names every table of its earlier statements too.
    ...Array.from({ length: 4 }, () => [{ tables: ['spore_counts'], order: 'unverified' as const }, { tables: ['spore_daily', 'spore_counts'], order: 'unverified' as const }, { tables: ['spore_session_counts', 'spore_counts'], order: 'unverified' as const }]).flat(),
    ...Array.from({ length: 4 }, () => ({ tables: ['plan_count_facts'], order: 'unverified' as const })),
    ...Array.from({ length: 4 }, () => ({ tables: ['plan_counts'], order: 'unverified' as const })),
  ],
  'db/embeddings/passed-over.ts#reconcilePassedOver': [{ tables: ['embedding_passed_over'], order: 'unverified' }],
  'db/embeddings/state.ts#reconcileSourceState': [{ tables: ['embedding_source_state'], order: 'unverified' }],
  'db/embeddings/state.ts#total': [{ tables: ['embedding_model_totals'], order: 'unverified' }],
  'db/embeddings/calibration.ts#reconcileCalibrationState': [{ tables: ['embedding_calibration_state'], order: 'unverified' }],
  'db/embeddings/calibration.ts#populationUpsert': [{ tables: ['embedding_calibration_population'], order: 'unverified' }],
  'db/schema-v722.ts#<module>': [
    ...Array.from({ length: 8 }, () => ({ tables: ['embedding_hubness_revision'], order: 'unverified' as const })),
    ...Array.from({ length: 12 }, () => ({ tables: ['embedding_calibration_state'], order: 'unverified' as const })),
    ...Array.from({ length: 5 }, () => ({ tables: ['embedding_calibration_population'], order: 'unverified' as const })),
  ],
  'db/schema-v716.ts#<module>': [
    ...Array.from({ length: 12 }, () => ({ tables: ['embedding_source_state'], order: 'unverified' as const })),
    ...Array.from({ length: 4 }, () => ({ tables: ['embedding_model_totals'], order: 'unverified' as const })),
  ],
  'db/embeddings/work.ts#<module>': [
    { tables: ['embedding_work_state'], order: 'unverified' },
    { tables: ['embedding_provider_holds'], order: 'unverified' },
    { tables: ['embedding_cursors'], order: 'unverified' },
    { tables: ['embedding_receipts'], order: 'unverified' },
    { tables: ['embedding_source_failures'], order: 'unverified' },
    { tables: ['embedding_receipts'], order: 'unverified' },
    { tables: ['embedding_resets'], order: 'unverified' },
    { tables: ['embedding_work_audit'], order: 'unverified' },
  ],
  'db/schema-v712.ts#<module>': Array.from({ length: 7 }, () => ({ tables: ['embedding_passed_over'], order: 'unverified' as const })),
  'db/runs/admission.ts#reconcileSpend': [{ tables: ['attempt_spend'], order: 'unverified' }],
  'db/runs/admission.ts#rollup': [{ tables: ['budget_totals'], order: 'unverified' }],
  'db/schema-v714.ts#<module>': [
    ...Array.from({ length: 5 }, () => ({ tables: ['budget_totals'], order: 'unverified' as const })),
    ...Array.from({ length: 4 }, () => ({ tables: ['attempt_spend'], order: 'unverified' as const })),
  ],
  'db/insights/kpi-reconcile.ts#upsertKpi': [{ tables: ['kpi_fact'], order: 'unverified' }],
  'db/insights/kpi-reconcile.ts#lineageUpsert': [{ tables: ['kpi_lineage'], order: 'unverified' }],
  'db/insights/kpi-reconcile.ts#roll': [{ tables: ['kpi_daily'], order: 'unverified' }],
  'db/meta/backup-prune.ts#<module>': [{ tables: ['schema_meta'], order: 'arrival-order' }],
  'db/schema-v711.ts#<module>': [
    ...Array.from({ length: 4 }, () => ({ tables: ['kpi_daily'], order: 'unverified' as const })),
    ...Array.from({ length: 63 }, () => ({ tables: ['kpi_fact'], order: 'unverified' as const })),
    { tables: ['kpi_lineage'], order: 'unverified' },
  ],
  'db/schema-v708.ts#captureHeadInsert': [{ tables: ['machine_capture_heads'], order: 'unverified' }],
  'db/curation-changes.ts#curationChangeSql': [{ tables: ['spore_curation_changes'], order: 'unverified' }],
  'db/meta/budget-activation.ts#indexWitness': [{ tables: ['schema_meta'], order: 'catalogue-snapshot' }],
  'core/activity.ts#<module>': [{ tables: ['schema_meta'], order: 'arrival-order' }],
  'db/maintenance/outcomes.ts#<module>': [{ tables: ['schema_meta'], order: 'arrival-order' }],
  'db/meta/member-naming-failure.ts#<module>': [{ tables: ['member_naming_failures'], order: 'unverified' }],
  'db/learning/source-repair.ts#<module>': [{ tables: ['schema_meta'], order: 'arrival-order' }],
  'db/schema-vNEXT-s4b2.ts#projectRollup': [{ tables: ['learning_project_counts'], order: 'unverified' }],
  'db/schema-vNEXT-s4b2.ts#readyDelta': [{ tables: ['learning_ready_projects'], order: 'unverified' }],
  'db/learning/quiet-policy.ts#<module>': [{ tables: ['learning_quiet_policy'], order: 'unverified' }],
  'db/schema.ts#withStamp': [{ tables: ['schema_meta'], order: 'arrival-order' }],
  'db/embedding-due.ts#embeddingDueInsert': [{ tables: ['embedding_due'], order: 'arrival-order' }],
  'db/meta/budget-activation.ts#budgetMigration': [{ tables: ['schema_meta'], order: 'arrival-order' }, { tables: ['schema_meta'], order: 'arrival-order' }, { tables: ['schema_meta'], order: 'arrival-order' }],
  'db/schema-v466.ts#<module>': [{tables:['embedding_hubness_revision'],order:'unverified'}],
  'db/document-facts.ts#refreshDocumentFacts': [{tables:['document_publication_facts'],order:'unverified'}],
  'db/document-facts.ts#differenceDelta': [{tables:['document_difference_totals'],order:'unverified'}],
  'db/document-facts.ts#queueDue': [{tables:['document_due'],order:'unverified'}],
  'db/document-facts-v467.ts#refreshDocumentFacts': [{tables:['document_publication_facts'],order:'unverified'}],
  'db/document-facts-v467.ts#documentFactDelta': [{tables:['document_difference_totals'],order:'unverified'}],
  'db/document-facts-v467.ts#documentDueDelta': [{tables:['document_due_totals'],order:'unverified'}],
  'db/event-references.ts#restoreReference': [{tables:['event_refs'],order:'unverified'}],
  'db/schema-v117.ts#captureReferences': [{tables:['event_refs'],order:'unverified'}],
  'db/schema-v117.ts#fillReferences': [{tables:['event_refs'],order:'unverified'}],
  'content/tool-statistics.ts#turnStatisticsStatements': [{ tables: ['session_turn_entries'], order: 'unverified' }],
  'ingest/document-summaries.ts#catchUpSummaries': ['session_path_build', 'session_paths']
    .map(table => ({ tables: [table], order: 'unverified' as const })),
  'core/attempt-accounting.ts#restoreAttemptStatement': [
    { tables: ['agent_run_attempts'], order: 'unverified' },
  ],
  'db/meta/budget-estimates.ts#<module>': [
    { tables: ['schema_meta'], order: 'unverified' },
    { tables: ['schema_meta'], order: 'unverified' },
    { tables: ['agent_state'], order: 'unverified' },
    { tables: ['schema_meta'], order: 'arrival-order' },
  ],
  'db/meta/budget-estimates.ts#estimateInvalidationStatements': [
    { tables: ['schema_meta'], order: 'arrival-order' },
    { tables: ['schema_meta'], order: 'unverified' },
  ],
  'db/identity/member-naming.ts#<module>': [
    { tables: ['schema_meta'], order: 'unverified' },
  ],
  'core/backup.ts#claimRestoreTable': [
    { tables: ['backup_restore_progress'], order: 'unverified' },
  ],
  'core/backup.ts#restoreArtifact': [
    { tables: ['backup_restore_progress'], order: 'unverified' },
  ],
  'db/runs/attributed-writes.ts#<module>': [
    { tables: ['canopy_maps'], order: 'unverified' },
  ],
    'core/machine-settings.ts#machineBlockFor': [
    { tables: ['machine_settings_snapshots'], order: 'unverified' },
  ],
  'core/machine-settings.ts#setMachineLeaf': [
    { tables: ['machine_settings'], order: 'unverified' },
  ],
    'db/release/classification.ts#<module>': [
    { tables: ['knowledge_release_state'], order: 'unverified' },
  ],
    'db/settings/secret-writes.ts#<module>': [
    { tables: ['deployment_secrets'], order: 'unverified' },
  ],
  'db/storage/repository-connection.ts#<module>': [
    { tables: ['project_repositories'], order: 'unverified' },
  ],
  'db/settings/leaves.ts#<module>': [
    { tables: ['deployment_settings'], order: 'writer-revision' },
    { tables: ['deployment_setting_resets'], order: 'unverified' },
    { tables: ['project_settings'], order: 'unverified' },
    { tables: ['project_capabilities'], order: 'unverified' },
  ],
  'db/schema-v710.ts#<module>': [{ tables: ['setting_revisions'], order: 'unverified' }],
  'db/storage/release-queue.ts#<module>': [{ tables: ['blob_release_candidates'], order: 'unverified' }],
  'db/sessions/deletion-phases.ts#phase': [{ tables: ['blob_release_candidates'], order: 'unverified' }],
  'db/documents/reread.ts#<module>': [{ tables: ['transcript_publication'], order: 'unverified' }],
  'db/storage/cleanup.ts#<module>': [
    { tables: ['storage_cleanup_omissions'], order: 'unverified' },
  ],
  'db/storage/usage.ts#<module>': [
    { tables: ['storage_usage'], order: 'unverified' },
    { tables: ['storage_usage'], order: 'unverified' },
  ],
  'db/storage/usage.ts#storageUsageSchemaStatements': [{ tables: ['storage_usage'], order: 'unverified' }],
  'db/schema-v727.ts#<module>': [{ tables: ['storage_usage'], order: 'unverified' }],
  'db/schema-vNEXT-s1c.ts#<module>': [
    { tables: ['machine_head'], order: 'unverified' },
    { tables: ['machine_head'], order: 'unverified' },
    { tables: ['machine_head'], order: 'unverified' },
    { tables: ['machine_head'], order: 'unverified' },
    { tables: ['runner_head'], order: 'unverified' },
    { tables: ['runner_head'], order: 'unverified' },
    { tables: ['runner_head'], order: 'unverified' },
  ],
  'db/runners/heads.ts#mergeContact': [{ tables: ['machine_head'], order: 'unverified' }],
  'db/runners/heads.ts#mergeCapture': [{ tables: ['machine_head'], order: 'unverified' }],
  'db/runners/heads.ts#mergeRunner': [{ tables: ['runner_head'], order: 'unverified' }],
  'db/runners/heads.ts#<module>': [{ tables: ['runner_head'], order: 'unverified' }],
  'db/runners/harness-health.ts#<module>': [
    { tables: ['machine_head'], order: 'unverified' },
    { tables: ['machine_harness_reports'], order: 'unverified' },
  ],
  'db/runners/catalogs.ts#upsert': [{ tables: ['worker_model_catalogs', 'runner_model_catalogs'], order: 'reporter-stamp' }],
  'db/runners/updates.ts#<module>': [{ tables: ['runner_update_reports'], order: 'reporter-stamp' }],
  'db/runners/contacts.ts#<module>': [{ tables: ['runner_observations'], order: 'unverified' }],
  'db/identity/lineage-heads.ts#reconcileHead': [{ tables: ['credential_lineages'], order: 'unverified' }],
  'db/schema-vNEXT-s6.ts#<module>': [
    { tables: ['credential_lineages'], order: 'unverified' },
    { tables: ['credential_lineages'], order: 'unverified' },
    { tables: ['credential_lineages'], order: 'unverified' },
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
    { tables: ['_v48_credential_rows'], order: 'arrival-order' }, { tables: ['_v89_receipt_rows'], order: 'arrival-order' }, { tables: ['schema_meta'], order: 'arrival-order' }, { tables: ['_v89_answer_rows'], order: 'arrival-order' },
  ],
  'ingest/document-batch.ts#statements': ['session_chunks', 'session_pages', 'session_paths', 'myco_tool_calls']
    .map((table) => ({ tables: [table], order: 'unverified' as const })),
  'ingest/document-batch.ts#sealStatements': [{ tables: ['session_sealed_records'], order: 'unverified' }],
  'db/documents/frontiers.ts#<module>': [{ tables: ['transcript_publication'], order: 'unverified' }],
  'ingest/document-batch.ts#sessionRowStatements': [{ tables: ['plans'], order: 'unverified' }],
  'ingest/events.ts#planEventWrite': [
    { tables: ['sessions'], order: 'unverified' },
  ],
  'ingest/projections.ts#plan': [
    { tables: ['plans'], order: 'event-rank' },
  ],
  'ingest/projections.ts#sessionCommit': [
    { tables: ['knowledge_git_provenance'], order: 'event-rank' },
  ],
  'ingest/projections.ts#transcriptSegment': [
    { tables: ['transcripts'], order: 'unverified' },
  ],
  'ingest/uncaptured.ts#recordUncapturedStatement': [
    { tables: ['uncaptured_roots'], order: 'unverified' },
  ],
  'platform/bun/vectors.ts#upsert': [
    { tables: ['local_vectors'], order: 'content-key' },
  ],
  'platform/cloudflare/recovery-producer-object.ts#checkpoint': [
    { tables: ['parts'], order: 'checkpoint-transaction' },
    { tables: ['objects'], order: 'checkpoint-transaction' },
  ],
};
