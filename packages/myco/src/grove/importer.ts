import type { Database } from '@myco/db/client.js';
import {
  lookupImportMappingBySource,
  markImportMappingStatus,
  recordImportMapping,
  type ImportMappingRow,
} from '@myco/db/queries/migration-import-journal.js';
import { assertGroveEraId, createGroveEraId } from '@myco/grove/ids.js';

export interface ImportProjectCoreInput {
  migrationId: string;
  sourceDb: Database;
  targetDb: Database;
  sourceProjectRoot: string;
  sourceDbPath: string;
  targetGroveId: string;
  targetProjectId: string;
  targetMachineId?: string | null;
}

export interface ImportProjectCoreResult {
  sessions: number;
  prompt_batches: number;
  activities: number;
  attachments: number;
  plans: number;
  artifacts: number;
}

interface ImportContext {
  migrationId: string;
  sourceDb: Database;
  targetDb: Database;
  sourceProjectRoot: string;
  sourceDbPath: string;
  targetGroveId: string;
  targetProjectId: string;
  targetMachineId: string | null;
}

interface SourceSessionRow {
  id: string;
  agent: string;
  user: string | null;
  project_root: string | null;
  branch: string | null;
  started_at: number;
  ended_at: number | null;
  status: string | null;
  prompt_count: number | null;
  tool_count: number | null;
  title: string | null;
  summary: string | null;
  transcript_path: string | null;
  parent_session_id: string | null;
  parent_session_reason: string | null;
  processed: number | null;
  content_hash: string | null;
  created_at: number;
  embedded: number | null;
  machine_id: string | null;
  synced_at: number | null;
  canopy_injections_offered: number | null;
  canopy_injection_total_tokens: number | null;
  canopy_skips_after_injection: number | null;
  canopy_reads_after_injection: number | null;
  canopy_tokens_saved: number | null;
  canopy_redundant_reads: number | null;
  canopy_map_tool_calls: number | null;
}

interface SourcePromptBatchRow {
  id: number;
  session_id: string;
  parent_prompt_batch_id: number | null;
  kind: string | null;
  prompt_number: number | null;
  user_prompt: string | null;
  response_summary: string | null;
  classification: string | null;
  started_at: number | null;
  ended_at: number | null;
  status: string | null;
  activity_count: number | null;
  processed: number | null;
  content_hash: string | null;
  created_at: number;
  machine_id: string | null;
  synced_at: number | null;
}

interface SourceActivityRow {
  id: number;
  session_id: string;
  prompt_batch_id: number | null;
  tool_name: string;
  tool_input: string | null;
  tool_output_summary: string | null;
  file_path: string | null;
  files_affected: string | null;
  duration_ms: number | null;
  success: number | null;
  error_message: string | null;
  timestamp: number;
  processed: number | null;
  content_hash: string | null;
  created_at: number;
  canopy_injection_tokens: number | null;
}

interface SourceAttachmentRow {
  id: string;
  session_id: string | null;
  prompt_batch_id: number | null;
  file_path: string;
  media_type: string | null;
  description: string | null;
  data: Uint8Array | null;
  content_hash: string | null;
  created_at: number;
}

interface SourcePlanRow {
  id: string;
  logical_key: string;
  status: string | null;
  author: string | null;
  title: string | null;
  content: string | null;
  source_path: string | null;
  tags: string | null;
  session_id: string | null;
  prompt_batch_id: number | null;
  content_hash: string | null;
  processed: number | null;
  created_at: number;
  updated_at: number | null;
  embedded: number | null;
  machine_id: string | null;
  synced_at: number | null;
}

interface SourceArtifactRow {
  id: string;
  artifact_type: string | null;
  source_path: string;
  title: string;
  content: string | null;
  last_captured_by: string | null;
  tags: string | null;
  created_at: number;
  updated_at: number | null;
  embedded: number | null;
  machine_id: string | null;
  synced_at: number | null;
}

type TargetTable =
  | 'sessions'
  | 'prompt_batches'
  | 'activities'
  | 'attachments'
  | 'plans'
  | 'artifacts';

const IMPORT_ORIGIN = 'legacy_project_vault';

