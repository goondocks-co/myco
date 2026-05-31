/**
 * Shared test database helpers.
 *
 * Each test suite gets a fresh in-memory SQLite database via `setupTestDb()`.
 * `cleanTestDb()` deletes all rows between tests (fast, no re-init).
 * `teardownTestDb()` closes the database after all tests.
 */

import type { Database } from 'bun:sqlite';
import { initDatabase, closeDatabase, getDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';

/** Tables to delete between tests (FK dependency order -- children first). */
const DELETE_TABLES = [
  'skill_lineage',
  'skill_usage',
  'skill_records',
  'skill_candidates',
  'migration_import_journal',
  'agent_run_write_intents',
  'digest_extract_revisions',
  'agent_turns',
  'agent_reports',
  'agent_state',
  'agent_runs',
  'agent_tasks',
  'resolution_events',
  'entity_mentions',
  'graph_edges',
  'entities',
  'digest_extracts',
  'cortex_instructions',
  'canopy_maps',
  'canopy_entries',
  'attachments',
  'session_myco_tool_calls',
  'activities',
  'spores',
  'plans',
  'knowledge_release_state',
  'knowledge_git_provenance',
  'prompt_batches',
  'artifacts',
  'team_members',
  'team_outbox',
  'team_sync_state',
  'notifications',
  'sessions',
  'agents',
  'log_entries',
  'migration_tasks',
];

/**
 * FTS5 external-content virtual tables.
 * These cannot use plain DELETE — we drop and recreate them instead.
 */
const FTS_DDL = [
  {
    name: 'prompt_batches_fts',
    ddl: `CREATE VIRTUAL TABLE IF NOT EXISTS prompt_batches_fts
          USING fts5(user_prompt, response_summary, content='prompt_batches', content_rowid='id')`,
  },
  {
    name: 'activities_fts',
    ddl: `CREATE VIRTUAL TABLE IF NOT EXISTS activities_fts
          USING fts5(tool_name, tool_input, file_path, content='activities', content_rowid='id')`,
  },
  {
    name: 'log_entries_fts',
    ddl: `CREATE VIRTUAL TABLE IF NOT EXISTS log_entries_fts
          USING fts5(message, content='log_entries', content_rowid='id')`,
  },
  {
    name: 'spores_fts',
    ddl: `CREATE VIRTUAL TABLE IF NOT EXISTS spores_fts
          USING fts5(content, content='spores', content_rowid='rowid')`,
  },
  {
    name: 'sessions_fts',
    ddl: `CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts
          USING fts5(title, summary, content='sessions', content_rowid='rowid')`,
  },
];

/**
 * Initialize the test database once per suite.
 * Call in `beforeAll`.
 */
export function setupTestDb() {
  const db = initDatabase(); // in-memory
  createSchema(db);
  return db;
}

/**
 * Delete all rows between tests.
 * Call in `beforeEach`.
 */
export function cleanTestDb() {
  const db = getDatabase();
  // Delete regular table data (children first for FK ordering)
  for (const table of DELETE_TABLES) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  // Drop and recreate FTS5 external-content tables (plain DELETE is not supported)
  for (const fts of FTS_DDL) {
    db.exec(`DROP TABLE IF EXISTS ${fts.name}`);
    db.exec(fts.ddl);
  }
}

/**
 * Close the test database after all tests in a suite.
 * Call in `afterAll`.
 */
export function teardownTestDb() {
  closeDatabase();
}

/* ---------- canopy_entries seed helper ---------- */

/**
 * Inputs for `seedCanopyEntry`. All fields are optional except `path` so
 * tests can assert against minimal fixtures. Sensible defaults match what
 * the real canopy scanner writes for a typical row (project_id='p',
 * machine_id='local', content_hash='h', etc.).
 */
export interface CanopyEntrySeed {
  project_id?: string;
  machine_id?: string;
  path: string;
  content_hash?: string;
  size_bytes?: number;
  token_estimate?: number;
  line_count?: number;
  language?: string | null;
  exports_json?: string | null;
  imports_json?: string | null;
  top_comment?: string | null;
  mechanical_updated_at?: number;
  llm_description?: string | null;
  llm_updated_at?: number | null;
  embedded?: 0 | 1;
}

/**
 * Insert a single row into `canopy_entries` with sensible defaults. Keeps
 * the four canopy test files from drifting on column order or default
 * values. Migration tests in `tests/db/canopy-embedded-migration.test.ts`
 * deliberately bypass this helper because they exercise the schema chain
 * directly.
 */
export function seedCanopyEntry(db: Database, seed: CanopyEntrySeed): void {
  db.prepare(
    `INSERT INTO canopy_entries
       (project_id, machine_id, path, content_hash, size_bytes, token_estimate,
        line_count, language, exports_json, imports_json, top_comment,
        mechanical_updated_at, llm_description, llm_updated_at, embedded)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    seed.project_id ?? 'p',
    seed.machine_id ?? 'local',
    seed.path,
    seed.content_hash ?? 'h',
    seed.size_bytes ?? 1,
    seed.token_estimate ?? 1,
    seed.line_count ?? 1,
    seed.language ?? null,
    seed.exports_json ?? null,
    seed.imports_json ?? null,
    seed.top_comment ?? null,
    seed.mechanical_updated_at ?? 1,
    seed.llm_description ?? null,
    seed.llm_updated_at ?? null,
    seed.embedded ?? 0,
  );
}
