import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { handleUserPrompt } from '@myco/daemon/event-handlers.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertActivityWithBatch } from '@myco/db/queries/activities.js';

const now = () => Math.floor(Date.now() / 1000);

describe('activity routing under steering nesting', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(teardownTestDb);

  beforeEach(() => {
    cleanTestDb();
    upsertSession({ id: 's1', agent: 'claude-code', started_at: now(), created_at: now(), status: 'active' });
  });

  it('activity attaches to steering child batch when both parent and child are open', () => {
    const { batchId: parentId } = handleUserPrompt('s1', 'initial prompt', { kind: 'initial' });
    const { batchId: childId } = handleUserPrompt('s1', 'steer me', { kind: 'steering' });

    const activity = insertActivityWithBatch({
      session_id: 's1',
      tool_name: 'Read',
      timestamp: now(),
      created_at: now(),
    });

    // Should attach to the most recently opened batch (the child)
    expect(activity.prompt_batch_id).toBe(childId);
    expect(activity.prompt_batch_id).not.toBe(parentId);
  });

  it('activity attaches to the parent batch when only the parent is open', () => {
    const { batchId: parentId } = handleUserPrompt('s1', 'initial prompt', { kind: 'initial' });

    const activity = insertActivityWithBatch({
      session_id: 's1',
      tool_name: 'Write',
      timestamp: now(),
      created_at: now(),
    });

    // No child exists — should attach to the only open batch (the parent)
    expect(activity.prompt_batch_id).toBe(parentId);
  });
});
