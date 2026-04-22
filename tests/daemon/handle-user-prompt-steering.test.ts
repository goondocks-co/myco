import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { nowSec, seedSession } from '../helpers/sessions.js';
import { handleUserPrompt } from '@myco/daemon/event-handlers.js';
import { listBatchesBySession } from '@myco/db/queries/batches.js';
import { getDatabase } from '@myco/db/client.js';

describe('handleUserPrompt steering nesting', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(teardownTestDb);

  beforeEach(() => {
    cleanTestDb();
    seedSession({ id: 's1' });
  });

  it('creates an initial batch with kind=initial and no parent', () => {
    const { batchId } = handleUserPrompt('s1', 'first', { kind: 'initial' });
    const batches = listBatchesBySession('s1');
    expect(batches).toHaveLength(1);
    expect(batches[0].id).toBe(batchId);
    expect(batches[0].kind).toBe('initial');
    expect(batches[0].parent_prompt_batch_id).toBeNull();
    expect(batches[0].ended_at).toBeNull();
  });

  it('steering creates a child, keeps parent open, parent_prompt_batch_id points at parent', () => {
    const { batchId: parentId } = handleUserPrompt('s1', 'first', { kind: 'initial' });
    const { batchId: childId } = handleUserPrompt('s1', 'steer me', { kind: 'steering' });

    const batches = listBatchesBySession('s1');
    expect(batches).toHaveLength(2);

    const parent = batches.find((b) => b.id === parentId)!;
    const child = batches.find((b) => b.id === childId)!;

    // Parent should still be open
    expect(parent.ended_at).toBeNull();

    // Child should be steering with parent link
    expect(child.kind).toBe('steering');
    expect(child.parent_prompt_batch_id).toBe(parentId);
  });

  it('steering with no open parent falls back to kind=initial with null parent', () => {
    // Close any batches first by sending an initial and then closing it
    const { batchId: firstId } = handleUserPrompt('s1', 'first', { kind: 'initial' });
    const db = getDatabase();
    db.prepare(`UPDATE prompt_batches SET ended_at = ? WHERE id = ?`).run(nowSec(), firstId);

    // Now send steering — no open parent exists
    const { batchId: fallbackId } = handleUserPrompt('s1', 'steer with no parent', { kind: 'steering' });

    const batches = listBatchesBySession('s1');
    const fallback = batches.find((b) => b.id === fallbackId)!;
    expect(fallback.kind).toBe('initial');
    expect(fallback.parent_prompt_batch_id).toBeNull();
  });

  it('backwards-compat: no options still creates a valid initial batch', () => {
    const { batchId } = handleUserPrompt('s1', 'legacy prompt');
    const batches = listBatchesBySession('s1');
    expect(batches).toHaveLength(1);
    expect(batches[0].id).toBe(batchId);
    expect(batches[0].kind).toBe('initial');
    expect(batches[0].parent_prompt_batch_id).toBeNull();
  });
});
