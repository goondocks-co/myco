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
  agents: number;
  sessions: number;
  prompt_batches: number;
  activities: number;
  attachments: number;
  plans: number;
  artifacts: number;
  spores: number;
  entities: number;
  entity_mentions: number;
  resolution_events: number;
  skipped_resolution_events: number;
  graph_edges: number;
  skipped_graph_edges: number;
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

interface SourceAgentRow {
  id: string;
  name: string;
  provider: string | null;
  model: string | null;
  system_prompt_hash: string | null;
  config: string | null;
  source: string | null;
  system_prompt: string | null;
  max_turns: number | null;
  timeout_seconds: number | null;
  tool_access: string | null;
  enabled: number | null;
  created_at: number;
  updated_at: number | null;
}

interface SourceSporeRow {
  id: string;
  agent_id: string;
  session_id: string | null;
  prompt_batch_id: number | null;
  observation_type: string;
  status: string | null;
  content: string;
  context: string | null;
  importance: number | null;
  file_path: string | null;
  tags: string | null;
  content_hash: string | null;
  properties: string | null;
  created_at: number;
  updated_at: number | null;
  embedded: number | null;
  machine_id: string | null;
  synced_at: number | null;
}

interface SourceEntityRow {
  id: string;
  agent_id: string;
  type: string;
  name: string;
  properties: string | null;
  first_seen: number;
  last_seen: number;
  status: string | null;
  machine_id: string | null;
  synced_at: number | null;
}

interface SourceEntityMentionRow {
  entity_id: string;
  note_id: string;
  note_type: string;
  agent_id: string;
  machine_id: string | null;
  synced_at: number | null;
}

interface SourceResolutionEventRow {
  id: string;
  agent_id: string;
  spore_id: string;
  action: string;
  new_spore_id: string | null;
  reason: string | null;
  session_id: string | null;
  created_at: number;
  machine_id: string | null;
  synced_at: number | null;
}

interface SourceGraphEdgeRow {
  id: string;
  agent_id: string;
  source_id: string;
  source_type: string;
  target_id: string;
  target_type: string;
  type: string;
  session_id: string | null;
  confidence: number | null;
  properties: string | null;
  created_at: number;
  machine_id: string | null;
  synced_at: number | null;
}

type TargetTable =
  | 'agents'
  | 'sessions'
  | 'prompt_batches'
  | 'activities'
  | 'attachments'
  | 'plans'
  | 'artifacts'
  | 'spores'
  | 'entities'
  | 'entity_mentions'
  | 'resolution_events'
  | 'graph_edges';

const IMPORT_ORIGIN = 'legacy_project_vault';

