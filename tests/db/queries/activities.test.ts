/**
 * Tests for activity query helpers.
 *
 * Each test initializes an in-memory PGlite instance, creates the schema,
 * exercises the query function, and tears down the database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertBatch } from '@myco/db/queries/batches.js';
import type { SessionInsert } from '@myco/db/queries/sessions.js';
import type { BatchInsert } from '@myco/db/queries/batches.js';
import {
  insertActivity,
  insertActivityWithBatch,
  listActivities,
  countActivities,
} from '@myco/db/queries/activities.js';
import type { ActivityInsert } from '@myco/db/queries/activities.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

/** Epoch seconds helper. */
const epochNow = () => Math.floor(Date.now() / 1000);

/** Factory for minimal valid session data. */
function makeSession(overrides: Partial<SessionInsert> = {}): SessionInsert {
  const now = epochNow();
  return {
    id: `sess-${Math.random().toString(36).slice(2, 8)}`,
    agent: 'claude-code',
    started_at: now,
    created_at: now,
    ...overrides,
  };
}

/** Factory for minimal valid batch data. */
function makeBatch(sessionId: string, overrides: Partial<BatchInsert> = {}): BatchInsert {
  const now = epochNow();
  return {
    session_id: sessionId,
    started_at: now,
    created_at: now,
    ...overrides,
  };
}

/** Factory for minimal valid activity data. Tests that need a specific
 *  batch override this; otherwise the surrounding describe binds
 *  `defaultBatchId` (set in beforeEach) for the activity FK. */
function makeActivity(
  sessionId: string,
  overrides: Partial<ActivityInsert> = {},
): ActivityInsert {
  const now = epochNow();
  return {
    session_id: sessionId,
    tool_name: 'Read',
    timestamp: now,
    created_at: now,
    prompt_batch_id: defaultBatchIdOrNull(),
    ...overrides,
  };
}

// Lazy lookup so the helper compiles before the describe block runs.
let _defaultBatchId: number | null = null;
function setDefaultBatchId(id: number | null) { _defaultBatchId = id; }
function defaultBatchIdOrNull() { return _defaultBatchId; }