export function importProjectCoreRows(input: ImportProjectCoreInput): ImportProjectCoreResult {
  const ctx = normalizeInput(input);
  const result: ImportProjectCoreResult = {
    sessions: 0,
    prompt_batches: 0,
    activities: 0,
    attachments: 0,
    plans: 0,
    artifacts: 0,
  };

  ctx.targetDb.transaction(() => {
    const sessions = listSourceSessions(ctx.sourceDb);
    for (const row of sessions) {
      ensureTextMapping(ctx, {
        sourceTable: 'sessions',
        sourceId: row.id,
        targetTable: 'sessions',
        targetId: () => createGroveEraId('session'),
        sourceMachineId: row.machine_id,
      });
    }
    for (const row of sessions) {
      if (importSession(ctx, row)) result.sessions += 1;
    }

    for (const row of listSourcePromptBatches(ctx.sourceDb)) {
      if (importPromptBatch(ctx, row)) result.prompt_batches += 1;
    }

    for (const row of listSourceActivities(ctx.sourceDb)) {
      if (importActivity(ctx, row)) result.activities += 1;
    }

    const attachments = listSourceAttachments(ctx.sourceDb);
    for (const row of attachments) {
      ensureTextMapping(ctx, {
        sourceTable: 'attachments',
        sourceId: row.id,
        targetTable: 'attachments',
        targetId: () => createGroveEraId('attachment'),
      });
    }
    for (const row of attachments) {
      if (importAttachment(ctx, row)) result.attachments += 1;
    }

    const plans = listSourcePlans(ctx.sourceDb);
    for (const row of plans) {
      ensureTextMapping(ctx, {
        sourceTable: 'plans',
        sourceId: row.id,
        targetTable: 'plans',
        targetId: () => createGroveEraId('plan'),
        sourceMachineId: row.machine_id,
      });
    }
    for (const row of plans) {
      if (importPlan(ctx, row)) result.plans += 1;
    }

    const artifacts = listSourceArtifacts(ctx.sourceDb);
    for (const row of artifacts) {
      ensureTextMapping(ctx, {
        sourceTable: 'artifacts',
        sourceId: row.id,
        targetTable: 'artifacts',
        targetId: () => createGroveEraId('artifact'),
        sourceMachineId: row.machine_id,
      });
    }
    for (const row of artifacts) {
      if (importArtifact(ctx, row)) result.artifacts += 1;
    }

    rebuildCoreFtsIndexes(ctx.targetDb);
  })();

  return result;
}

function normalizeInput(input: ImportProjectCoreInput): ImportContext {
  assertGroveEraId(input.migrationId, 'migration');
  assertGroveEraId(input.targetGroveId, 'grove');
  assertGroveEraId(input.targetProjectId, 'project');
  assertNonEmpty(input.sourceProjectRoot, 'sourceProjectRoot');
  assertNonEmpty(input.sourceDbPath, 'sourceDbPath');

  return {
    migrationId: input.migrationId,
    sourceDb: input.sourceDb,
    targetDb: input.targetDb,
    sourceProjectRoot: input.sourceProjectRoot,
    sourceDbPath: input.sourceDbPath,
    targetGroveId: input.targetGroveId,
    targetProjectId: input.targetProjectId,
    targetMachineId: input.targetMachineId ?? null,
  };
}

