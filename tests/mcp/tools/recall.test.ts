/**
 * Tests for myco_recall tool handler.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { upsertPlan } from '@myco/db/queries/plans.js';
import { insertSpore } from '@myco/db/queries/spores.js';
import { registerCurator } from '@myco/db/queries/curators.js';
import { handleMycoRecall } from '@myco/mcp/tools/recall.js';

const epochNow = () => Math.floor(Date.now() / 1000);

describe('myco_recall', () => {
  beforeEach(async () => {
    const db = await initDatabase();
    await createSchema(db);

    const now = epochNow();

    await registerCurator({
      id: 'test-curator', name: 'Test Curator', created_at: now,
    });

    await upsertSession({
      id: 'sess-1', agent: 'claude-code', started_at: now,
      created_at: now, title: 'Auth Session',
    });

    await upsertPlan({
      id: 'plan-auth', title: 'Auth Redesign', status: 'active',
      created_at: now,
    });

    await insertSpore({
      id: 'gotcha-abc', curator_id: 'test-curator',
      observation_type: 'gotcha', content: 'CORS strips headers',
      created_at: now,
    });
  });

  afterEach(async () => {
    await closeDatabase();
  });

  it('recalls a session by ID', async () => {
    const result = await handleMycoRecall({ note_id: 'sess-1' });
    expect(result.type).toBe('session');
    expect(result.id).toBe('sess-1');
  });

  it('recalls a plan by ID', async () => {
    const result = await handleMycoRecall({ note_id: 'plan-auth' });
    expect(result.type).toBe('plan');
    expect(result.id).toBe('plan-auth');
  });

  it('recalls a spore by ID', async () => {
    const result = await handleMycoRecall({ note_id: 'gotcha-abc' });
    expect(result.type).toBe('spore');
    expect(result.id).toBe('gotcha-abc');
  });

  it('returns error for unknown ID', async () => {
    const result = await handleMycoRecall({ note_id: 'nonexistent' });
    expect(result.error).toBeDefined();
  });
});
