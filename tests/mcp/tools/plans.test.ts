/**
 * Tests for myco_plans tool handler.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { upsertPlan } from '@myco/db/queries/plans.js';
import { handleMycoPlans } from '@myco/mcp/tools/plans.js';

const epochNow = () => Math.floor(Date.now() / 1000);

describe('myco_plans', () => {
  beforeEach(async () => {
    const db = await initDatabase();
    await createSchema(db);

    const now = epochNow();
    await upsertPlan({
      id: 'auth', title: 'Auth Redesign', status: 'active',
      content: '- [x] Step 1\n- [ ] Step 2', created_at: now - 100,
    });
    await upsertPlan({
      id: 'done', title: 'Completed Plan', status: 'completed',
      content: '- [x] All done', created_at: now - 200,
    });
  });

  afterEach(async () => {
    await closeDatabase();
  });

  it('lists all plans', async () => {
    const results = await handleMycoPlans({});
    expect(results).toHaveLength(2);
  });

  it('filters by status', async () => {
    const results = await handleMycoPlans({ status: 'active' });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('auth');
  });

  it('extracts progress from checklist content', async () => {
    const results = await handleMycoPlans({ status: 'active' });
    expect(results[0].progress).toBe('1/2');
  });

  it('lists all when status is "all"', async () => {
    const results = await handleMycoPlans({ status: 'all' });
    expect(results).toHaveLength(2);
  });
});