function importSession(ctx: ImportContext, row: SourceSessionRow): boolean {
  const mapping = requireMapping(ctx, 'sessions', row.id);
  if (targetRowExists(ctx.targetDb, 'sessions', mapping.target_id)) {
    markImported(ctx, 'sessions', row.id);
    return false;
  }

  const parentSessionId = mapOptionalTextId(ctx, 'sessions', row.parent_session_id);
  const machineId = row.machine_id ?? ctx.targetMachineId ?? 'local';

  ctx.targetDb.prepare(
    `INSERT INTO sessions (
       id, agent, "user", project_root, project_id, branch,
       started_at, ended_at, status, prompt_count, tool_count,
       title, summary, transcript_path, parent_session_id, parent_session_reason,
       processed, content_hash, created_at, embedded, machine_id, synced_at,
       canopy_injections_offered, canopy_injection_total_tokens,
       canopy_skips_after_injection, canopy_reads_after_injection,
       canopy_tokens_saved, canopy_redundant_reads, canopy_map_tool_calls
     ) VALUES (
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?, ?, ?
     )`,
  ).run(
    mapping.target_id,
    row.agent,
    row.user,
    row.project_root ?? ctx.sourceProjectRoot,
    ctx.targetProjectId,
    row.branch,
    row.started_at,
    row.ended_at,
    row.status ?? 'active',
    row.prompt_count ?? 0,
    row.tool_count ?? 0,
    row.title,
    row.summary,
    row.transcript_path,
    parentSessionId,
    row.parent_session_reason,
    row.processed ?? 0,
    row.content_hash,
    row.created_at,
    0,
    machineId,
    row.synced_at,
    row.canopy_injections_offered,
    row.canopy_injection_total_tokens,
    row.canopy_skips_after_injection,
    row.canopy_reads_after_injection,
    row.canopy_tokens_saved,
    row.canopy_redundant_reads,
    row.canopy_map_tool_calls ?? 0,
  );

  markImported(ctx, 'sessions', row.id);
  return true;
}

function importPromptBatch(ctx: ImportContext, row: SourcePromptBatchRow): boolean {
  const existing = lookupImportMappingBySource(
    ctx.migrationId,
    'prompt_batches',
    row.id,
    ctx.targetDb,
  );
  if (existing) {
    const targetId = parseMappedInteger(existing);
    if (targetRowExists(ctx.targetDb, 'prompt_batches', targetId)) {
      markImported(ctx, 'prompt_batches', row.id);
      return false;
    }
    insertPromptBatch(ctx, row, targetId);
    markImported(ctx, 'prompt_batches', row.id);
    return true;
  }

  const info = insertPromptBatch(ctx, row);
  const targetId = Number(info.lastInsertRowid);
  recordImportedMapping(ctx, {
    sourceTable: 'prompt_batches',
    sourceId: row.id,
    targetTable: 'prompt_batches',
    targetId: String(targetId),
    sourceMachineId: row.machine_id,
  });
  return true;
}

function insertPromptBatch(ctx: ImportContext, row: SourcePromptBatchRow, targetId?: number) {
  const sessionId = mapRequiredTextId(ctx, 'sessions', row.session_id);
  const parentPromptBatchId = mapOptionalIntegerId(ctx, 'prompt_batches', row.parent_prompt_batch_id);
  const machineId = row.machine_id ?? ctx.targetMachineId ?? 'local';

  const sql = targetId == null
    ? `INSERT INTO prompt_batches (
         project_id, session_id, parent_prompt_batch_id, kind, prompt_number,
         user_prompt, response_summary, classification, started_at, ended_at,
         status, activity_count, processed, content_hash, created_at, machine_id, synced_at
       ) VALUES (
         ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?
       )`
    : `INSERT INTO prompt_batches (
         id, project_id, session_id, parent_prompt_batch_id, kind, prompt_number,
         user_prompt, response_summary, classification, started_at, ended_at,
         status, activity_count, processed, content_hash, created_at, machine_id, synced_at
       ) VALUES (
         ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?
       )`;
  const params = [
    ctx.targetProjectId,
    sessionId,
    parentPromptBatchId,
    row.kind ?? 'initial',
    row.prompt_number,
    row.user_prompt,
    row.response_summary,
    row.classification,
    row.started_at,
    row.ended_at,
    row.status ?? 'active',
    row.activity_count ?? 0,
    row.processed ?? 0,
    row.content_hash,
    row.created_at,
    machineId,
    row.synced_at,
  ];

  return targetId == null
    ? ctx.targetDb.prepare(sql).run(...params)
    : ctx.targetDb.prepare(sql).run(targetId, ...params);
}

