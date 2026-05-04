import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Database } from '@myco/db/client.js';
import { openDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import {
  listImportMappingsForMigration,
  lookupImportMappingBySource,
} from '@myco/db/queries/migration-import-journal.js';
import { importProjectCoreRows } from '@myco/grove/importer.js';
import { createMigrationId } from '@myco/grove/ids.js';

const TARGET_GROVE_ID = 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TARGET_PROJECT_ID = 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
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
      canopy_entries: 1,
      canopy_maps: 1,
      digest_extracts: 1,
      digest_extract_revisions: 2,
      cortex_instructions: 1,
    });

    const agentId = lookupImportMappingBySource(migrationId, 'agents', 'myco-agent', targetDb)?.target_id;
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

    expect(agentId).toBe('myco-agent');
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
    expect(canopyEntryId).toBe(`${TARGET_PROJECT_ID}\u001fpackages/myco/src/grove/importer.ts`);
    expect(canopyMapId).toBe(`${TARGET_PROJECT_ID}\u001fsource-machine`);
    expect(digestExtractId).not.toBe(7);
    expect(digestRevisionId).not.toBe(8);
    expect(digestParentRevisionId).not.toBe(9);
    expect(cortexInstructionsId).toBe('myco-agent:session-start');
    expect(parentBatchId).not.toBe(2);
    expect(childBatchId).not.toBe(1);
    expect(activityId).not.toBe(1);
    expect(skippedGraphEdge?.status).toBe('skipped');
    expect(skippedGraphEdge?.notes).toContain('unmapped endpoint entity/missing-entity');

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
    expect(canopyMap.generated_by_run_id).toBeNull();

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
    expect(digestRevision.run_id).toBeNull();
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
    expect(cortexInstructions.source_run_id).toBeNull();
    expect(cortexInstructions.machine_id).toBe('source-machine');

    expect(matchCount(targetDb, 'sessions_fts', 'child')).toBeGreaterThan(0);
    expect(matchCount(targetDb, 'prompt_batches_fts', 'steering')).toBeGreaterThan(0);
    expect(matchCount(targetDb, 'activities_fts', 'README')).toBeGreaterThan(0);
    expect(matchCount(targetDb, 'spores_fts', 'durable')).toBeGreaterThan(0);

    const mappings = listImportMappingsForMigration(migrationId, targetDb);
    expect(mappings).toHaveLength(25);
    expect(mappings.filter((mapping) => mapping.status === 'imported')).toHaveLength(24);
    expect(mappings.filter((mapping) => mapping.status === 'skipped')).toHaveLength(1);
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
      canopy_entries: 0,
      canopy_maps: 0,
      digest_extracts: 0,
      digest_extract_revisions: 0,
      cortex_instructions: 0,
    });
    expect(countRows(targetDb, 'agents')).toBe(1);
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
    expect(countRows(targetDb, 'canopy_entries', TARGET_PROJECT_ID)).toBe(1);
    expect(countRows(targetDb, 'canopy_maps', TARGET_PROJECT_ID)).toBe(1);
    expect(countRows(targetDb, 'digest_extracts', TARGET_PROJECT_ID)).toBe(1);
    expect(countRows(targetDb, 'digest_extract_revisions', TARGET_PROJECT_ID)).toBe(2);
    expect(countRows(targetDb, 'cortex_instructions', TARGET_PROJECT_ID)).toBe(1);
    expect(listImportMappingsForMigration(migrationId, targetDb)).toHaveLength(25);
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
    `INSERT INTO agent_runs (
       id, agent_id, task, instruction, status, harness, provider,
       model, session_ref, started_at, completed_at, dry_run
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'legacy-run',
    'myco-agent',
    'cortex-instructions',
    'Generate cortex instructions',
    'completed',
    'openai',
    'openai',
    'gpt-test',
    'legacy-session',
    360,
    400,
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
