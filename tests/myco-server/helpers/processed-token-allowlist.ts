/** Unrelated domain uses, admitted only at their complete source lines. */
export const UNRELATED_PROCESSED_LINES = {
  "embeddingWorkCounts": {
    "core/embedding/hubness.ts": [
      "if (await tally(SPORE_VECTORS) < 2) return { phase: 'settled', processed: 0 };",
      "return { phase: 'hubness', processed: done ? 1 : 0 };",
      "if (!started) return { phase: 'hubness', processed: 0 };",
      "if (joining.length > 0) return { phase: 'visibility', processed: 0 };",
      "if (visible.length === 0) return { phase: 'visibility', processed: 1 };",
      "if (after === null) return { phase: waiting ? 'visibility' : 'settled', processed: 0 };",
      "if (subjects.length === 0) return { phase: 'hubness', processed: 1 };",
      "return { phase: 'hubness', processed: done || started ? 1 : 0 };"
    ],
    "core/embedding/jobs.ts": [
      "changed += 'processed' in step ? step.processed : 0;"
    ],
    "core/embedding/reconcile.ts": [
      "export interface EmbeddingStep { phase: 'missing' | 'stale' | 'switch' | 'passed-over' | 'orphans' | 'hubness' | 'visibility' | 'settled'; processed: number }",
      "if (claimed === null) return { phase: 'orphans', processed: 0 };",
      "return { phase: 'orphans', processed: 1 };",
      "if (context.retireOnly === true) return { phase: 'settled', processed: 0 };",
      ".bind(projectId, type, source.record_id, modelKey, source.revision, reason, now).run().then((): EmbeddingStep => ({ phase: 'passed-over', processed: 1 }));",
      "if (rejournaled.results.length !== 1) return { phase, processed: 0 };",
      "return { phase, processed: 1 };"
    ],
    "core/embedding/run.ts": [
      "export interface EmbeddingRunResult { processed: number; phase: string; missing?: MissingSporeVectors }",
      "const summary = [`Processed ${result.processed} embedding records; ${result.phase}.`, ...missingWords(result.missing)].join(' ');",
      "let processed = 0;",
      "if (typeof result.phase !== 'string' || typeof result.processed !== 'number') throw new Error('embedding step returned an invalid result');",
      "processed += result.processed;",
      "if (result.processed === 0) break;",
      "return missing === undefined || missing.rewriting + missing.waiting + missing.abandoned === 0 ? { processed, phase } : { processed, phase, missing };"
    ],
    "core/embedding/step.ts": [
      "step = providers.building === undefined ? { phase: 'switch', processed: 0 } : await reconcileEmbedding(context, projectId, now);",
      "const built = step.processed > 0 && (step.phase === 'switch' || (providers.building === undefined && providers.provider.modelKey === providers.switching && (step.phase === 'missing' || step.phase === 'stale')));"
    ],
    "api/embedding-task.ts": [
      "if (run.dryRun === 1) return Response.json({ persisted: true, held: true, phase: 'settled', processed: 0 });"
    ]
  },
  "registeredBodyReferences": {
    "core/backup.ts": [
      "const processed = (byTable.get('processed_resources') ?? []).find(candidate => candidate.project_id === row.project_id",
      "const inputEvent = processed === undefined ? undefined : artifactEvents.get(transcriptIdentity(row.project_id, processed.event_id));",
      "if (outcomeEvent === undefined || inputEvent === undefined || processed === undefined) {",
      "throw new BackupApplyError(table, 'a displayed input lacks its source or processed reference');",
      "inserted += await restoreToolInput(db, row, outcomeEvent, inputEvent, processed, proofs);",
      "outcome.tables[table] = { rows: artifactRowCount, inserted: 0, skipped: 'displayed input restoration owns processed references' };"
    ],
    "core/relational-snapshot.ts": [
      "const processed = (snapshot.get('processed_resources') ?? []).find(row => row.project_id === tool.project_id",
      "&& row.classification === 'processed');",
      "const inputEvent = processed === undefined ? undefined : events.get(JSON.stringify([tool.project_id, processed.event_id]));",
      "&& row.event_id === processed?.event_id && row.envelope_hash === inputEvent?.envelope_hash",
      "|| processed?.source_token_id !== inputEvent.token_id || blob?.size !== tool.input_bytes",
      "|| processed === undefined || proof === undefined) {"
    ],
    "core/tool-input-restore.ts": [
      "/** A displayed input, its full body proof and processed reference restore in one transaction. */",
      "db: RelationalStore, tool: Row, outcomeEvent: Row, inputEvent: Row, processed: Row, proofs: readonly Row[],",
      "|| inputEvent.project_id !== project || inputEvent.event_id !== processed.event_id || inputEvent.session_id !== tool.session_id",
      "|| processed.project_id !== project || processed.kind !== 'tool-input'",
      "|| processed.resource_id !== id || processed.blob_key !== key",
      "|| processed.source_token_id !== inputEvent.token_id",
      "|| processed.classification !== 'processed') {",
      "throw new Error('a displayed tool input lacks its exact source and processed reference');",
      "const inputSource = { project_id: project, event_id: processed.event_id, envelope_hash: inputEvent.envelope_hash,",
      "ingest_nonce: inputEvent.ingest_nonce, session_id: tool.session_id, token_id: processed.source_token_id };",
      "const processedMatch = matches('processed_resources', processed, 'p');",
      "const processedColumns = columnsOf(processed);",
      ".bind(...processedColumns.map(column => processed[column] ?? null), ...outcomeMatch.values, ...inputMatch.values,"
    ]
  },
  "authorizationResourceKinds": {
    "auth/authorization.ts": [
      "export const RESOURCE_KINDS = ['protocol', 'settings', 'secret', 'directory', 'member', 'credential', 'machine', 'machine-settings', 'project', 'processed', 'plan', 'spore', 'raw', 'raw-index', 'run', 'grant', 'enrollment', 'backup', 'queue', 'runner', 'legacy-worker'] as const;",
      "processed: ['project', 'deployment'], plan: ['project', 'deployment'], spore: ['project', 'deployment'],",
      "project: ['read', 'create', 'admin'], processed: ['read', 'admin', 'capture'],",
      "return (['processed', 'project', 'plan', 'spore', 'run'] as ResourceKind[]).includes(resource.kind)",
      "return (['processed', 'project', 'plan', 'spore'] as ResourceKind[]).includes(resource.kind)",
      "if (action === 'capture') return resource.kind === 'machine-settings' ? resource.claimantMemberId === subject.memberId : ['processed', 'plan'].includes(resource.kind);"
    ]
  },
  "registeredBodyLabels": {
    "core/raw-backfill.ts": [
      "if (!('blob' in source)) throw new Error('Missing processed field backfill');"
    ],
    "core/jobs.ts": [
      "{ name: 'raw-provenance-backfill', runsThrough: 'sleep', converges: 'every historical raw reference and processed field has immutable provenance, through bounded checkpointed pages' },"
    ],
    "read/material-readiness.ts": [
      "constructor() { super('Session capture is incomplete or has errors; retry after its transcripts are fully processed.'); }"
    ]
  }
} as const;
