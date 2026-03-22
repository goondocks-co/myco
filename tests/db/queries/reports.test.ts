/**
 * Tests for agent report CRUD query helpers.
 *
 * Each test initializes an in-memory PGlite instance, creates the schema,
 * exercises the query function, and tears down the database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { registerCurator } from '@myco/db/queries/curators.js';
import { insertRun } from '@myco/db/queries/runs.js';
import {
  insertReport,
  listReports,
  listReportsByCurator,
} from '@myco/db/queries/reports.js';
import type { ReportInsert } from '@myco/db/queries/reports.js';

/** Epoch seconds helper. */
const epochNow = () => Math.floor(Date.now() / 1000);

/** Shared curator and run IDs used across tests. */
const TEST_CURATOR_ID = 'curator-reports-test';
const TEST_RUN_ID = 'run-reports-test';

/** Factory for minimal valid report data. */
function makeReport(overrides: Partial<ReportInsert> = {}): ReportInsert {
  return {
    run_id: TEST_RUN_ID,
    curator_id: TEST_CURATOR_ID,
    action: 'write_spore',
    summary: 'Created a new spore',
    created_at: epochNow(),
    ...overrides,
  };
}

describe('report query helpers', () => {
  beforeEach(async () => {
    const db = await initDatabase();
    await createSchema(db);
    // Insert FK targets
    await registerCurator({
      id: TEST_CURATOR_ID,
      name: 'Test Curator',
      created_at: epochNow(),
    });
    await insertRun({
      id: TEST_RUN_ID,
      curator_id: TEST_CURATOR_ID,
      started_at: epochNow(),
    });
  });

  afterEach(async () => {
    await closeDatabase();
  });

  // ---------------------------------------------------------------------------
  // insertReport
  // ---------------------------------------------------------------------------

  describe('insertReport', () => {
    it('inserts a report and returns it with auto-generated id', async () => {
      const data = makeReport();
      const row = await insertReport(data);

      expect(typeof row.id).toBe('number');
      expect(row.run_id).toBe(TEST_RUN_ID);
      expect(row.curator_id).toBe(TEST_CURATOR_ID);
      expect(row.action).toBe('write_spore');
      expect(row.summary).toBe('Created a new spore');
      expect(row.details).toBeNull();
      expect(row.created_at).toBe(data.created_at);
    });

    it('stores details as JSON string', async () => {
      const details = JSON.stringify({ spore_id: 'spore-abc', type: 'gotcha' });
      const data = makeReport({ details });
      const row = await insertReport(data);

      expect(row.details).toBe(details);
    });
  });

  // ---------------------------------------------------------------------------
  // listReports
  // ---------------------------------------------------------------------------

  describe('listReports', () => {
    it('returns reports for a run ordered by created_at ASC', async () => {
      const now = epochNow();
      await insertReport(makeReport({ summary: 'First', created_at: now - 20 }));
      await insertReport(makeReport({ summary: 'Second', created_at: now - 10 }));
      await insertReport(makeReport({ summary: 'Third', created_at: now }));

      const rows = await listReports(TEST_RUN_ID);
      expect(rows).toHaveLength(3);
      expect(rows[0].summary).toBe('First');
      expect(rows[1].summary).toBe('Second');
      expect(rows[2].summary).toBe('Third');
    });

    it('returns empty array for run with no reports', async () => {
      const rows = await listReports('no-such-run');
      expect(rows).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // listReportsByCurator
  // ---------------------------------------------------------------------------

  describe('listReportsByCurator', () => {
    it('returns reports by curator ordered by created_at DESC', async () => {
      const now = epochNow();
      await insertReport(makeReport({ summary: 'Old', created_at: now - 100 }));
      await insertReport(makeReport({ summary: 'New', created_at: now }));

      const rows = await listReportsByCurator(TEST_CURATOR_ID);
      expect(rows).toHaveLength(2);
      expect(rows[0].summary).toBe('New');
      expect(rows[1].summary).toBe('Old');
    });

    it('respects limit', async () => {
      const now = epochNow();
      await insertReport(makeReport({ created_at: now - 2 }));
      await insertReport(makeReport({ created_at: now - 1 }));
      await insertReport(makeReport({ created_at: now }));

      const rows = await listReportsByCurator(TEST_CURATOR_ID, { limit: 2 });
      expect(rows).toHaveLength(2);
    });

    it('returns empty array for curator with no reports', async () => {
      const rows = await listReportsByCurator('no-such-curator');
      expect(rows).toEqual([]);
    });
  });
});
