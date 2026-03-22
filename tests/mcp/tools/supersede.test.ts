/**
 * Tests for myco_supersede tool handler.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { insertSpore, getSpore } from '@myco/db/queries/spores.js';
import { registerCurator } from '@myco/db/queries/curators.js';
import { handleMycoSupersede } from '@myco/mcp/tools/supersede.js';

const epochNow = () => Math.floor(Date.now() / 1000);

describe('myco_supersede', () => {
  beforeEach(async () => {
    const db = await initDatabase();
    await createSchema(db);

    const now = epochNow();
    await registerCurator({
      id: 'test-curator', name: 'Test', created_at: now,
    });

    await insertSpore({
      id: 'old-spore', curator_id: 'test-curator',
      observation_type: 'gotcha', content: 'Old gotcha',
      created_at: now,
    });

    await insertSpore({
      id: 'new-spore', curator_id: 'test-curator',
      observation_type: 'gotcha', content: 'Updated gotcha',
      created_at: now + 1,
    });
  });

  afterEach(async () => {
    await closeDatabase();
  });

  it('supersedes a spore and returns success', async () => {
    const result = await handleMycoSupersede({
      old_spore_id: 'old-spore',
      new_spore_id: 'new-spore',
      reason: 'Bug was fixed',
    });

    expect(result.status).toBe('superseded');
    expect(result.old_spore).toBe('old-spore');
    expect(result.new_spore).toBe('new-spore');
  });

  it('marks old spore as superseded in database', async () => {
    await handleMycoSupersede({
      old_spore_id: 'old-spore',
      new_spore_id: 'new-spore',
    });

    const spore = await getSpore('old-spore');
    expect(spore!.status).toBe('superseded');
  });

  it('creates a resolution event', async () => {
    await handleMycoSupersede({
      old_spore_id: 'old-spore',
      new_spore_id: 'new-spore',
      reason: 'Test reason',
    });

    const db = getDatabase();
    const events = await db.query(
      'SELECT * FROM resolution_events WHERE spore_id = $1',
      ['old-spore'],
    );
    expect(events.rows).toHaveLength(1);
    const event = events.rows[0] as Record<string, unknown>;
    expect(event.action).toBe('supersede');
    expect(event.new_spore_id).toBe('new-spore');
    expect(event.reason).toBe('Test reason');
  });

  it('throws on nonexistent spore (FK constraint)', async () => {
    await expect(handleMycoSupersede({
      old_spore_id: 'nonexistent',
      new_spore_id: 'new-spore',
    })).rejects.toThrow();
  });
});
