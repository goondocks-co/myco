import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { nowSec, seedSession } from '../helpers/sessions.js';
import { insertBatchStateless, findOpenParentBatch } from '@myco/db/queries/batches.js';
import { getDatabase } from '@myco/db/client.js';

describe('findOpenParentBatch', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(teardownTestDb);

  beforeEach(() => {
    cleanTestDb();
    seedSession({ id: 's1' });
  });

  it('returns null when no batches exist', () => {
    expect(findOpenParentBatch('s1')).toBeNull();
  });

  it('returns the open initial batch', () => {
    const { row: b } = insertBatchStateless({ session_id: 's1', created_at: nowSec(), kind: 'initial' });
    const found = findOpenParentBatch('s1');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(b.id);
    expect(found!.kind).toBe('initial');
  });

  it('returns null when the batch is closed (ended_at set)', () => {
    const { row: b } = insertBatchStateless({ session_id: 's1', created_at: nowSec(), kind: 'initial' });
    const db = getDatabase();
    db.prepare(`UPDATE prompt_batches SET ended_at = ? WHERE id = ?`).run(nowSec(), b.id);
    expect(findOpenParentBatch('s1')).toBeNull();
  });

  it('returns the parent, never a steering child', () => {
    const { row: parent } = insertBatchStateless({ session_id: 's1', created_at: nowSec(), kind: 'initial' });
    insertBatchStateless({
      session_id: 's1',
      created_at: nowSec(),
      kind: 'steering',
      parent_prompt_batch_id: parent.id,
    });
    const found = findOpenParentBatch('s1');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(parent.id);
    expect(found!.kind).toBe('initial');
  });
});
