import type { Database } from '@myco/db/client.js';
import {
  lookupImportMappingBySource,
  markImportMappingStatus,
  recordImportMapping,
  type ImportMappingRow,
} from '@myco/db/queries/migration-import-journal.js';
import { assertGroveEraId, createGroveEraId } from '@myco/grove/ids.js';
import {
  listSourceActivities,
  listSourceAgentReports,
  listSourceAgentRunWriteIntents,
  listSourceAgentRuns,
  listSourceAgentState,
  listSourceAgentTasks,
  listSourceAgentTurns,
  listSourceAgents,
  listSourceArtifacts,
  listSourceAttachments,
  listSourceCanopyEntries,
  listSourceCanopyMaps,
  listSourceCortexInstructions,
  listSourceDigestExtractRevisions,
  listSourceDigestExtracts,
  listSourceEntities,
  listSourceEntityMentions,
  listSourceGraphEdges,
  listSourceLogEntries,
  listSourceNotifications,
  listSourcePlans,
  listSourcePromptBatches,
  listSourceResolutionEvents,
  listSourceSkillCandidates,
  listSourceSkillLineage,
  listSourceSkillRecords,
  listSourceSkillUsage,
  listSourceSpores,
  listSourceSessions,
  type SourceActivityRow,
  type SourceAgentReportRow,
  type SourceAgentRunRow,
  type SourceAgentRunWriteIntentRow,
  type SourceAgentStateRow,
  type SourceAgentTaskRow,
  type SourceAgentTurnRow,
  type SourceAgentRow,
  type SourceArtifactRow,
  type SourceAttachmentRow,
  type SourceCanopyEntryRow,
  type SourceCanopyMapRow,
  type SourceCortexInstructionsRow,
  type SourceDigestExtractRevisionRow,
  type SourceDigestExtractRow,
  type SourceEntityMentionRow,
  type SourceEntityRow,
  type SourceGraphEdgeRow,
  type SourceLogEntryRow,
  type SourceNotificationRow,
  type SourcePlanRow,
  type SourcePromptBatchRow,
  type SourceResolutionEventRow,
  type SourceSkillCandidateRow,
  type SourceSkillLineageRow,
  type SourceSkillRecordRow,
  type SourceSkillUsageRow,
  type SourceSporeRow,
  type SourceSessionRow,
} from './importer/source-rows.js';

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
  agent_tasks: number;
  skipped_agent_tasks: number;
  agent_state: number;
  skipped_agent_state: number;
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
  agent_runs: number;
  agent_reports: number;
  skipped_agent_reports: number;
  agent_turns: number;
  skipped_agent_turns: number;
  agent_run_write_intents: number;
  skipped_agent_run_write_intents: number;
  skill_records: number;
  skipped_skill_records: number;
  skill_candidates: number;
  skipped_skill_candidates: number;
  skill_lineage: number;
  skipped_skill_lineage: number;
  skill_usage: number;
  skipped_skill_usage: number;
  canopy_entries: number;
  canopy_maps: number;
  digest_extracts: number;
  digest_extract_revisions: number;
  cortex_instructions: number;
  notifications: number;
  log_entries: number;
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

/**
 * Outcome of importing a single source row into the target Grove DB.
 *
 * - 'imported': the row was inserted (or rebound to an existing target id) on
 *   this pass. Increments the per-table imported counter.
 * - 'skipped':  the row could not be imported because a required mapping was
 *   missing (dangling reference). Increments the per-table skipped counter.
 *   Skipped rows are recorded in the import journal so re-runs are idempotent.
 * - 'unchanged': the target row already exists or this row was already
 *   imported on a previous run. No counter is incremented.
 *
 * Every per-table importer returns this union; counter wiring lives in
 * `runTable` so the orchestrator stays declarative.
 */
export type ImportOutcome = 'imported' | 'skipped' | 'unchanged';

type ImportedCounter = {
  [K in keyof ImportProjectCoreResult]: K extends `skipped_${string}` ? never : K
}[keyof ImportProjectCoreResult];

type SkippedCounter = {
  [K in keyof ImportProjectCoreResult]: K extends `skipped_${string}` ? K : never
}[keyof ImportProjectCoreResult];

interface RunTableSpec<Row> {
  rows: readonly Row[];
  run: (row: Row) => ImportOutcome;
  imported: ImportedCounter;
  skipped?: SkippedCounter;
}

/**
 * Iterate `rows`, run the per-table importer, and increment the right
 * counters on `result`. Centralizes the counter wiring so per-table
 * orchestrator blocks no longer need hand-written `if (outcome === 'imported')`
 * ladders. If `skipped` is omitted, this importer is not expected to skip;
 * a 'skipped' outcome will throw to surface the contract mismatch loudly.
 */
function runTable<Row>(
  spec: RunTableSpec<Row>,
  result: ImportProjectCoreResult,
): void {
  for (const row of spec.rows) {
    const outcome = spec.run(row);
    if (outcome === 'imported') {
      result[spec.imported] += 1;
    } else if (outcome === 'skipped') {
      if (!spec.skipped) {
        throw new Error(
          `runTable: importer for "${spec.imported}" returned 'skipped' but no skipped counter was configured`,
        );
      }
      result[spec.skipped] += 1;
    }
  }
}

type TargetTable =
  | 'agents'
  | 'agent_tasks'
  | 'agent_state'
  | 'agent_runs'
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
  | 'graph_edges'
  | 'agent_reports'
  | 'agent_turns'
  | 'agent_run_write_intents'
  | 'canopy_entries'
  | 'canopy_maps'
  | 'digest_extracts'
  | 'digest_extract_revisions'
  | 'cortex_instructions'
  | 'skill_candidates'
  | 'skill_records'
  | 'skill_lineage'
  | 'skill_usage'
  | 'notifications'
  | 'log_entries';

const IMPORT_ORIGIN = 'legacy_project_vault';