function importActivity(ctx: ImportContext, row: SourceActivityRow): boolean {
  const existing = lookupImportMappingBySource(
    ctx.migrationId,
    'activities',
    row.id,
    ctx.targetDb,
  );
  if (existing) {
    const targetId = parseMappedInteger(existing);
    if (targetRowExists(ctx.targetDb, 'activities', targetId)) {
      markImported(ctx, 'activities', row.id);
      return false;
    }
    insertActivity(ctx, row, targetId);
    markImported(ctx, 'activities', row.id);
    return true;
  }

  const info = insertActivity(ctx, row);
  const targetId = Number(info.lastInsertRowid);
  recordImportedMapping(ctx, {
    sourceTable: 'activities',
    sourceId: row.id,
    targetTable: 'activities',
    targetId: String(targetId),
    sourceMachineId: null,
  });
  return true;
}

function insertActivity(ctx: ImportContext, row: SourceActivityRow, targetId?: number) {
  const sessionId = mapRequiredTextId(ctx, 'sessions', row.session_id);
  const promptBatchId = mapOptionalIntegerId(ctx, 'prompt_batches', row.prompt_batch_id);

  const sql = targetId == null
    ? `INSERT INTO activities (
         project_id, session_id, prompt_batch_id, tool_name, tool_input,
         tool_output_summary, file_path, files_affected, duration_ms, success,
         error_message, timestamp, processed, content_hash, created_at,
         canopy_injection_tokens
       ) VALUES (
         ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?,
         ?
       )`
    : `INSERT INTO activities (
         id, project_id, session_id, prompt_batch_id, tool_name, tool_input,
         tool_output_summary, file_path, files_affected, duration_ms, success,
         error_message, timestamp, processed, content_hash, created_at,
         canopy_injection_tokens
       ) VALUES (
         ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?,
         ?
       )`;
  const params = [
    ctx.targetProjectId,
    sessionId,
    promptBatchId,
    row.tool_name,
    row.tool_input,
    row.tool_output_summary,
    row.file_path,
    row.files_affected,
    row.duration_ms,
    row.success ?? 1,
    row.error_message,
    row.timestamp,
    row.processed ?? 0,
    row.content_hash,
    row.created_at,
    row.canopy_injection_tokens,
  ];

  return targetId == null
    ? ctx.targetDb.prepare(sql).run(...params)
    : ctx.targetDb.prepare(sql).run(targetId, ...params);
}

function importAttachment(ctx: ImportContext, row: SourceAttachmentRow): boolean {
  const mapping = requireMapping(ctx, 'attachments', row.id);
  if (targetRowExists(ctx.targetDb, 'attachments', mapping.target_id)) {
    markImported(ctx, 'attachments', row.id);
    return false;
  }

  const sessionId = mapOptionalTextId(ctx, 'sessions', row.session_id);
  const promptBatchId = mapOptionalIntegerId(ctx, 'prompt_batches', row.prompt_batch_id);

  ctx.targetDb.prepare(
    `INSERT INTO attachments (
       id, project_id, session_id, prompt_batch_id, file_path,
       media_type, description, data, content_hash, created_at
     ) VALUES (
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?
     )`,
  ).run(
    mapping.target_id,
    ctx.targetProjectId,
    sessionId,
    promptBatchId,
    row.file_path,
    row.media_type,
    row.description,
    row.data,
    row.content_hash,
    row.created_at,
  );

  markImported(ctx, 'attachments', row.id);
  return true;
}

function importPlan(ctx: ImportContext, row: SourcePlanRow): boolean {
  const mapping = requireMapping(ctx, 'plans', row.id);
  if (targetRowExists(ctx.targetDb, 'plans', mapping.target_id)) {
    markImported(ctx, 'plans', row.id);
    return false;
  }

  const sessionId = mapOptionalTextId(ctx, 'sessions', row.session_id);
  const promptBatchId = mapOptionalIntegerId(ctx, 'prompt_batches', row.prompt_batch_id);
  const machineId = row.machine_id ?? ctx.targetMachineId ?? 'local';

  ctx.targetDb.prepare(
    `INSERT INTO plans (
       id, project_id, logical_key, status, author, title, content,
       source_path, tags, session_id, prompt_batch_id, content_hash,
       processed, created_at, updated_at, embedded, machine_id, synced_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?, ?
     )`,
  ).run(
    mapping.target_id,
    ctx.targetProjectId,
    row.logical_key,
    row.status ?? 'active',
    row.author,
    row.title,
    row.content,
    row.source_path,
    row.tags,
    sessionId,
    promptBatchId,
    row.content_hash,
    row.processed ?? 0,
    row.created_at,
    row.updated_at,
    0,
    machineId,
    row.synced_at,
  );

  markImported(ctx, 'plans', row.id);
  return true;
}

