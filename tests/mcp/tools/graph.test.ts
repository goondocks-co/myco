/**
 * Tests for myco_graph tool handler.
 *
 * In Phase 1, the entities/edges tables are empty. The handler
 * returns empty results gracefully.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { handleMycoGraph } from '@myco/mcp/tools/graph.js';

describe('myco_graph', () => {
  beforeEach(async () => {
    const db = await initDatabase();
    await createSchema(db);
  });

  afterEach(async () => {
    await closeDatabase();
  });

  it('returns empty results for unknown note', async () => {
    const result = await handleMycoGraph({ note_id: 'nonexistent' });
    expect(result.note_id).toBe('nonexistent');
    expect(result.edges).toEqual([]);
    expect(result.entities).toEqual([]);
  });

  it('accepts direction parameter', async () => {
    const result = await handleMycoGraph({
      note_id: 'test-note',
      direction: 'outgoing',
    });
    expect(result.edges).toEqual([]);
  });

  it('accepts depth parameter', async () => {
    const result = await handleMycoGraph({
      note_id: 'test-note',
      depth: 2,
    });
    expect(result.edges).toEqual([]);
  });
});