export function importProjectCoreRows(input: ImportProjectCoreInput): ImportProjectCoreResult {
  const ctx = normalizeInput(input);
  const result: ImportProjectCoreResult = {
    agents: 0,
    agent_tasks: 0,
    skipped_agent_tasks: 0,
    agent_state: 0,
    skipped_agent_state: 0,
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
    agent_runs: 0,
    agent_reports: 0,
    skipped_agent_reports: 0,
    agent_turns: 0,
    skipped_agent_turns: 0,
    agent_run_write_intents: 0,
    skipped_agent_run_write_intents: 0,
    skill_records: 0,
    skipped_skill_records: 0,
    skill_candidates: 0,
    skipped_skill_candidates: 0,
    skill_lineage: 0,
    skipped_skill_lineage: 0,
    skill_usage: 0,
    skipped_skill_usage: 0,
    canopy_entries: 0,
    canopy_maps: 0,
    digest_extracts: 0,
    digest_extract_revisions: 0,
    cortex_instructions: 0,
    notifications: 0,
    log_entries: 0,
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
    runTable({
      rows: agents,
      run: (row) => importAgent(ctx, row),
      imported: 'agents',
    }, result);

    const agentTasks = listSourceAgentTasks(ctx.sourceDb);
    for (const row of agentTasks) {
      ensureTextMapping(ctx, {
        sourceTable: 'agent_tasks',
        sourceId: row.id,
        targetTable: 'agent_tasks',
        targetId: () => row.id,
      });
    }
    runTable({
      rows: agentTasks,
      run: (row) => importAgentTask(ctx, row),
      imported: 'agent_tasks',
      skipped: 'skipped_agent_tasks',
    }, result);

    const agentState = listSourceAgentState(ctx.sourceDb);
    for (const row of agentState) {
      ensureTextMapping(ctx, {
        sourceTable: 'agent_state',
        sourceId: agentStateSourceId(row),
        targetTable: 'agent_state',
        targetId: () => agentStateTargetId(ctx, row),
      });
    }
    runTable({
      rows: agentState,
      run: (row) => importAgentState(ctx, row),
      imported: 'agent_state',
      skipped: 'skipped_agent_state',
    }, result);

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
    runTable({
      rows: sessions,
      run: (row) => importSession(ctx, row),
      imported: 'sessions',
    }, result);

    const promptBatches = listSourcePromptBatches(ctx.sourceDb);
    ensureIntegerMappings(ctx, {
      rows: promptBatches,
      sourceTable: 'prompt_batches',
      targetTable: 'prompt_batches',
      sourceId: (row) => row.id,
      sourceMachineId: (row) => row.machine_id,
    });
    runTable({
      rows: sortPromptBatchesForImport(promptBatches),
      run: (row) => importPromptBatch(ctx, row),
      imported: 'prompt_batches',
    }, result);

    runTable({
      rows: listSourceActivities(ctx.sourceDb),
      run: (row) => importActivity(ctx, row),
      imported: 'activities',
    }, result);

    const attachments = listSourceAttachments(ctx.sourceDb);
    for (const row of attachments) {
      ensureTextMapping(ctx, {
        sourceTable: 'attachments',
        sourceId: row.id,
        targetTable: 'attachments',
        targetId: () => createGroveEraId('attachment'),
      });
    }
    runTable({
      rows: attachments,
      run: (row) => importAttachment(ctx, row),
      imported: 'attachments',
    }, result);

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
    runTable({
      rows: plans,
      run: (row) => importPlan(ctx, row),
      imported: 'plans',
    }, result);

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
    runTable({
      rows: artifacts,
      run: (row) => importArtifact(ctx, row),
      imported: 'artifacts',
    }, result);

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
    runTable({
      rows: spores,
      run: (row) => importSpore(ctx, row),
      imported: 'spores',
    }, result);

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
    runTable({
      rows: entities,
      run: (row) => importEntity(ctx, row),
      imported: 'entities',
    }, result);

    runTable({
      rows: listSourceEntityMentions(ctx.sourceDb),
      run: (row) => importEntityMention(ctx, row),
      imported: 'entity_mentions',
    }, result);

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
    runTable({
      rows: resolutionEvents,
      run: (row) => importResolutionEvent(ctx, row),
      imported: 'resolution_events',
      skipped: 'skipped_resolution_events',
    }, result);

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
    runTable({
      rows: graphEdges,
      run: (row) => importGraphEdge(ctx, row),
      imported: 'graph_edges',
      skipped: 'skipped_graph_edges',
    }, result);

    const agentRuns = listSourceAgentRuns(ctx.sourceDb);
    for (const row of agentRuns) {
      ensureTextMapping(ctx, {
        sourceTable: 'agent_runs',
        sourceId: row.id,
        targetTable: 'agent_runs',
        targetId: () => createGroveEraId('agent_run'),
      });
    }
    runTable({
      rows: agentRuns,
      run: (row) => importAgentRun(ctx, row),
      imported: 'agent_runs',
    }, result);

    const agentReports = listSourceAgentReports(ctx.sourceDb);
    ensureIntegerMappings(ctx, {
      rows: agentReports,
      sourceTable: 'agent_reports',
      targetTable: 'agent_reports',
      sourceId: (row) => row.id,
    });
    runTable({
      rows: agentReports,
      run: (row) => importAgentReport(ctx, row),
      imported: 'agent_reports',
      skipped: 'skipped_agent_reports',
    }, result);

    const agentTurns = listSourceAgentTurns(ctx.sourceDb);
    ensureIntegerMappings(ctx, {
      rows: agentTurns,
      sourceTable: 'agent_turns',
      targetTable: 'agent_turns',
      sourceId: (row) => row.id,
    });
    runTable({
      rows: agentTurns,
      run: (row) => importAgentTurn(ctx, row),
      imported: 'agent_turns',
      skipped: 'skipped_agent_turns',
    }, result);

    const writeIntents = listSourceAgentRunWriteIntents(ctx.sourceDb);
    ensureIntegerMappings(ctx, {
      rows: writeIntents,
      sourceTable: 'agent_run_write_intents',
      targetTable: 'agent_run_write_intents',
      sourceId: (row) => row.id,
    });
    runTable({
      rows: writeIntents,
      run: (row) => importAgentRunWriteIntent(ctx, row),
      imported: 'agent_run_write_intents',
      skipped: 'skipped_agent_run_write_intents',
    }, result);

    const skillRecords = listSourceSkillRecords(ctx.sourceDb);
    for (const row of skillRecords) {
      ensureTextMapping(ctx, {
        sourceTable: 'skill_records',
        sourceId: row.id,
        targetTable: 'skill_records',
        targetId: () => createGroveEraId('skill_record'),
        sourceMachineId: row.machine_id,
      });
    }

    const skillCandidates = listSourceSkillCandidates(ctx.sourceDb);
    for (const row of skillCandidates) {
      ensureTextMapping(ctx, {
        sourceTable: 'skill_candidates',
        sourceId: row.id,
        targetTable: 'skill_candidates',
        targetId: () => createGroveEraId('skill_candidate'),
        sourceMachineId: row.machine_id,
      });
    }

    runTable({
      rows: skillRecords,
      run: (row) => importSkillRecord(ctx, row),
      imported: 'skill_records',
      skipped: 'skipped_skill_records',
    }, result);

    runTable({
      rows: skillCandidates,
      run: (row) => importSkillCandidate(ctx, row),
      imported: 'skill_candidates',
      skipped: 'skipped_skill_candidates',
    }, result);

    for (const row of skillRecords) {
      linkSkillRecordCandidate(ctx, row);
    }

    const skillLineage = listSourceSkillLineage(ctx.sourceDb);
    for (const row of skillLineage) {
      ensureTextMapping(ctx, {
        sourceTable: 'skill_lineage',
        sourceId: row.id,
        targetTable: 'skill_lineage',
        targetId: () => createGroveEraId('skill_lineage'),
      });
    }
    runTable({
      rows: skillLineage,
      run: (row) => importSkillLineage(ctx, row),
      imported: 'skill_lineage',
      skipped: 'skipped_skill_lineage',
    }, result);

    const skillUsage = listSourceSkillUsage(ctx.sourceDb);
    for (const row of skillUsage) {
      ensureTextMapping(ctx, {
        sourceTable: 'skill_usage',
        sourceId: row.id,
        targetTable: 'skill_usage',
        targetId: () => createGroveEraId('skill_usage'),
        sourceMachineId: row.machine_id,
      });
    }
    runTable({
      rows: skillUsage,
      run: (row) => importSkillUsage(ctx, row),
      imported: 'skill_usage',
      skipped: 'skipped_skill_usage',
    }, result);

    const canopyEntries = listSourceCanopyEntries(ctx.sourceDb);
    for (const row of canopyEntries) {
      ensureTextMapping(ctx, {
        sourceTable: 'canopy_entries',
        sourceId: canopyEntrySourceId(row),
        targetTable: 'canopy_entries',
        targetId: () => canopyEntryTargetId(ctx, row),
        sourceMachineId: row.machine_id,
      });
    }
    runTable({
      rows: canopyEntries,
      run: (row) => importCanopyEntry(ctx, row),
      imported: 'canopy_entries',
    }, result);

    const canopyMaps = listSourceCanopyMaps(ctx.sourceDb);
    for (const row of canopyMaps) {
      ensureTextMapping(ctx, {
        sourceTable: 'canopy_maps',
        sourceId: canopyMapSourceId(row),
        targetTable: 'canopy_maps',
        targetId: () => canopyMapTargetId(ctx, row),
        sourceMachineId: row.machine_id,
      });
    }
    runTable({
      rows: canopyMaps,
      run: (row) => importCanopyMap(ctx, row),
      imported: 'canopy_maps',
    }, result);

    const digestExtracts = listSourceDigestExtracts(ctx.sourceDb);
    ensureIntegerMappings(ctx, {
      rows: digestExtracts,
      sourceTable: 'digest_extracts',
      targetTable: 'digest_extracts',
      sourceId: (row) => row.id,
      sourceMachineId: (row) => row.machine_id,
    });
    runTable({
      rows: digestExtracts,
      run: (row) => importDigestExtract(ctx, row),
      imported: 'digest_extracts',
    }, result);

    const digestExtractRevisions = listSourceDigestExtractRevisions(ctx.sourceDb);
    ensureIntegerMappings(ctx, {
      rows: digestExtractRevisions,
      sourceTable: 'digest_extract_revisions',
      targetTable: 'digest_extract_revisions',
      sourceId: (row) => row.id,
    });
    runTable({
      rows: sortDigestExtractRevisionsForImport(digestExtractRevisions),
      run: (row) => importDigestExtractRevision(ctx, row),
      imported: 'digest_extract_revisions',
    }, result);

    const cortexInstructions = listSourceCortexInstructions(ctx.sourceDb);
    for (const row of cortexInstructions) {
      ensureTextMapping(ctx, {
        sourceTable: 'cortex_instructions',
        sourceId: row.id,
        targetTable: 'cortex_instructions',
        targetId: () => row.id,
        sourceMachineId: row.machine_id,
      });
    }
    runTable({
      rows: cortexInstructions,
      run: (row) => importCortexInstructions(ctx, row),
      imported: 'cortex_instructions',
    }, result);

    const notifications = listSourceNotifications(ctx.sourceDb);
    for (const row of notifications) {
      ensureTextMapping(ctx, {
        sourceTable: 'notifications',
        sourceId: row.id,
        targetTable: 'notifications',
        targetId: () => createGroveEraId('notification'),
      });
    }
    runTable({
      rows: notifications,
      run: (row) => importNotification(ctx, row),
      imported: 'notifications',
    }, result);

    const logEntries = listSourceLogEntries(ctx.sourceDb);
    ensureIntegerMappings(ctx, {
      rows: logEntries,
      sourceTable: 'log_entries',
      targetTable: 'log_entries',
      sourceId: (row) => row.id,
    });
    runTable({
      rows: logEntries,
      run: (row) => importLogEntry(ctx, row),
      imported: 'log_entries',
    }, result);

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

function importAgent(ctx: ImportContext, row: SourceAgentRow): ImportOutcome {
  const mapping = requireMapping(ctx, 'agents', row.id);
  if (targetRowExists(ctx.targetDb, 'agents', mapping.target_id)) {
    markImported(ctx, 'agents', row.id);
    return 'unchanged';
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
  return 'imported';
}

function importAgentTask(ctx: ImportContext, row: SourceAgentTaskRow): ImportOutcome {
  const mapping = requireMapping(ctx, 'agent_tasks', row.id);
  if (mapping.status === 'skipped') return 'unchanged';

  const agentId = mapOptionalTextIdIfMapped(ctx, 'agents', row.agent_id);
  if (!agentId) {
    markSkipped(ctx, 'agent_tasks', row.id, `unmapped agent reference ${row.agent_id}`);
    return 'skipped';
  }

  if (targetRowExists(ctx.targetDb, 'agent_tasks', mapping.target_id)) {
    markImported(ctx, 'agent_tasks', row.id);
    return 'unchanged';
  }

  ctx.targetDb.prepare(
    `INSERT INTO agent_tasks (
       id, agent_id, source, display_name, description,
       prompt, is_default, tool_overrides, model, config,
       created_at, updated_at
     ) VALUES (
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?
     )`,
  ).run(
    mapping.target_id,
    agentId,
    row.source ?? 'built-in',
    row.display_name,
    row.description,
    row.prompt,
    row.is_default ?? 0,
    row.tool_overrides,
    row.model,
    row.config,
    row.created_at,
    row.updated_at,
  );

  markImported(ctx, 'agent_tasks', row.id);
  return 'imported';
}

function importAgentState(ctx: ImportContext, row: SourceAgentStateRow): ImportOutcome {
  const sourceId = agentStateSourceId(row);
  const mapping = requireMapping(ctx, 'agent_state', sourceId);
  if (mapping.status === 'skipped') return 'unchanged';

  const agentId = mapOptionalTextIdIfMapped(ctx, 'agents', row.agent_id);
  if (!agentId) {
    markSkipped(ctx, 'agent_state', sourceId, `unmapped agent reference ${row.agent_id}`);
    return 'skipped';
  }

  const existing = getAgentStateUpdatedAt(ctx.targetDb, agentId, ctx.targetProjectId, row.key);
  if (existing == null) {
    ctx.targetDb.prepare(
      `INSERT INTO agent_state (agent_id, project_id, key, value, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(agentId, ctx.targetProjectId, row.key, row.value, row.updated_at);
    markImported(ctx, 'agent_state', sourceId);
    return 'imported';
  }

  if (row.updated_at > existing) {
    ctx.targetDb.prepare(
      `UPDATE agent_state
          SET value = ?,
              updated_at = ?
        WHERE agent_id = ?
          AND project_id = ?
          AND key = ?`,
    ).run(row.value, row.updated_at, agentId, ctx.targetProjectId, row.key);
    markImported(ctx, 'agent_state', sourceId);
    return 'imported';
  }

  markImported(ctx, 'agent_state', sourceId);
  return 'unchanged';
}

function importSession(ctx: ImportContext, row: SourceSessionRow): ImportOutcome {
  const mapping = requireMapping(ctx, 'sessions', row.id);
  if (targetRowExists(ctx.targetDb, 'sessions', mapping.target_id)) {
    markImported(ctx, 'sessions', row.id);
    return 'unchanged';
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
  return 'imported';
}

function importPromptBatch(ctx: ImportContext, row: SourcePromptBatchRow): ImportOutcome {
  const existing = lookupSourceMapping(ctx, 'prompt_batches', row.id);
  if (existing) {
    const targetId = parseMappedInteger(existing);
    if (targetRowExists(ctx.targetDb, 'prompt_batches', targetId)) {
      markImported(ctx, 'prompt_batches', row.id);
      return 'unchanged';
    }
    insertPromptBatch(ctx, row, targetId);
    markImported(ctx, 'prompt_batches', row.id);
    return 'imported';
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
  return 'imported';
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

function importActivity(ctx: ImportContext, row: SourceActivityRow): ImportOutcome {
  const existing = lookupSourceMapping(ctx, 'activities', row.id);
  if (existing) {
    const targetId = parseMappedInteger(existing);
    if (targetRowExists(ctx.targetDb, 'activities', targetId)) {
      markImported(ctx, 'activities', row.id);
      return 'unchanged';
    }
    insertActivity(ctx, row, targetId);
    markImported(ctx, 'activities', row.id);
    return 'imported';
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
  return 'imported';
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

function importAttachment(ctx: ImportContext, row: SourceAttachmentRow): ImportOutcome {
  const mapping = requireMapping(ctx, 'attachments', row.id);
  if (targetRowExists(ctx.targetDb, 'attachments', mapping.target_id)) {
    markImported(ctx, 'attachments', row.id);
    return 'unchanged';
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
  return 'imported';
}

function importPlan(ctx: ImportContext, row: SourcePlanRow): ImportOutcome {
  const mapping = requireMapping(ctx, 'plans', row.id);
  if (targetRowExists(ctx.targetDb, 'plans', mapping.target_id)) {
    markImported(ctx, 'plans', row.id);
    return 'unchanged';
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
  return 'imported';
}

function importArtifact(ctx: ImportContext, row: SourceArtifactRow): ImportOutcome {
  const mapping = requireMapping(ctx, 'artifacts', row.id);
  if (targetRowExists(ctx.targetDb, 'artifacts', mapping.target_id)) {
    markImported(ctx, 'artifacts', row.id);
    return 'unchanged';
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
  return 'imported';
}

function importSpore(ctx: ImportContext, row: SourceSporeRow): ImportOutcome {
  const mapping = requireMapping(ctx, 'spores', row.id);
  if (targetRowExists(ctx.targetDb, 'spores', mapping.target_id)) {
    markImported(ctx, 'spores', row.id);
    return 'unchanged';
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
  return 'imported';
}

function importEntity(ctx: ImportContext, row: SourceEntityRow): ImportOutcome {
  const mapping = requireMapping(ctx, 'entities', row.id);
  if (targetRowExists(ctx.targetDb, 'entities', mapping.target_id)) {
    markImported(ctx, 'entities', row.id);
    return 'unchanged';
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
  return 'imported';
}

function importEntityMention(ctx: ImportContext, row: SourceEntityMentionRow): ImportOutcome {
  const sourceId = entityMentionSourceId(row);
  const existing = lookupSourceMapping(ctx, 'entity_mentions', sourceId);
  if (existing?.status === 'imported') return 'unchanged';

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
    return 'imported';
  }

  markImported(ctx, 'entity_mentions', sourceId);
  return 'unchanged';
}

function importResolutionEvent(ctx: ImportContext, row: SourceResolutionEventRow): ImportOutcome {
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

function importGraphEdge(ctx: ImportContext, row: SourceGraphEdgeRow): ImportOutcome {
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

function importAgentRun(ctx: ImportContext, row: SourceAgentRunRow): ImportOutcome {
  const mapping = requireMapping(ctx, 'agent_runs', row.id);
  if (targetRowExists(ctx.targetDb, 'agent_runs', mapping.target_id)) {
    markImported(ctx, 'agent_runs', row.id);
    return 'unchanged';
  }

  const agentId = mapRequiredTextId(ctx, 'agents', row.agent_id);
  const sessionRef = mapOptionalTextIdIfMapped(ctx, 'sessions', row.session_ref) ?? row.session_ref;

  ctx.targetDb.prepare(
    `INSERT INTO agent_runs (
       id, project_id, agent_id, task, instruction, status,
       harness, provider, model, session_ref, resumable,
       resume_status, resume_mode, resumed_at, checkpoints, usage_data,
       started_at, completed_at, tokens_used, cost_usd, actual_cost_usd,
       estimated_cost_usd, cost_source, cost_data, actions_taken, error,
       dry_run, reasoning_level, execution_overrides
     ) VALUES (
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?
     )`,
  ).run(
    mapping.target_id,
    ctx.targetProjectId,
    agentId,
    row.task,
    row.instruction,
    row.status ?? 'pending',
    row.harness,
    row.provider,
    row.model,
    sessionRef,
    row.resumable ?? 0,
    row.resume_status,
    row.resume_mode,
    row.resumed_at,
    row.checkpoints,
    row.usage_data,
    row.started_at,
    row.completed_at,
    row.tokens_used,
    row.cost_usd,
    row.actual_cost_usd,
    row.estimated_cost_usd,
    row.cost_source,
    row.cost_data,
    row.actions_taken,
    row.error,
    row.dry_run ?? 0,
    row.reasoning_level,
    row.execution_overrides,
  );

  markImported(ctx, 'agent_runs', row.id);
  return 'imported';
}

function importAgentReport(ctx: ImportContext, row: SourceAgentReportRow): ImportOutcome {
  const mapping = requireMapping(ctx, 'agent_reports', row.id);
  if (mapping.status === 'skipped') return 'unchanged';
  const targetId = parseMappedInteger(mapping);
  if (targetRowExists(ctx.targetDb, 'agent_reports', targetId)) {
    markImported(ctx, 'agent_reports', row.id);
    return 'unchanged';
  }

  const runId = mapOptionalTextIdIfMapped(ctx, 'agent_runs', row.run_id);
  const agentId = mapOptionalTextIdIfMapped(ctx, 'agents', row.agent_id);
  if (!runId || !agentId) {
    markSkipped(ctx, 'agent_reports', row.id, agentOperationSkipReason(row.run_id, row.agent_id, runId, agentId));
    return 'skipped';
  }

  insertAgentReport(ctx, row, targetId, { runId, agentId });
  markImported(ctx, 'agent_reports', row.id);
  return 'imported';
}

function insertAgentReport(
  ctx: ImportContext,
  row: SourceAgentReportRow,
  targetId: number,
  refs: { runId: string; agentId: string },
) {
  const sql = `INSERT INTO agent_reports (
     id, project_id, run_id, agent_id, action, summary, details, created_at
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
  const params = [
    ctx.targetProjectId,
    refs.runId,
    refs.agentId,
    row.action,
    row.summary,
    row.details,
    row.created_at,
  ];

  return ctx.targetDb.prepare(sql).run(targetId, ...params);
}

function importAgentTurn(ctx: ImportContext, row: SourceAgentTurnRow): ImportOutcome {
  const mapping = requireMapping(ctx, 'agent_turns', row.id);
  if (mapping.status === 'skipped') return 'unchanged';
  const targetId = parseMappedInteger(mapping);
  if (targetRowExists(ctx.targetDb, 'agent_turns', targetId)) {
    markImported(ctx, 'agent_turns', row.id);
    return 'unchanged';
  }

  const runId = mapOptionalTextIdIfMapped(ctx, 'agent_runs', row.run_id);
  const agentId = mapOptionalTextIdIfMapped(ctx, 'agents', row.agent_id);
  if (!runId || !agentId) {
    markSkipped(ctx, 'agent_turns', row.id, agentOperationSkipReason(row.run_id, row.agent_id, runId, agentId));
    return 'skipped';
  }

  insertAgentTurn(ctx, row, targetId, { runId, agentId });
  markImported(ctx, 'agent_turns', row.id);
  return 'imported';
}

function insertAgentTurn(
  ctx: ImportContext,
  row: SourceAgentTurnRow,
  targetId: number,
  refs: { runId: string; agentId: string },
) {
  const sql = `INSERT INTO agent_turns (
     id, project_id, run_id, agent_id, turn_number, tool_name,
     tool_input, tool_output_summary, started_at, completed_at
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const params = [
    ctx.targetProjectId,
    refs.runId,
    refs.agentId,
    row.turn_number,
    row.tool_name,
    row.tool_input,
    row.tool_output_summary,
    row.started_at,
    row.completed_at,
  ];

  return ctx.targetDb.prepare(sql).run(targetId, ...params);
}

function importAgentRunWriteIntent(ctx: ImportContext, row: SourceAgentRunWriteIntentRow): ImportOutcome {
  const mapping = requireMapping(ctx, 'agent_run_write_intents', row.id);
  if (mapping.status === 'skipped') return 'unchanged';
  const targetId = parseMappedInteger(mapping);
  if (targetRowExists(ctx.targetDb, 'agent_run_write_intents', targetId)) {
    markImported(ctx, 'agent_run_write_intents', row.id);
    return 'unchanged';
  }

  const runId = mapOptionalTextIdIfMapped(ctx, 'agent_runs', row.run_id);
  if (!runId) {
    markSkipped(ctx, 'agent_run_write_intents', row.id, `unmapped run reference ${row.run_id}`);
    return 'skipped';
  }

  insertAgentRunWriteIntent(ctx, row, targetId, runId);
  markImported(ctx, 'agent_run_write_intents', row.id);
  return 'imported';
}

function insertAgentRunWriteIntent(
  ctx: ImportContext,
  row: SourceAgentRunWriteIntentRow,
  targetId: number,
  runId: string,
) {
  const sql = `INSERT INTO agent_run_write_intents (
     id, project_id, run_id, phase_id, tool_name, tool_input,
     synthetic_output, stub_id, recorded_at
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const params = [
    ctx.targetProjectId,
    runId,
    row.phase_id,
    row.tool_name,
    row.tool_input,
    row.synthetic_output,
    row.stub_id,
    row.recorded_at,
  ];

  return ctx.targetDb.prepare(sql).run(targetId, ...params);
}

function importSkillRecord(ctx: ImportContext, row: SourceSkillRecordRow): ImportOutcome {
  const mapping = requireMapping(ctx, 'skill_records', row.id);
  if (mapping.status === 'skipped') return 'unchanged';
  if (targetRowExists(ctx.targetDb, 'skill_records', mapping.target_id)) {
    markImported(ctx, 'skill_records', row.id);
    return 'unchanged';
  }

  const agentId = mapOptionalTextIdIfMapped(ctx, 'agents', row.agent_id);
  if (!agentId) {
    markSkipped(ctx, 'skill_records', row.id, `unmapped agent reference ${row.agent_id}`);
    return 'skipped';
  }

  const machineId = row.machine_id ?? ctx.targetMachineId ?? 'local';

  ctx.targetDb.prepare(
    `INSERT INTO skill_records (
       id, project_id, agent_id, machine_id, name, display_name,
       description, status, embedded, generation, candidate_id,
       source_ids, path, usage_count, last_used_at, created_at,
       updated_at, properties, synced_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?
     )`,
  ).run(
    mapping.target_id,
    ctx.targetProjectId,
    agentId,
    machineId,
    row.name,
    row.display_name,
    row.description,
    row.status ?? 'active',
    0,
    row.generation ?? 1,
    null,
    row.source_ids ?? '[]',
    row.path,
    row.usage_count ?? 0,
    row.last_used_at,
    row.created_at,
    row.updated_at,
    row.properties ?? '{}',
    row.synced_at,
  );

  markImported(ctx, 'skill_records', row.id);
  return 'imported';
}

function importSkillCandidate(ctx: ImportContext, row: SourceSkillCandidateRow): ImportOutcome {
  const mapping = requireMapping(ctx, 'skill_candidates', row.id);
  if (mapping.status === 'skipped') return 'unchanged';
  if (targetRowExists(ctx.targetDb, 'skill_candidates', mapping.target_id)) {
    markImported(ctx, 'skill_candidates', row.id);
    return 'unchanged';
  }

  const agentId = mapOptionalTextIdIfMapped(ctx, 'agents', row.agent_id);
  if (!agentId) {
    markSkipped(ctx, 'skill_candidates', row.id, `unmapped agent reference ${row.agent_id}`);
    return 'skipped';
  }

  const skillId = mapOptionalTextIdIfMapped(ctx, 'skill_records', row.skill_id);
  const machineId = row.machine_id ?? ctx.targetMachineId ?? 'local';

  ctx.targetDb.prepare(
    `INSERT INTO skill_candidates (
       id, project_id, agent_id, machine_id, topic, rationale,
       confidence, status, source_ids, skill_id, supersedes,
       created_at, updated_at, approved_at, evidence_bundle_id,
       quality_score, quality_failures, coverage_matches, last_reconciled_at,
       reconciliation_reason, synced_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?
     )`,
  ).run(
    mapping.target_id,
    ctx.targetProjectId,
    agentId,
    machineId,
    row.topic,
    row.rationale,
    row.confidence ?? 0,
    row.status ?? 'identified',
    row.source_ids ?? '[]',
    skillId,
    row.supersedes,
    row.created_at,
    row.updated_at,
    row.approved_at,
    row.evidence_bundle_id,
    row.quality_score,
    row.quality_failures ?? '[]',
    row.coverage_matches ?? '[]',
    row.last_reconciled_at,
    row.reconciliation_reason,
    row.synced_at,
  );

  markImported(ctx, 'skill_candidates', row.id);
  return 'imported';
}

function linkSkillRecordCandidate(ctx: ImportContext, row: SourceSkillRecordRow): void {
  if (!row.candidate_id) return;
  const record = lookupSourceMapping(ctx, 'skill_records', row.id);
  if (!record || record.status === 'skipped' || record.status === 'error') return;

  const candidateId = mapOptionalTextIdIfMapped(ctx, 'skill_candidates', row.candidate_id);
  if (!candidateId || !targetRowExists(ctx.targetDb, 'skill_records', record.target_id)) return;

  ctx.targetDb.prepare(
    `UPDATE skill_records
        SET candidate_id = ?
      WHERE id = ?
        AND (candidate_id IS NULL OR candidate_id != ?)`,
  ).run(candidateId, record.target_id, candidateId);
}

function importSkillLineage(ctx: ImportContext, row: SourceSkillLineageRow): ImportOutcome {
  const mapping = requireMapping(ctx, 'skill_lineage', row.id);
  if (mapping.status === 'skipped') return 'unchanged';
  if (targetRowExists(ctx.targetDb, 'skill_lineage', mapping.target_id)) {
    markImported(ctx, 'skill_lineage', row.id);
    return 'unchanged';
  }

  const skillId = mapOptionalTextIdIfMapped(ctx, 'skill_records', row.skill_id);
  if (!skillId) {
    markSkipped(ctx, 'skill_lineage', row.id, `unmapped skill reference ${row.skill_id}`);
    return 'skipped';
  }

  ctx.targetDb.prepare(
    `INSERT INTO skill_lineage (
       id, project_id, skill_id, generation, action, rationale,
       source_ids_added, content_snapshot, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    mapping.target_id,
    ctx.targetProjectId,
    skillId,
    row.generation,
    row.action,
    row.rationale,
    row.source_ids_added ?? '[]',
    row.content_snapshot,
    row.created_at,
  );

  markImported(ctx, 'skill_lineage', row.id);
  return 'imported';
}

function importSkillUsage(ctx: ImportContext, row: SourceSkillUsageRow): ImportOutcome {
  const mapping = requireMapping(ctx, 'skill_usage', row.id);
  if (mapping.status === 'skipped') return 'unchanged';
  if (targetRowExists(ctx.targetDb, 'skill_usage', mapping.target_id)) {
    markImported(ctx, 'skill_usage', row.id);
    return 'unchanged';
  }

  const skillId = mapOptionalTextIdIfMapped(ctx, 'skill_records', row.skill_id);
  const sessionId = mapOptionalTextIdIfMapped(ctx, 'sessions', row.session_id);
  if (!skillId || !sessionId) {
    markSkipped(ctx, 'skill_usage', row.id, skillUsageSkipReason(row, skillId, sessionId));
    return 'skipped';
  }

  const machineId = row.machine_id ?? ctx.targetMachineId ?? 'local';

  ctx.targetDb.prepare(
    `INSERT INTO skill_usage (
       id, project_id, skill_id, session_id, machine_id, detected_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    mapping.target_id,
    ctx.targetProjectId,
    skillId,
    sessionId,
    machineId,
    row.detected_at,
  );

  markImported(ctx, 'skill_usage', row.id);
  return 'imported';
}

function importCanopyEntry(ctx: ImportContext, row: SourceCanopyEntryRow): ImportOutcome {
  const sourceId = canopyEntrySourceId(row);
  requireMapping(ctx, 'canopy_entries', sourceId);
  if (canopyEntryExists(ctx.targetDb, ctx.targetProjectId, row.path)) {
    markImported(ctx, 'canopy_entries', sourceId);
    return 'unchanged';
  }

  const machineId = row.machine_id ?? ctx.targetMachineId ?? 'local';

  ctx.targetDb.prepare(
    `INSERT INTO canopy_entries (
       project_id, machine_id, path, content_hash, size_bytes,
       token_estimate, line_count, language, exports_json, imports_json,
       top_comment, mechanical_updated_at, llm_description, llm_updated_at,
       embedded
     ) VALUES (
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?
     )`,
  ).run(
    ctx.targetProjectId,
    machineId,
    row.path,
    row.content_hash,
    row.size_bytes,
    row.token_estimate,
    row.line_count,
    row.language,
    row.exports_json,
    row.imports_json,
    row.top_comment,
    row.mechanical_updated_at,
    row.llm_description,
    row.llm_updated_at,
    0,
  );

  markImported(ctx, 'canopy_entries', sourceId);
  return 'imported';
}

function importCanopyMap(ctx: ImportContext, row: SourceCanopyMapRow): ImportOutcome {
  const sourceId = canopyMapSourceId(row);
  const mapping = requireMapping(ctx, 'canopy_maps', sourceId);
  const machineId = canopyMapMachineIdFromTargetId(mapping.target_id);
  if (canopyMapExists(ctx.targetDb, ctx.targetProjectId, machineId)) {
    markImported(ctx, 'canopy_maps', sourceId);
    return 'unchanged';
  }

  const generatedByRunId = mapOptionalTextIdIfMapped(ctx, 'agent_runs', row.generated_by_run_id);

  ctx.targetDb.prepare(
    `INSERT INTO canopy_maps (
       project_id, machine_id, content, inputs_hash, generated_at,
       generated_by_run_id, token_estimate
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ctx.targetProjectId,
    machineId,
    row.content,
    row.inputs_hash,
    row.generated_at,
    generatedByRunId,
    row.token_estimate,
  );

  markImported(ctx, 'canopy_maps', sourceId);
  return 'imported';
}

function importDigestExtract(ctx: ImportContext, row: SourceDigestExtractRow): ImportOutcome {
  const existing = lookupSourceMapping(ctx, 'digest_extracts', row.id);
  if (existing) {
    const targetId = parseMappedInteger(existing);
    if (targetRowExists(ctx.targetDb, 'digest_extracts', targetId)) {
      markImported(ctx, 'digest_extracts', row.id);
      return 'unchanged';
    }
    insertDigestExtract(ctx, row, targetId);
    markImported(ctx, 'digest_extracts', row.id);
    return 'imported';
  }

  const info = insertDigestExtract(ctx, row);
  const targetId = Number(info.lastInsertRowid);
  recordImportedMapping(ctx, {
    sourceTable: 'digest_extracts',
    sourceId: row.id,
    targetTable: 'digest_extracts',
    targetId: String(targetId),
    sourceMachineId: row.machine_id,
  });
  return 'imported';
}

function insertDigestExtract(ctx: ImportContext, row: SourceDigestExtractRow, targetId?: number) {
  const agentId = mapRequiredTextId(ctx, 'agents', row.agent_id);
  const machineId = row.machine_id ?? ctx.targetMachineId ?? 'local';

  const sql = targetId == null
    ? `INSERT INTO digest_extracts (
         project_id, agent_id, tier, content, substrate_hash,
         generated_at, machine_id, synced_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    : `INSERT INTO digest_extracts (
         id, project_id, agent_id, tier, content, substrate_hash,
         generated_at, machine_id, synced_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const params = [
    ctx.targetProjectId,
    agentId,
    row.tier,
    row.content,
    row.substrate_hash,
    row.generated_at,
    machineId,
    row.synced_at,
  ];

  return targetId == null
    ? ctx.targetDb.prepare(sql).run(...params)
    : ctx.targetDb.prepare(sql).run(targetId, ...params);
}

function importDigestExtractRevision(ctx: ImportContext, row: SourceDigestExtractRevisionRow): ImportOutcome {
  const existing = lookupSourceMapping(ctx, 'digest_extract_revisions', row.id);
  if (existing) {
    const targetId = parseMappedInteger(existing);
    if (targetRowExists(ctx.targetDb, 'digest_extract_revisions', targetId)) {
      markImported(ctx, 'digest_extract_revisions', row.id);
      return 'unchanged';
    }
    insertDigestExtractRevision(ctx, row, targetId);
    markImported(ctx, 'digest_extract_revisions', row.id);
    return 'imported';
  }

  const info = insertDigestExtractRevision(ctx, row);
  const targetId = Number(info.lastInsertRowid);
  recordImportedMapping(ctx, {
    sourceTable: 'digest_extract_revisions',
    sourceId: row.id,
    targetTable: 'digest_extract_revisions',
    targetId: String(targetId),
  });
  return 'imported';
}

function insertDigestExtractRevision(ctx: ImportContext, row: SourceDigestExtractRevisionRow, targetId?: number) {
  const agentId = mapRequiredTextId(ctx, 'agents', row.agent_id);
  const runId = mapOptionalTextIdIfMapped(ctx, 'agent_runs', row.run_id);
  const parentRevisionId = mapOptionalIntegerId(ctx, 'digest_extract_revisions', row.parent_revision_id);

  const sql = targetId == null
    ? `INSERT INTO digest_extract_revisions (
         project_id, agent_id, tier, content, metadata,
         run_id, parent_revision_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    : `INSERT INTO digest_extract_revisions (
         id, project_id, agent_id, tier, content, metadata,
         run_id, parent_revision_id, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const params = [
    ctx.targetProjectId,
    agentId,
    row.tier,
    row.content,
    row.metadata,
    runId,
    parentRevisionId,
    row.created_at,
  ];

  return targetId == null
    ? ctx.targetDb.prepare(sql).run(...params)
    : ctx.targetDb.prepare(sql).run(targetId, ...params);
}

function importCortexInstructions(ctx: ImportContext, row: SourceCortexInstructionsRow): ImportOutcome {
  const mapping = requireMapping(ctx, 'cortex_instructions', row.id);
  if (cortexInstructionsExists(ctx.targetDb, ctx.targetProjectId, mapping.target_id)) {
    markImported(ctx, 'cortex_instructions', row.id);
    return 'unchanged';
  }

  const agentId = mapRequiredTextId(ctx, 'agents', row.agent_id);
  const sourceRunId = mapOptionalTextIdIfMapped(ctx, 'agent_runs', row.source_run_id);
  const machineId = row.machine_id ?? ctx.targetMachineId ?? 'local';

  ctx.targetDb.prepare(
    `INSERT INTO cortex_instructions (
       id, project_id, agent_id, content, input_hash,
       source_run_id, generated_at, machine_id, synced_at
     ) VALUES (
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?
     )`,
  ).run(
    mapping.target_id,
    ctx.targetProjectId,
    agentId,
    row.content,
    row.input_hash,
    sourceRunId,
    row.generated_at,
    machineId,
    row.synced_at,
  );

  markImported(ctx, 'cortex_instructions', row.id);
  return 'imported';
}

function importNotification(ctx: ImportContext, row: SourceNotificationRow): ImportOutcome {
  const mapping = requireMapping(ctx, 'notifications', row.id);
  if (targetRowExists(ctx.targetDb, 'notifications', mapping.target_id)) {
    markImported(ctx, 'notifications', row.id);
    return 'unchanged';
  }

  ctx.targetDb.prepare(
    `INSERT INTO notifications (
       id, project_id, domain, type, level, title, message,
       mode, status, link, metadata, created_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?
     )`,
  ).run(
    mapping.target_id,
    ctx.targetProjectId,
    row.domain,
    row.type,
    row.level ?? 'info',
    row.title,
    row.message,
    row.mode ?? 'banner',
    row.status ?? 'unread',
    row.link,
    row.metadata,
    row.created_at,
  );

  markImported(ctx, 'notifications', row.id);
  return 'imported';
}

function cortexInstructionsExists(db: Database, projectId: string, id: string): boolean {
  const row = db.prepare(
    `SELECT 1 AS present
       FROM cortex_instructions
      WHERE project_id = ? AND id = ?
      LIMIT 1`,
  ).get(projectId, id) as { present: number } | undefined;
  return row?.present === 1;
}

function importLogEntry(ctx: ImportContext, row: SourceLogEntryRow): ImportOutcome {
  const mapping = requireMapping(ctx, 'log_entries', row.id);
  const targetId = parseMappedInteger(mapping);
  if (targetRowExists(ctx.targetDb, 'log_entries', targetId)) {
    markImported(ctx, 'log_entries', row.id);
    return 'unchanged';
  }

  const sessionId = mapOptionalTextIdIfMapped(ctx, 'sessions', row.session_id);

  ctx.targetDb.prepare(
    `INSERT INTO log_entries (
       id, project_id, timestamp, level, component, kind,
       message, data, session_id
     ) VALUES (
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?
     )`,
  ).run(
    targetId,
    ctx.targetProjectId,
    row.timestamp,
    row.level,
    row.component,
    row.kind,
    row.message,
    row.data,
    sessionId,
  );

  markImported(ctx, 'log_entries', row.id);
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
  const existing = lookupSourceMapping(ctx, input.sourceTable, input.sourceId);
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
  const mappingBySourceId = new Map<number, ImportMappingRow | null>();
  for (const row of input.rows) {
    const sourceId = input.sourceId(row);
    if (mappingBySourceId.has(sourceId)) continue;
    const mapping = lookupSourceMapping(ctx, input.sourceTable, sourceId);
    mappingBySourceId.set(sourceId, mapping);
    if (mapping) usedTargetIds.add(mapping.target_id);
  }

  let nextTargetId = nextIntegerTargetId(ctx.targetDb, input.targetTable);
  for (const row of input.rows) {
    const sourceId = input.sourceId(row);
    if (mappingBySourceId.get(sourceId)) continue;

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

function lookupSourceMapping(
  ctx: ImportContext,
  sourceTable: TargetTable,
  sourceId: string | number,
): ImportMappingRow | null {
  return lookupImportMappingBySource(ctx.migrationId, sourceTable, sourceId, {
    source_db_path: ctx.sourceDbPath,
    target_project_id: ctx.targetProjectId,
  }, ctx.targetDb);
}

function requireMapping(
  ctx: ImportContext,
  sourceTable: TargetTable,
  sourceId: string | number,
): ImportMappingRow {
  const mapping = lookupSourceMapping(ctx, sourceTable, sourceId);
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

function sortDigestExtractRevisionsForImport(rows: readonly SourceDigestExtractRevisionRow[]): SourceDigestExtractRevisionRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const visited = new Set<number>();
  const visiting = new Set<number>();
  const ordered: SourceDigestExtractRevisionRow[] = [];

  function visit(row: SourceDigestExtractRevisionRow): void {
    if (visited.has(row.id)) return;
    if (visiting.has(row.id)) {
      throw new Error(`Cycle in digest_extract_revisions parent chain at ${row.id}`);
    }

    visiting.add(row.id);
    if (row.parent_revision_id != null) {
      const parent = byId.get(row.parent_revision_id);
      if (!parent) {
        throw new Error(`Missing source digest_extract_revisions parent ${row.parent_revision_id} for ${row.id}`);
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
  markImportMappingStatus(ctx.migrationId, sourceTable, sourceId, 'imported', {
    source_db_path: ctx.sourceDbPath,
    target_project_id: ctx.targetProjectId,
  }, ctx.targetDb);
}

function markSkipped(ctx: ImportContext, sourceTable: TargetTable, sourceId: string | number, reason: string): void {
  markImportMappingStatus(ctx.migrationId, sourceTable, sourceId, 'skipped', {
    notes: reason,
    source_db_path: ctx.sourceDbPath,
    target_project_id: ctx.targetProjectId,
  }, ctx.targetDb);
}

function agentOperationSkipReason(
  sourceRunId: string,
  sourceAgentId: string,
  mappedRunId: string | null,
  mappedAgentId: string | null,
): string {
  const reasons: string[] = [];
  if (!mappedRunId) reasons.push(`unmapped run reference ${sourceRunId}`);
  if (!mappedAgentId) reasons.push(`unmapped agent reference ${sourceAgentId}`);
  return reasons.join('; ');
}

function skillUsageSkipReason(
  row: SourceSkillUsageRow,
  mappedSkillId: string | null,
  mappedSessionId: string | null,
): string {
  const reasons: string[] = [];
  if (!mappedSkillId) reasons.push(`unmapped skill reference ${row.skill_id}`);
  if (!mappedSessionId) reasons.push(`unmapped session reference ${row.session_id}`);
  return reasons.join('; ');
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
  const mapping = lookupSourceMapping(ctx, sourceTable, sourceId);
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
      return lookupSourceMapping(ctx, 'sessions', sourceId);
    case 'batch':
    case 'prompt_batch':
      return lookupSourceMapping(ctx, 'prompt_batches', parseIntegerSourceId(sourceType, sourceId));
    case 'spore':
      return lookupSourceMapping(ctx, 'spores', sourceId);
    case 'entity':
      return lookupSourceMapping(ctx, 'entities', sourceId);
    case 'plan':
      return lookupSourceMapping(ctx, 'plans', sourceId);
    case 'artifact':
      return lookupSourceMapping(ctx, 'artifacts', sourceId);
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

function canopyEntryExists(db: Database, projectId: string, path: string): boolean {
  const row = db.prepare(
    `SELECT 1 AS present
       FROM canopy_entries
      WHERE project_id = ? AND path = ?
      LIMIT 1`,
  ).get(projectId, path) as { present: number } | undefined;
  return row?.present === 1;
}

function canopyMapExists(db: Database, projectId: string, machineId: string): boolean {
  const row = db.prepare(
    `SELECT 1 AS present
       FROM canopy_maps
      WHERE project_id = ? AND machine_id = ?
      LIMIT 1`,
  ).get(projectId, machineId) as { present: number } | undefined;
  return row?.present === 1;
}

function getAgentStateUpdatedAt(
  db: Database,
  agentId: string,
  projectId: string,
  key: string,
): number | null {
  const row = db.prepare(
    `SELECT updated_at
       FROM agent_state
      WHERE agent_id = ?
        AND project_id = ?
        AND key = ?
      LIMIT 1`,
  ).get(agentId, projectId, key) as { updated_at: number } | undefined;
  return row?.updated_at ?? null;
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

function agentStateSourceId(row: SourceAgentStateRow): string {
  return [row.agent_id, row.key].join('\u001f');
}

function agentStateTargetId(ctx: ImportContext, row: SourceAgentStateRow): string {
  const agentId = mapOptionalTextIdIfMapped(ctx, 'agents', row.agent_id) ?? row.agent_id;
  return [agentId, row.key].join('\u001f');
}

function canopyEntrySourceId(row: SourceCanopyEntryRow): string {
  return [row.project_id, row.path].join('\u001f');
}

function canopyEntryTargetId(ctx: ImportContext, row: SourceCanopyEntryRow): string {
  return [ctx.targetProjectId, row.path].join('\u001f');
}

function canopyMapSourceId(row: SourceCanopyMapRow): string {
  return [row.project_id, row.machine_id ?? 'local'].join('\u001f');
}

function canopyMapTargetId(ctx: ImportContext, row: SourceCanopyMapRow): string {
  return [ctx.targetProjectId, row.machine_id ?? ctx.targetMachineId ?? 'local'].join('\u001f');
}

function canopyMapMachineIdFromTargetId(targetId: string): string {
  const separatorIndex = targetId.indexOf('\u001f');
  if (separatorIndex < 0 || separatorIndex === targetId.length - 1) {
    throw new Error(`Invalid canopy_maps target id: ${targetId}`);
  }
  return targetId.slice(separatorIndex + 1);
}

function rebuildCoreFtsIndexes(db: Database): void {
  for (const table of ['sessions_fts', 'prompt_batches_fts', 'activities_fts', 'spores_fts', 'log_entries_fts'] as const) {
    db.prepare(`INSERT INTO ${table}(${table}) VALUES('rebuild')`).run();
  }
}

function assertNonEmpty(value: string, fieldName: string): void {
  if (typeof value === 'string' && value.trim().length > 0) return;
  throw new Error(`${fieldName} is required`);
}
