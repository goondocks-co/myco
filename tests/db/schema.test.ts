import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '@myco/db/client.js';
import { createSchema, SCHEMA_VERSION, EMBEDDING_DIMENSIONS } from '@myco/db/schema.js';
import { MIGRATIONS } from '@myco/db/migrations.js';
import type { Database } from 'better-sqlite3';

/** Helper: check if a table exists in SQLite. */
function tableExists(db: Database, tableName: string): boolean {
  const row = db.prepare(
    `SELECT count(*) AS cnt FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?`,
  ).get(tableName) as { cnt: number };
  return row.cnt > 0;
}

/** Helper: get column names for a table. */
function getColumnNames(db: Database, tableName: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/** Helper: check if an index exists. */
function indexExists(db: Database, indexName: string): boolean {
  const row = db.prepare(
    `SELECT count(*) AS cnt FROM sqlite_master WHERE type = 'index' AND name = ?`,
  ).get(indexName) as { cnt: number };
  return row.cnt > 0;
}

describe('Database schema', () => {
  let db: Database;

  beforeEach(() => {
    db = initDatabase();
  });

  afterEach(() => {
    closeDatabase();
  });

  describe('constants', () => {
    it('exports SCHEMA_VERSION as a positive integer', () => {
      expect(SCHEMA_VERSION).toBe(21);
      expect(Number.isInteger(SCHEMA_VERSION)).toBe(true);
    });

    it('exports EMBEDDING_DIMENSIONS as 1024 (bge-m3)', () => {
      expect(EMBEDDING_DIMENSIONS).toBe(1024);
    });
  });

  describe('createSchema()', () => {
    it('is idempotent — running twice does not throw', () => {
      createSchema(db);
      expect(() => createSchema(db)).not.toThrow();
    });

    describe('schema_version table', () => {
      it('records the current schema version', () => {
        createSchema(db);
        const result = db.prepare(
          'SELECT version, applied_at FROM schema_version ORDER BY version DESC LIMIT 1',
        ).get() as { version: number; applied_at: number };
        expect(result).toBeDefined();
        expect(result.version).toBe(SCHEMA_VERSION);
        expect(typeof result.applied_at).toBe('number');
      });

      it('reports the current SCHEMA_VERSION after createSchema on a fresh DB', () => {
        createSchema(db);
        const result = db.prepare(
          'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1',
        ).get() as { version: number };
        expect(result.version).toBe(SCHEMA_VERSION);
      });

      it('creates eval harness tables with expected columns', () => {
        createSchema(db);
        expect(tableExists(db, 'agent_run_write_intents')).toBe(true);
        expect(tableExists(db, 'digest_extract_revisions')).toBe(true);
        expect(tableExists(db, 'agent_run_evaluations')).toBe(true);

        expect(getColumnNames(db, 'agent_run_write_intents'))
          .toEqual(expect.arrayContaining(['run_id', 'phase_id', 'tool_name', 'tool_input', 'synthetic_output', 'stub_id', 'recorded_at']));
        expect(getColumnNames(db, 'digest_extract_revisions'))
          .toEqual(expect.arrayContaining(['agent_id', 'tier', 'content', 'metadata', 'run_id', 'parent_revision_id', 'created_at']));
        expect(getColumnNames(db, 'agent_run_evaluations'))
          .toEqual(expect.arrayContaining(['task_id', 'matrix_json', 'notes', 'status', 'created_at', 'completed_at']));

        expect(getColumnNames(db, 'agent_runs')).toEqual(expect.arrayContaining(['dry_run', 'evaluation_id']));
      });

      it('creates cortex_instructions on fresh install', () => {
        createSchema(db);
        expect(tableExists(db, 'cortex_instructions')).toBe(true);
        expect(getColumnNames(db, 'cortex_instructions')).toEqual(
          expect.arrayContaining([
            'agent_id',
            'content',
            'input_hash',
            'source_run_id',
            'generated_at',
          ]),
        );
        expect(indexExists(db, 'idx_cortex_instructions_agent_id')).toBe(true);
      });

      it('creates reasoning/override columns on agent_runs', () => {
        createSchema(db);
        expect(getColumnNames(db, 'agent_runs'))
          .toEqual(expect.arrayContaining(['reasoning_level', 'execution_overrides']));
      });

      it('does not insert duplicate version rows on re-run', () => {
        createSchema(db);
        createSchema(db);
        const result = db.prepare(
          'SELECT count(*) AS count FROM schema_version WHERE version = ?',
        ).get(SCHEMA_VERSION) as { count: number };
        expect(result.count).toBe(1);
      });
    });

    describe('capture layer tables', () => {
      const captureTables = [
        'sessions',
        'prompt_batches',
        'activities',
        'plans',
        'artifacts',
        'team_members',
        'attachments',
      ];

      it.each(captureTables)('creates %s table', (table) => {
        createSchema(db);
        expect(tableExists(db, table)).toBe(true);
      });

      it('sessions table has correct columns', () => {
        createSchema(db);
        const colNames = getColumnNames(db, 'sessions');
        expect(colNames).toContain('id');
        expect(colNames).toContain('agent');
        expect(colNames).toContain('user');
        expect(colNames).toContain('project_root');
        expect(colNames).toContain('branch');
        expect(colNames).toContain('started_at');
        expect(colNames).toContain('ended_at');
        expect(colNames).toContain('status');
        expect(colNames).toContain('prompt_count');
        expect(colNames).toContain('tool_count');
        expect(colNames).toContain('title');
        expect(colNames).toContain('summary');
        expect(colNames).toContain('transcript_path');
        expect(colNames).toContain('parent_session_id');
        expect(colNames).toContain('parent_session_reason');
        expect(colNames).toContain('processed');
        expect(colNames).toContain('content_hash');
        expect(colNames).toContain('created_at');
        expect(colNames).toContain('embedded');
      });

      it('prompt_batches table has correct columns', () => {
        createSchema(db);
        const colNames = getColumnNames(db, 'prompt_batches');
        expect(colNames).toContain('id');
        expect(colNames).toContain('session_id');
        expect(colNames).toContain('prompt_number');
        expect(colNames).toContain('user_prompt');
        expect(colNames).toContain('response_summary');
        expect(colNames).toContain('classification');
        expect(colNames).toContain('started_at');
        expect(colNames).toContain('ended_at');
        expect(colNames).toContain('status');
        expect(colNames).toContain('activity_count');
        expect(colNames).toContain('processed');
        expect(colNames).toContain('content_hash');
        expect(colNames).toContain('created_at');
      });

      it('activities table has correct columns', () => {
        createSchema(db);
        const colNames = getColumnNames(db, 'activities');
        expect(colNames).toContain('id');
        expect(colNames).toContain('session_id');
        expect(colNames).toContain('prompt_batch_id');
        expect(colNames).toContain('tool_name');
        expect(colNames).toContain('tool_input');
        expect(colNames).toContain('tool_output_summary');
        expect(colNames).toContain('file_path');
        expect(colNames).toContain('files_affected');
        expect(colNames).toContain('duration_ms');
        expect(colNames).toContain('success');
        expect(colNames).toContain('error_message');
        expect(colNames).toContain('timestamp');
        expect(colNames).toContain('processed');
        expect(colNames).toContain('content_hash');
        expect(colNames).toContain('created_at');
      });

      it('plans table has correct columns', () => {
        createSchema(db);
        const colNames = getColumnNames(db, 'plans');
        expect(colNames).toContain('id');
        expect(colNames).toContain('logical_key');
        expect(colNames).toContain('status');
        expect(colNames).toContain('author');
        expect(colNames).toContain('title');
        expect(colNames).toContain('content');
        expect(colNames).toContain('source_path');
        expect(colNames).toContain('tags');
        expect(colNames).toContain('processed');
        expect(colNames).toContain('created_at');
        expect(colNames).toContain('updated_at');
        expect(colNames).toContain('embedded');
      });

      it('artifacts table has correct columns', () => {
        createSchema(db);
        const colNames = getColumnNames(db, 'artifacts');
        expect(colNames).toContain('id');
        expect(colNames).toContain('artifact_type');
        expect(colNames).toContain('source_path');
        expect(colNames).toContain('title');
        expect(colNames).toContain('content');
        expect(colNames).toContain('last_captured_by');
        expect(colNames).toContain('tags');
        expect(colNames).toContain('created_at');
        expect(colNames).toContain('updated_at');
        expect(colNames).toContain('embedded');
      });

      it('team_members table has correct columns', () => {
        createSchema(db);
        const colNames = getColumnNames(db, 'team_members');
        expect(colNames).toContain('id');
        expect(colNames).toContain('user');
        expect(colNames).toContain('role');
        expect(colNames).toContain('joined');
        expect(colNames).toContain('tags');
      });

      it('attachments table has correct columns', () => {
        createSchema(db);
        const colNames = getColumnNames(db, 'attachments');
        expect(colNames).toContain('id');
        expect(colNames).toContain('session_id');
        expect(colNames).toContain('prompt_batch_id');
        expect(colNames).toContain('file_path');
        expect(colNames).toContain('media_type');
        expect(colNames).toContain('description');
        expect(colNames).toContain('created_at');
      });
    });

    describe('intelligence layer tables', () => {
      const intelligenceTables = [
        'agents',
        'spores',
        'entities',
        'graph_edges',
        'entity_mentions',
        'resolution_events',
        'digest_extracts',
      ];

      it.each(intelligenceTables)('creates %s table', (table) => {
        createSchema(db);
        expect(tableExists(db, table)).toBe(true);
      });

      it('spores table has embedded flag column', () => {
        createSchema(db);
        const colNames = getColumnNames(db, 'spores');
        expect(colNames).toContain('embedded');
      });

      it('entities table has correct columns including compound unique', () => {
        createSchema(db);
        const colNames = getColumnNames(db, 'entities');
        expect(colNames).toContain('id');
        expect(colNames).toContain('agent_id');
        expect(colNames).toContain('type');
        expect(colNames).toContain('name');
        expect(colNames).toContain('properties');
        expect(colNames).toContain('first_seen');
        expect(colNames).toContain('last_seen');
      });

      it('entity_mentions table has correct columns', () => {
        createSchema(db);
        const colNames = getColumnNames(db, 'entity_mentions');
        expect(colNames).toContain('entity_id');
        expect(colNames).toContain('note_id');
        expect(colNames).toContain('note_type');
        expect(colNames).toContain('agent_id');
      });

      it('resolution_events table has correct columns', () => {
        createSchema(db);
        const colNames = getColumnNames(db, 'resolution_events');
        expect(colNames).toContain('id');
        expect(colNames).toContain('agent_id');
        expect(colNames).toContain('spore_id');
        expect(colNames).toContain('action');
        expect(colNames).toContain('new_spore_id');
        expect(colNames).toContain('reason');
        expect(colNames).toContain('session_id');
        expect(colNames).toContain('created_at');
      });

      it('digest_extracts table has correct columns', () => {
        createSchema(db);
        const colNames = getColumnNames(db, 'digest_extracts');
        expect(colNames).toContain('id');
        expect(colNames).toContain('agent_id');
        expect(colNames).toContain('tier');
        expect(colNames).toContain('content');
        expect(colNames).toContain('substrate_hash');
        expect(colNames).toContain('generated_at');
      });

      it('graph_edges table has correct columns', () => {
        createSchema(db);
        const colNames = getColumnNames(db, 'graph_edges');
        expect(colNames).toContain('id');
        expect(colNames).toContain('agent_id');
        expect(colNames).toContain('source_id');
        expect(colNames).toContain('source_type');
        expect(colNames).toContain('target_id');
        expect(colNames).toContain('target_type');
        expect(colNames).toContain('type');
        expect(colNames).toContain('session_id');
        expect(colNames).toContain('confidence');
        expect(colNames).toContain('properties');
        expect(colNames).toContain('created_at');
      });

      it('spores table has properties column', () => {
        createSchema(db);
        const colNames = getColumnNames(db, 'spores');
        expect(colNames).toContain('properties');
      });

      it('entities table has status column', () => {
        createSchema(db);
        const colNames = getColumnNames(db, 'entities');
        expect(colNames).toContain('status');
      });

      it('agent_tasks table has model column', () => {
        createSchema(db);
        const colNames = getColumnNames(db, 'agent_tasks');
        expect(colNames).toContain('model');
      });
    });

    describe('agent state tables', () => {
      it('creates agent_runs table with instruction column', () => {
        createSchema(db);
        expect(tableExists(db, 'agent_runs')).toBe(true);
        const colNames = getColumnNames(db, 'agent_runs');
        expect(colNames).toContain('id');
        expect(colNames).toContain('agent_id');
        expect(colNames).toContain('task');
        expect(colNames).toContain('instruction');
        expect(colNames).toContain('status');
        expect(colNames).toContain('started_at');
        expect(colNames).toContain('completed_at');
        expect(colNames).toContain('tokens_used');
        expect(colNames).toContain('cost_usd');
        expect(colNames).toContain('actions_taken');
        expect(colNames).toContain('error');
      });

      it('creates agent_state table with compound primary key', () => {
        createSchema(db);
        expect(tableExists(db, 'agent_state')).toBe(true);
        const colNames = getColumnNames(db, 'agent_state');
        expect(colNames).toContain('agent_id');
        expect(colNames).toContain('key');
        expect(colNames).toContain('value');
        expect(colNames).toContain('updated_at');
      });
    });

    describe('phase 2 tables', () => {
      it('creates agent_reports table with correct columns', () => {
        createSchema(db);
        expect(tableExists(db, 'agent_reports')).toBe(true);
        const colNames = getColumnNames(db, 'agent_reports');
        expect(colNames).toContain('id');
        expect(colNames).toContain('run_id');
        expect(colNames).toContain('agent_id');
        expect(colNames).toContain('action');
        expect(colNames).toContain('summary');
        expect(colNames).toContain('details');
        expect(colNames).toContain('created_at');
      });

      it('creates agent_turns table with correct columns', () => {
        createSchema(db);
        expect(tableExists(db, 'agent_turns')).toBe(true);
        const colNames = getColumnNames(db, 'agent_turns');
        expect(colNames).toContain('id');
        expect(colNames).toContain('run_id');
        expect(colNames).toContain('agent_id');
        expect(colNames).toContain('turn_number');
        expect(colNames).toContain('tool_name');
        expect(colNames).toContain('tool_input');
        expect(colNames).toContain('tool_output_summary');
        expect(colNames).toContain('started_at');
        expect(colNames).toContain('completed_at');
      });

      it('creates agent_tasks table with correct columns', () => {
        createSchema(db);
        expect(tableExists(db, 'agent_tasks')).toBe(true);
        const colNames = getColumnNames(db, 'agent_tasks');
        expect(colNames).toContain('id');
        expect(colNames).toContain('agent_id');
        expect(colNames).toContain('source');
        expect(colNames).toContain('display_name');
        expect(colNames).toContain('description');
        expect(colNames).toContain('prompt');
        expect(colNames).toContain('is_default');
        expect(colNames).toContain('tool_overrides');
        expect(colNames).toContain('config');
        expect(colNames).toContain('created_at');
        expect(colNames).toContain('updated_at');
      });

      it('agents table has expanded Phase 2 columns', () => {
        createSchema(db);
        const colNames = getColumnNames(db, 'agents');
        expect(colNames).toContain('source');
        expect(colNames).toContain('system_prompt');
        expect(colNames).toContain('max_turns');
        expect(colNames).toContain('timeout_seconds');
        expect(colNames).toContain('tool_access');
        expect(colNames).toContain('enabled');
        expect(colNames).toContain('updated_at');
      });

      it('creates indexes on Phase 2 tables', () => {
        createSchema(db);
        expect(indexExists(db, 'idx_agent_reports_run_id')).toBe(true);
        expect(indexExists(db, 'idx_agent_turns_run_id')).toBe(true);
        expect(indexExists(db, 'idx_agent_tasks_agent_id')).toBe(true);
      });
    });

    describe('skills layer tables', () => {
      const skillsTables = [
        'skill_candidates',
        'skill_records',
        'skill_lineage',
        'skill_usage',
      ];

      it.each(skillsTables)('creates %s table', (table) => {
        createSchema(db);
        expect(tableExists(db, table)).toBe(true);
      });

      it('skill_candidates table has correct columns', () => {
        createSchema(db);
        const colNames = getColumnNames(db, 'skill_candidates');
        expect(colNames).toContain('id');
        expect(colNames).toContain('agent_id');
        expect(colNames).toContain('machine_id');
        expect(colNames).toContain('topic');
        expect(colNames).toContain('rationale');
        expect(colNames).toContain('confidence');
        expect(colNames).toContain('status');
        expect(colNames).toContain('source_ids');
        expect(colNames).toContain('skill_id');
        expect(colNames).toContain('created_at');
        expect(colNames).toContain('updated_at');
        expect(colNames).toContain('approved_at');
        expect(colNames).toContain('synced_at');
      });

      it('skill_records table has correct columns', () => {
        createSchema(db);
        const colNames = getColumnNames(db, 'skill_records');
        expect(colNames).toContain('id');
        expect(colNames).toContain('agent_id');
        expect(colNames).toContain('machine_id');
        expect(colNames).toContain('name');
        expect(colNames).toContain('display_name');
        expect(colNames).toContain('description');
        expect(colNames).toContain('status');
        expect(colNames).toContain('generation');
        expect(colNames).toContain('candidate_id');
        expect(colNames).toContain('source_ids');
        expect(colNames).toContain('path');
        expect(colNames).toContain('usage_count');
        expect(colNames).toContain('last_used_at');
        expect(colNames).toContain('created_at');
        expect(colNames).toContain('updated_at');
        expect(colNames).toContain('properties');
        expect(colNames).toContain('synced_at');
      });

      it('skill_lineage table has correct columns', () => {
        createSchema(db);
        const colNames = getColumnNames(db, 'skill_lineage');
        expect(colNames).toContain('id');
        expect(colNames).toContain('skill_id');
        expect(colNames).toContain('generation');
        expect(colNames).toContain('action');
        expect(colNames).toContain('rationale');
        expect(colNames).toContain('source_ids_added');
        expect(colNames).toContain('content_snapshot');
        expect(colNames).toContain('created_at');
      });

      it('skill_usage table has correct columns', () => {
        createSchema(db);
        const colNames = getColumnNames(db, 'skill_usage');
        expect(colNames).toContain('id');
        expect(colNames).toContain('skill_id');
        expect(colNames).toContain('session_id');
        expect(colNames).toContain('machine_id');
        expect(colNames).toContain('detected_at');
      });

      it('creates indexes on skills tables', () => {
        createSchema(db);
        expect(indexExists(db, 'idx_skill_candidates_agent_id')).toBe(true);
        expect(indexExists(db, 'idx_skill_candidates_status')).toBe(true);
        expect(indexExists(db, 'idx_skill_candidates_machine_id')).toBe(true);
        expect(indexExists(db, 'idx_skill_records_agent_id')).toBe(true);
        expect(indexExists(db, 'idx_skill_records_status')).toBe(true);
        expect(indexExists(db, 'idx_skill_records_name')).toBe(true);
        expect(indexExists(db, 'idx_skill_records_machine_id')).toBe(true);
        expect(indexExists(db, 'idx_skill_lineage_skill_id')).toBe(true);
        expect(indexExists(db, 'idx_skill_usage_skill_id')).toBe(true);
        expect(indexExists(db, 'idx_skill_usage_session_id')).toBe(true);
      });
    });

    describe('FTS5 virtual tables', () => {
      it('creates prompt_batches_fts virtual table', () => {
        createSchema(db);
        expect(tableExists(db, 'prompt_batches_fts')).toBe(true);
      });

      it('creates activities_fts virtual table', () => {
        createSchema(db);
        expect(tableExists(db, 'activities_fts')).toBe(true);
      });
    });

    describe('unique constraints', () => {
      it('enforces content_hash uniqueness on sessions', () => {
        createSchema(db);
        db.prepare(
          `INSERT INTO sessions (id, agent, started_at, created_at, content_hash)
           VALUES ('s1', 'test', 1000, 1000, 'hash-abc')`,
        ).run();
        expect(() =>
          db.prepare(
            `INSERT INTO sessions (id, agent, started_at, created_at, content_hash)
             VALUES ('s2', 'test', 1001, 1001, 'hash-abc')`,
          ).run(),
        ).toThrow();
      });

      it('enforces compound unique on entities (agent_id, type, name)', () => {
        createSchema(db);
        db.prepare(
          `INSERT INTO agents (id, name, created_at) VALUES ('c1', 'Test', 1000)`,
        ).run();
        db.prepare(
          `INSERT INTO entities (id, agent_id, type, name, first_seen, last_seen)
           VALUES ('e1', 'c1', 'component', 'AuthModule', 1000, 1000)`,
        ).run();
        expect(() =>
          db.prepare(
            `INSERT INTO entities (id, agent_id, type, name, first_seen, last_seen)
             VALUES ('e2', 'c1', 'component', 'AuthModule', 1001, 1001)`,
          ).run(),
        ).toThrow();
      });

      it('enforces compound unique on entity_mentions', () => {
        createSchema(db);
        db.prepare(
          `INSERT INTO agents (id, name, created_at) VALUES ('c1', 'Test', 1000)`,
        ).run();
        db.prepare(
          `INSERT INTO entities (id, agent_id, type, name, first_seen, last_seen)
           VALUES ('e1', 'c1', 'component', 'X', 1000, 1000)`,
        ).run();
        db.prepare(
          `INSERT INTO entity_mentions (entity_id, note_id, note_type, agent_id)
           VALUES ('e1', 'spore-1', 'spore', 'c1')`,
        ).run();
        expect(() =>
          db.prepare(
            `INSERT INTO entity_mentions (entity_id, note_id, note_type, agent_id)
             VALUES ('e1', 'spore-1', 'spore', 'c1')`,
          ).run(),
        ).toThrow();
      });

      it('enforces compound unique on digest_extracts (agent_id, tier)', () => {
        createSchema(db);
        db.prepare(
          `INSERT INTO agents (id, name, created_at) VALUES ('c1', 'Test', 1000)`,
        ).run();
        db.prepare(
          `INSERT INTO digest_extracts (agent_id, tier, content, generated_at)
           VALUES ('c1', 1500, 'context', 1000)`,
        ).run();
        expect(() =>
          db.prepare(
            `INSERT INTO digest_extracts (agent_id, tier, content, generated_at)
             VALUES ('c1', 1500, 'updated context', 1001)`,
          ).run(),
        ).toThrow();
      });

      it('enforces compound primary key on agent_state', () => {
        createSchema(db);
        db.prepare(
          `INSERT INTO agents (id, name, created_at) VALUES ('c1', 'Test', 1000)`,
        ).run();
        db.prepare(
          `INSERT INTO agent_state (agent_id, key, value, updated_at)
           VALUES ('c1', 'cursor', '42', 1000)`,
        ).run();
        expect(() =>
          db.prepare(
            `INSERT INTO agent_state (agent_id, key, value, updated_at)
             VALUES ('c1', 'cursor', '43', 1001)`,
          ).run(),
        ).toThrow();
      });
    });

    describe('secondary indexes', () => {
      it('creates indexes on commonly queried columns', () => {
        createSchema(db);
        // Spot-check a few critical indexes
        expect(indexExists(db, 'idx_sessions_status')).toBe(true);
        expect(indexExists(db, 'idx_sessions_processed')).toBe(true);
        expect(indexExists(db, 'idx_prompt_batches_session_id')).toBe(true);
        expect(indexExists(db, 'idx_activities_session_id')).toBe(true);
        expect(indexExists(db, 'idx_plans_logical_key')).toBe(true);
        expect(indexExists(db, 'idx_spores_agent_id')).toBe(true);
        expect(indexExists(db, 'idx_spores_status')).toBe(true);
        expect(indexExists(db, 'idx_entities_agent_id')).toBe(true);
        expect(indexExists(db, 'idx_graph_edges_source')).toBe(true);
        expect(indexExists(db, 'idx_graph_edges_target')).toBe(true);
        expect(indexExists(db, 'idx_graph_edges_type')).toBe(true);
        expect(indexExists(db, 'idx_graph_edges_agent')).toBe(true);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Migrations — exercises individual migration functions on hand-built
  // pre-migration DB states so we can verify both the DDL change AND any
  // backfill logic. Uses the MIGRATIONS registry directly rather than
  // createSchema so the test can control the starting point.
  // ---------------------------------------------------------------------------
  describe('migrations', () => {
    describe('v9 to v10: skill_candidates.approved_at with backfill', () => {
      /**
       * Build a v9-shape DB: pre-v10 skill_candidates table + required FKs.
       * Runs each DDL as an individual prepared statement to keep the
       * test deterministic and compatible with the Edit hook guard.
       */
      function buildV9Db(target: Database) {
        const ddl = [
          `CREATE TABLE schema_version (
            version    INTEGER PRIMARY KEY,
            applied_at INTEGER NOT NULL
          )`,
          `CREATE TABLE agents (
            id         TEXT PRIMARY KEY,
            name       TEXT NOT NULL,
            created_at INTEGER NOT NULL
          )`,
          `CREATE TABLE skill_candidates (
            id              TEXT PRIMARY KEY,
            agent_id        TEXT NOT NULL REFERENCES agents(id),
            machine_id      TEXT NOT NULL DEFAULT 'local',
            topic           TEXT NOT NULL,
            rationale       TEXT NOT NULL,
            confidence      REAL NOT NULL DEFAULT 0.0,
            status          TEXT NOT NULL DEFAULT 'identified',
            source_ids      TEXT NOT NULL DEFAULT '[]',
            skill_id        TEXT,
            created_at      INTEGER NOT NULL,
            updated_at      INTEGER NOT NULL,
            synced_at       INTEGER
          )`,
        ];
        for (const stmt of ddl) target.prepare(stmt).run();
        target.prepare(
          `INSERT INTO schema_version (version, applied_at) VALUES (9, 1000)`,
        ).run();
        target.prepare(
          `INSERT INTO agents (id, name, created_at) VALUES ('agent-test', 'Test', 1000)`,
        ).run();
      }

      /** Insert a candidate directly (no TS helpers — we're pre-migration). */
      function seedCandidate(target: Database, id: string, status: string) {
        target.prepare(
          `INSERT INTO skill_candidates (id, agent_id, topic, rationale, status, created_at, updated_at)
           VALUES (?, 'agent-test', ?, ?, ?, 1000, 1100)`,
        ).run(id, `topic-${id}`, `rationale-${id}`, status);
      }

      it('adds approved_at column to existing skill_candidates', () => {
        buildV9Db(db);
        expect(getColumnNames(db, 'skill_candidates')).not.toContain('approved_at');

        const migration = MIGRATIONS.find((m) => m.version === 10);
        expect(migration).toBeDefined();
        migration!.migrate(db, 'local');

        expect(getColumnNames(db, 'skill_candidates')).toContain('approved_at');
      });

      it('records schema_version row 10 after migration', () => {
        buildV9Db(db);
        const migration = MIGRATIONS.find((m) => m.version === 10)!;
        migration.migrate(db, 'local');

        const row = db.prepare(
          'SELECT version FROM schema_version WHERE version = 10',
        ).get() as { version: number } | undefined;
        expect(row?.version).toBe(10);
      });

      it('backfills approved_at for approved and generated rows only', () => {
        buildV9Db(db);
        seedCandidate(db, 'c-identified', 'identified');
        seedCandidate(db, 'c-approved', 'approved');
        seedCandidate(db, 'c-generated', 'generated');
        seedCandidate(db, 'c-dismissed', 'dismissed');

        const migration = MIGRATIONS.find((m) => m.version === 10)!;
        migration.migrate(db, 'local');

        const rows = db.prepare(
          `SELECT id, status, approved_at FROM skill_candidates ORDER BY id`,
        ).all() as Array<{ id: string; status: string; approved_at: number | null }>;

        const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
        expect(byId['c-identified'].approved_at).toBeNull();
        expect(byId['c-approved'].approved_at).not.toBeNull();
        expect(byId['c-generated'].approved_at).not.toBeNull();
        expect(byId['c-dismissed'].approved_at).toBeNull();
      });

      it('is idempotent — running twice does not throw', () => {
        buildV9Db(db);
        const migration = MIGRATIONS.find((m) => m.version === 10)!;
        migration.migrate(db, 'local');
        expect(() => migration.migrate(db, 'local')).not.toThrow();
      });

      it('does not overwrite existing approved_at on re-run', () => {
        buildV9Db(db);
        seedCandidate(db, 'c-approved', 'approved');

        const migration = MIGRATIONS.find((m) => m.version === 10)!;
        migration.migrate(db, 'local');

        const first = db.prepare(
          `SELECT approved_at FROM skill_candidates WHERE id = 'c-approved'`,
        ).get() as { approved_at: number };
        expect(first.approved_at).toBeGreaterThan(0);

        // Second run must be safe under re-execution — the backfill should
        // skip already-populated rows and not modify them.
        migration.migrate(db, 'local');

        const second = db.prepare(
          `SELECT approved_at FROM skill_candidates WHERE id = 'c-approved'`,
        ).get() as { approved_at: number };
        expect(second.approved_at).toBe(first.approved_at);
      });
    });

    describe('v15 to v16: agent_runs reasoning_level + execution_overrides', () => {
      /**
       * Build a minimal pre-v16 agent_runs shape — only the columns the
       * migration cares about need to be present. Matches the layout after
       * v15 but without the v16 columns.
       */
      function buildV15AgentRunsDb(target: Database) {
        target.prepare(
          `CREATE TABLE schema_version (
             version    INTEGER PRIMARY KEY,
             applied_at INTEGER NOT NULL
           )`,
        ).run();
        target.prepare(
          `CREATE TABLE agent_runs (
             id             TEXT PRIMARY KEY,
             agent_id       TEXT NOT NULL,
             task           TEXT,
             status         TEXT,
             dry_run        INTEGER NOT NULL DEFAULT 0,
             evaluation_id  TEXT
           )`,
        ).run();
        target.prepare(
          `INSERT INTO schema_version (version, applied_at) VALUES (15, 1000)`,
        ).run();
      }

      it('adds reasoning_level and execution_overrides columns', () => {
        buildV15AgentRunsDb(db);
        expect(getColumnNames(db, 'agent_runs')).not.toContain('reasoning_level');
        expect(getColumnNames(db, 'agent_runs')).not.toContain('execution_overrides');

        const migration = MIGRATIONS.find((m) => m.version === 16);
        expect(migration).toBeDefined();
        migration!.migrate(db, 'local');

        const cols = getColumnNames(db, 'agent_runs');
        expect(cols).toContain('reasoning_level');
        expect(cols).toContain('execution_overrides');
      });

      it('records schema_version row 16 after migration', () => {
        buildV15AgentRunsDb(db);
        const migration = MIGRATIONS.find((m) => m.version === 16)!;
        migration.migrate(db, 'local');

        const row = db.prepare(
          'SELECT version FROM schema_version WHERE version = 16',
        ).get() as { version: number } | undefined;
        expect(row?.version).toBe(16);
      });

      it('is idempotent — running twice does not throw', () => {
        buildV15AgentRunsDb(db);
        const migration = MIGRATIONS.find((m) => m.version === 16)!;
        migration.migrate(db, 'local');
        expect(() => migration.migrate(db, 'local')).not.toThrow();
      });
    });

    describe('v19 to v20: plans.logical_key with backfill', () => {
      function buildV19Db(target: Database) {
        const ddl = [
          `CREATE TABLE schema_version (
            version    INTEGER PRIMARY KEY,
            applied_at INTEGER NOT NULL
          )`,
          `CREATE TABLE sessions (
            id         TEXT PRIMARY KEY,
            agent      TEXT NOT NULL,
            started_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL
          )`,
          `CREATE TABLE plans (
            id               TEXT PRIMARY KEY,
            status           TEXT DEFAULT 'active',
            author           TEXT,
            title            TEXT,
            content          TEXT,
            source_path      TEXT,
            tags             TEXT,
            session_id       TEXT REFERENCES sessions(id),
            prompt_batch_id  INTEGER,
            content_hash     TEXT,
            processed        INTEGER DEFAULT 0,
            created_at       INTEGER NOT NULL,
            updated_at       INTEGER,
            embedded         INTEGER DEFAULT 0,
            machine_id       TEXT NOT NULL DEFAULT 'local',
            synced_at        INTEGER
          )`,
          `CREATE TABLE team_outbox (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name      TEXT NOT NULL,
            row_id          TEXT NOT NULL,
            operation       TEXT NOT NULL DEFAULT 'upsert',
            payload         TEXT NOT NULL,
            machine_id      TEXT NOT NULL,
            created_at      INTEGER NOT NULL,
            sent_at         INTEGER,
            retry_count     INTEGER NOT NULL DEFAULT 0,
            last_attempt_at INTEGER
          )`,
        ];

        for (const stmt of ddl) target.prepare(stmt).run();
        target.prepare(
          `INSERT INTO schema_version (version, applied_at) VALUES (19, 1000)`,
        ).run();
      }

      it('adds logical_key to plans and backfills file-backed rows', () => {
        buildV19Db(db);
        db.prepare(
          `INSERT INTO plans (id, source_path, title, content, created_at)
           VALUES ('old-plan', 'docs/plans/roadmap.md', 'Roadmap', '# Roadmap', 1000)`,
        ).run();

        const migration = MIGRATIONS.find((m) => m.version === 20)!;
        migration.migrate(db, 'local');

        const row = db.prepare(
          `SELECT logical_key FROM plans WHERE title = 'Roadmap'`,
        ).get() as { logical_key: string };
        expect(row.logical_key).toBe('path:docs/plans/roadmap.md');
      });

      it('backfills transcript-tag rows as session-scoped logical keys', () => {
        buildV19Db(db);
        db.prepare(
          `INSERT INTO sessions (id, agent, started_at, created_at)
           VALUES ('sess-1', 'claude-code', 1000, 1000)`,
        ).run();
        db.prepare(
          `INSERT INTO plans (id, source_path, session_id, title, content, created_at)
           VALUES ('tagged-plan', 'transcript:proposed_plan', 'sess-1', 'Tagged', '# Tagged', 1000)`,
        ).run();

        const migration = MIGRATIONS.find((m) => m.version === 20)!;
        migration.migrate(db, 'local');

        const row = db.prepare(
          `SELECT logical_key FROM plans WHERE session_id = 'sess-1'`,
        ).get() as { logical_key: string };
        expect(row.logical_key).toBe('session:sess-1:tag:proposed_plan');
      });

      it('falls back to legacy logical keys when no source_path exists', () => {
        buildV19Db(db);
        db.prepare(
          `INSERT INTO plans (id, title, content, created_at)
           VALUES ('legacy-plan', 'Legacy', '# Legacy', 1000)`,
        ).run();

        const migration = MIGRATIONS.find((m) => m.version === 20)!;
        migration.migrate(db, 'local');

        const row = db.prepare(
          `SELECT logical_key FROM plans WHERE title = 'Legacy'`,
        ).get() as { logical_key: string };
        expect(row.logical_key).toBe('legacy:legacy-plan');
      });

      it('requeues migrated plans for embedding and team sync', () => {
        buildV19Db(db);
        db.prepare(
          `INSERT INTO plans (id, source_path, title, content, embedded, synced_at, machine_id, created_at)
           VALUES ('old-plan', 'docs/plans/roadmap.md', 'Roadmap', '# Roadmap', 1, 1234, 'machine-a', 1000)`,
        ).run();
        db.prepare(
          `INSERT INTO team_outbox (table_name, row_id, operation, payload, machine_id, created_at)
           VALUES ('plans', 'old-plan', 'upsert', '{"id":"old-plan"}', 'machine-a', 1000)`,
        ).run();

        const migration = MIGRATIONS.find((m) => m.version === 20)!;
        migration.migrate(db, 'machine-a');

        const row = db.prepare(
          `SELECT id, embedded, synced_at, logical_key FROM plans WHERE title = 'Roadmap'`,
        ).get() as { id: string; embedded: number; synced_at: number | null; logical_key: string };
        expect(row.id).not.toBe('old-plan');
        expect(row.embedded).toBe(0);
        expect(row.synced_at).toBeNull();
        expect(row.logical_key).toBe('path:docs/plans/roadmap.md');

        const outboxRows = db.prepare(
          `SELECT row_id, operation, machine_id FROM team_outbox WHERE table_name = 'plans' ORDER BY id ASC`,
        ).all() as Array<{ row_id: string; operation: string; machine_id: string }>;
        expect(outboxRows).toEqual([
          { row_id: 'old-plan', operation: 'delete', machine_id: 'machine-a' },
          { row_id: row.id, operation: 'upsert', machine_id: 'machine-a' },
        ]);
      });

      it('surfaces a descriptive error when staged plan ids collide (#23)', async () => {
        buildV19Db(db);
        const { resolveV20PlanIdentityCollisionsForTest } = await import('@myco/db/migrations.js');

        // Simulate a post-staging state where two rows already share the
        // same id_next but have different logical_key_next — the exact
        // situation an MD5 collision would produce. The legacy-fallback
        // only rewrites dup logical keys, so this case exercises the
        // final-guard throw.
        db.exec(`ALTER TABLE plans ADD COLUMN logical_key TEXT NOT NULL DEFAULT ''`);
        db.exec(`ALTER TABLE plans ADD COLUMN id_next TEXT`);
        db.exec(`ALTER TABLE plans ADD COLUMN logical_key_next TEXT NOT NULL DEFAULT ''`);

        db.prepare(
          `INSERT INTO plans (id, source_path, title, content, created_at, id_next, logical_key_next)
           VALUES ('r-a', 'p/a.md', 'A', '# A', 1000, 'dup0000000000000', 'path:p/a.md')`,
        ).run();
        db.prepare(
          `INSERT INTO plans (id, source_path, title, content, created_at, id_next, logical_key_next)
           VALUES ('r-b', 'p/b.md', 'B', '# B', 1001, 'dup0000000000000', 'path:p/b.md')`,
        ).run();

        expect(() => resolveV20PlanIdentityCollisionsForTest(db))
          .toThrow(/plan id collisions after legacy fallback/);
      });

      it('skips redundant outbox re-enqueue when identity is unchanged (#39)', async () => {
        buildV19Db(db);
        const { buildPathPlanLogicalKey, buildPlanId } = await import('@myco/plans/identity.js');
        const logicalKey = buildPathPlanLogicalKey('docs/plans/a.md');
        const computedId = buildPlanId(logicalKey);

        db.prepare(
          `INSERT INTO plans (id, source_path, title, content, created_at, machine_id)
           VALUES (?, 'docs/plans/a.md', 'A', '# A', 1000, 'machine-a')`,
        ).run(computedId);

        const migration = MIGRATIONS.find((m) => m.version === 20)!;
        migration.migrate(db, 'machine-a');

        const planRow = db.prepare(`SELECT id, logical_key FROM plans`).get() as { id: string; logical_key: string };
        expect(planRow.id).toBe(computedId);
        expect(planRow.logical_key).toBe(logicalKey);

        const outboxRows = db.prepare(
          `SELECT row_id, operation FROM team_outbox WHERE table_name = 'plans'`,
        ).all() as Array<{ row_id: string; operation: string }>;
        // identity (id) didn't change -> no delete enqueued.
        expect(outboxRows.some((r) => r.operation === 'delete')).toBe(false);
      });
    });

    describe('createSchema fresh-install detection (#6)', () => {
      it('propagates migration errors instead of masking as fresh install', () => {
        db.prepare(
          `CREATE TABLE schema_version (
             version    INTEGER PRIMARY KEY,
             applied_at INTEGER NOT NULL
           )`,
        ).run();
        db.prepare(
          `INSERT INTO schema_version (version, applied_at) VALUES (19, 1000)`,
        ).run();

        const v20 = MIGRATIONS.find((m) => m.version === 20)!;
        const original = v20.migrate;
        v20.migrate = () => {
          throw new Error('simulated migration failure');
        };

        try {
          expect(() => createSchema(db)).toThrow(/simulated migration failure/);

          const row = db.prepare(
            `SELECT MAX(version) AS v FROM schema_version`,
          ).get() as { v: number };
          expect(row.v).toBe(19);
        } finally {
          v20.migrate = original;
        }
      });

      it('still performs fresh-install on a completely empty database', () => {
        createSchema(db);
        const row = db.prepare(
          `SELECT MAX(version) AS v FROM schema_version`,
        ).get() as { v: number };
        expect(row.v).toBe(SCHEMA_VERSION);
      });
    });

    describe('upgrade chain v13 -> v20 (idempotency + replay)', () => {
      function buildV13Db(target: Database) {
        const ddl = [
          `CREATE TABLE schema_version (
             version    INTEGER PRIMARY KEY,
             applied_at INTEGER NOT NULL
           )`,
          `CREATE TABLE agents (
             id         TEXT PRIMARY KEY,
             name       TEXT NOT NULL,
             created_at INTEGER NOT NULL
           )`,
          `CREATE TABLE sessions (
             id         TEXT PRIMARY KEY,
             agent      TEXT NOT NULL,
             started_at INTEGER NOT NULL,
             created_at INTEGER NOT NULL
           )`,
          `CREATE TABLE agent_runs (
             id             TEXT PRIMARY KEY,
             agent_id       TEXT NOT NULL,
             task           TEXT,
             status         TEXT,
             started_at     INTEGER,
             completed_at   INTEGER,
             runtime        TEXT,
             provider       TEXT,
             model          TEXT,
             session_ref    TEXT,
             resumable      INTEGER DEFAULT 0,
             resume_status  TEXT,
             resume_mode    TEXT,
             resumed_at     INTEGER,
             checkpoints    TEXT,
             usage_data     TEXT
           )`,
          `CREATE TABLE plans (
             id               TEXT PRIMARY KEY,
             status           TEXT DEFAULT 'active',
             author           TEXT,
             title            TEXT,
             content          TEXT,
             source_path      TEXT,
             tags             TEXT,
             session_id       TEXT REFERENCES sessions(id),
             prompt_batch_id  INTEGER,
             content_hash     TEXT,
             processed        INTEGER DEFAULT 0,
             created_at       INTEGER NOT NULL,
             updated_at       INTEGER,
             embedded         INTEGER DEFAULT 0,
             machine_id       TEXT NOT NULL DEFAULT 'local',
             synced_at        INTEGER
           )`,
          `CREATE TABLE team_outbox (
             id              INTEGER PRIMARY KEY AUTOINCREMENT,
             table_name      TEXT NOT NULL,
             row_id          TEXT NOT NULL,
             operation       TEXT NOT NULL DEFAULT 'upsert',
             payload         TEXT NOT NULL,
             machine_id      TEXT NOT NULL,
             created_at      INTEGER NOT NULL,
             sent_at         INTEGER,
             retry_count     INTEGER NOT NULL DEFAULT 0,
             last_attempt_at INTEGER
           )`,
        ];
        for (const stmt of ddl) target.prepare(stmt).run();
        target.prepare(
          `INSERT INTO schema_version (version, applied_at) VALUES (13, 1000)`,
        ).run();
      }

      function runMigration(target: Database, version: number) {
        const m = MIGRATIONS.find((mm) => mm.version === version);
        expect(m, `migration v${version} registered`).toBeDefined();
        m!.migrate(target, 'local');
      }

      it('v14: adds cost accounting columns and is idempotent', () => {
        buildV13Db(db);
        runMigration(db, 14);

        const cols = getColumnNames(db, 'agent_runs');
        expect(cols).toEqual(expect.arrayContaining([
          'actual_cost_usd', 'estimated_cost_usd', 'cost_source', 'cost_data',
        ]));

        expect(() => runMigration(db, 14)).not.toThrow();
        const versionRows = db.prepare(
          `SELECT COUNT(*) AS n FROM schema_version WHERE version = 14`,
        ).get() as { n: number };
        expect(versionRows.n).toBe(1);
      });

      it('v15: adds eval harness tables + agent_runs.dry_run column', () => {
        buildV13Db(db);
        runMigration(db, 14);
        runMigration(db, 15);

        expect(tableExists(db, 'agent_run_write_intents')).toBe(true);
        expect(tableExists(db, 'digest_extract_revisions')).toBe(true);
        expect(tableExists(db, 'agent_run_evaluations')).toBe(true);

        const cols = getColumnNames(db, 'agent_runs');
        expect(cols).toEqual(expect.arrayContaining(['dry_run', 'evaluation_id']));

        expect(() => runMigration(db, 15)).not.toThrow();
      });

      it('v17: adds composite write-intents index, idempotent', () => {
        buildV13Db(db);
        runMigration(db, 14);
        runMigration(db, 15);
        runMigration(db, 16);
        runMigration(db, 17);

        expect(indexExists(db, 'idx_write_intents_run_id_tool')).toBe(true);
        expect(() => runMigration(db, 17)).not.toThrow();
      });

      it('v18: creates cortex_instructions table, idempotent', () => {
        buildV13Db(db);
        for (const v of [14, 15, 16, 17, 18]) runMigration(db, v);

        expect(tableExists(db, 'cortex_instructions')).toBe(true);
        expect(indexExists(db, 'idx_cortex_instructions_agent_id')).toBe(true);

        expect(() => runMigration(db, 18)).not.toThrow();
      });

      it('v19: scope test — deletes only cortex_instructions outbox rows', () => {
        buildV13Db(db);
        for (const v of [14, 15, 16, 17, 18]) runMigration(db, v);

        const stmt = db.prepare(
          `INSERT INTO team_outbox (table_name, row_id, operation, payload, machine_id, created_at)
           VALUES (?, ?, 'upsert', ?, 'machine-a', 1000)`,
        );
        stmt.run('cortex_instructions', 'c1', '{"id":"c1"}');
        stmt.run('cortex_instructions', 'c2', '{"id":"c2"}');
        stmt.run('spores', 's1', '{"id":"s1"}');
        stmt.run('plans', 'p1', '{"id":"p1"}');

        runMigration(db, 19);

        const remaining = db.prepare(
          `SELECT table_name, row_id FROM team_outbox ORDER BY id ASC`,
        ).all() as Array<{ table_name: string; row_id: string }>;
        expect(remaining).toEqual([
          { table_name: 'spores', row_id: 's1' },
          { table_name: 'plans', row_id: 'p1' },
        ]);

        expect(() => runMigration(db, 19)).not.toThrow();
      });

      it('full v13 -> v21 chain reaches SCHEMA_VERSION and is replay-safe', () => {
        buildV13Db(db);
        for (const v of [14, 15, 16, 17, 18, 19, 20, 21]) runMigration(db, v);

        const row = db.prepare(
          `SELECT MAX(version) AS v FROM schema_version`,
        ).get() as { v: number };
        expect(row.v).toBe(SCHEMA_VERSION);

        for (const v of [14, 15, 16, 17, 18, 19, 20, 21]) {
          expect(() => runMigration(db, v), `v${v} replay`).not.toThrow();
        }
      });
    });

    describe('v20 to v21: prune semantic graph data', () => {
      function runMigration(target: Database, version: number) {
        const m = MIGRATIONS.find((mm) => mm.version === version);
        expect(m, `migration v${version} registered`).toBeDefined();
        m!.migrate(target, 'local');
      }

      /** Run createSchema first so all tables exist, then stamp back to v20 so v21 runs. */
      function setupAtV20(target: Database): void {
        createSchema(target);
        target.prepare(`DELETE FROM schema_version WHERE version = ?`).run(SCHEMA_VERSION);
      }

      /** Seed an entity row directly. */
      function seedEntity(target: Database, id: string, type: string, name: string): void {
        target.prepare(
          `INSERT INTO entities (id, agent_id, type, name, first_seen, last_seen)
           VALUES (?, 'agent-test', ?, ?, 1000, 2000)`,
        ).run(id, type, name);
      }

      /** Seed a graph edge row of a given type. */
      function seedEdge(
        target: Database,
        sourceId: string,
        targetId: string,
        type: string,
      ): void {
        target.prepare(
          `INSERT INTO graph_edges (agent_id, source_id, source_type, target_id, target_type, type, created_at)
           VALUES ('agent-test', ?, 'spore', ?, 'entity', ?, 1000)`,
        ).run(sourceId, targetId, type);
      }

      /** Seed an entity_mention row. */
      function seedMention(target: Database, entityId: string, noteId: string): void {
        target.prepare(
          `INSERT INTO entity_mentions (entity_id, note_id, note_type, agent_id)
           VALUES (?, ?, 'spore', 'agent-test')`,
        ).run(entityId, noteId);
      }

      it('deletes entities, entity_mentions, and semantic edges', () => {
        setupAtV20(db);
        db.prepare(`INSERT INTO agents (id, name, created_at) VALUES ('agent-test', 'Test', 1000)`).run();

        seedEntity(db, 'e1', 'component', 'DaemonClient');
        seedEntity(db, 'e2', 'concept', 'Supersession');
        seedMention(db, 'e1', 'spore-1');
        seedEdge(db, 'spore-1', 'e1', 'REFERENCES');
        seedEdge(db, 'spore-2', 'e2', 'AFFECTS');
        seedEdge(db, 'e1', 'e2', 'DEPENDS_ON');
        seedEdge(db, 'spore-3', 'e2', 'RELATES_TO');

        runMigration(db, 21);

        const entityCount = db.prepare(`SELECT count(*) AS c FROM entities`).get() as { c: number };
        const mentionCount = db.prepare(`SELECT count(*) AS c FROM entity_mentions`).get() as { c: number };
        const semanticEdgeCount = db.prepare(
          `SELECT count(*) AS c FROM graph_edges
            WHERE type IN ('REFERENCES', 'AFFECTS', 'DEPENDS_ON', 'RELATES_TO')`,
        ).get() as { c: number };

        expect(entityCount.c).toBe(0);
        expect(mentionCount.c).toBe(0);
        expect(semanticEdgeCount.c).toBe(0);
      });

      it('preserves lineage edges', () => {
        setupAtV20(db);
        db.prepare(`INSERT INTO agents (id, name, created_at) VALUES ('agent-test', 'Test', 1000)`).run();

        db.prepare(
          `INSERT INTO graph_edges (agent_id, source_id, source_type, target_id, target_type, type, created_at)
           VALUES ('agent-test', ?, ?, ?, ?, ?, 1000)`,
        ).run('spore-1', 'spore', 'session-1', 'session', 'FROM_SESSION');
        db.prepare(
          `INSERT INTO graph_edges (agent_id, source_id, source_type, target_id, target_type, type, created_at)
           VALUES ('agent-test', ?, ?, ?, ?, ?, 1000)`,
        ).run('spore-1', 'spore', '42', 'batch', 'EXTRACTED_FROM');
        db.prepare(
          `INSERT INTO graph_edges (agent_id, source_id, source_type, target_id, target_type, type, created_at)
           VALUES ('agent-test', ?, ?, ?, ?, ?, 1000)`,
        ).run('session-1', 'session', '42', 'batch', 'HAS_BATCH');
        db.prepare(
          `INSERT INTO graph_edges (agent_id, source_id, source_type, target_id, target_type, type, created_at)
           VALUES ('agent-test', ?, ?, ?, ?, ?, 1000)`,
        ).run('spore-wisdom', 'spore', 'spore-source', 'spore', 'DERIVED_FROM');

        runMigration(db, 21);

        const lineageCount = db.prepare(
          `SELECT count(*) AS c FROM graph_edges
            WHERE type IN ('FROM_SESSION', 'EXTRACTED_FROM', 'HAS_BATCH', 'DERIVED_FROM', 'SUPERSEDED_BY')`,
        ).get() as { c: number };
        expect(lineageCount.c).toBe(4);
      });

      it('records schema_version row 21 after migration', () => {
        setupAtV20(db);
        runMigration(db, 21);
        const row = db.prepare(`SELECT version FROM schema_version WHERE version = 21`).get() as
          | { version: number }
          | undefined;
        expect(row?.version).toBe(21);
      });

      it('is idempotent — running twice does not throw', () => {
        setupAtV20(db);
        db.prepare(`INSERT INTO agents (id, name, created_at) VALUES ('agent-test', 'Test', 1000)`).run();
        seedEntity(db, 'e1', 'component', 'DaemonClient');
        seedEdge(db, 'spore-1', 'e1', 'REFERENCES');

        runMigration(db, 21);
        expect(() => runMigration(db, 21)).not.toThrow();
      });
    });
  });
});