export function importProjectCoreRows(input: ImportProjectCoreInput): ImportProjectCoreResult {
  const ctx = normalizeInput(input);
  const result: ImportProjectCoreResult = {
    agents: 0,
    sessions: 0,
    prompt_batches: 0,
    activities: 0,
    attachments: 0,
    plans: 0,
    artifacts: 0,
    spores: 0,
    entities: 0,
    entity_mentions: 0,
    resolution_events: 0,
    skipped_resolution_events: 0,
    graph_edges: 0,
    skipped_graph_edges: 0,
  };

  ctx.targetDb.transaction(() => {
    const agents = listSourceAgents(ctx.sourceDb);
    for (const row of agents) {
      ensureTextMapping(ctx, {
        sourceTable: 'agents',
        sourceId: row.id,
        targetTable: 'agents',
        targetId: () => row.id,
      });
    }
    for (const row of agents) {
      if (importAgent(ctx, row)) result.agents += 1;
    }

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

    const promptBatches = listSourcePromptBatches(ctx.sourceDb);
    ensureIntegerMappings(ctx, {
      rows: promptBatches,
      sourceTable: 'prompt_batches',
      targetTable: 'prompt_batches',
      sourceId: (row) => row.id,
      sourceMachineId: (row) => row.machine_id,
    });
    for (const row of sortPromptBatchesForImport(promptBatches)) {
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

    const spores = listSourceSpores(ctx.sourceDb);
    for (const row of spores) {
      ensureTextMapping(ctx, {
        sourceTable: 'spores',
        sourceId: row.id,
        targetTable: 'spores',
        targetId: () => createGroveEraId('spore'),
        sourceMachineId: row.machine_id,
      });
    }
    for (const row of spores) {
      if (importSpore(ctx, row)) result.spores += 1;
    }

    const entities = listSourceEntities(ctx.sourceDb);
    for (const row of entities) {
      ensureTextMapping(ctx, {
        sourceTable: 'entities',
        sourceId: row.id,
        targetTable: 'entities',
        targetId: () => createGroveEraId('entity'),
        sourceMachineId: row.machine_id,
      });
    }
    for (const row of entities) {
      if (importEntity(ctx, row)) result.entities += 1;
    }

    for (const row of listSourceEntityMentions(ctx.sourceDb)) {
      if (importEntityMention(ctx, row)) result.entity_mentions += 1;
    }

    const resolutionEvents = listSourceResolutionEvents(ctx.sourceDb);
    for (const row of resolutionEvents) {
      ensureTextMapping(ctx, {
        sourceTable: 'resolution_events',
        sourceId: row.id,
        targetTable: 'resolution_events',
        targetId: () => createGroveEraId('resolution_event'),
        sourceMachineId: row.machine_id,
      });
    }
    for (const row of resolutionEvents) {
      const imported = importResolutionEvent(ctx, row);
      if (imported === 'imported') result.resolution_events += 1;
      if (imported === 'skipped') result.skipped_resolution_events += 1;
    }

    const graphEdges = listSourceGraphEdges(ctx.sourceDb);
    for (const row of graphEdges) {
      ensureTextMapping(ctx, {
        sourceTable: 'graph_edges',
        sourceId: row.id,
        targetTable: 'graph_edges',
        targetId: () => createGroveEraId('graph_edge'),
        sourceMachineId: row.machine_id,
      });
    }
    for (const row of graphEdges) {
      const imported = importGraphEdge(ctx, row);
      if (imported === 'imported') result.graph_edges += 1;
      if (imported === 'skipped') result.skipped_graph_edges += 1;
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

function importAgent(ctx: ImportContext, row: SourceAgentRow): boolean {
  const mapping = requireMapping(ctx, 'agents', row.id);
  if (targetRowExists(ctx.targetDb, 'agents', mapping.target_id)) {
    markImported(ctx, 'agents', row.id);
    return false;
  }

  ctx.targetDb.prepare(
    `INSERT INTO agents (
       id, name, provider, model, system_prompt_hash, config,
       source, system_prompt, max_turns, timeout_seconds, tool_access,
       enabled, created_at, updated_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?
     )`,
  ).run(
    mapping.target_id,
    row.name,
    row.provider,
    row.model,
    row.system_prompt_hash,
    row.config,
    row.source ?? 'built-in',
    row.system_prompt,
    row.max_turns,
    row.timeout_seconds,
    row.tool_access,
    row.enabled ?? 1,
    row.created_at,
    row.updated_at,
  );

  markImported(ctx, 'agents', row.id);
  return true;
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

function importSpore(ctx: ImportContext, row: SourceSporeRow): boolean {
  const mapping = requireMapping(ctx, 'spores', row.id);
  if (targetRowExists(ctx.targetDb, 'spores', mapping.target_id)) {
    markImported(ctx, 'spores', row.id);
    return false;
  }

  const agentId = mapRequiredTextId(ctx, 'agents', row.agent_id);
  const sessionId = mapOptionalTextId(ctx, 'sessions', row.session_id);
  const promptBatchId = mapOptionalIntegerId(ctx, 'prompt_batches', row.prompt_batch_id);
  const machineId = row.machine_id ?? ctx.targetMachineId ?? 'local';

  ctx.targetDb.prepare(
    `INSERT INTO spores (
       id, project_id, agent_id, session_id, prompt_batch_id,
       observation_type, status, content, context, importance,
       file_path, tags, content_hash, properties, created_at,
       updated_at, embedded, machine_id, synced_at
     ) VALUES (
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?
     )`,
  ).run(
    mapping.target_id,
    ctx.targetProjectId,
    agentId,
    sessionId,
    promptBatchId,
    row.observation_type,
    row.status ?? 'active',
    row.content,
    row.context,
    row.importance ?? 5,
    row.file_path,
    row.tags,
    row.content_hash,
    row.properties,
    row.created_at,
    row.updated_at,
    0,
    machineId,
    row.synced_at,
  );

  markImported(ctx, 'spores', row.id);
  return true;
}

function importEntity(ctx: ImportContext, row: SourceEntityRow): boolean {
  const mapping = requireMapping(ctx, 'entities', row.id);
  if (targetRowExists(ctx.targetDb, 'entities', mapping.target_id)) {
    markImported(ctx, 'entities', row.id);
    return false;
  }

  const agentId = mapRequiredTextId(ctx, 'agents', row.agent_id);
  const machineId = row.machine_id ?? ctx.targetMachineId ?? 'local';

  ctx.targetDb.prepare(
    `INSERT INTO entities (
       id, project_id, agent_id, type, name, properties,
       first_seen, last_seen, status, machine_id, synced_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?
     )`,
  ).run(
    mapping.target_id,
    ctx.targetProjectId,
    agentId,
    row.type,
    row.name,
    row.properties,
    row.first_seen,
    row.last_seen,
    row.status ?? 'active',
    machineId,
    row.synced_at,
  );

  markImported(ctx, 'entities', row.id);
  return true;
}

function importEntityMention(ctx: ImportContext, row: SourceEntityMentionRow): boolean {
  const sourceId = entityMentionSourceId(row);
  const existing = lookupImportMappingBySource(ctx.migrationId, 'entity_mentions', sourceId, ctx.targetDb);
  if (existing?.status === 'imported') return false;

  const entityId = mapRequiredTextId(ctx, 'entities', row.entity_id);
  const noteId = mapRequiredPolymorphicId(ctx, row.note_type, row.note_id);
  const agentId = mapRequiredTextId(ctx, 'agents', row.agent_id);
  const machineId = row.machine_id ?? ctx.targetMachineId ?? 'local';
  const targetId = entityMentionTargetId({
    entityId,
    noteId,
    noteType: row.note_type,
    agentId,
  });

  if (!existing) {
    recordImportMapping({
      migration_id: ctx.migrationId,
      source_project_root: ctx.sourceProjectRoot,
      source_db_path: ctx.sourceDbPath,
      target_grove_id: ctx.targetGroveId,
      target_project_id: ctx.targetProjectId,
      source_table: 'entity_mentions',
      source_id: sourceId,
      target_table: 'entity_mentions',
      target_id: targetId,
      source_machine_id: row.machine_id,
      target_machine_id: ctx.targetMachineId ?? row.machine_id ?? null,
      import_origin: IMPORT_ORIGIN,
    }, ctx.targetDb);
  }

  if (!entityMentionExists(ctx.targetDb, entityId, noteId, row.note_type, agentId)) {
    ctx.targetDb.prepare(
      `INSERT INTO entity_mentions (
         project_id, entity_id, note_id, note_type, agent_id, machine_id, synced_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ctx.targetProjectId,
      entityId,
      noteId,
      row.note_type,
      agentId,
      machineId,
      row.synced_at,
    );
    markImported(ctx, 'entity_mentions', sourceId);
    return true;
  }

  markImported(ctx, 'entity_mentions', sourceId);
  return false;
}

function importResolutionEvent(ctx: ImportContext, row: SourceResolutionEventRow): 'imported' | 'skipped' | 'unchanged' {
  const mapping = requireMapping(ctx, 'resolution_events', row.id);
  if (mapping.status === 'skipped') return 'unchanged';
  if (targetRowExists(ctx.targetDb, 'resolution_events', mapping.target_id)) {
    markImported(ctx, 'resolution_events', row.id);
    return 'unchanged';
  }

  const agentId = mapRequiredTextId(ctx, 'agents', row.agent_id);
  const sporeId = mapOptionalTextIdIfMapped(ctx, 'spores', row.spore_id);
  const newSporeId = mapOptionalTextIdIfMapped(ctx, 'spores', row.new_spore_id);
  if (!sporeId || (row.new_spore_id != null && !newSporeId)) {
    markSkipped(ctx, 'resolution_events', row.id, `unmapped spore reference ${row.spore_id} -> ${row.new_spore_id ?? 'null'}`);
    return 'skipped';
  }
  const sessionId = mapOptionalTextId(ctx, 'sessions', row.session_id);
  const machineId = row.machine_id ?? ctx.targetMachineId ?? 'local';

  ctx.targetDb.prepare(
    `INSERT INTO resolution_events (
       id, project_id, agent_id, spore_id, action, new_spore_id,
       reason, session_id, created_at, machine_id, synced_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?
     )`,
  ).run(
    mapping.target_id,
    ctx.targetProjectId,
    agentId,
    sporeId,
    row.action,
    newSporeId,
    row.reason,
    sessionId,
    row.created_at,
    machineId,
    row.synced_at,
  );

  markImported(ctx, 'resolution_events', row.id);
  return 'imported';
}

function importGraphEdge(ctx: ImportContext, row: SourceGraphEdgeRow): 'imported' | 'skipped' | 'unchanged' {
  const mapping = requireMapping(ctx, 'graph_edges', row.id);
  if (mapping.status === 'skipped') return 'unchanged';
  if (targetRowExists(ctx.targetDb, 'graph_edges', mapping.target_id)) {
    markImported(ctx, 'graph_edges', row.id);
    return 'unchanged';
  }

  const sourceId = mapOptionalPolymorphicId(ctx, row.source_type, row.source_id);
  const targetId = mapOptionalPolymorphicId(ctx, row.target_type, row.target_id);
  if (!sourceId || !targetId) {
    markSkipped(ctx, 'graph_edges', row.id, `unmapped endpoint ${row.source_type}/${row.source_id} -> ${row.target_type}/${row.target_id}`);
    return 'skipped';
  }

  const agentId = mapRequiredTextId(ctx, 'agents', row.agent_id);
  const sessionId = mapOptionalTextId(ctx, 'sessions', row.session_id);
  const machineId = row.machine_id ?? ctx.targetMachineId ?? 'local';

  ctx.targetDb.prepare(
    `INSERT INTO graph_edges (
       id, project_id, agent_id, source_id, source_type, target_id,
       target_type, type, session_id, confidence, properties,
       created_at, machine_id, synced_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?
     )`,
  ).run(
    mapping.target_id,
    ctx.targetProjectId,
    agentId,
    sourceId,
    row.source_type,
    targetId,
    row.target_type,
    row.type,
    sessionId,
    row.confidence ?? 1,
    row.properties,
    row.created_at,
    machineId,
    row.synced_at,
  );

  markImported(ctx, 'graph_edges', row.id);
  return 'imported';
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

function ensureIntegerMappings<Row>(
  ctx: ImportContext,
  input: {
    rows: readonly Row[];
    sourceTable: TargetTable;
    targetTable: TargetTable;
    sourceId: (row: Row) => number;
    sourceMachineId?: (row: Row) => string | null;
  },
): void {
  const usedTargetIds = new Set<string>();
  for (const row of input.rows) {
    const mapping = lookupImportMappingBySource(
      ctx.migrationId,
      input.sourceTable,
      input.sourceId(row),
      ctx.targetDb,
    );
    if (mapping) usedTargetIds.add(mapping.target_id);
  }

  let nextTargetId = nextIntegerTargetId(ctx.targetDb, input.targetTable);
  for (const row of input.rows) {
    const sourceId = input.sourceId(row);
    const existing = lookupImportMappingBySource(ctx.migrationId, input.sourceTable, sourceId, ctx.targetDb);
    if (existing) continue;

    while (usedTargetIds.has(String(nextTargetId)) || targetRowExists(ctx.targetDb, input.targetTable, nextTargetId)) {
      nextTargetId += 1;
    }
    const targetId = String(nextTargetId);
    usedTargetIds.add(targetId);
    nextTargetId += 1;

    recordImportMapping({
      migration_id: ctx.migrationId,
      source_project_root: ctx.sourceProjectRoot,
      source_db_path: ctx.sourceDbPath,
      target_grove_id: ctx.targetGroveId,
      target_project_id: ctx.targetProjectId,
      source_table: input.sourceTable,
      source_id: sourceId,
      target_table: input.targetTable,
      target_id: targetId,
      source_machine_id: input.sourceMachineId?.(row) ?? null,
      target_machine_id: ctx.targetMachineId ?? input.sourceMachineId?.(row) ?? null,
      import_origin: IMPORT_ORIGIN,
    }, ctx.targetDb);
  }
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

function nextIntegerTargetId(db: Database, table: TargetTable): number {
  const row = db.prepare(`SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM ${table}`).get() as
    | { next_id: number }
    | undefined;
  return row?.next_id ?? 1;
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

function sortPromptBatchesForImport(rows: readonly SourcePromptBatchRow[]): SourcePromptBatchRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const visited = new Set<number>();
  const visiting = new Set<number>();
  const ordered: SourcePromptBatchRow[] = [];

  function visit(row: SourcePromptBatchRow): void {
    if (visited.has(row.id)) return;
    if (visiting.has(row.id)) {
      throw new Error(`Cycle in prompt_batches parent chain at ${row.id}`);
    }

    visiting.add(row.id);
    if (row.parent_prompt_batch_id != null) {
      const parent = byId.get(row.parent_prompt_batch_id);
      if (!parent) {
        throw new Error(`Missing source prompt_batches parent ${row.parent_prompt_batch_id} for ${row.id}`);
      }
      visit(parent);
    }
    visiting.delete(row.id);
    visited.add(row.id);
    ordered.push(row);
  }

  for (const row of rows) visit(row);
  return ordered;
}

function markImported(ctx: ImportContext, sourceTable: TargetTable, sourceId: string | number): void {
  markImportMappingStatus(ctx.migrationId, sourceTable, sourceId, 'imported', {}, ctx.targetDb);
}

function markSkipped(ctx: ImportContext, sourceTable: TargetTable, sourceId: string | number, reason: string): void {
  markImportMappingStatus(ctx.migrationId, sourceTable, sourceId, 'skipped', { notes: reason }, ctx.targetDb);
}

function mapRequiredTextId(ctx: ImportContext, sourceTable: TargetTable, sourceId: string): string {
  return requireMapping(ctx, sourceTable, sourceId).target_id;
}

function mapOptionalTextId(ctx: ImportContext, sourceTable: TargetTable, sourceId: string | null): string | null {
  if (sourceId == null) return null;
  return mapRequiredTextId(ctx, sourceTable, sourceId);
}

function mapOptionalTextIdIfMapped(ctx: ImportContext, sourceTable: TargetTable, sourceId: string | null): string | null {
  if (sourceId == null) return null;
  const mapping = lookupImportMappingBySource(ctx.migrationId, sourceTable, sourceId, ctx.targetDb);
  if (!mapping || mapping.status === 'skipped' || mapping.status === 'error') return null;
  return mapping.target_id;
}

function mapOptionalIntegerId(ctx: ImportContext, sourceTable: TargetTable, sourceId: number | null): number | null {
  if (sourceId == null) return null;
  return parseMappedInteger(requireMapping(ctx, sourceTable, sourceId));
}

function mapRequiredPolymorphicId(ctx: ImportContext, sourceType: string, sourceId: string): string {
  const mapped = mapOptionalPolymorphicId(ctx, sourceType, sourceId);
  if (!mapped) throw new Error(`Missing import mapping for ${sourceType}/${sourceId}`);
  return mapped;
}

function mapOptionalPolymorphicId(ctx: ImportContext, sourceType: string, sourceId: string): string | null {
  const mapping = lookupPolymorphicMapping(ctx, sourceType, sourceId);
  if (!mapping || mapping.status === 'skipped' || mapping.status === 'error') return null;
  return mapping.target_id;
}

function lookupPolymorphicMapping(ctx: ImportContext, sourceType: string, sourceId: string): ImportMappingRow | null {
  switch (sourceType) {
    case 'session':
      return lookupImportMappingBySource(ctx.migrationId, 'sessions', sourceId, ctx.targetDb);
    case 'batch':
    case 'prompt_batch':
      return lookupImportMappingBySource(ctx.migrationId, 'prompt_batches', parseIntegerSourceId(sourceType, sourceId), ctx.targetDb);
    case 'spore':
      return lookupImportMappingBySource(ctx.migrationId, 'spores', sourceId, ctx.targetDb);
    case 'entity':
      return lookupImportMappingBySource(ctx.migrationId, 'entities', sourceId, ctx.targetDb);
    case 'plan':
      return lookupImportMappingBySource(ctx.migrationId, 'plans', sourceId, ctx.targetDb);
    case 'artifact':
      return lookupImportMappingBySource(ctx.migrationId, 'artifacts', sourceId, ctx.targetDb);
    default:
      return null;
  }
}

function parseIntegerSourceId(sourceType: string, sourceId: string): number {
  const value = Number(sourceId);
  if (!Number.isSafeInteger(value) || value <= 0 || String(value) !== sourceId) {
    throw new Error(`Invalid integer ${sourceType} id: ${sourceId}`);
  }
  return value;
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

function entityMentionExists(
  db: Database,
  entityId: string,
  noteId: string,
  noteType: string,
  agentId: string,
): boolean {
  const row = db.prepare(
    `SELECT 1 AS present
       FROM entity_mentions
      WHERE entity_id = ? AND note_id = ? AND note_type = ? AND agent_id = ?
      LIMIT 1`,
  ).get(entityId, noteId, noteType, agentId) as { present: number } | undefined;
  return row?.present === 1;
}

function entityMentionSourceId(row: SourceEntityMentionRow): string {
  return [row.entity_id, row.note_id, row.note_type, row.agent_id].join('\u001f');
}

function entityMentionTargetId(input: {
  entityId: string;
  noteId: string;
  noteType: string;
  agentId: string;
}): string {
  return [input.entityId, input.noteId, input.noteType, input.agentId].join('\u001f');
}

function rebuildCoreFtsIndexes(db: Database): void {
  for (const table of ['sessions_fts', 'prompt_batches_fts', 'activities_fts', 'spores_fts'] as const) {
    db.prepare(`INSERT INTO ${table}(${table}) VALUES('rebuild')`).run();
  }
}

function listSourceAgents(db: Database): SourceAgentRow[] {
  return db.prepare(
    `SELECT
       id, name, provider, model, system_prompt_hash, config,
       source, system_prompt, max_turns, timeout_seconds, tool_access,
       enabled, created_at, updated_at
     FROM agents
     ORDER BY created_at ASC, id ASC`,
  ).all() as SourceAgentRow[];
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

function listSourceSpores(db: Database): SourceSporeRow[] {
  return db.prepare(
    `SELECT
       id, agent_id, session_id, prompt_batch_id, observation_type,
       status, content, context, importance, file_path, tags,
       content_hash, properties, created_at, updated_at, embedded,
       machine_id, synced_at
     FROM spores
     ORDER BY created_at ASC, id ASC`,
  ).all() as SourceSporeRow[];
}

function listSourceEntities(db: Database): SourceEntityRow[] {
  return db.prepare(
    `SELECT
       id, agent_id, type, name, properties, first_seen, last_seen,
       status, machine_id, synced_at
     FROM entities
     ORDER BY first_seen ASC, id ASC`,
  ).all() as SourceEntityRow[];
}

function listSourceEntityMentions(db: Database): SourceEntityMentionRow[] {
  return db.prepare(
    `SELECT
       entity_id, note_id, note_type, agent_id, machine_id, synced_at
     FROM entity_mentions
     ORDER BY entity_id ASC, note_type ASC, note_id ASC, agent_id ASC`,
  ).all() as SourceEntityMentionRow[];
}

function listSourceResolutionEvents(db: Database): SourceResolutionEventRow[] {
  return db.prepare(
    `SELECT
       id, agent_id, spore_id, action, new_spore_id, reason,
       session_id, created_at, machine_id, synced_at
     FROM resolution_events
     ORDER BY created_at ASC, id ASC`,
  ).all() as SourceResolutionEventRow[];
}

function listSourceGraphEdges(db: Database): SourceGraphEdgeRow[] {
  return db.prepare(
    `SELECT
       id, agent_id, source_id, source_type, target_id, target_type,
       type, session_id, confidence, properties, created_at, machine_id, synced_at
     FROM graph_edges
     ORDER BY created_at ASC, id ASC`,
  ).all() as SourceGraphEdgeRow[];
}

function assertNonEmpty(value: string, fieldName: string): void {
  if (typeof value === 'string' && value.trim().length > 0) return;
  throw new Error(`${fieldName} is required`);
}
