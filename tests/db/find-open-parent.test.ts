import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { insertBatchStateless, findOpenParentBatch } from '@myco/db/queries/batches.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { getDatabase } from '@myco/db/client.js';

const now = () => Math.floor(Date.now() / 1000);

describe('findOpenParentBatch', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(teardownTestDb);

  beforeEach(() => {
    cleanTestDb();
    upsertSession({ id: 's1', agent: 'claude-code', started_at: now(), created_at: now(), status: 'active' });
  });

  it('returns null when no batches exist', () => {
    expect(findOpenParentBatch('s1')).toBeNull();
  });

  it('returns the open initial batch', () => {
    const b = insertBatchStateless({ session_id: 's1', created_at: now(), kind: 'initial' });
    const found = findOpenParentBatch('s1');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(b.id);
    expect(found!.kind).toBe('initial');
  });

  it('returns null when the batch is closed (ended_at set)', () => {
    const b = insertBatchStateless({ session_id: 's1', created_at: now(), kind: 'initial' });
    const db = getDatabase();
    db.prepare(`UPDATE prompt_batches SET ended_at = ? WHERE id = ?`).run(now(), b.id);
    expect(findOpenParentBatch('s1')).toBeNull();
  });

  it('returns the parent, never a steering child', () => {
    const parent = insertBatchStateless({ session_id: 's1', created_at: now(), kind: 'initial' });
    insertBatchStateless({
      session_id: 's1',
      created_at: now(),
      kind: 'steering',
      parent_prompt_batch_id: parent.id,
    });
    const found = findOpenParentBatch('s1');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(parent.id);
    expect(found!.kind).toBe('initial');
  });
});
