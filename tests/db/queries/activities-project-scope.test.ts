import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import { insertActivity, listActivitiesByBatch } from '@myco/db/queries/activities.js';
import { insertBatch } from '@myco/db/queries/batches.js';
import { upsertSession } from '@myco/db/queries/sessions.js';

const PROJECT_A = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PROJECT_B = 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('activity query project scope', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('filters batch activity reads through the owning batch project', () => {
    upsertSession({ id: 'sess-a', project_id: PROJECT_A, agent: 'codex', started_at: 10, created_at: 10 });
    upsertSession({ id: 'sess-b', project_id: PROJECT_B, agent: 'codex', started_at: 10, created_at: 10 });
    const batchA = insertBatch({ session_id: 'sess-a', project_id: PROJECT_A, prompt_number: 1, created_at: 10 });
    const batchB = insertBatch({ session_id: 'sess-b', project_id: PROJECT_B, prompt_number: 1, created_at: 10 });
    insertActivity({
      session_id: 'sess-a',
      prompt_batch_id: batchA.id,
      tool_name: 'Edit',
      timestamp: 11,
      created_at: 11,
    });
    insertActivity({
      session_id: 'sess-b',
      prompt_batch_id: batchB.id,
      tool_name: 'Write',
      timestamp: 12,
      created_at: 12,
    });

    expect(listActivitiesByBatch(batchA.id, { project_id: PROJECT_A }).map((row) => row.tool_name)).toEqual(['Edit']);
    expect(listActivitiesByBatch(batchA.id, { project_id: PROJECT_B })).toEqual([]);
  });
});