describe('activity query helpers', () => {
  let sessionId: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();

    const session = makeSession();
    upsertSession(session);
    sessionId = session.id;

    // v43 invariant: activities.prompt_batch_id is NOT NULL. Tests that
    // don't explicitly set a batch_id receive this default via makeActivity().
    const batch = insertBatch(makeBatch(sessionId));
    setDefaultBatchId(batch.id);
  });
  afterEach(() => { setDefaultBatchId(null); });

  // ---------------------------------------------------------------------------
  // insertActivity
  // ---------------------------------------------------------------------------

  describe('insertActivity', () => {
    it('inserts a new activity and returns it with a generated id', () => {
      const data = makeActivity(sessionId, { tool_name: 'Bash' });
      const row = insertActivity(data);

      expect(row.id).toBeGreaterThan(0);
      expect(row.session_id).toBe(sessionId);
      expect(row.tool_name).toBe('Bash');
      expect(row.success).toBe(1);
      expect(row.processed).toBe(0);
    });

    it('stores all optional fields', () => {
      const data = makeActivity(sessionId, {
        tool_name: 'Edit',
        tool_input: '{"file": "src/main.ts"}',
        tool_output_summary: 'File edited successfully',
        file_path: 'src/main.ts',
        files_affected: 'src/main.ts,src/util.ts',
        duration_ms: 150,
        success: 0,
        error_message: 'Permission denied',
        content_hash: 'abc123',
      });
      const row = insertActivity(data);

      expect(row.tool_input).toBe('{"file": "src/main.ts"}');
      expect(row.tool_output_summary).toBe('File edited successfully');
      expect(row.file_path).toBe('src/main.ts');
      expect(row.files_affected).toBe('src/main.ts,src/util.ts');
      expect(row.duration_ms).toBe(150);
      expect(row.success).toBe(0);
      expect(row.error_message).toBe('Permission denied');
      expect(row.content_hash).toBe('abc123');
    });

    it('links to a prompt batch via prompt_batch_id', () => {
      const batch = insertBatch(makeBatch(sessionId));
      const data = makeActivity(sessionId, { prompt_batch_id: batch.id });
      const row = insertActivity(data);

      expect(row.prompt_batch_id).toBe(batch.id);
    });

    it('stores an explicit project_id', () => {
      const row = insertActivity(makeActivity(sessionId, { project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }));

      expect(row.project_id).toBe('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    });

    it('derives project_id from the session for stateless inserts', () => {
      const scopedSession = makeSession({ id: 'sess-project-a', project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
      upsertSession(scopedSession);
      insertBatch(makeBatch(scopedSession.id));

      const row = insertActivityWithBatch(makeActivity(scopedSession.id));

      expect(row.project_id).toBe('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    });

    it('links activity to the open batch when one exists', () => {
      // Fresh session — no default batch from beforeEach() applies here.
      const session = makeSession({ id: 'sess-open-batch-link' });
      upsertSession(session);
      const openBatch = insertBatch(makeBatch(session.id));
      const row = insertActivityWithBatch(makeActivity(session.id));
      expect(row.prompt_batch_id).toBe(openBatch.id);
    });

    it('falls back to the most-recent closed batch when no batch is open', () => {
      const session = makeSession({ id: 'sess-closed-fallback' });
      upsertSession(session);
      const earlier = insertBatch(makeBatch(session.id, { started_at: epochNow() - 10 }));
      const latest = insertBatch(makeBatch(session.id, { started_at: epochNow() }));
      const { getDatabase } = require('@myco/db/client.js');
      const db = getDatabase();
      db.prepare('UPDATE prompt_batches SET ended_at = ? WHERE id = ?').run(epochNow(), earlier.id);
      db.prepare('UPDATE prompt_batches SET ended_at = ? WHERE id = ?').run(epochNow(), latest.id);

      const row = insertActivityWithBatch(makeActivity(session.id));
      // Falls back to the highest-id closed batch (= `latest`),
      // preserving "attach to the turn that just ended."
      expect(row.prompt_batch_id).toBe(latest.id);
    });

    it('throws on NOT NULL FK when the session has zero batches (caller must ensureOpenBatch first)', () => {
      // The v43 invariant forbids NULL prompt_batch_id. Callers in the
      // event-handlers module use ensureOpenBatch() to fabricate a row
      // before insert when the session truly has no batches yet.
      const session = makeSession({ id: 'sess-no-batches' });
      upsertSession(session);
      expect(() => insertActivityWithBatch(makeActivity(session.id))).toThrow(/NOT NULL constraint failed/);
    });
  });

  // ---------------------------------------------------------------------------
  // listActivities
  // ---------------------------------------------------------------------------

  describe('listActivities', () => {
    it('lists activities by session_id ordered by timestamp ASC', () => {
      const now = epochNow();
      insertActivity(makeActivity(sessionId, { tool_name: 'Read', timestamp: now }));
      insertActivity(makeActivity(sessionId, { tool_name: 'Edit', timestamp: now + 1 }));
      insertActivity(makeActivity(sessionId, { tool_name: 'Bash', timestamp: now + 2 }));

      const rows = listActivities({ session_id: sessionId, scope: ALL_PROJECTS_SCOPE });
      expect(rows).toHaveLength(3);
      expect(rows[0].tool_name).toBe('Read');
      expect(rows[1].tool_name).toBe('Edit');
      expect(rows[2].tool_name).toBe('Bash');
    });

    it('filters by prompt_batch_id', () => {
      const batch1 = insertBatch(makeBatch(sessionId));
      const batch2 = insertBatch(makeBatch(sessionId));

      const now = epochNow();
      insertActivity(makeActivity(sessionId, { prompt_batch_id: batch1.id, tool_name: 'Read', timestamp: now }));
      insertActivity(makeActivity(sessionId, { prompt_batch_id: batch2.id, tool_name: 'Edit', timestamp: now + 1 }));
      insertActivity(makeActivity(sessionId, { prompt_batch_id: batch1.id, tool_name: 'Bash', timestamp: now + 2 }));

      const rows = listActivities({ prompt_batch_id: batch1.id, scope: ALL_PROJECTS_SCOPE });
      expect(rows).toHaveLength(2);
      expect(rows[0].tool_name).toBe('Read');
      expect(rows[1].tool_name).toBe('Bash');
    });

    it('combines session_id and prompt_batch_id filters', () => {
      const session2 = makeSession();
      upsertSession(session2);

      const batch = insertBatch(makeBatch(sessionId));

      const now = epochNow();
      insertActivity(makeActivity(sessionId, { prompt_batch_id: batch.id, tool_name: 'Read', timestamp: now }));
      insertActivity(makeActivity(sessionId, { tool_name: 'Edit', timestamp: now + 1 }));

      const rows = listActivities({ session_id: sessionId, prompt_batch_id: batch.id, scope: ALL_PROJECTS_SCOPE });
      expect(rows).toHaveLength(1);
      expect(rows[0].tool_name).toBe('Read');
    });

    it('respects the limit option', () => {
      const now = epochNow();
      for (let i = 0; i < 5; i++) {
        insertActivity(makeActivity(sessionId, { timestamp: now + i }));
      }

      const rows = listActivities({ session_id: sessionId, limit: 2, scope: ALL_PROJECTS_SCOPE });
      expect(rows).toHaveLength(2);
    });

    it('returns empty array when no activities match', () => {
      const rows = listActivities({ session_id: 'nonexistent', scope: ALL_PROJECTS_SCOPE });
      expect(rows).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // countActivities
  // ---------------------------------------------------------------------------

  describe('countActivities', () => {
    it('returns 0 when no activities exist for a session', () => {
      const count = countActivities(sessionId, ALL_PROJECTS_SCOPE);
      expect(count).toBe(0);
    });

    it('counts activities for a specific session', () => {
      const now = epochNow();
      insertActivity(makeActivity(sessionId, { timestamp: now }));
      insertActivity(makeActivity(sessionId, { timestamp: now + 1 }));
      insertActivity(makeActivity(sessionId, { timestamp: now + 2 }));

      const count = countActivities(sessionId, ALL_PROJECTS_SCOPE);
      expect(count).toBe(3);
    });

    it('does not count activities from other sessions', () => {
      const session2 = makeSession();
      upsertSession(session2);

      const now = epochNow();
      insertActivity(makeActivity(sessionId, { timestamp: now }));
      insertActivity(makeActivity(session2.id, { timestamp: now + 1 }));

      const count = countActivities(sessionId, ALL_PROJECTS_SCOPE);
      expect(count).toBe(1);
    });
  });
});
