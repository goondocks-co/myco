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
      sessions: 2,
      prompt_batches: 2,
      activities: 1,
      attachments: 1,
      plans: 1,
      artifacts: 1,
    });

    const parentSessionId = lookupImportMappingBySource(migrationId, 'sessions', 'legacy-parent', targetDb)?.target_id;
    const childSessionId = lookupImportMappingBySource(migrationId, 'sessions', 'legacy-session', targetDb)?.target_id;
    const parentBatchId = Number(lookupImportMappingBySource(migrationId, 'prompt_batches', 1, targetDb)?.target_id);
    const childBatchId = Number(lookupImportMappingBySource(migrationId, 'prompt_batches', 2, targetDb)?.target_id);
    const activityId = Number(lookupImportMappingBySource(migrationId, 'activities', 1, targetDb)?.target_id);
    const attachmentId = lookupImportMappingBySource(migrationId, 'attachments', 'legacy-attachment', targetDb)?.target_id;
    const planId = lookupImportMappingBySource(migrationId, 'plans', 'legacy-plan', targetDb)?.target_id;
    const artifactId = lookupImportMappingBySource(migrationId, 'artifacts', 'legacy-artifact', targetDb)?.target_id;

    expect(parentSessionId).toMatch(/^sess_[0-9a-f]{32}$/);
    expect(childSessionId).toMatch(/^sess_[0-9a-f]{32}$/);
    expect(childSessionId).not.toBe('legacy-session');
    expect(attachmentId).toMatch(/^att_[0-9a-f]{32}$/);
    expect(attachmentId).not.toBe('legacy-attachment');
    expect(planId).toMatch(/^plan_[0-9a-f]{32}$/);
    expect(planId).not.toBe('legacy-plan');
    expect(artifactId).toMatch(/^art_[0-9a-f]{32}$/);
    expect(artifactId).not.toBe('legacy-artifact');
    expect(parentBatchId).not.toBe(1);
    expect(childBatchId).not.toBe(2);
    expect(activityId).not.toBe(1);

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

    expect(matchCount(targetDb, 'sessions_fts', 'child')).toBeGreaterThan(0);
    expect(matchCount(targetDb, 'prompt_batches_fts', 'steering')).toBeGreaterThan(0);
    expect(matchCount(targetDb, 'activities_fts', 'README')).toBeGreaterThan(0);

    const mappings = listImportMappingsForMigration(migrationId, targetDb);
    expect(mappings).toHaveLength(8);
    expect(new Set(mappings.map((mapping) => mapping.status))).toEqual(new Set(['imported']));
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
      sessions: 0,
      prompt_batches: 0,
      activities: 0,
      attachments: 0,
      plans: 0,
      artifacts: 0,
    });
    expect(countRows(targetDb, 'sessions', TARGET_PROJECT_ID)).toBe(2);
    expect(countRows(targetDb, 'prompt_batches', TARGET_PROJECT_ID)).toBe(2);
    expect(countRows(targetDb, 'activities', TARGET_PROJECT_ID)).toBe(1);
    expect(countRows(targetDb, 'attachments', TARGET_PROJECT_ID)).toBe(1);
    expect(countRows(targetDb, 'plans', TARGET_PROJECT_ID)).toBe(1);
    expect(countRows(targetDb, 'artifacts', TARGET_PROJECT_ID)).toBe(1);
    expect(listImportMappingsForMigration(migrationId, targetDb)).toHaveLength(8);
  });
});

function seedSourceProject(db: Database): void {
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
       session_id, parent_prompt_batch_id, kind, prompt_number, user_prompt,
       response_summary, classification, started_at, ended_at, status,
       activity_count, processed, content_hash, created_at, machine_id, synced_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
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
       session_id, parent_prompt_batch_id, kind, prompt_number, user_prompt,
       response_summary, classification, started_at, ended_at, status,
       activity_count, processed, content_hash, created_at, machine_id, synced_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'legacy-session',
    1,
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
    2,
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
    2,
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
    2,
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

function countRows(db: Database, table: string, projectId: string): number {
  return getRow<{ count: number }>(
    db,
    `SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ?`,
    projectId,
  ).count;
}

function matchCount(db: Database, table: string, query: string): number {
  return getRow<{ count: number }>(
    db,
    `SELECT COUNT(*) AS count FROM ${table} WHERE ${table} MATCH ?`,
    query,
  ).count;
}