function importArtifact(ctx: ImportContext, row: SourceArtifactRow): boolean {
  const mapping = requireMapping(ctx, 'artifacts', row.id);
  if (targetRowExists(ctx.targetDb, 'artifacts', mapping.target_id)) {
    markImported(ctx, 'artifacts', row.id);
    return false;
  }

  const machineId = row.machine_id ?? ctx.targetMachineId ?? 'local';

  ctx.targetDb.prepare(
    `INSERT INTO artifacts (
       id, project_id, artifact_type, source_path, title, content,
       last_captured_by, tags, created_at, updated_at, embedded,
       machine_id, synced_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?
     )`,
  ).run(
    mapping.target_id,
    ctx.targetProjectId,
    row.artifact_type,
    row.source_path,
    row.title,
    row.content,
    row.last_captured_by,
    row.tags,
    row.created_at,
    row.updated_at,
    0,
    machineId,
    row.synced_at,
  );

  markImported(ctx, 'artifacts', row.id);
  return true;
}

function ensureTextMapping(
  ctx: ImportContext,
  input: {
    sourceTable: TargetTable;
    sourceId: string;
    targetTable: TargetTable;
    targetId: () => string;
    sourceMachineId?: string | null;
  },
): ImportMappingRow {
  const existing = lookupImportMappingBySource(
    ctx.migrationId,
    input.sourceTable,
    input.sourceId,
    ctx.targetDb,
  );
  if (existing) return existing;

  return recordImportMapping({
    migration_id: ctx.migrationId,
    source_project_root: ctx.sourceProjectRoot,
    source_db_path: ctx.sourceDbPath,
    target_grove_id: ctx.targetGroveId,
    target_project_id: ctx.targetProjectId,
    source_table: input.sourceTable,
    source_id: input.sourceId,
    target_table: input.targetTable,
    target_id: input.targetId(),
    source_machine_id: input.sourceMachineId ?? null,
    target_machine_id: ctx.targetMachineId ?? input.sourceMachineId ?? null,
    import_origin: IMPORT_ORIGIN,
  }, ctx.targetDb);
}

function recordImportedMapping(
  ctx: ImportContext,
  input: {
    sourceTable: TargetTable;
    sourceId: string | number;
    targetTable: TargetTable;
    targetId: string;
    sourceMachineId?: string | null;
  },
): ImportMappingRow {
  return recordImportMapping({
    migration_id: ctx.migrationId,
    source_project_root: ctx.sourceProjectRoot,
    source_db_path: ctx.sourceDbPath,
    target_grove_id: ctx.targetGroveId,
    target_project_id: ctx.targetProjectId,
    source_table: input.sourceTable,
    source_id: input.sourceId,
    target_table: input.targetTable,
    target_id: input.targetId,
    source_machine_id: input.sourceMachineId ?? null,
    target_machine_id: ctx.targetMachineId ?? input.sourceMachineId ?? null,
    import_origin: IMPORT_ORIGIN,
    status: 'imported',
  }, ctx.targetDb);
}

function requireMapping(
  ctx: ImportContext,
  sourceTable: TargetTable,
  sourceId: string | number,
): ImportMappingRow {
  const mapping = lookupImportMappingBySource(ctx.migrationId, sourceTable, sourceId, ctx.targetDb);
  if (!mapping) {
    throw new Error(`Missing import mapping for ${sourceTable}/${sourceId}`);
  }
  return mapping;
}

function markImported(ctx: ImportContext, sourceTable: TargetTable, sourceId: string | number): void {
  markImportMappingStatus(ctx.migrationId, sourceTable, sourceId, 'imported', {}, ctx.targetDb);
}

function mapRequiredTextId(ctx: ImportContext, sourceTable: TargetTable, sourceId: string): string {
  return requireMapping(ctx, sourceTable, sourceId).target_id;
}

function mapOptionalTextId(ctx: ImportContext, sourceTable: TargetTable, sourceId: string | null): string | null {
  if (sourceId == null) return null;
  return mapRequiredTextId(ctx, sourceTable, sourceId);
}

