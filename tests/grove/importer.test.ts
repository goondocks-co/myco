import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '@myco/db/client.js';
import { openDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import {
  listImportMappingsForMigration,
  lookupImportMappingBySource,
} from '@myco/db/queries/migration-import-journal.js';
import { type ImportOutcome, importProjectCoreRows } from '@myco/grove/importer.js';
import { createMigrationId } from '@myco/grove/ids.js';

const TARGET_GROVE_ID = 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TARGET_PROJECT_ID = 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TARGET_PROJECT_B_ID = 'proj_dddddddddddddddddddddddddddddddd';
const SOURCE_PROJECT_ROOT = '/legacy/project';
const SOURCE_DB_PATH = '/legacy/project/.myco/myco.db';

let sourceDb: Database;
let targetDb: Database;

describe('Grove project core importer', () => {
  beforeEach(() => {
    sourceDb = openDatabase();
    targetDb = openDatabase();
    createSchema(sourceDb);
    createSchema(targetDb);
    seedSourceProject(sourceDb);
    seedTargetExistingRows(targetDb);
  });

  afterEach(() => {
    sourceDb.close();
    targetDb.close();
  });

  it('exposes a stable ImportOutcome union shape', () => {
    // Runtime guard for the documented per-table outcome contract. If a
    // future change introduces a new outcome (e.g. 'partial'), the
    // exhaustive switch below stops compiling and the orchestrator
    // counter wiring in `runTable` must be updated to match.
    const outcomes: readonly ImportOutcome[] = ['imported', 'skipped', 'unchanged'];
    for (const outcome of outcomes) {
      switch (outcome) {
        case 'imported':
        case 'skipped':
        case 'unchanged':
          break;
        default: {
          const _exhaustive: never = outcome;
          throw new Error(`unexpected outcome: ${String(_exhaustive)}`);
        }
      }
    }
    expect(outcomes).toHaveLength(3);
  });

  it('imports capture and plan rows with project scope, rekeyed ids, and rewritten relationships', () => {
    const migrationId = createMigrationId();

    const result = importProjectCoreRows({
      migrationId,
      sourceDb,
      targetDb,
      sourceProjectRoot: SOURCE_PROJECT_ROOT,
      sourceDbPath: SOURCE_DB_PATH,
      targetGroveId: TARGET_GROVE_ID,
      targetProjectId: TARGET_PROJECT_ID,
      targetMachineId: 'target-machine',
    });

    expect(result).toEqual({
      agents: 1,
      agent_tasks: 1,
      skipped_agent_tasks: 1,
      agent_state: 2,
      skipped_agent_state: 1,
      sessions: 2,
      prompt_batches: 2,
      activities: 1,
      attachments: 1,
      plans: 1,
      artifacts: 1,
      spores: 2,
      entities: 1,
      entity_mentions: 1,
      resolution_events: 1,
      skipped_resolution_events: 0,
      graph_edges: 4,
      skipped_graph_edges: 1,
      agent_runs: 1,
      agent_reports: 1,
      skipped_agent_reports: 1,
      agent_turns: 1,
      skipped_agent_turns: 1,
      agent_run_write_intents: 1,
      skipped_agent_run_write_intents: 1,
      skill_records: 1,
      skipped_skill_records: 0,
      skill_candidates: 1,
      skipped_skill_candidates: 0,
      skill_lineage: 1,
      skipped_skill_lineage: 1,
      skill_usage: 1,
      skipped_skill_usage: 1,
      canopy_entries: 1,
      canopy_maps: 1,
      digest_extracts: 1,
      digest_extract_revisions: 2,
      cortex_instructions: 1,
      notifications: 1,
      log_entries: 2,
    });

    const agentId = lookupImportMappingBySource(migrationId, 'agents', 'myco-agent', targetDb)?.target_id;
    const agentTaskId = lookupImportMappingBySource(migrationId, 'agent_tasks', 'skill-evolve', targetDb)?.target_id;
    const skippedAgentTask = lookupImportMappingBySource(migrationId, 'agent_tasks', 'orphan-task', targetDb);
    const phaseStateId = lookupImportMappingBySource(migrationId, 'agent_state', 'myco-agent\u001fskill-evolve-current-phase', targetDb)?.target_id;
    const cursorStateId = lookupImportMappingBySource(migrationId, 'agent_state', 'myco-agent\u001fskill-evolve-assessment-cursor', targetDb)?.target_id;
    const skippedAgentState = lookupImportMappingBySource(migrationId, 'agent_state', 'missing-agent\u001forphan-state', targetDb);
    const parentSessionId = lookupImportMappingBySource(migrationId, 'sessions', 'legacy-parent', targetDb)?.target_id;
    const childSessionId = lookupImportMappingBySource(migrationId, 'sessions', 'legacy-session', targetDb)?.target_id;
    const parentBatchId = Number(lookupImportMappingBySource(migrationId, 'prompt_batches', 2, targetDb)?.target_id);
    const childBatchId = Number(lookupImportMappingBySource(migrationId, 'prompt_batches', 1, targetDb)?.target_id);
    const activityId = Number(lookupImportMappingBySource(migrationId, 'activities', 1, targetDb)?.target_id);
    const attachmentId = lookupImportMappingBySource(migrationId, 'attachments', 'legacy-attachment', targetDb)?.target_id;
    const planId = lookupImportMappingBySource(migrationId, 'plans', 'legacy-plan', targetDb)?.target_id;
    const artifactId = lookupImportMappingBySource(migrationId, 'artifacts', 'legacy-artifact', targetDb)?.target_id;
    const sporeId = lookupImportMappingBySource(migrationId, 'spores', 'legacy-spore', targetDb)?.target_id;
    const wisdomSporeId = lookupImportMappingBySource(migrationId, 'spores', 'legacy-wisdom', targetDb)?.target_id;
    const entityId = lookupImportMappingBySource(migrationId, 'entities', 'legacy-entity', targetDb)?.target_id;
    const resolutionEventId = lookupImportMappingBySource(migrationId, 'resolution_events', 'legacy-resolution', targetDb)?.target_id;
    const graphEdgeId = lookupImportMappingBySource(migrationId, 'graph_edges', 'legacy-edge-spore-session', targetDb)?.target_id;
    const skippedGraphEdge = lookupImportMappingBySource(migrationId, 'graph_edges', 'legacy-edge-dangling-entity', targetDb);
    const agentRunId = lookupImportMappingBySource(migrationId, 'agent_runs', 'legacy-run', targetDb)?.target_id;
    const agentReportId = Number(lookupImportMappingBySource(migrationId, 'agent_reports', 3, targetDb)?.target_id);
    const skippedAgentReport = lookupImportMappingBySource(migrationId, 'agent_reports', 30, targetDb);
    const agentTurnId = Number(lookupImportMappingBySource(migrationId, 'agent_turns', 4, targetDb)?.target_id);
    const skippedAgentTurn = lookupImportMappingBySource(migrationId, 'agent_turns', 40, targetDb);
    const writeIntentId = Number(lookupImportMappingBySource(migrationId, 'agent_run_write_intents', 5, targetDb)?.target_id);
    const skippedWriteIntent = lookupImportMappingBySource(migrationId, 'agent_run_write_intents', 50, targetDb);
    const skillRecordId = lookupImportMappingBySource(migrationId, 'skill_records', 'legacy-skill', targetDb)?.target_id;
    const skillCandidateId = lookupImportMappingBySource(migrationId, 'skill_candidates', 'legacy-candidate', targetDb)?.target_id;
    const skillLineageId = lookupImportMappingBySource(migrationId, 'skill_lineage', 'legacy-lineage', targetDb)?.target_id;
    const skippedSkillLineage = lookupImportMappingBySource(migrationId, 'skill_lineage', 'legacy-orphan-lineage', targetDb);
    const skillUsageId = lookupImportMappingBySource(migrationId, 'skill_usage', 'legacy-usage', targetDb)?.target_id;
    const skippedSkillUsage = lookupImportMappingBySource(migrationId, 'skill_usage', 'legacy-orphan-usage', targetDb);
    const canopyEntryId = lookupImportMappingBySource(
      migrationId,
      'canopy_entries',
      `${SOURCE_PROJECT_ROOT}\u001fpackages/myco/src/grove/importer.ts`,
      targetDb,
    )?.target_id;
    const canopyMapId = lookupImportMappingBySource(
      migrationId,
      'canopy_maps',
      `${SOURCE_PROJECT_ROOT}\u001fsource-machine`,
      targetDb,
    )?.target_id;
    const digestExtractId = Number(lookupImportMappingBySource(migrationId, 'digest_extracts', 7, targetDb)?.target_id);
    const digestRevisionId = Number(lookupImportMappingBySource(migrationId, 'digest_extract_revisions', 8, targetDb)?.target_id);
    const digestParentRevisionId = Number(lookupImportMappingBySource(migrationId, 'digest_extract_revisions', 9, targetDb)?.target_id);
    const cortexInstructionsId = lookupImportMappingBySource(migrationId, 'cortex_instructions', 'myco-agent:session-start', targetDb)?.target_id;
    const notificationId = lookupImportMappingBySource(migrationId, 'notifications', 'legacy-notification', targetDb)?.target_id;
    const logEntryId = Number(lookupImportMappingBySource(migrationId, 'log_entries', 42, targetDb)?.target_id);
    const orphanLogEntryId = Number(lookupImportMappingBySource(migrationId, 'log_entries', 43, targetDb)?.target_id);

    expect(agentId).toBe('myco-agent');
    expect(agentTaskId).toBe('skill-evolve');
    expect(skippedAgentTask?.status).toBe('skipped');
    expect(skippedAgentTask?.notes).toContain('unmapped agent reference missing-agent');
    expect(phaseStateId).toBe('myco-agent\u001fskill-evolve-current-phase');
    expect(cursorStateId).toBe('myco-agent\u001fskill-evolve-assessment-cursor');
    expect(skippedAgentState?.status).toBe('skipped');
    expect(skippedAgentState?.notes).toContain('unmapped agent reference missing-agent');
    expect(parentSessionId).toMatch(/^sess_[0-9a-f]{32}$/);
    expect(childSessionId).toMatch(/^sess_[0-9a-f]{32}$/);
    expect(childSessionId).not.toBe('legacy-session');
    expect(attachmentId).toMatch(/^att_[0-9a-f]{32}$/);
    expect(attachmentId).not.toBe('legacy-attachment');
    expect(planId).toMatch(/^plan_[0-9a-f]{32}$/);
    expect(planId).not.toBe('legacy-plan');
    expect(artifactId).toMatch(/^art_[0-9a-f]{32}$/);
    expect(artifactId).not.toBe('legacy-artifact');
    expect(sporeId).toMatch(/^spore_[0-9a-f]{32}$/);
    expect(sporeId).not.toBe('legacy-spore');
    expect(wisdomSporeId).toMatch(/^spore_[0-9a-f]{32}$/);
    expect(entityId).toMatch(/^ent_[0-9a-f]{32}$/);
    expect(resolutionEventId).toMatch(/^res_[0-9a-f]{32}$/);
    expect(graphEdgeId).toMatch(/^edge_[0-9a-f]{32}$/);
    expect(agentRunId).toMatch(/^run_[0-9a-f]{32}$/);
    expect(agentRunId).not.toBe('legacy-run');
    expect(agentReportId).not.toBe(3);
    expect(agentTurnId).not.toBe(4);
    expect(writeIntentId).not.toBe(5);
    expect(skippedAgentReport?.status).toBe('skipped');
    expect(skippedAgentReport?.notes).toContain('unmapped run reference missing-run');
    expect(skippedAgentTurn?.status).toBe('skipped');
    expect(skippedAgentTurn?.notes).toContain('unmapped run reference missing-run');
    expect(skippedWriteIntent?.status).toBe('skipped');
    expect(skippedWriteIntent?.notes).toContain('unmapped run reference missing-run');
    expect(skillRecordId).toMatch(/^skill_[0-9a-f]{32}$/);
    expect(skillRecordId).not.toBe('legacy-skill');
    expect(skillCandidateId).toMatch(/^skcand_[0-9a-f]{32}$/);
    expect(skillCandidateId).not.toBe('legacy-candidate');
    expect(skillLineageId).toMatch(/^sklin_[0-9a-f]{32}$/);
    expect(skillUsageId).toMatch(/^skuse_[0-9a-f]{32}$/);
    expect(skippedSkillLineage?.status).toBe('skipped');
    expect(skippedSkillLineage?.notes).toContain('unmapped skill reference missing-skill');
    expect(skippedSkillUsage?.status).toBe('skipped');
    expect(skippedSkillUsage?.notes).toContain('unmapped session reference missing-session');
    expect(canopyEntryId).toBe(`${TARGET_PROJECT_ID}\u001fpackages/myco/src/grove/importer.ts`);
    expect(canopyMapId).toBe(`${TARGET_PROJECT_ID}\u001fsource-machine`);
    expect(digestExtractId).not.toBe(7);
    expect(digestRevisionId).not.toBe(8);
    expect(digestParentRevisionId).not.toBe(9);
    expect(cortexInstructionsId).toBe('myco-agent:session-start');
    expect(notificationId).toMatch(/^notif_[0-9a-f]{32}$/);
    expect(notificationId).not.toBe('legacy-notification');
    expect(logEntryId).not.toBe(42);
    expect(orphanLogEntryId).not.toBe(43);
    expect(parentBatchId).not.toBe(2);
    expect(childBatchId).not.toBe(1);
    expect(activityId).not.toBe(1);
    expect(skippedGraphEdge?.status).toBe('skipped');
    expect(skippedGraphEdge?.notes).toContain('unmapped endpoint entity/missing-entity');

    const agentTask = getRow<{
      id: string;
      agent_id: string;
      source: string;
      display_name: string;
      prompt: string;
      is_default: number;
      model: string;
      config: string;
      updated_at: number;
    }>(
      targetDb,
      `SELECT id, agent_id, source, display_name, prompt,
              is_default, model, config, updated_at
         FROM agent_tasks WHERE id = ?`,
      agentTaskId,
    );
    expect(agentTask.agent_id).toBe(agentId);
    expect(agentTask.source).toBe('built-in');
    expect(agentTask.display_name).toBe('Skill Evolution');
    expect(agentTask.prompt).toContain('Evolve skills from persisted state');
    expect(agentTask.is_default).toBe(0);
    expect(agentTask.model).toBe('gpt-test');
    expect(agentTask.config).toBe('{"phase":"assess"}');
    expect(agentTask.updated_at).toBe(491);

    const phaseState = getRow<{ agent_id: string; key: string; value: string; updated_at: number }>(
      targetDb,
      'SELECT agent_id, key, value, updated_at FROM agent_state WHERE agent_id = ? AND key = ?',
      agentId,
      'skill-evolve-current-phase',
    );
    expect(phaseState.value).toBe('assess');
    expect(phaseState.updated_at).toBe(490);

    const cursorState = getRow<{ agent_id: string; key: string; value: string; updated_at: number }>(
      targetDb,
      'SELECT agent_id, key, value, updated_at FROM agent_state WHERE agent_id = ? AND key = ?',
      agentId,
      'skill-evolve-assessment-cursor',
    );
    expect(cursorState.value).toBe('skill-a,skill-b');
    expect(cursorState.updated_at).toBe(492);

    const childSession = getRow<{
      id: string;
      project_id: string;
      project_root: string;
      parent_session_id: string;
      embedded: number;
      machine_id: string;
      canopy_map_tool_calls: number;
    }>(targetDb, 'SELECT id, project_id, project_root, parent_session_id, embedded, machine_id, canopy_map_tool_calls FROM sessions WHERE id = ?', childSessionId);
    expect(childSession.project_id).toBe(TARGET_PROJECT_ID);
    expect(childSession.project_root).toBe(SOURCE_PROJECT_ROOT);
    expect(childSession.parent_session_id).toBe(parentSessionId);
    expect(childSession.embedded).toBe(0);
    expect(childSession.machine_id).toBe('source-machine');
    expect(childSession.canopy_map_tool_calls).toBe(3);

    const childBatch = getRow<{
      project_id: string;
      session_id: string;
      parent_prompt_batch_id: number;
      machine_id: string;
    }>(targetDb, 'SELECT project_id, session_id, parent_prompt_batch_id, machine_id FROM prompt_batches WHERE id = ?', childBatchId);
    expect(childBatch.project_id).toBe(TARGET_PROJECT_ID);
    expect(childBatch.session_id).toBe(childSessionId);
    expect(childBatch.parent_prompt_batch_id).toBe(parentBatchId);
    expect(childBatch.machine_id).toBe('source-machine');

    const activity = getRow<{
      project_id: string;
      session_id: string;
      prompt_batch_id: number;
      tool_name: string;
    }>(targetDb, 'SELECT project_id, session_id, prompt_batch_id, tool_name FROM activities WHERE id = ?', activityId);
    expect(activity.project_id).toBe(TARGET_PROJECT_ID);
    expect(activity.session_id).toBe(childSessionId);
    expect(activity.prompt_batch_id).toBe(childBatchId);
    expect(activity.tool_name).toBe('Read');

    const attachment = getRow<{
      project_id: string;
      session_id: string;
      prompt_batch_id: number;
      file_path: string;
      media_type: string;
      description: string;
      data: Uint8Array;
    }>(targetDb, 'SELECT project_id, session_id, prompt_batch_id, file_path, media_type, description, data FROM attachments WHERE id = ?', attachmentId);
    expect(attachment.project_id).toBe(TARGET_PROJECT_ID);
    expect(attachment.session_id).toBe(childSessionId);
    expect(attachment.prompt_batch_id).toBe(childBatchId);
    expect(attachment.file_path).toBe('attachments/legacy-session-2.png');
    expect(attachment.media_type).toBe('image/png');
    expect(attachment.description).toBe('Prompt image');
    expect(Array.from(attachment.data)).toEqual([1, 2, 3, 4]);

    const plan = getRow<{
      id: string;
      project_id: string;
      session_id: string;
      prompt_batch_id: number;
      content: string;
      embedded: number;
      machine_id: string;
    }>(targetDb, 'SELECT id, project_id, session_id, prompt_batch_id, content, embedded, machine_id FROM plans WHERE id = ?', planId);
    expect(plan.project_id).toBe(TARGET_PROJECT_ID);
    expect(plan.session_id).toBe(childSessionId);
    expect(plan.prompt_batch_id).toBe(childBatchId);
    expect(plan.content).toContain('legacy-plan');
    expect(plan.embedded).toBe(0);
    expect(plan.machine_id).toBe('source-machine');

    const artifact = getRow<{
      id: string;
      project_id: string;
      artifact_type: string;
      source_path: string;
      title: string;
      content: string;
      embedded: number;
      machine_id: string;
    }>(targetDb, 'SELECT id, project_id, artifact_type, source_path, title, content, embedded, machine_id FROM artifacts WHERE id = ?', artifactId);
    expect(artifact.project_id).toBe(TARGET_PROJECT_ID);
    expect(artifact.artifact_type).toBe('doc');
    expect(artifact.source_path).toBe('docs/legacy.md');
    expect(artifact.title).toBe('Legacy artifact');
    expect(artifact.content).toContain('expensive artifact content');
    expect(artifact.embedded).toBe(0);
    expect(artifact.machine_id).toBe('source-machine');

    const spore = getRow<{
      id: string;
      project_id: string;
      agent_id: string;
      session_id: string;
      prompt_batch_id: number;
      content: string;
      embedded: number;
      machine_id: string;
    }>(targetDb, 'SELECT id, project_id, agent_id, session_id, prompt_batch_id, content, embedded, machine_id FROM spores WHERE id = ?', sporeId);
    expect(spore.project_id).toBe(TARGET_PROJECT_ID);
    expect(spore.agent_id).toBe(agentId);
    expect(spore.session_id).toBe(childSessionId);
    expect(spore.prompt_batch_id).toBe(childBatchId);
    expect(spore.content).toContain('durable Grove importer observation');
    expect(spore.embedded).toBe(0);
    expect(spore.machine_id).toBe('source-machine');

    const entity = getRow<{
      project_id: string;
      agent_id: string;
      type: string;
      name: string;
      status: string;
    }>(targetDb, 'SELECT project_id, agent_id, type, name, status FROM entities WHERE id = ?', entityId);
    expect(entity.project_id).toBe(TARGET_PROJECT_ID);
    expect(entity.agent_id).toBe(agentId);
    expect(entity.type).toBe('component');
    expect(entity.name).toBe('Grove importer');
    expect(entity.status).toBe('active');

    const mention = getRow<{
      project_id: string;
      entity_id: string;
      note_id: string;
      note_type: string;
      agent_id: string;
    }>(
      targetDb,
      'SELECT project_id, entity_id, note_id, note_type, agent_id FROM entity_mentions WHERE entity_id = ?',
      entityId,
    );
    expect(mention.project_id).toBe(TARGET_PROJECT_ID);
    expect(mention.entity_id).toBe(entityId);
    expect(mention.note_id).toBe(sporeId);
    expect(mention.note_type).toBe('spore');
    expect(mention.agent_id).toBe(agentId);

    const resolutionEvent = getRow<{
      project_id: string;
      agent_id: string;
      spore_id: string;
      new_spore_id: string;
      session_id: string;
    }>(
      targetDb,
      'SELECT project_id, agent_id, spore_id, new_spore_id, session_id FROM resolution_events WHERE id = ?',
      resolutionEventId,
    );
    expect(resolutionEvent.project_id).toBe(TARGET_PROJECT_ID);
    expect(resolutionEvent.agent_id).toBe(agentId);
    expect(resolutionEvent.spore_id).toBe(sporeId);
    expect(resolutionEvent.new_spore_id).toBe(wisdomSporeId);
    expect(resolutionEvent.session_id).toBe(childSessionId);

    const graphEdge = getRow<{
      project_id: string;
      agent_id: string;
      source_id: string;
      source_type: string;
      target_id: string;
      target_type: string;
      session_id: string;
    }>(
      targetDb,
      'SELECT project_id, agent_id, source_id, source_type, target_id, target_type, session_id FROM graph_edges WHERE id = ?',
      graphEdgeId,
    );
    expect(graphEdge.project_id).toBe(TARGET_PROJECT_ID);
    expect(graphEdge.agent_id).toBe(agentId);
    expect(graphEdge.source_id).toBe(sporeId);
    expect(graphEdge.source_type).toBe('spore');
    expect(graphEdge.target_id).toBe(childSessionId);
    expect(graphEdge.target_type).toBe('session');
    expect(graphEdge.session_id).toBe(childSessionId);

    const agentRun = getRow<{
      project_id: string;
      agent_id: string;
      task: string;
      instruction: string;
      status: string;
      harness: string;
      provider: string;
      model: string;
      session_ref: string;
      resumable: number;
      tokens_used: number;
      cost_usd: number;
      actions_taken: string;
      dry_run: number;
      reasoning_level: string;
      execution_overrides: string;
    }>(
      targetDb,
      `SELECT project_id, agent_id, task, instruction, status, harness, provider,
              model, session_ref, resumable, tokens_used, cost_usd, actions_taken,
              dry_run, reasoning_level, execution_overrides
         FROM agent_runs WHERE id = ?`,
      agentRunId,
    );
    expect(agentRun.project_id).toBe(TARGET_PROJECT_ID);
    expect(agentRun.agent_id).toBe(agentId);
    expect(agentRun.task).toBe('cortex-instructions');
    expect(agentRun.instruction).toContain('Generate cortex instructions');
    expect(agentRun.status).toBe('completed');
    expect(agentRun.harness).toBe('openai');
    expect(agentRun.provider).toBe('openai');
    expect(agentRun.model).toBe('gpt-test');
    expect(agentRun.session_ref).toBe(childSessionId);
    expect(agentRun.resumable).toBe(1);
    expect(agentRun.tokens_used).toBe(1234);
    expect(agentRun.cost_usd).toBe(0.42);
    expect(agentRun.actions_taken).toBe('["wrote digest"]');
    expect(agentRun.dry_run).toBe(0);
    expect(agentRun.reasoning_level).toBe('medium');
    expect(agentRun.execution_overrides).toBe('{"provider":{"model":"gpt-test"}}');

    const agentReport = getRow<{
      project_id: string;
      run_id: string;
      agent_id: string;
      action: string;
      summary: string;
      details: string;
    }>(
      targetDb,
      'SELECT project_id, run_id, agent_id, action, summary, details FROM agent_reports WHERE id = ?',
      agentReportId,
    );
    expect(agentReport.project_id).toBe(TARGET_PROJECT_ID);
    expect(agentReport.run_id).toBe(agentRunId);
    expect(agentReport.agent_id).toBe(agentId);
    expect(agentReport.action).toBe('digest_write');
    expect(agentReport.summary).toContain('Wrote digest');
    expect(agentReport.details).toBe('{"tier":5000}');

    const agentTurn = getRow<{
      project_id: string;
      run_id: string;
      agent_id: string;
      turn_number: number;
      tool_name: string;
      tool_input: string;
      tool_output_summary: string;
    }>(
      targetDb,
      'SELECT project_id, run_id, agent_id, turn_number, tool_name, tool_input, tool_output_summary FROM agent_turns WHERE id = ?',
      agentTurnId,
    );
    expect(agentTurn.project_id).toBe(TARGET_PROJECT_ID);
    expect(agentTurn.run_id).toBe(agentRunId);
    expect(agentTurn.agent_id).toBe(agentId);
    expect(agentTurn.turn_number).toBe(1);
    expect(agentTurn.tool_name).toBe('vault_write_digest');
    expect(agentTurn.tool_input).toBe('{"tier":5000}');
    expect(agentTurn.tool_output_summary).toContain('digest persisted');

    const writeIntent = getRow<{
      project_id: string;
      run_id: string;
      phase_id: string;
      tool_name: string;
      tool_input: string;
      synthetic_output: string;
      stub_id: string;
    }>(
      targetDb,
      `SELECT project_id, run_id, phase_id, tool_name, tool_input,
              synthetic_output, stub_id
         FROM agent_run_write_intents WHERE id = ?`,
      writeIntentId,
    );
    expect(writeIntent.project_id).toBe(TARGET_PROJECT_ID);
    expect(writeIntent.run_id).toBe(agentRunId);
    expect(writeIntent.phase_id).toBe('phase-digest');
    expect(writeIntent.tool_name).toBe('vault_create_spore');
    expect(writeIntent.tool_input).toBe('{"content":"synthetic"}');
    expect(writeIntent.synthetic_output).toBe('{"id":"stub-spore"}');
    expect(writeIntent.stub_id).toBe('stub-spore');

    const skillRecord = getRow<{
      project_id: string;
      agent_id: string;
      machine_id: string;
      name: string;
      display_name: string;
      description: string;
      status: string;
      embedded: number;
      generation: number;
      candidate_id: string;
      source_ids: string;
      path: string;
      usage_count: number;
      last_used_at: number;
      properties: string;
    }>(
      targetDb,
      `SELECT project_id, agent_id, machine_id, name, display_name, description,
              status, embedded, generation, candidate_id, source_ids, path,
              usage_count, last_used_at, properties
         FROM skill_records WHERE id = ?`,
      skillRecordId,
    );
    expect(skillRecord.project_id).toBe(TARGET_PROJECT_ID);
    expect(skillRecord.agent_id).toBe(agentId);
    expect(skillRecord.machine_id).toBe('source-machine');
    expect(skillRecord.name).toBe('myco:legacy-grove-import');
    expect(skillRecord.display_name).toBe('Legacy Grove Import');
    expect(skillRecord.description).toContain('Grove importer skill');
    expect(skillRecord.status).toBe('active');
    expect(skillRecord.embedded).toBe(0);
    expect(skillRecord.generation).toBe(2);
    expect(skillRecord.candidate_id).toBe(skillCandidateId);
    expect(skillRecord.source_ids).toBe('["legacy-spore"]');
    expect(skillRecord.path).toBe('.agents/skills/legacy-grove-import/SKILL.md');
    expect(skillRecord.usage_count).toBe(3);
    expect(skillRecord.last_used_at).toBe(471);
    expect(skillRecord.properties).toBe('{"quality":"validated"}');

    const skillCandidate = getRow<{
      project_id: string;
      agent_id: string;
      machine_id: string;
      topic: string;
      rationale: string;
      confidence: number;
      status: string;
      source_ids: string;
      skill_id: string;
      supersedes: string;
      approved_at: number;
    }>(
      targetDb,
      `SELECT project_id, agent_id, machine_id, topic, rationale, confidence,
              status, source_ids, skill_id, supersedes, approved_at
         FROM skill_candidates WHERE id = ?`,
      skillCandidateId,
    );
    expect(skillCandidate.project_id).toBe(TARGET_PROJECT_ID);
    expect(skillCandidate.agent_id).toBe(agentId);
    expect(skillCandidate.machine_id).toBe('source-machine');
    expect(skillCandidate.topic).toBe('Grove importer operations');
    expect(skillCandidate.rationale).toContain('Importer work repeats');
    expect(skillCandidate.confidence).toBe(0.87);
    expect(skillCandidate.status).toBe('generated');
    expect(skillCandidate.source_ids).toBe('["legacy-spore"]');
    expect(skillCandidate.skill_id).toBe(skillRecordId);
    expect(skillCandidate.supersedes).toBe('["myco:old-importer"]');
    expect(skillCandidate.approved_at).toBe(462);

    const skillLineage = getRow<{
      project_id: string;
      skill_id: string;
      generation: number;
      action: string;
      rationale: string;
      source_ids_added: string;
      content_snapshot: string;
    }>(
      targetDb,
      `SELECT project_id, skill_id, generation, action, rationale,
              source_ids_added, content_snapshot
         FROM skill_lineage WHERE id = ?`,
      skillLineageId,
    );
    expect(skillLineage.project_id).toBe(TARGET_PROJECT_ID);
    expect(skillLineage.skill_id).toBe(skillRecordId);
    expect(skillLineage.generation).toBe(2);
    expect(skillLineage.action).toBe('evolve');
    expect(skillLineage.rationale).toContain('Added Grove import detail');
    expect(skillLineage.source_ids_added).toBe('["legacy-wisdom"]');
    expect(skillLineage.content_snapshot).toContain('Preserve lineage content');

    const skillUsage = getRow<{
      project_id: string;
      skill_id: string;
      session_id: string;
      machine_id: string;
      detected_at: number;
    }>(
      targetDb,
      'SELECT project_id, skill_id, session_id, machine_id, detected_at FROM skill_usage WHERE id = ?',
      skillUsageId,
    );
    expect(skillUsage.project_id).toBe(TARGET_PROJECT_ID);
    expect(skillUsage.skill_id).toBe(skillRecordId);
    expect(skillUsage.session_id).toBe(childSessionId);
    expect(skillUsage.machine_id).toBe('source-machine');
    expect(skillUsage.detected_at).toBe(475);

    const canopyEntry = getRow<{
      project_id: string;
      machine_id: string;
      path: string;
      llm_description: string;
      llm_updated_at: number;
      embedded: number;
    }>(
      targetDb,
      'SELECT project_id, machine_id, path, llm_description, llm_updated_at, embedded FROM canopy_entries WHERE project_id = ? AND path = ?',
      TARGET_PROJECT_ID,
      'packages/myco/src/grove/importer.ts',
    );
    expect(canopyEntry.project_id).toBe(TARGET_PROJECT_ID);
    expect(canopyEntry.machine_id).toBe('source-machine');
    expect(canopyEntry.path).toBe('packages/myco/src/grove/importer.ts');
    expect(canopyEntry.llm_description).toContain('semantic Canopy summary');
    expect(canopyEntry.llm_updated_at).toBe(405);
    expect(canopyEntry.embedded).toBe(0);

    const canopyMap = getRow<{
      project_id: string;
      machine_id: string;
      content: string;
      inputs_hash: string;
      generated_by_run_id: string | null;
    }>(
      targetDb,
      'SELECT project_id, machine_id, content, inputs_hash, generated_by_run_id FROM canopy_maps WHERE project_id = ? AND machine_id = ?',
      TARGET_PROJECT_ID,
      'source-machine',
    );
    expect(canopyMap.project_id).toBe(TARGET_PROJECT_ID);
    expect(canopyMap.machine_id).toBe('source-machine');
    expect(canopyMap.content).toContain('Project architecture map');
    expect(canopyMap.inputs_hash).toBe('canopy-map-inputs');
    expect(canopyMap.generated_by_run_id).toBe(agentRunId);

    const digestExtract = getRow<{
      project_id: string;
      agent_id: string;
      tier: number;
      content: string;
      substrate_hash: string;
      machine_id: string;
    }>(
      targetDb,
      'SELECT project_id, agent_id, tier, content, substrate_hash, machine_id FROM digest_extracts WHERE id = ?',
      digestExtractId,
    );
    expect(digestExtract.project_id).toBe(TARGET_PROJECT_ID);
    expect(digestExtract.agent_id).toBe(agentId);
    expect(digestExtract.tier).toBe(5000);
    expect(digestExtract.content).toContain('expensive digest content');
    expect(digestExtract.substrate_hash).toBe('digest-substrate');
    expect(digestExtract.machine_id).toBe('source-machine');

    const digestRevision = getRow<{
      project_id: string;
      agent_id: string;
      parent_revision_id: number;
      run_id: string | null;
      content: string;
    }>(
      targetDb,
      'SELECT project_id, agent_id, parent_revision_id, run_id, content FROM digest_extract_revisions WHERE id = ?',
      digestRevisionId,
    );
    expect(digestRevision.project_id).toBe(TARGET_PROJECT_ID);
    expect(digestRevision.agent_id).toBe(agentId);
    expect(digestRevision.parent_revision_id).toBe(digestParentRevisionId);
    expect(digestRevision.run_id).toBe(agentRunId);
    expect(digestRevision.content).toContain('newer digest revision');

    const cortexInstructions = getRow<{
      project_id: string;
      agent_id: string;
      content: string;
      source_run_id: string | null;
      machine_id: string;
    }>(
      targetDb,
      'SELECT project_id, agent_id, content, source_run_id, machine_id FROM cortex_instructions WHERE id = ?',
      cortexInstructionsId,
    );
    expect(cortexInstructions.project_id).toBe(TARGET_PROJECT_ID);
    expect(cortexInstructions.agent_id).toBe(agentId);
    expect(cortexInstructions.content).toContain('standing operating context');
    expect(cortexInstructions.source_run_id).toBe(agentRunId);
    expect(cortexInstructions.machine_id).toBe('source-machine');

    const notification = getRow<{
      project_id: string;
      domain: string;
      type: string;
      level: string;
      title: string;
      message: string;
      mode: string;
      status: string;
      link: string;
      metadata: string;
      created_at: number;
    }>(
      targetDb,
      `SELECT project_id, domain, type, level, title, message,
              mode, status, link, metadata, created_at
         FROM notifications WHERE id = ?`,
      notificationId,
    );
    expect(notification.project_id).toBe(TARGET_PROJECT_ID);
    expect(notification.domain).toBe('settings');
    expect(notification.type).toBe('settings-saved');
    expect(notification.level).toBe('success');
    expect(notification.title).toBe('Settings saved');
    expect(notification.message).toContain('legacy notification');
    expect(notification.mode).toBe('summary');
    expect(notification.status).toBe('read');
    expect(notification.link).toBe('/settings');
    expect(notification.metadata).toBe('{"scope":"project"}');
    expect(notification.created_at).toBe(480);

    const logEntry = getRow<{
      project_id: string;
      timestamp: string;
      level: string;
      component: string;
      kind: string;
      message: string;
      data: string;
      session_id: string;
    }>(
      targetDb,
      `SELECT project_id, timestamp, level, component, kind, message, data, session_id
         FROM log_entries WHERE id = ?`,
      logEntryId,
    );
    expect(logEntry.project_id).toBe(TARGET_PROJECT_ID);
    expect(logEntry.timestamp).toBe('2026-05-01T10:00:00.000Z');
    expect(logEntry.level).toBe('info');
    expect(logEntry.component).toBe('grove-importer');
    expect(logEntry.kind).toBe('migration:smoke');
    expect(logEntry.message).toContain('GroveLog imported linked session');
    expect(logEntry.data).toBe('{"source":"fixture"}');
    expect(logEntry.session_id).toBe(childSessionId);

    const orphanLogEntry = getRow<{
      project_id: string;
      message: string;
      session_id: string | null;
    }>(
      targetDb,
      'SELECT project_id, message, session_id FROM log_entries WHERE id = ?',
      orphanLogEntryId,
    );
    expect(orphanLogEntry.project_id).toBe(TARGET_PROJECT_ID);
    expect(orphanLogEntry.message).toContain('GroveLog imported dangling session');
    expect(orphanLogEntry.session_id).toBeNull();

    expect(matchCount(targetDb, 'sessions_fts', 'child')).toBeGreaterThan(0);
    expect(matchCount(targetDb, 'prompt_batches_fts', 'steering')).toBeGreaterThan(0);
    expect(matchCount(targetDb, 'activities_fts', 'README')).toBeGreaterThan(0);
    expect(matchCount(targetDb, 'spores_fts', 'durable')).toBeGreaterThan(0);
    expect(matchCount(targetDb, 'log_entries_fts', 'GroveLog')).toBe(2);

    const mappings = listImportMappingsForMigration(migrationId, targetDb);
    expect(mappings).toHaveLength(46);
    expect(mappings.filter((mapping) => mapping.status === 'imported')).toHaveLength(38);
    expect(mappings.filter((mapping) => mapping.status === 'skipped')).toHaveLength(8);
  });

  it('imports overlapping legacy projects into one Grove without global project-row conflicts', () => {
    const migrationA = createMigrationId();
    const migrationB = createMigrationId();

    importProjectCoreRows({
      migrationId: migrationA,
      sourceDb,
      targetDb,
      sourceProjectRoot: SOURCE_PROJECT_ROOT,
      sourceDbPath: SOURCE_DB_PATH,
      targetGroveId: TARGET_GROVE_ID,
      targetProjectId: TARGET_PROJECT_ID,
      targetMachineId: 'target-machine',
    });

    const resultB = importProjectCoreRows({
      migrationId: migrationB,
      sourceDb,
      targetDb,
      sourceProjectRoot: SOURCE_PROJECT_ROOT,
      sourceDbPath: SOURCE_DB_PATH,
      targetGroveId: TARGET_GROVE_ID,
      targetProjectId: TARGET_PROJECT_B_ID,
      targetMachineId: 'target-machine',
    });

    expect(resultB.sessions).toBe(2);
    expect(resultB.prompt_batches).toBe(2);
    expect(resultB.activities).toBe(1);
    expect(resultB.plans).toBe(1);
    expect(resultB.spores).toBe(2);
    expect(resultB.entities).toBe(1);
    expect(resultB.skill_records).toBe(1);
    expect(resultB.digest_extracts).toBe(1);
    expect(resultB.cortex_instructions).toBe(1);

    for (const projectId of [TARGET_PROJECT_ID, TARGET_PROJECT_B_ID]) {
      expect(countRows(targetDb, 'sessions', projectId), `${projectId}.sessions`).toBe(2);
      expect(countRows(targetDb, 'prompt_batches', projectId), `${projectId}.prompt_batches`).toBe(2);
      expect(countRows(targetDb, 'activities', projectId), `${projectId}.activities`).toBe(1);
      expect(countRows(targetDb, 'plans', projectId), `${projectId}.plans`).toBe(1);
      expect(countRows(targetDb, 'spores', projectId), `${projectId}.spores`).toBe(2);
      expect(countRows(targetDb, 'entities', projectId), `${projectId}.entities`).toBe(1);
      expect(countRows(targetDb, 'skill_records', projectId), `${projectId}.skill_records`).toBe(1);
      expect(countRows(targetDb, 'digest_extracts', projectId), `${projectId}.digest_extracts`).toBe(1);
      expect(countRows(targetDb, 'cortex_instructions', projectId), `${projectId}.cortex_instructions`).toBe(1);
    }

    const planLogicalKeyCount = getRow<{ count: number }>(
      targetDb,
      `SELECT COUNT(*) AS count
         FROM plans
        WHERE logical_key = 'plans/grove-core.md'`,
    ).count;
    expect(planLogicalKeyCount).toBe(2);

    const cortexKeyCount = getRow<{ count: number }>(
      targetDb,
      `SELECT COUNT(*) AS count
         FROM cortex_instructions
        WHERE id = 'myco-agent:session-start'`,
    ).count;
    expect(cortexKeyCount).toBe(2);
  });

  it('uses existing journal mappings on retry instead of duplicating rows', () => {
    const migrationId = createMigrationId();
    importProjectCoreRows({
      migrationId,
      sourceDb,
      targetDb,
      sourceProjectRoot: SOURCE_PROJECT_ROOT,
      sourceDbPath: SOURCE_DB_PATH,
      targetGroveId: TARGET_GROVE_ID,
      targetProjectId: TARGET_PROJECT_ID,
    });

    const retry = importProjectCoreRows({
      migrationId,
      sourceDb,
      targetDb,
      sourceProjectRoot: SOURCE_PROJECT_ROOT,
      sourceDbPath: SOURCE_DB_PATH,
      targetGroveId: TARGET_GROVE_ID,
      targetProjectId: TARGET_PROJECT_ID,
    });

    expect(retry).toEqual({
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
    });
    expect(countRows(targetDb, 'agents')).toBe(1);
    expect(countRows(targetDb, 'agent_tasks')).toBe(1);
    expect(countRows(targetDb, 'agent_state')).toBe(2);
    expect(countRows(targetDb, 'sessions', TARGET_PROJECT_ID)).toBe(2);
    expect(countRows(targetDb, 'prompt_batches', TARGET_PROJECT_ID)).toBe(2);
    expect(countRows(targetDb, 'activities', TARGET_PROJECT_ID)).toBe(1);
    expect(countRows(targetDb, 'attachments', TARGET_PROJECT_ID)).toBe(1);
    expect(countRows(targetDb, 'plans', TARGET_PROJECT_ID)).toBe(1);
    expect(countRows(targetDb, 'artifacts', TARGET_PROJECT_ID)).toBe(1);
    expect(countRows(targetDb, 'spores', TARGET_PROJECT_ID)).toBe(2);
    expect(countRows(targetDb, 'entities', TARGET_PROJECT_ID)).toBe(1);
    expect(countRows(targetDb, 'entity_mentions', TARGET_PROJECT_ID)).toBe(1);
    expect(countRows(targetDb, 'resolution_events', TARGET_PROJECT_ID)).toBe(1);
    expect(countRows(targetDb, 'graph_edges', TARGET_PROJECT_ID)).toBe(4);
    expect(countRows(targetDb, 'agent_runs', TARGET_PROJECT_ID)).toBe(1);
    expect(countRows(targetDb, 'agent_reports', TARGET_PROJECT_ID)).toBe(1);
    expect(countRows(targetDb, 'agent_turns', TARGET_PROJECT_ID)).toBe(1);
    expect(countRows(targetDb, 'agent_run_write_intents', TARGET_PROJECT_ID)).toBe(1);
    expect(countRows(targetDb, 'skill_records', TARGET_PROJECT_ID)).toBe(1);
    expect(countRows(targetDb, 'skill_candidates', TARGET_PROJECT_ID)).toBe(1);
    expect(countRows(targetDb, 'skill_lineage', TARGET_PROJECT_ID)).toBe(1);
    expect(countRows(targetDb, 'skill_usage', TARGET_PROJECT_ID)).toBe(1);
    expect(countRows(targetDb, 'canopy_entries', TARGET_PROJECT_ID)).toBe(1);
    expect(countRows(targetDb, 'canopy_maps', TARGET_PROJECT_ID)).toBe(1);
    expect(countRows(targetDb, 'digest_extracts', TARGET_PROJECT_ID)).toBe(1);
    expect(countRows(targetDb, 'digest_extract_revisions', TARGET_PROJECT_ID)).toBe(2);
    expect(countRows(targetDb, 'cortex_instructions', TARGET_PROJECT_ID)).toBe(1);
    expect(countRows(targetDb, 'notifications', TARGET_PROJECT_ID)).toBe(1);
    expect(countRows(targetDb, 'log_entries', TARGET_PROJECT_ID)).toBe(2);
    expect(listImportMappingsForMigration(migrationId, targetDb)).toHaveLength(46);
  });

  it('keeps newer target agent state when legacy imports collide', () => {
    seedTargetAgent(targetDb);
    targetDb.prepare(
      `INSERT INTO agent_state (agent_id, key, value, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run('myco-agent', 'skill-evolve-current-phase', 'target-newer-phase', 999);
    targetDb.prepare(
      `INSERT INTO agent_state (agent_id, key, value, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run('myco-agent', 'skill-evolve-assessment-cursor', 'target-older-cursor', 100);

    const result = importProjectCoreRows({
      migrationId: createMigrationId(),
      sourceDb,
      targetDb,
      sourceProjectRoot: SOURCE_PROJECT_ROOT,
      sourceDbPath: SOURCE_DB_PATH,
      targetGroveId: TARGET_GROVE_ID,
      targetProjectId: TARGET_PROJECT_ID,
    });

    expect(result.agents).toBe(0);
    expect(result.agent_state).toBe(1);
    expect(result.skipped_agent_state).toBe(1);

    const newerState = getRow<{ value: string; updated_at: number }>(
      targetDb,
      'SELECT value, updated_at FROM agent_state WHERE agent_id = ? AND key = ?',
      'myco-agent',
      'skill-evolve-current-phase',
    );
    expect(newerState.value).toBe('target-newer-phase');
    expect(newerState.updated_at).toBe(999);

    const updatedState = getRow<{ value: string; updated_at: number }>(
      targetDb,
      'SELECT value, updated_at FROM agent_state WHERE agent_id = ? AND key = ?',
      'myco-agent',
      'skill-evolve-assessment-cursor',
    );
    expect(updatedState.value).toBe('skill-a,skill-b');
    expect(updatedState.updated_at).toBe(492);
  });

  // Pins the targetDb.transaction(() => {...})() wrap inside
  // importProjectCoreRows. Activation depends on this contract:
  // a mid-import failure rolls the whole import back so the next
  // attempt sees an empty target and a clean journal. If a refactor
  // ever removed or split that transaction, this test fails.
  it('rolls back the entire import (rows + journal) when a row fails mid-stream', () => {
    const migrationId = createMigrationId();

    // Fail the first plan INSERT mid-import. Plans run after sessions
    // and prompt_batches, so by the time we throw the importer has
    // already inserted real rows and recorded multiple journal
    // mappings — proving the transaction rollback covers everything,
    // not just the table we crashed on.
    const originalPrepare = targetDb.prepare.bind(targetDb);
    let injected = false;
    const failingPrepare: typeof originalPrepare = ((sql: string) => {
      if (!injected && sql.trimStart().startsWith('INSERT INTO plans')) {
        injected = true;
        throw new Error('injected mid-import failure');
      }
      return originalPrepare(sql);
    }) as typeof originalPrepare;

    (targetDb as unknown as { prepare: typeof originalPrepare }).prepare = failingPrepare;
    try {
      expect(() =>
        importProjectCoreRows({
          migrationId,
          sourceDb,
          targetDb,
          sourceProjectRoot: SOURCE_PROJECT_ROOT,
          sourceDbPath: SOURCE_DB_PATH,
          targetGroveId: TARGET_GROVE_ID,
          targetProjectId: TARGET_PROJECT_ID,
          targetMachineId: 'target-machine',
        }),
      ).toThrow('injected mid-import failure');
    } finally {
      (targetDb as unknown as { prepare: typeof originalPrepare }).prepare = originalPrepare;
    }
    expect(injected).toBe(true);

    // (a) Zero project-scoped rows landed on the target.
    for (const table of [
      'sessions',
      'prompt_batches',
      'activities',
      'attachments',
      'plans',
      'artifacts',
      'spores',
      'entities',
      'entity_mentions',
      'resolution_events',
      'graph_edges',
      'agent_runs',
      'agent_reports',
      'agent_turns',
      'agent_run_write_intents',
      'skill_records',
      'skill_candidates',
      'skill_lineage',
      'skill_usage',
      'canopy_entries',
      'canopy_maps',
      'digest_extracts',
      'digest_extract_revisions',
      'cortex_instructions',
      'notifications',
      'log_entries',
    ]) {
      expect(countRows(targetDb, table, TARGET_PROJECT_ID)).toBe(0);
    }

    // (b) Zero journal mappings recorded for this migrationId.
    expect(listImportMappingsForMigration(migrationId, targetDb)).toHaveLength(0);

    // (c) A clean retry with a fresh migrationId completes the full
    // import — nothing on the target remembers the aborted attempt.
    const retryMigrationId = createMigrationId();
    const retry = importProjectCoreRows({
      migrationId: retryMigrationId,
      sourceDb,
      targetDb,
      sourceProjectRoot: SOURCE_PROJECT_ROOT,
      sourceDbPath: SOURCE_DB_PATH,
      targetGroveId: TARGET_GROVE_ID,
      targetProjectId: TARGET_PROJECT_ID,
      targetMachineId: 'target-machine',
    });

    expect(retry.sessions).toBe(2);
    expect(retry.plans).toBe(1);
    expect(retry.spores).toBe(2);
    expect(countRows(targetDb, 'sessions', TARGET_PROJECT_ID)).toBe(2);
    expect(countRows(targetDb, 'plans', TARGET_PROJECT_ID)).toBe(1);
    expect(listImportMappingsForMigration(retryMigrationId, targetDb).length).toBeGreaterThan(0);
  });
});

function seedSourceProject(db: Database): void {
  db.prepare(
    `INSERT INTO agents (
       id, name, provider, model, system_prompt_hash, config,
       source, system_prompt, max_turns, timeout_seconds, tool_access,
       enabled, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'myco-agent',
    'Myco Agent',
    'openai',
    'gpt-test',
    'agent-hash',
    '{"temperature":0}',
    'built-in',
    'You are Myco.',
    20,
    120,
    '["vault_spores"]',
    1,
    50,
    55,
  );

  db.prepare(
    `INSERT INTO agent_tasks (
       id, agent_id, source, display_name, description,
       prompt, is_default, tool_overrides, model, config,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'skill-evolve',
    'myco-agent',
    'built-in',
    'Skill Evolution',
    'Evolve generated skills from persisted assessment state.',
    'Evolve skills from persisted state.',
    0,
    '["myco_skills"]',
    'gpt-test',
    '{"phase":"assess"}',
    486,
    491,
  );

  db.prepare(
    `INSERT INTO agent_state (agent_id, key, value, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run('myco-agent', 'skill-evolve-current-phase', 'assess', 490);
  db.prepare(
    `INSERT INTO agent_state (agent_id, key, value, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run('myco-agent', 'skill-evolve-assessment-cursor', 'skill-a,skill-b', 492);

  db.run('PRAGMA foreign_keys = OFF');
  db.prepare(
    `INSERT INTO agent_tasks (
       id, agent_id, source, display_name, description,
       prompt, is_default, tool_overrides, model, config,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'orphan-task',
    'missing-agent',
    'user',
    'Orphan Task',
    'Task whose agent was pruned before migration.',
    'This task should be skipped.',
    0,
    null,
    null,
    null,
    487,
    488,
  );
  db.prepare(
    `INSERT INTO agent_state (agent_id, key, value, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run('missing-agent', 'orphan-state', 'skip me', 493);
  db.run('PRAGMA foreign_keys = ON');

  db.prepare(
    `INSERT INTO agent_runs (
       id, project_id, agent_id, task, instruction, status, harness, provider,
       model, session_ref, resumable, resume_status, resume_mode, resumed_at,
       checkpoints, usage_data, started_at, completed_at, tokens_used,
       cost_usd, actual_cost_usd, estimated_cost_usd, cost_source, cost_data,
       actions_taken, error, dry_run, reasoning_level, execution_overrides
     ) VALUES (
       ?, ?, ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?,
       ?, ?, ?, ?, ?
     )`,
  ).run(
    'legacy-run',
    SOURCE_PROJECT_ROOT,
    'myco-agent',
    'cortex-instructions',
    'Generate cortex instructions',
    'completed',
    'openai',
    'openai',
    'gpt-test',
    'legacy-session',
    1,
    'ready',
    'resume',
    390,
    '{"phases":{"digest":{"status":"completed"}}}',
    '{"input_tokens":100,"output_tokens":50}',
    360,
    400,
    1234,
    0.42,
    0.4,
    0.5,
    'actual',
    '{"source":"fixture"}',
    '["wrote digest"]',
    null,
    0,
    'medium',
    '{"provider":{"model":"gpt-test"}}',
  );

  db.prepare(
    `INSERT INTO agent_reports (
       id, project_id, run_id, agent_id, action, summary, details, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    3,
    SOURCE_PROJECT_ROOT,
    'legacy-run',
    'myco-agent',
    'digest_write',
    'Wrote digest report',
    '{"tier":5000}',
    401,
  );

  db.run('PRAGMA foreign_keys = OFF');
  db.prepare(
    `INSERT INTO agent_reports (
       id, project_id, run_id, agent_id, action, summary, details, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    30,
    SOURCE_PROJECT_ROOT,
    'missing-run',
    'myco-agent',
    'orphaned_report',
    'Report whose run was pruned before migration',
    null,
    401,
  );

  db.prepare(
    `INSERT INTO agent_turns (
       id, project_id, run_id, agent_id, turn_number, tool_name,
       tool_input, tool_output_summary, started_at, completed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    4,
    SOURCE_PROJECT_ROOT,
    'legacy-run',
    'myco-agent',
    1,
    'vault_write_digest',
    '{"tier":5000}',
    'digest persisted',
    402,
    403,
  );
  db.prepare(
    `INSERT INTO agent_turns (
       id, project_id, run_id, agent_id, turn_number, tool_name,
       tool_input, tool_output_summary, started_at, completed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    40,
    SOURCE_PROJECT_ROOT,
    'missing-run',
    'myco-agent',
    2,
    'vault_report',
    '{}',
    'orphaned turn',
    402,
    403,
  );

  db.prepare(
    `INSERT INTO agent_run_write_intents (
       id, project_id, run_id, phase_id, tool_name, tool_input,
       synthetic_output, stub_id, recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    5,
    SOURCE_PROJECT_ROOT,
    'legacy-run',
    'phase-digest',
    'vault_create_spore',
    '{"content":"synthetic"}',
    '{"id":"stub-spore"}',
    'stub-spore',
    404,
  );
  db.prepare(
    `INSERT INTO agent_run_write_intents (
       id, project_id, run_id, phase_id, tool_name, tool_input,
       synthetic_output, stub_id, recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    50,
    SOURCE_PROJECT_ROOT,
    'missing-run',
    'phase-orphan',
    'vault_create_spore',
    '{}',
    '{"id":"stub-orphan"}',
    'stub-orphan',
    404,
  );
  db.run('PRAGMA foreign_keys = ON');

  db.prepare(
    `INSERT INTO sessions (
       id, agent, "user", project_root, branch, started_at, ended_at, status,
       prompt_count, tool_count, title, summary, transcript_path,
       parent_session_id, parent_session_reason, processed, content_hash,
       created_at, embedded, machine_id, synced_at, canopy_map_tool_calls
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'legacy-parent',
    'codex',
    'chris',
    SOURCE_PROJECT_ROOT,
    'main',
    100,
    110,
    'completed',
    1,
    1,
    'Parent session',
    'Parent summary',
    '/tmp/parent.jsonl',
    null,
    null,
    1,
    'session-parent-hash',
    100,
    1,
    'source-machine',
    120,
    0,
  );

  db.prepare(
    `INSERT INTO sessions (
       id, agent, "user", project_root, branch, started_at, ended_at, status,
       prompt_count, tool_count, title, summary, transcript_path,
       parent_session_id, parent_session_reason, processed, content_hash,
       created_at, embedded, machine_id, synced_at, canopy_map_tool_calls
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'legacy-session',
    'codex',
    'chris',
    SOURCE_PROJECT_ROOT,
    'main',
    200,
    250,
    'completed',
    2,
    3,
    'Child session',
    'Child migration summary',
    '/tmp/child.jsonl',
    'legacy-parent',
    'resume',
    1,
    'session-child-hash',
    200,
    1,
    'source-machine',
    260,
    3,
  );

  db.prepare(
    `INSERT INTO prompt_batches (
       id, session_id, parent_prompt_batch_id, kind, prompt_number, user_prompt,
       response_summary, classification, started_at, ended_at, status,
       activity_count, processed, content_hash, created_at, machine_id, synced_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    2,
    'legacy-session',
    null,
    'initial',
    1,
    'Initial migration request',
    'Initial response',
    'feature',
    201,
    210,
    'completed',
    0,
    1,
    'batch-parent-hash',
    201,
    'source-machine',
    215,
  );

  db.prepare(
    `INSERT INTO prompt_batches (
       id, session_id, parent_prompt_batch_id, kind, prompt_number, user_prompt,
       response_summary, classification, started_at, ended_at, status,
       activity_count, processed, content_hash, created_at, machine_id, synced_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    1,
    'legacy-session',
    2,
    'steering',
    2,
    'Steering migration follow-up',
    'Steering response',
    'feature',
    220,
    230,
    'completed',
    1,
    1,
    'batch-child-hash',
    220,
    'source-machine',
    235,
  );

  db.prepare(
    `INSERT INTO activities (
       session_id, prompt_batch_id, tool_name, tool_input, tool_output_summary,
       file_path, files_affected, duration_ms, success, error_message,
       timestamp, processed, content_hash, created_at, canopy_injection_tokens
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'legacy-session',
    1,
    'Read',
    '{"file_path":"README.md"}',
    'Read README',
    'README.md',
    '["README.md"]',
    17,
    1,
    null,
    225,
    1,
    'activity-hash',
    225,
    44,
  );

  db.prepare(
    `INSERT INTO attachments (
       id, session_id, prompt_batch_id, file_path, media_type,
       description, data, content_hash, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'legacy-attachment',
    'legacy-session',
    1,
    'attachments/legacy-session-2.png',
    'image/png',
    'Prompt image',
    new Uint8Array([1, 2, 3, 4]),
    'attachment-hash',
    226,
  );

  db.prepare(
    `INSERT INTO plans (
       id, logical_key, status, author, title, content, source_path, tags,
       session_id, prompt_batch_id, content_hash, processed, created_at,
       updated_at, embedded, machine_id, synced_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'legacy-plan',
    'plans/grove-core.md',
    'active',
    'codex',
    'Grove core import',
    'Preserve literal references such as legacy-plan in content.',
    'plans/grove-core.md',
    '["grove","migration"]',
    'legacy-session',
    1,
    'plan-hash',
    1,
    240,
    245,
    1,
    'source-machine',
    250,
  );

  db.prepare(
    `INSERT INTO artifacts (
       id, artifact_type, source_path, title, content, last_captured_by,
       tags, created_at, updated_at, embedded, machine_id, synced_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'legacy-artifact',
    'doc',
    'docs/legacy.md',
    'Legacy artifact',
    'Preserve expensive artifact content.',
    'codex',
    '["doc","migration"]',
    260,
    265,
    1,
    'source-machine',
    270,
  );

  db.prepare(
    `INSERT INTO spores (
       id, agent_id, session_id, prompt_batch_id, observation_type, status,
       content, context, importance, file_path, tags, content_hash, properties,
       created_at, updated_at, embedded, machine_id, synced_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'legacy-spore',
    'myco-agent',
    'legacy-session',
    1,
    'discovery',
    'active',
    'A durable Grove importer observation from the legacy vault.',
    'Importer context',
    6,
    'packages/myco/src/grove/importer.ts',
    '["grove","importer"]',
    'spore-hash',
    '{"kind":"fixture"}',
    280,
    285,
    1,
    'source-machine',
    290,
  );

  db.prepare(
    `INSERT INTO spores (
       id, agent_id, session_id, prompt_batch_id, observation_type, status,
       content, context, importance, file_path, tags, content_hash, properties,
       created_at, updated_at, embedded, machine_id, synced_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'legacy-wisdom',
    'myco-agent',
    null,
    null,
    'wisdom',
    'active',
    'A consolidated Grove importer wisdom note.',
    null,
    8,
    null,
    '["grove","wisdom"]',
    'wisdom-hash',
    '{"consolidated_from":["legacy-spore"]}',
    300,
    305,
    1,
    'source-machine',
    310,
  );

  db.prepare(
    `INSERT INTO entities (
       id, agent_id, type, name, properties, first_seen, last_seen,
       status, machine_id, synced_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'legacy-entity',
    'myco-agent',
    'component',
    'Grove importer',
    '{"path":"packages/myco/src/grove/importer.ts"}',
    280,
    285,
    'active',
    'source-machine',
    290,
  );

  db.prepare(
    `INSERT INTO entity_mentions (
       entity_id, note_id, note_type, agent_id, machine_id, synced_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'legacy-entity',
    'legacy-spore',
    'spore',
    'myco-agent',
    'source-machine',
    291,
  );

  db.prepare(
    `INSERT INTO resolution_events (
       id, agent_id, spore_id, action, new_spore_id, reason,
       session_id, created_at, machine_id, synced_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'legacy-resolution',
    'myco-agent',
    'legacy-spore',
    'supersede',
    'legacy-wisdom',
    'Consolidated into wisdom',
    'legacy-session',
    320,
    'source-machine',
    325,
  );

  const edge = db.prepare(
    `INSERT INTO graph_edges (
       id, agent_id, source_id, source_type, target_id, target_type,
       type, session_id, confidence, properties, created_at, machine_id, synced_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  edge.run(
    'legacy-edge-session-batch',
    'myco-agent',
    'legacy-session',
    'session',
    '1',
    'batch',
    'HAS_BATCH',
    'legacy-session',
    1,
    null,
    330,
    'source-machine',
    335,
  );
  edge.run(
    'legacy-edge-spore-session',
    'myco-agent',
    'legacy-spore',
    'spore',
    'legacy-session',
    'session',
    'FROM_SESSION',
    'legacy-session',
    1,
    null,
    331,
    'source-machine',
    336,
  );
  edge.run(
    'legacy-edge-spore-batch',
    'myco-agent',
    'legacy-spore',
    'spore',
    '1',
    'batch',
    'EXTRACTED_FROM',
    'legacy-session',
    1,
    null,
    332,
    'source-machine',
    337,
  );
  edge.run(
    'legacy-edge-wisdom-spore',
    'myco-agent',
    'legacy-wisdom',
    'spore',
    'legacy-spore',
    'spore',
    'DERIVED_FROM',
    null,
    0.9,
    '{"kind":"consolidation"}',
    333,
    'source-machine',
    338,
  );
  edge.run(
    'legacy-edge-dangling-entity',
    'myco-agent',
    'missing-entity',
    'entity',
    'legacy-spore',
    'spore',
    'SUPERSEDED_BY',
    null,
    0.8,
    null,
    334,
    'source-machine',
    339,
  );

  db.prepare(
    `INSERT INTO skill_candidates (
       id, project_id, agent_id, machine_id, topic, rationale,
       confidence, status, source_ids, skill_id, supersedes,
       created_at, updated_at, approved_at, synced_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'legacy-candidate',
    SOURCE_PROJECT_ROOT,
    'myco-agent',
    'source-machine',
    'Grove importer operations',
    'Importer work repeats across Grove migration slices.',
    0.87,
    'generated',
    '["legacy-spore"]',
    'legacy-skill',
    '["myco:old-importer"]',
    460,
    465,
    462,
    466,
  );

  db.prepare(
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
    'legacy-skill',
    SOURCE_PROJECT_ROOT,
    'myco-agent',
    'source-machine',
    'myco:legacy-grove-import',
    'Legacy Grove Import',
    'A Grove importer skill with expensive generated description.',
    'active',
    1,
    2,
    'legacy-candidate',
    '["legacy-spore"]',
    '.agents/skills/legacy-grove-import/SKILL.md',
    3,
    471,
    468,
    472,
    '{"quality":"validated"}',
    473,
  );

  db.prepare(
    `INSERT INTO skill_lineage (
       id, project_id, skill_id, generation, action, rationale,
       source_ids_added, content_snapshot, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'legacy-lineage',
    SOURCE_PROJECT_ROOT,
    'legacy-skill',
    2,
    'evolve',
    'Added Grove import detail from migration work.',
    '["legacy-wisdom"]',
    '# Legacy Grove Import\n\nPreserve lineage content.',
    474,
  );

  db.prepare(
    `INSERT INTO skill_usage (
       id, project_id, skill_id, session_id, machine_id, detected_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'legacy-usage',
    SOURCE_PROJECT_ROOT,
    'legacy-skill',
    'legacy-session',
    'source-machine',
    475,
  );

  db.run('PRAGMA foreign_keys = OFF');
  db.prepare(
    `INSERT INTO skill_lineage (
       id, project_id, skill_id, generation, action, rationale,
       source_ids_added, content_snapshot, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'legacy-orphan-lineage',
    SOURCE_PROJECT_ROOT,
    'missing-skill',
    1,
    'generate',
    'Lineage whose skill was pruned before migration.',
    '[]',
    '# Missing skill',
    476,
  );
  db.prepare(
    `INSERT INTO skill_usage (
       id, project_id, skill_id, session_id, machine_id, detected_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'legacy-orphan-usage',
    SOURCE_PROJECT_ROOT,
    'legacy-skill',
    'missing-session',
    'source-machine',
    477,
  );
  db.run('PRAGMA foreign_keys = ON');

  db.prepare(
    `INSERT INTO canopy_entries (
       project_id, machine_id, path, content_hash, size_bytes,
       token_estimate, line_count, language, exports_json, imports_json,
       top_comment, mechanical_updated_at, llm_description, llm_updated_at,
       embedded
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    SOURCE_PROJECT_ROOT,
    'source-machine',
    'packages/myco/src/grove/importer.ts',
    'canopy-entry-hash',
    1234,
    456,
    78,
    'typescript',
    '["importProjectCoreRows"]',
    '["@myco/grove/ids.js"]',
    'Importer top comment',
    400,
    'An expensive semantic Canopy summary of the importer.',
    405,
    1,
  );

  db.prepare(
    `INSERT INTO canopy_maps (
       project_id, machine_id, content, inputs_hash, generated_at,
       generated_by_run_id, token_estimate
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    SOURCE_PROJECT_ROOT,
    'source-machine',
    '# Project architecture map\n\nProject architecture map content.',
    'canopy-map-inputs',
    410,
    'legacy-run',
    321,
  );

  db.prepare(
    `INSERT INTO digest_extracts (
       id, project_id, agent_id, tier, content, substrate_hash,
       generated_at, machine_id, synced_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    7,
    SOURCE_PROJECT_ROOT,
    'myco-agent',
    5000,
    'Preserve expensive digest content for Grove migration.',
    'digest-substrate',
    420,
    'source-machine',
    425,
  );

  db.prepare(
    `INSERT INTO digest_extract_revisions (
       id, project_id, agent_id, tier, content, metadata,
       run_id, parent_revision_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    9,
    SOURCE_PROJECT_ROOT,
    'myco-agent',
    5000,
    'Older digest revision.',
    '{"phase":"parent"}',
    'legacy-run',
    null,
    430,
  );

  db.prepare(
    `INSERT INTO digest_extract_revisions (
       id, project_id, agent_id, tier, content, metadata,
       run_id, parent_revision_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    8,
    SOURCE_PROJECT_ROOT,
    'myco-agent',
    5000,
    'A newer digest revision with parent linkage.',
    '{"phase":"child"}',
    'legacy-run',
    9,
    440,
  );

  db.prepare(
    `INSERT INTO cortex_instructions (
       id, project_id, agent_id, content, input_hash, source_run_id,
       generated_at, machine_id, synced_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'myco-agent:session-start',
    SOURCE_PROJECT_ROOT,
    'myco-agent',
    'Preserve standing operating context for future sessions.',
    'cortex-input-hash',
    'legacy-run',
    450,
    'source-machine',
    455,
  );

  db.prepare(
    `INSERT INTO notifications (
       id, project_id, domain, type, level, title, message,
       mode, status, link, metadata, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'legacy-notification',
    SOURCE_PROJECT_ROOT,
    'settings',
    'settings-saved',
    'success',
    'Settings saved',
    'A legacy notification from project settings.',
    'summary',
    'read',
    '/settings',
    '{"scope":"project"}',
    480,
  );

  db.prepare(
    `INSERT INTO log_entries (
       id, project_id, timestamp, level, component, kind,
       message, data, session_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    42,
    SOURCE_PROJECT_ROOT,
    '2026-05-01T10:00:00.000Z',
    'info',
    'grove-importer',
    'migration:smoke',
    'GroveLog imported linked session',
    '{"source":"fixture"}',
    'legacy-session',
  );

  db.prepare(
    `INSERT INTO log_entries (
       id, project_id, timestamp, level, component, kind,
       message, data, session_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    43,
    SOURCE_PROJECT_ROOT,
    '2026-05-01T10:01:00.000Z',
    'warn',
    'grove-importer',
    'migration:smoke',
    'GroveLog imported dangling session',
    null,
    'missing-session',
  );
}

function seedTargetExistingRows(db: Database): void {
  db.prepare(
    `INSERT INTO sessions (
       id, agent, project_root, project_id, started_at, created_at, machine_id, content_hash
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'sess_cccccccccccccccccccccccccccccccc',
    'codex',
    '/existing/project',
    'proj_cccccccccccccccccccccccccccccccc',
    1,
    1,
    'target-machine',
    'existing-session-hash',
  );

  db.prepare(
    `INSERT INTO prompt_batches (
       project_id, session_id, kind, created_at, machine_id, content_hash
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'proj_cccccccccccccccccccccccccccccccc',
    'sess_cccccccccccccccccccccccccccccccc',
    'initial',
    1,
    'target-machine',
    'existing-batch-hash',
  );

  db.prepare(
    `INSERT INTO activities (
       project_id, session_id, prompt_batch_id, tool_name, timestamp, created_at, content_hash
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'proj_cccccccccccccccccccccccccccccccc',
    'sess_cccccccccccccccccccccccccccccccc',
    1,
    'Write',
    2,
    2,
    'existing-activity-hash',
  );
}

function seedTargetAgent(db: Database): void {
  db.prepare(
    `INSERT INTO agents (
       id, name, provider, model, system_prompt_hash, config,
       source, system_prompt, max_turns, timeout_seconds, tool_access,
       enabled, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'myco-agent',
    'Existing Myco Agent',
    'openai',
    'gpt-existing',
    'existing-agent-hash',
    '{}',
    'built-in',
    'Existing target agent.',
    20,
    120,
    '[]',
    1,
    1,
    2,
  );
}

function getRow<T>(db: Database, sql: string, ...params: unknown[]): T {
  const row = db.prepare(sql).get(...params) as T | undefined;
  if (!row) throw new Error(`Expected row for query: ${sql}`);
  return row;
}

function countRows(db: Database, table: string, projectId?: string): number {
  const sql = projectId
    ? `SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ?`
    : `SELECT COUNT(*) AS count FROM ${table}`;
  const params = projectId ? [projectId] : [];
  return getRow<{ count: number }>(db, sql, ...params).count;
}

function matchCount(db: Database, table: string, query: string): number {
  return getRow<{ count: number }>(
    db,
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${table} MATCH ?`,
    query,
  ).count;
}
