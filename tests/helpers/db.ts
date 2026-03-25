/**
 * Shared test database helpers.
 *
 * Provides a fast setup/teardown pattern for tests that need PGlite:
 * - `setupTestDb()` in beforeAll — creates DB + schema once per suite
 * - `cleanTestDb()` in beforeEach — truncates all tables (fast, no re-init)
 * - `teardownTestDb()` in afterAll — closes the DB
 *
 * This replaces the per-test initDatabase()/createSchema()/closeDatabase()
 * pattern which was creating a fresh PGlite instance for every single test.
 */

import { initDatabase, closeDatabase, getDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';

/** Tables to truncate between tests (order matters for FK constraints). */
const TRUNCATE_TABLES = [
  'agent_turns',
  'agent_reports',
  'agent_state',
  'agent_runs',
  'agent_tasks',
  'resolution_events',
  'entity_mentions',
  'graph_edges',
  'edges',
  'entities',
  'digest_extracts',
  'attachments',
  'activities',
  'spores',
  'prompt_batches',
  'plans',
  'artifacts',
  'team_members',
  'sessions',
  'agents',
];

/**
 * Initialize the test database once per suite.
 * Call in `beforeAll`.
 */
export async function setupTestDb() {
  const db = await initDatabase();
  await createSchema(db);
  return db;
}

/**
 * Truncate all tables between tests.
 * Call in `beforeEach` — much faster than re-creating the DB.
 */
export async function cleanTestDb() {
  const db = getDatabase();
  // TRUNCATE CASCADE handles FK constraints in one statement
  await db.query(`TRUNCATE ${TRUNCATE_TABLES.join(', ')} CASCADE`);
}

/**
 * Close the test database after all tests in a suite.
 * Call in `afterAll`.
 */
export async function teardownTestDb() {
  await closeDatabase();
}
