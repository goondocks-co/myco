import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '@myco/db/client.js';
import { createSchema, SCHEMA_VERSION, EMBEDDING_DIMENSIONS } from '@myco/db/schema.js';
import type { PGlite } from '@electric-sql/pglite';

/** Helper: query pg_catalog for a table's existence. */
async function tableExists(db: PGlite, tableName: string): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [tableName],
  );
  return result.rows[0].exists;
}

/** Helper: query column info for a table. */
async function getColumns(
  db: PGlite,
  tableName: string,
): Promise<Array<{ column_name: string; data_type: string; is_nullable: string }>> {
  const result = await db.query<{
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [tableName],
  );
  return result.rows;
}

/** Helper: check if an index exists. */
async function indexExists(db: PGlite, indexName: string): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = $1
     ) AS exists`,
    [indexName],
  );
  return result.rows[0].exists;
}

describe('Database schema', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await initDatabase();
  });

  afterEach(async () => {
    await closeDatabase();
  });

  describe('constants', () => {
    it('exports SCHEMA_VERSION as a positive integer', () => {
      expect(SCHEMA_VERSION).toBe(4);
      expect(Number.isInteger(SCHEMA_VERSION)).toBe(true);
    });

    it('exports EMBEDDING_DIMENSIONS as 1024 (bge-m3)', () => {
      expect(EMBEDDING_DIMENSIONS).toBe(1024);
    });
  });

  describe('createSchema()', () => {
    it('is idempotent — running twice does not throw', async () => {
      await createSchema(db);
      await expect(createSchema(db)).resolves.not.toThrow();
    });

    describe('schema_version table', () => {
      it('records the current schema version', async () => {
        await createSchema(db);
        const result = await db.query<{ version: number; applied_at: number }>(
          'SELECT version, applied_at FROM schema_version ORDER BY version DESC LIMIT 1',
        );
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].version).toBe(SCHEMA_VERSION);
        expect(typeof result.rows[0].applied_at).toBe('number');
      });

      it('does not insert duplicate version rows on re-run', async () => {
        await createSchema(db);
        await createSchema(db);
        const result = await db.query<{ count: string }>(
          'SELECT count(*) AS count FROM schema_version WHERE version = $1',
          [SCHEMA_VERSION],
        );
        expect(Number(result.rows[0].count)).toBe(1);
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

      it.each(captureTables)('creates %s table', async (table) => {
        await createSchema(db);
        expect(await tableExists(db, table)).toBe(true);
      });

      it('sessions table has correct columns', async () => {
        await createSchema(db);
        const cols = await getColumns(db, 'sessions');
        const colNames = cols.map((c) => c.column_name);
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
        expect(colNames).toContain('embedding');
      });

      it('prompt_batches table has correct columns', async () => {
        await createSchema(db);
        const cols = await getColumns(db, 'prompt_batches');
        const colNames = cols.map((c) => c.column_name);
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
        expect(colNames).toContain('embedding');
        expect(colNames).toContain('search_vector');
      });

      it('activities table has correct columns', async () => {
        await createSchema(db);
        const cols = await getColumns(db, 'activities');
        const colNames = cols.map((c) => c.column_name);
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
        expect(colNames).toContain('search_vector');
      });

      it('plans table has correct columns', async () => {
        await createSchema(db);
        const cols = await getColumns(db, 'plans');
        const colNames = cols.map((c) => c.column_name);
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
        expect(colNames).toContain('embedding');
      });

      it('artifacts table has correct columns', async () => {
        await createSchema(db);
        const cols = await getColumns(db, 'artifacts');
        const colNames = cols.map((c) => c.column_name);
        expect(colNames).toContain('id');
        expect(colNames).toContain('artifact_type');
        expect(colNames).toContain('source_path');
        expect(colNames).toContain('title');
        expect(colNames).toContain('content');
        expect(colNames).toContain('last_captured_by');
        expect(colNames).toContain('tags');
        expect(colNames).toContain('created_at');
        expect(colNames).toContain('updated_at');
        expect(colNames).toContain('embedding');
      });

      it('team_members table has correct columns', async () => {
        await createSchema(db);
        const cols = await getColumns(db, 'team_members');
        const colNames = cols.map((c) => c.column_name);
        expect(colNames).toContain('id');
        expect(colNames).toContain('user');
        expect(colNames).toContain('role');
        expect(colNames).toContain('joined');
        expect(colNames).toContain('tags');
      });

      it('attachments table has correct columns', async () => {
        await createSchema(db);
        const cols = await getColumns(db, 'attachments');
        const colNames = cols.map((c) => c.column_name);
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
        'edges',
        'entity_mentions',
        'resolution_events',
        'digest_extracts',
      ];

      it.each(intelligenceTables)('creates %s table', async (table) => {
        await createSchema(db);
        expect(await tableExists(db, table)).toBe(true);
      });

      it('spores table has embedding column', async () => {
        await createSchema(db);
        const cols = await getColumns(db, 'spores');
        const colNames = cols.map((c) => c.column_name);
        expect(colNames).toContain('embedding');
      });

      it('entities table has correct columns including compound unique', async () => {
        await createSchema(db);
        const cols = await getColumns(db, 'entities');
        const colNames = cols.map((c) => c.column_name);
        expect(colNames).toContain('id');
        expect(colNames).toContain('agent_id');
        expect(colNames).toContain('type');
        expect(colNames).toContain('name');
        expect(colNames).toContain('properties');
        expect(colNames).toContain('first_seen');
        expect(colNames).toContain('last_seen');
      });

      it('edges table has correct columns', async () => {
        await createSchema(db);
        const cols = await getColumns(db, 'edges');
        const colNames = cols.map((c) => c.column_name);
        expect(colNames).toContain('id');
        expect(colNames).toContain('agent_id');
        expect(colNames).toContain('source_id');
        expect(colNames).toContain('target_id');
        expect(colNames).toContain('type');
        expect(colNames).toContain('valid_from');
        expect(colNames).toContain('valid_until');
        expect(colNames).toContain('session_id');
        expect(colNames).toContain('confidence');
        expect(colNames).toContain('properties');
        expect(colNames).toContain('created_at');
      });

      it('entity_mentions table has correct columns', async () => {
        await createSchema(db);
        const cols = await getColumns(db, 'entity_mentions');
        const colNames = cols.map((c) => c.column_name);
        expect(colNames).toContain('entity_id');
        expect(colNames).toContain('note_id');
        expect(colNames).toContain('note_type');
        expect(colNames).toContain('agent_id');
      });

      it('resolution_events table has correct columns', async () => {
        await createSchema(db);
        const cols = await getColumns(db, 'resolution_events');
        const colNames = cols.map((c) => c.column_name);
        expect(colNames).toContain('id');
        expect(colNames).toContain('agent_id');
        expect(colNames).toContain('spore_id');
        expect(colNames).toContain('action');
        expect(colNames).toContain('new_spore_id');
        expect(colNames).toContain('reason');
        expect(colNames).toContain('session_id');
        expect(colNames).toContain('created_at');
      });

      it('digest_extracts table has correct columns', async () => {
        await createSchema(db);
        const cols = await getColumns(db, 'digest_extracts');
        const colNames = cols.map((c) => c.column_name);
        expect(colNames).toContain('id');
        expect(colNames).toContain('agent_id');
        expect(colNames).toContain('tier');
        expect(colNames).toContain('content');
        expect(colNames).toContain('substrate_hash');
        expect(colNames).toContain('generated_at');
      });
    });

    describe('agent state tables', () => {
      it('creates agent_runs table with instruction column', async () => {
        await createSchema(db);
        expect(await tableExists(db, 'agent_runs')).toBe(true);
        const cols = await getColumns(db, 'agent_runs');
        const colNames = cols.map((c) => c.column_name);
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

      it('creates agent_state table with compound primary key', async () => {
        await createSchema(db);
        expect(await tableExists(db, 'agent_state')).toBe(true);
        const cols = await getColumns(db, 'agent_state');
        const colNames = cols.map((c) => c.column_name);
        expect(colNames).toContain('agent_id');
        expect(colNames).toContain('key');
        expect(colNames).toContain('value');
        expect(colNames).toContain('updated_at');
      });
    });

    describe('phase 2 tables', () => {
      it('creates agent_reports table with correct columns', async () => {
        await createSchema(db);
        expect(await tableExists(db, 'agent_reports')).toBe(true);
        const cols = await getColumns(db, 'agent_reports');
        const colNames = cols.map((c) => c.column_name);
        expect(colNames).toContain('id');
        expect(colNames).toContain('run_id');
        expect(colNames).toContain('agent_id');
        expect(colNames).toContain('action');
        expect(colNames).toContain('summary');
        expect(colNames).toContain('details');
        expect(colNames).toContain('created_at');
      });

      it('creates agent_turns table with correct columns', async () => {
        await createSchema(db);
        expect(await tableExists(db, 'agent_turns')).toBe(true);
        const cols = await getColumns(db, 'agent_turns');
        const colNames = cols.map((c) => c.column_name);
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

      it('creates agent_tasks table with correct columns', async () => {
        await createSchema(db);
        expect(await tableExists(db, 'agent_tasks')).toBe(true);
        const cols = await getColumns(db, 'agent_tasks');
        const colNames = cols.map((c) => c.column_name);
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

      it('agents table has expanded Phase 2 columns', async () => {
        await createSchema(db);
        const cols = await getColumns(db, 'agents');
        const colNames = cols.map((c) => c.column_name);
        expect(colNames).toContain('source');
        expect(colNames).toContain('system_prompt');
        expect(colNames).toContain('max_turns');
        expect(colNames).toContain('timeout_seconds');
        expect(colNames).toContain('tool_access');
        expect(colNames).toContain('enabled');
        expect(colNames).toContain('updated_at');
      });

      it('creates indexes on Phase 2 tables', async () => {
        await createSchema(db);
        expect(await indexExists(db, 'idx_agent_reports_run_id')).toBe(true);
        expect(await indexExists(db, 'idx_agent_turns_run_id')).toBe(true);
        expect(await indexExists(db, 'idx_agent_tasks_agent_id')).toBe(true);
      });
    });

    describe('v3 to v4 migration', () => {
      it('is idempotent — running createSchema twice produces same result', async () => {
        await createSchema(db);
        await expect(createSchema(db)).resolves.not.toThrow();

        // Verify agents still has the new columns after double-run
        const cols = await getColumns(db, 'agents');
        const colNames = cols.map((c) => c.column_name);
        expect(colNames).toContain('source');
        expect(colNames).toContain('enabled');
        expect(colNames).toContain('updated_at');
      });

      it('records schema version 4', async () => {
        await createSchema(db);
        const result = await db.query<{ version: number }>(
          'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1',
        );
        expect(result.rows[0].version).toBe(4);
      });

      it('migrates a v3 database: renames curators→agents and curator_id→agent_id', async () => {
        // Build a v3-state database by running a full schema at v4 and then
        // simulating the pre-migration state: rename agents→curators and
        // agent_id→curator_id in spores, and downgrade schema_version to 3.
        // This lets createSchema see a real v3 state and verify the migration
        // path without fighting the DDL index loop with under-specified tables.
        await createSchema(db);

        // Downgrade to v3 state: undo the curator→agent rename on key tables
        await db.query('ALTER TABLE agents RENAME TO curators');
        await db.query('ALTER TABLE spores RENAME COLUMN agent_id TO curator_id');
        await db.query(`UPDATE schema_version SET version = 3 WHERE version = 4`);

        // Re-run createSchema — must detect v3 and apply v3→v4 migration
        await createSchema(db);

        // agents table must exist; curators must not
        expect(await tableExists(db, 'agents')).toBe(true);
        expect(await tableExists(db, 'curators')).toBe(false);

        // agent_id column must exist in spores; curator_id must not
        const sporesCols = await getColumns(db, 'spores');
        const sporesColNames = sporesCols.map((c) => c.column_name);
        expect(sporesColNames).toContain('agent_id');
        expect(sporesColNames).not.toContain('curator_id');

        // Schema version must be 4
        const result = await db.query<{ version: number }>(
          'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1',
        );
        expect(result.rows[0].version).toBe(4);
      });
    });

    describe('v2 to v3 migration', () => {
      it('adds search_vector column to prompt_batches', async () => {
        await createSchema(db);
        const cols = await getColumns(db, 'prompt_batches');
        const colNames = cols.map((c) => c.column_name);
        expect(colNames).toContain('search_vector');
      });

      it('adds search_vector column to activities', async () => {
        await createSchema(db);
        const cols = await getColumns(db, 'activities');
        const colNames = cols.map((c) => c.column_name);
        expect(colNames).toContain('search_vector');
      });

      it('adds embedding column to plans', async () => {
        await createSchema(db);
        const cols = await getColumns(db, 'plans');
        const colNames = cols.map((c) => c.column_name);
        expect(colNames).toContain('embedding');
      });

      it('adds embedding column to artifacts', async () => {
        await createSchema(db);
        const cols = await getColumns(db, 'artifacts');
        const colNames = cols.map((c) => c.column_name);
        expect(colNames).toContain('embedding');
      });

      it('creates GIN index on prompt_batches.search_vector', async () => {
        await createSchema(db);
        expect(await indexExists(db, 'idx_prompt_batches_search')).toBe(true);
      });

      it('creates GIN index on activities.search_vector', async () => {
        await createSchema(db);
        expect(await indexExists(db, 'idx_activities_search')).toBe(true);
      });

      it('creates HNSW index on plans.embedding', async () => {
        await createSchema(db);
        expect(await indexExists(db, 'idx_plans_embedding')).toBe(true);
      });

      it('creates HNSW index on artifacts.embedding', async () => {
        await createSchema(db);
        expect(await indexExists(db, 'idx_artifacts_embedding')).toBe(true);
      });

      it('is idempotent — running createSchema twice produces same result', async () => {
        await createSchema(db);
        await expect(createSchema(db)).resolves.not.toThrow();

        const cols = await getColumns(db, 'prompt_batches');
        const colNames = cols.map((c) => c.column_name);
        expect(colNames).toContain('search_vector');
        expect(colNames).toContain('embedding');
      });
    });

    describe('pgvector embedding columns', () => {
      it('sessions table has a vector embedding column', async () => {
        await createSchema(db);
        // Verify we can insert and query a vector value
        await db.query(
          `INSERT INTO sessions (id, agent, started_at, created_at)
           VALUES ('test-session', 'test', 1000, 1000)`,
        );
        // A valid vector literal for dimension 1024
        const zeros = new Array(EMBEDDING_DIMENSIONS).fill(0).join(',');
        await db.query(
          `UPDATE sessions SET embedding = '[${zeros}]' WHERE id = 'test-session'`,
        );
        const result = await db.query<{ id: string }>(
          `SELECT id FROM sessions WHERE embedding IS NOT NULL`,
        );
        expect(result.rows).toHaveLength(1);
      });

      it('prompt_batches table has a vector embedding column', async () => {
        await createSchema(db);
        await db.query(
          `INSERT INTO sessions (id, agent, started_at, created_at)
           VALUES ('test-session', 'test', 1000, 1000)`,
        );
        await db.query(
          `INSERT INTO prompt_batches (session_id, created_at)
           VALUES ('test-session', 1000)`,
        );
        const zeros = new Array(EMBEDDING_DIMENSIONS).fill(0).join(',');
        await db.query(
          `UPDATE prompt_batches SET embedding = '[${zeros}]' WHERE session_id = 'test-session'`,
        );
        const result = await db.query<{ id: number }>(
          `SELECT id FROM prompt_batches WHERE embedding IS NOT NULL`,
        );
        expect(result.rows).toHaveLength(1);
      });

      it('spores table has a vector embedding column', async () => {
        await createSchema(db);
        await db.query(
          `INSERT INTO agents (id, name, created_at) VALUES ('test-agent', 'Test', 1000)`,
        );
        await db.query(
          `INSERT INTO spores (id, agent_id, observation_type, content, created_at)
           VALUES ('test-spore', 'test-agent', 'gotcha', 'Test observation', 1000)`,
        );
        const zeros = new Array(EMBEDDING_DIMENSIONS).fill(0).join(',');
        await db.query(
          `UPDATE spores SET embedding = '[${zeros}]' WHERE id = 'test-spore'`,
        );
        const result = await db.query<{ id: string }>(
          `SELECT id FROM spores WHERE embedding IS NOT NULL`,
        );
        expect(result.rows).toHaveLength(1);
      });
    });

    describe('HNSW indexes', () => {
      it('creates HNSW index on sessions.embedding', async () => {
        await createSchema(db);
        expect(await indexExists(db, 'idx_sessions_embedding')).toBe(true);
      });

      it('creates HNSW index on prompt_batches.embedding', async () => {
        await createSchema(db);
        expect(await indexExists(db, 'idx_prompt_batches_embedding')).toBe(true);
      });

      it('creates HNSW index on spores.embedding', async () => {
        await createSchema(db);
        expect(await indexExists(db, 'idx_spores_embedding')).toBe(true);
      });
    });

    describe('secondary indexes', () => {
      it('creates indexes on commonly queried columns', async () => {
        await createSchema(db);
        // Spot-check a few critical indexes
        expect(await indexExists(db, 'idx_sessions_status')).toBe(true);
        expect(await indexExists(db, 'idx_sessions_processed')).toBe(true);
        expect(await indexExists(db, 'idx_prompt_batches_session_id')).toBe(true);
        expect(await indexExists(db, 'idx_activities_session_id')).toBe(true);
        expect(await indexExists(db, 'idx_spores_agent_id')).toBe(true);
        expect(await indexExists(db, 'idx_spores_status')).toBe(true);
        expect(await indexExists(db, 'idx_entities_agent_id')).toBe(true);
        expect(await indexExists(db, 'idx_edges_agent_id')).toBe(true);
        expect(await indexExists(db, 'idx_edges_source_id')).toBe(true);
        expect(await indexExists(db, 'idx_edges_target_id')).toBe(true);
      });
    });

    describe('unique constraints', () => {
      it('enforces content_hash uniqueness on sessions', async () => {
        await createSchema(db);
        await db.query(
          `INSERT INTO sessions (id, agent, started_at, created_at, content_hash)
           VALUES ('s1', 'test', 1000, 1000, 'hash-abc')`,
        );
        await expect(
          db.query(
            `INSERT INTO sessions (id, agent, started_at, created_at, content_hash)
             VALUES ('s2', 'test', 1001, 1001, 'hash-abc')`,
          ),
        ).rejects.toThrow();
      });

      it('enforces compound unique on entities (agent_id, type, name)', async () => {
        await createSchema(db);
        await db.query(
          `INSERT INTO agents (id, name, created_at) VALUES ('c1', 'Test', 1000)`,
        );
        await db.query(
          `INSERT INTO entities (id, agent_id, type, name, first_seen, last_seen)
           VALUES ('e1', 'c1', 'component', 'AuthModule', 1000, 1000)`,
        );
        await expect(
          db.query(
            `INSERT INTO entities (id, agent_id, type, name, first_seen, last_seen)
             VALUES ('e2', 'c1', 'component', 'AuthModule', 1001, 1001)`,
          ),
        ).rejects.toThrow();
      });

      it('enforces compound unique on entity_mentions', async () => {
        await createSchema(db);
        await db.query(
          `INSERT INTO agents (id, name, created_at) VALUES ('c1', 'Test', 1000)`,
        );
        await db.query(
          `INSERT INTO entities (id, agent_id, type, name, first_seen, last_seen)
           VALUES ('e1', 'c1', 'component', 'X', 1000, 1000)`,
        );
        await db.query(
          `INSERT INTO entity_mentions (entity_id, note_id, note_type, agent_id)
           VALUES ('e1', 'spore-1', 'spore', 'c1')`,
        );
        await expect(
          db.query(
            `INSERT INTO entity_mentions (entity_id, note_id, note_type, agent_id)
             VALUES ('e1', 'spore-1', 'spore', 'c1')`,
          ),
        ).rejects.toThrow();
      });

      it('enforces compound unique on digest_extracts (agent_id, tier)', async () => {
        await createSchema(db);
        await db.query(
          `INSERT INTO agents (id, name, created_at) VALUES ('c1', 'Test', 1000)`,
        );
        await db.query(
          `INSERT INTO digest_extracts (agent_id, tier, content, generated_at)
           VALUES ('c1', 1500, 'context', 1000)`,
        );
        await expect(
          db.query(
            `INSERT INTO digest_extracts (agent_id, tier, content, generated_at)
             VALUES ('c1', 1500, 'updated context', 1001)`,
          ),
        ).rejects.toThrow();
      });

      it('enforces compound primary key on agent_state', async () => {
        await createSchema(db);
        await db.query(
          `INSERT INTO agents (id, name, created_at) VALUES ('c1', 'Test', 1000)`,
        );
        await db.query(
          `INSERT INTO agent_state (agent_id, key, value, updated_at)
           VALUES ('c1', 'cursor', '42', 1000)`,
        );
        await expect(
          db.query(
            `INSERT INTO agent_state (agent_id, key, value, updated_at)
             VALUES ('c1', 'cursor', '43', 1001)`,
          ),
        ).rejects.toThrow();
      });
    });

    describe('timestamp convention', () => {
      it('stores timestamps as integers (Unix epoch)', async () => {
        await createSchema(db);
        const cols = await getColumns(db, 'sessions');
        const startedAt = cols.find((c) => c.column_name === 'started_at');
        const createdAt = cols.find((c) => c.column_name === 'created_at');
        // PGlite reports INTEGER as 'integer'
        expect(startedAt?.data_type).toBe('integer');
        expect(createdAt?.data_type).toBe('integer');
      });
    });
  });
});
