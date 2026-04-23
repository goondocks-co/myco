import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { nowSec, seedSession } from '../helpers/sessions.js';
import { insertBatchStateless } from '@myco/db/queries/batches.js';

describe('insertBatchStateless with steering fields', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(teardownTestDb);

  beforeEach(() => {
    cleanTestDb();
    seedSession({ id: 's1' });
  });

  it('defaults kind to "initial" and parent to null', () => {
    const b = insertBatchStateless({ session_id: 's1', created_at: nowSec() });
    expect(b.kind).toBe('initial');
    expect(b.parent_prompt_batch_id).toBeNull();
  });

  it('accepts explicit kind and parent_prompt_batch_id', () => {
    const parent = insertBatchStateless({ session_id: 's1', created_at: nowSec() });
    const child = insertBatchStateless({
      session_id: 's1',
      created_at: nowSec(),
      kind: 'steering',
      parent_prompt_batch_id: parent.id,
    });
    expect(child.kind).toBe('steering');
    expect(child.parent_prompt_batch_id).toBe(parent.id);
  });
});
