/**
 * Shared test database helpers.
 *
 * Each test suite gets a fresh in-memory SQLite database via `setupTestDb()`.
 * `cleanTestDb()` deletes all rows between tests (fast, no re-init).
 * `teardownTestDb()` closes the database after all tests.
 */

import { initDatabase, closeDatabase, getDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';

/** Tables to delete between tests (FK dependency order -- children first). */
const DELETE_TABLES = [
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
  'attachments',
  'activities',
  'spores',
  'plans',
  'prompt_batches',
  'artifacts',
  'team_members',
  'sessions',
  'agents',
];

/**
 * FTS5 external-content virtual tables.
 * These cannot use plain DELETE — we drop and recreate them instead.
 */
const FTS_DDL = [
  {
    name: 'prompt_batches_fts',
    ddl: `CREATE VIRTUAL TABLE IF NOT EXISTS prompt_batches_fts
          USING fts5(user_prompt, content='prompt_batches', content_rowid='id')`,
  },
  {
    name: 'activities_fts',
    ddl: `CREATE VIRTUAL TABLE IF NOT EXISTS activities_fts
          USING fts5(tool_name, tool_input, file_path, content='activities', content_rowid='id')`,
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
