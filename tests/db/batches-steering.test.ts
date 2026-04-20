import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { insertBatchStateless } from '@myco/db/queries/batches.js';
import { upsertSession } from '@myco/db/queries/sessions.js';

const now = () => Math.floor(Date.now() / 1000);

describe('insertBatchStateless with steering fields', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(teardownTestDb);

  beforeEach(() => {
    cleanTestDb();
    upsertSession({ id: 's1', agent: 'claude-code', started_at: now(), created_at: now(), status: 'active' });
  });

  it('defaults kind to "initial" and parent to null', () => {
    const b = insertBatchStateless({ session_id: 's1', created_at: now() });
    expect(b.kind).toBe('initial');
    expect(b.parent_prompt_batch_id).toBeNull();
  });

  it('accepts explicit kind and parent_prompt_batch_id', () => {
    const parent = insertBatchStateless({ session_id: 's1', created_at: now() });
    const child = insertBatchStateless({
      session_id: 's1',
      created_at: now(),
      kind: 'steering',
      parent_prompt_batch_id: parent.id,
    });
    expect(child.kind).toBe('steering');
    expect(child.parent_prompt_batch_id).toBe(parent.id);
  });
});
