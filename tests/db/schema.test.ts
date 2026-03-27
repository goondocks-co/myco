import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '@myco/db/client.js';
import { createSchema, SCHEMA_VERSION, EMBEDDING_DIMENSIONS } from '@myco/db/schema.js';
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
      expect(SCHEMA_VERSION).toBe(2);
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
});