function mapOptionalIntegerId(ctx: ImportContext, sourceTable: TargetTable, sourceId: number | null): number | null {
  if (sourceId == null) return null;
  return parseMappedInteger(requireMapping(ctx, sourceTable, sourceId));
}

function parseMappedInteger(mapping: ImportMappingRow): number {
  const value = Number(mapping.target_id);
  if (!Number.isSafeInteger(value) || value <= 0 || String(value) !== mapping.target_id) {
    throw new Error(`Invalid integer import mapping for ${mapping.source_table}/${mapping.source_id}: ${mapping.target_id}`);
  }
  return value;
}

function targetRowExists(db: Database, table: TargetTable, id: string | number): boolean {
  const row = db.prepare(`SELECT 1 AS present FROM ${table} WHERE id = ? LIMIT 1`).get(id) as
    | { present: number }
    | undefined;
  return row?.present === 1;
}

function rebuildCoreFtsIndexes(db: Database): void {
  for (const table of ['sessions_fts', 'prompt_batches_fts', 'activities_fts'] as const) {
    db.prepare(`INSERT INTO ${table}(${table}) VALUES('rebuild')`).run();
  }
}

function listSourceSessions(db: Database): SourceSessionRow[] {
  return db.prepare(
    `SELECT
       id, agent, "user" AS user, project_root, branch,
       started_at, ended_at, status, prompt_count, tool_count,
       title, summary, transcript_path, parent_session_id, parent_session_reason,
       processed, content_hash, created_at, embedded, machine_id, synced_at,
       canopy_injections_offered, canopy_injection_total_tokens,
       canopy_skips_after_injection, canopy_reads_after_injection,
       canopy_tokens_saved, canopy_redundant_reads, canopy_map_tool_calls
     FROM sessions
     ORDER BY started_at ASC, created_at ASC, id ASC`,
  ).all() as SourceSessionRow[];
}

function listSourcePromptBatches(db: Database): SourcePromptBatchRow[] {
  return db.prepare(
    `SELECT
       id, session_id, parent_prompt_batch_id, kind, prompt_number,
       user_prompt, response_summary, classification, started_at, ended_at,
       status, activity_count, processed, content_hash, created_at, machine_id, synced_at
     FROM prompt_batches
     ORDER BY id ASC`,
  ).all() as SourcePromptBatchRow[];
}

function listSourceActivities(db: Database): SourceActivityRow[] {
  return db.prepare(
    `SELECT
       id, session_id, prompt_batch_id, tool_name, tool_input, tool_output_summary,
       file_path, files_affected, duration_ms, success, error_message, timestamp,
       processed, content_hash, created_at, canopy_injection_tokens
     FROM activities
     ORDER BY id ASC`,
  ).all() as SourceActivityRow[];
}

function listSourceAttachments(db: Database): SourceAttachmentRow[] {
  return db.prepare(
    `SELECT
       id, session_id, prompt_batch_id, file_path, media_type,
       description, data, content_hash, created_at
     FROM attachments
     ORDER BY created_at ASC, id ASC`,
  ).all() as SourceAttachmentRow[];
}

function listSourcePlans(db: Database): SourcePlanRow[] {
  return db.prepare(
    `SELECT
       id, logical_key, status, author, title, content, source_path, tags,
       session_id, prompt_batch_id, content_hash, processed, created_at,
       updated_at, embedded, machine_id, synced_at
     FROM plans
     ORDER BY created_at ASC, id ASC`,
  ).all() as SourcePlanRow[];
}

function listSourceArtifacts(db: Database): SourceArtifactRow[] {
  return db.prepare(
    `SELECT
       id, artifact_type, source_path, title, content, last_captured_by,
       tags, created_at, updated_at, embedded, machine_id, synced_at
     FROM artifacts
     ORDER BY created_at ASC, id ASC`,
  ).all() as SourceArtifactRow[];
}

function assertNonEmpty(value: string, fieldName: string): void {
  if (typeof value === 'string' && value.trim().length > 0) return;
  throw new Error(`${fieldName} is required`);
}
