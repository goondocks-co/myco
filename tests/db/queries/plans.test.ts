/**
 * Tests for plan CRUD query helpers.
 *
 * Each test initializes an in-memory PGlite instance, creates the schema,
 * exercises the query function, and tears down the database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import {
  upsertPlan,
  getPlan,
  listPlans,
} from '@myco/db/queries/plans.js';
import type { PlanInsert } from '@myco/db/queries/plans.js';

/** Epoch seconds helper. */
const epochNow = () => Math.floor(Date.now() / 1000);

/** Factory for minimal valid plan data. */
function makePlan(overrides: Partial<PlanInsert> = {}): PlanInsert {
  const now = epochNow();
  return {
    id: `plan-${Math.random().toString(36).slice(2, 8)}`,
    created_at: now,
    ...overrides,
  };
}

describe('plan query helpers', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await cleanTestDb(); });

  // ---------------------------------------------------------------------------
  // upsertPlan + getPlan
  // ---------------------------------------------------------------------------

  describe('upsertPlan', () => {
    it('inserts a new plan and retrieves it', async () => {
      const data = makePlan({ title: 'Migration plan' });
      const row = await upsertPlan(data);

      expect(row.id).toBe(data.id);
      expect(row.title).toBe('Migration plan');
      expect(row.status).toBe('active');
      expect(row.processed).toBe(0);

      const fetched = await getPlan(data.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(data.id);
      expect(fetched!.title).toBe('Migration plan');
    });

    it('stores all optional fields', async () => {
      const data = makePlan({
        title: 'Full plan',
        author: 'chris',
        content: '## Steps\n1. Do thing\n2. Do other thing',
        source_path: 'plans/migration.md',
        tags: 'v2,migration',
        status: 'draft',
      });
      const row = await upsertPlan(data);

      expect(row.author).toBe('chris');
      expect(row.content).toBe('## Steps\n1. Do thing\n2. Do other thing');
      expect(row.source_path).toBe('plans/migration.md');
      expect(row.tags).toBe('v2,migration');
      expect(row.status).toBe('draft');
    });

    it('is idempotent — second upsert updates without error', async () => {
      const data = makePlan({ title: 'Original' });
      await upsertPlan(data);
      await upsertPlan({ ...data, title: 'Updated' });

      const row = await getPlan(data.id);
      expect(row).not.toBeNull();
      expect(row!.title).toBe('Updated');
    });

    it('updates status on conflict', async () => {
      const data = makePlan({ title: 'Plan', status: 'active' });
      await upsertPlan(data);

      await upsertPlan({ ...data, status: 'completed' });

      const row = await getPlan(data.id);
      expect(row!.status).toBe('completed');
    });

    it('sets updated_at on conflict update', async () => {
      const now = epochNow();
      const data = makePlan({ created_at: now });
      await upsertPlan(data);

      const later = now + 60;
      await upsertPlan({ ...data, title: 'Changed', updated_at: later });

      const row = await getPlan(data.id);
      expect(row!.updated_at).toBe(later);
    });
  });

  // ---------------------------------------------------------------------------
  // getPlan
  // ---------------------------------------------------------------------------

  describe('getPlan', () => {
    it('returns null for non-existent id', async () => {
      const row = await getPlan('does-not-exist');
      expect(row).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // listPlans
  // ---------------------------------------------------------------------------

  describe('listPlans', () => {
    it('returns plans ordered by created_at DESC', async () => {
      const now = epochNow();
      await upsertPlan(makePlan({ id: 'plan-old', created_at: now - 100 }));
      await upsertPlan(makePlan({ id: 'plan-mid', created_at: now - 50 }));
      await upsertPlan(makePlan({ id: 'plan-new', created_at: now }));

      const rows = await listPlans();
      expect(rows).toHaveLength(3);
      expect(rows[0].id).toBe('plan-new');
      expect(rows[1].id).toBe('plan-mid');
      expect(rows[2].id).toBe('plan-old');
    });

    it('filters by status', async () => {
      const now = epochNow();
      await upsertPlan(makePlan({ id: 'plan-active', status: 'active', created_at: now }));
      await upsertPlan(makePlan({ id: 'plan-done', status: 'completed', created_at: now + 1 }));
      await upsertPlan(makePlan({ id: 'plan-draft', status: 'draft', created_at: now + 2 }));

      const rows = await listPlans({ status: 'active' });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('plan-active');
    });

    it('respects the limit option', async () => {
      const now = epochNow();
      for (let i = 0; i < 5; i++) {
        await upsertPlan(makePlan({ created_at: now + i }));
      }

      const rows = await listPlans({ limit: 2 });
      expect(rows).toHaveLength(2);
    });

    it('combines status and limit filters', async () => {
      const now = epochNow();
      for (let i = 0; i < 5; i++) {
        await upsertPlan(makePlan({ status: 'active', created_at: now + i }));
      }
      await upsertPlan(makePlan({ status: 'completed', created_at: now + 10 }));

      const rows = await listPlans({ status: 'active', limit: 3 });
      expect(rows).toHaveLength(3);
      // All should be active
      for (const row of rows) {
        expect(row.status).toBe('active');
      }
    });

    it('returns empty array when no plans match', async () => {
      const rows = await listPlans({ status: 'nonexistent' });
      expect(rows).toEqual([]);
    });

    it('returns empty array when no plans exist', async () => {
      const rows = await listPlans();
      expect(rows).toEqual([]);
    });
  });
});
