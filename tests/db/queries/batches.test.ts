/**
 * Tests for prompt batch query helpers.
 *
 * Each test initializes an in-memory PGlite instance, creates the schema,
 * exercises the query function, and tears down the database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { upsertSession } from '@myco/db/queries/sessions.js';
import type { SessionInsert } from '@myco/db/queries/sessions.js';
import {
  insertBatch,
  closeBatch,
  countUnprocessedSettledBatches,
  getUnprocessedBatches,
  incrementActivityCount,
  INTELLIGENCE_DEFAULT_ORIGINS,
  listBatchesBySession,
  markBatchProcessed,
  PROMPT_BATCH_ORIGIN,
  setResponseSummary,
} from '@myco/db/queries/batches.js';
import type { BatchInsert } from '@myco/db/queries/batches.js';
import { ALL_PROJECTS_SCOPE, projectScope, type GroveProjectId } from '@myco/grove/ids.js';

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

/** Factory for minimal valid batch data (requires a session_id). */
function makeBatch(sessionId: string, overrides: Partial<BatchInsert> = {}): BatchInsert {
  const now = epochNow();
  return {
    session_id: sessionId,
    started_at: now,
    created_at: now,
    ...overrides,
  };
}

describe('prompt batch query helpers', () => {
  let sessionId: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();

    // Create a parent session for FK references
    const session = makeSession();
    upsertSession(session);
    sessionId = session.id;
  });

  // ---------------------------------------------------------------------------
  // insertBatch
  // ---------------------------------------------------------------------------

  describe('insertBatch', () => {
    it('inserts a new batch and returns it with a generated id', () => {
      const data = makeBatch(sessionId, { user_prompt: 'Hello world' });
      const row = insertBatch(data);

      expect(row.id).toBeGreaterThan(0);
      expect(row.session_id).toBe(sessionId);
      expect(row.user_prompt).toBe('Hello world');
      expect(row.status).toBe('active');
      expect(row.activity_count).toBe(0);
      expect(row.processed).toBe(0);
    });

    it('assigns sequential ids', () => {
      const b1 = insertBatch(makeBatch(sessionId));
      const b2 = insertBatch(makeBatch(sessionId));

      expect(b2.id).toBeGreaterThan(b1.id);
    });

    it('atomically bumps sessions.prompt_count without an explicit caller update', async () => {
      // Single-writer tenet: the insert function owns the cache the
      // column maintains. Three inserts -> session.prompt_count = 3.
      const { getSession } = await import('@myco/db/queries/sessions.js');
      insertBatch(makeBatch(sessionId, { prompt_number: 1 }));
      insertBatch(makeBatch(sessionId, { prompt_number: 2 }));
      insertBatch(makeBatch(sessionId, { prompt_number: 3 }));
      const session = getSession(sessionId, ALL_PROJECTS_SCOPE);
      expect(session?.prompt_count).toBe(3);
    });

    it('atomically bumps sessions.prompt_count via insertBatchStateless too', async () => {
      const { getSession } = await import('@myco/db/queries/sessions.js');
      const { insertBatchStateless } = await import('@myco/db/queries/batches.js');
      const now = epochNow();
      insertBatchStateless({ session_id: sessionId, started_at: now, created_at: now });
      insertBatchStateless({ session_id: sessionId, started_at: now, created_at: now });
      const session = getSession(sessionId, ALL_PROJECTS_SCOPE);
      expect(session?.prompt_count).toBe(2);
    });

    it('stores optional fields', () => {
      const data = makeBatch(sessionId, {
        prompt_number: 3,
        user_prompt: 'What is Myco?',
        response_summary: 'Myco is a knowledge capture system.',
        classification: 'question',
      });
      const row = insertBatch(data);

      expect(row.prompt_number).toBe(3);
      expect(row.user_prompt).toBe('What is Myco?');
      expect(row.response_summary).toBe('Myco is a knowledge capture system.');
      expect(row.classification).toBe('question');
    });

    it('inherits project_id from the parent session when omitted', () => {
      const scopedSession = makeSession({ id: 'sess-project-a', project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
      upsertSession(scopedSession);

      const row = insertBatch(makeBatch(scopedSession.id));

      expect(row.project_id).toBe('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    });
  });

  // ---------------------------------------------------------------------------
  // closeBatch
  // ---------------------------------------------------------------------------

  describe('closeBatch', () => {
    it('sets status to completed and records ended_at', () => {
      const batch = insertBatch(makeBatch(sessionId));
      const endTime = epochNow();
      const row = closeBatch(batch.id, endTime);

      expect(row).not.toBeNull();
      expect(row!.status).toBe('completed');
      expect(row!.ended_at).toBe(endTime);
    });

    it('returns null for non-existent batch', () => {
      const result = closeBatch(999999, epochNow());
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // incrementActivityCount
  // ---------------------------------------------------------------------------

  describe('incrementActivityCount', () => {
    it('increments activity_count by 1', () => {
      const batch = insertBatch(makeBatch(sessionId));
      expect(batch.activity_count).toBe(0);

      const updated = incrementActivityCount(batch.id);
      expect(updated).not.toBeNull();
      expect(updated!.activity_count).toBe(1);

      const again = incrementActivityCount(batch.id);
      expect(again!.activity_count).toBe(2);
    });

    it('returns null for non-existent batch', () => {
      const result = incrementActivityCount(999999);
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // markBatchProcessed
  // ---------------------------------------------------------------------------

  describe('markBatchProcessed', () => {
    it('sets processed flag to 1', () => {
      const batch = insertBatch(makeBatch(sessionId));
      expect(batch.processed).toBe(0);

      const row = markBatchProcessed(batch.id, ALL_PROJECTS_SCOPE);
      expect(row).not.toBeNull();
      expect(row!.processed).toBe(1);
    });

    it('returns null for non-existent batch', () => {
      const result = markBatchProcessed(999999, ALL_PROJECTS_SCOPE);
      expect(result).toBeNull();
    });

    it('does not mark a batch outside the requested project scope', () => {
      const scopedSession = makeSession({ id: 'sess-project-a', project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
      upsertSession(scopedSession);
      const batch = insertBatch(makeBatch(scopedSession.id));

      expect(markBatchProcessed(batch.id, projectScope('proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as GroveProjectId))).toBeNull();
      expect(markBatchProcessed(batch.id, projectScope('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as GroveProjectId))!.processed).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // getUnprocessedBatches
  // ---------------------------------------------------------------------------

  describe('getUnprocessedBatches', () => {
    it('returns only unprocessed batches ordered by id ASC', () => {
      const b1 = insertBatch(makeBatch(sessionId, { user_prompt: 'first' }));
      const b2 = insertBatch(makeBatch(sessionId, { user_prompt: 'second' }));
      insertBatch(makeBatch(sessionId, { user_prompt: 'third' }));

      // Mark b2 as processed
      markBatchProcessed(b2.id, ALL_PROJECTS_SCOPE);

      const rows = getUnprocessedBatches({ scope: ALL_PROJECTS_SCOPE });
      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe(b1.id);
      expect(rows[0].user_prompt).toBe('first');
      expect(rows[1].user_prompt).toBe('third');
    });

    it('respects the limit option', () => {
      for (let i = 0; i < 5; i++) {
        insertBatch(makeBatch(sessionId));
      }

      const rows = getUnprocessedBatches({ limit: 2, scope: ALL_PROJECTS_SCOPE });
      expect(rows).toHaveLength(2);
    });

    it('supports cursor-based pagination via after_id', () => {
      const b1 = insertBatch(makeBatch(sessionId, { user_prompt: 'a' }));
      const b2 = insertBatch(makeBatch(sessionId, { user_prompt: 'b' }));
      const b3 = insertBatch(makeBatch(sessionId, { user_prompt: 'c' }));

      const rows = getUnprocessedBatches({ after_id: b1.id, scope: ALL_PROJECTS_SCOPE });
      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe(b2.id);
      expect(rows[1].id).toBe(b3.id);
    });

    it('combines cursor and limit', () => {
      const b1 = insertBatch(makeBatch(sessionId));
      insertBatch(makeBatch(sessionId));
      insertBatch(makeBatch(sessionId));

      const rows = getUnprocessedBatches({ after_id: b1.id, limit: 1, scope: ALL_PROJECTS_SCOPE });
      expect(rows).toHaveLength(1);
    });

    it('returns empty array when all batches are processed', () => {
      const batch = insertBatch(makeBatch(sessionId));
      markBatchProcessed(batch.id, ALL_PROJECTS_SCOPE);

      const rows = getUnprocessedBatches({ scope: ALL_PROJECTS_SCOPE });
      expect(rows).toEqual([]);
    });

    it('returns empty array when no batches exist', () => {
      const rows = getUnprocessedBatches({ scope: ALL_PROJECTS_SCOPE });
      expect(rows).toEqual([]);
    });

    it('filters unprocessed batches by project_id when requested', () => {
      const sessionA = makeSession({ id: 'sess-project-a', project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', status: 'completed' });
      const sessionB = makeSession({ id: 'sess-project-b', project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', status: 'completed' });
      upsertSession(sessionA);
      upsertSession(sessionB);
      insertBatch(makeBatch(sessionA.id, { user_prompt: 'project a work' }));
      insertBatch(makeBatch(sessionB.id, { user_prompt: 'project b work' }));

      const rows = getUnprocessedBatches({ scope: projectScope('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as GroveProjectId), includeActive: false });

      expect(rows).toHaveLength(1);
      expect(rows[0].user_prompt).toBe('project a work');
    });

    describe('active-session gating (includeActive flag)', () => {
      it('by default (omitted) includes batches from active sessions', () => {
        insertBatch(makeBatch(sessionId, { user_prompt: 'live' }));
        const rows = getUnprocessedBatches({ scope: ALL_PROJECTS_SCOPE });
        expect(rows).toHaveLength(1);
      });

      it('with includeActive:false excludes batches from active sessions', () => {
        insertBatch(makeBatch(sessionId, { user_prompt: 'live' }));
        const rows = getUnprocessedBatches({ includeActive: false, scope: ALL_PROJECTS_SCOPE });
        expect(rows).toEqual([]);
      });

      it('with includeActive:false includes batches from completed sessions', () => {
        // Complete the session, then insert a batch referencing it.
        const completedSession = makeSession({ status: 'completed' });
        upsertSession(completedSession);
        insertBatch(makeBatch(completedSession.id, { user_prompt: 'settled' }));

        const rows = getUnprocessedBatches({ includeActive: false, scope: ALL_PROJECTS_SCOPE });
        expect(rows).toHaveLength(1);
        expect(rows[0].user_prompt).toBe('settled');
      });

      it('with includeActive:true bypasses the filter even for active sessions', () => {
        insertBatch(makeBatch(sessionId, { user_prompt: 'live' }));
        const rows = getUnprocessedBatches({ includeActive: true, scope: ALL_PROJECTS_SCOPE });
        expect(rows).toHaveLength(1);
      });
    });

    describe('origins filter', () => {
      it('returns batches of all origins when origins is omitted', () => {
        insertBatch(makeBatch(sessionId, { user_prompt: 'human', origin: PROMPT_BATCH_ORIGIN.HUMAN }));
        insertBatch(makeBatch(sessionId, { user_prompt: 'system', origin: PROMPT_BATCH_ORIGIN.SYSTEM }));
        insertBatch(makeBatch(sessionId, { user_prompt: 'dispatch', origin: PROMPT_BATCH_ORIGIN.AGENT_DISPATCH }));

        const rows = getUnprocessedBatches({ scope: ALL_PROJECTS_SCOPE });
        expect(rows.map((r) => r.origin).sort()).toEqual(
          ['agent_dispatch', 'human', 'system'].sort(),
        );
      });

      it('restricts to listed origins when origins is provided', () => {
        insertBatch(makeBatch(sessionId, { user_prompt: 'human', origin: PROMPT_BATCH_ORIGIN.HUMAN }));
        insertBatch(makeBatch(sessionId, { user_prompt: 'system', origin: PROMPT_BATCH_ORIGIN.SYSTEM }));
        insertBatch(makeBatch(sessionId, { user_prompt: 'dispatch', origin: PROMPT_BATCH_ORIGIN.AGENT_DISPATCH }));

        const rows = getUnprocessedBatches({
          origins: INTELLIGENCE_DEFAULT_ORIGINS,
          scope: ALL_PROJECTS_SCOPE,
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].origin).toBe('human');
      });

      it('treats empty origins list as no filter (permissive)', () => {
        insertBatch(makeBatch(sessionId, { origin: PROMPT_BATCH_ORIGIN.HUMAN }));
        insertBatch(makeBatch(sessionId, { origin: PROMPT_BATCH_ORIGIN.SYSTEM }));

        const rows = getUnprocessedBatches({ origins: [], scope: ALL_PROJECTS_SCOPE });
        expect(rows).toHaveLength(2);
      });

      it('accepts multi-origin allowlist', () => {
        insertBatch(makeBatch(sessionId, { origin: PROMPT_BATCH_ORIGIN.HUMAN }));
        insertBatch(makeBatch(sessionId, { origin: PROMPT_BATCH_ORIGIN.SYSTEM }));
        insertBatch(makeBatch(sessionId, { origin: PROMPT_BATCH_ORIGIN.AGENT_DISPATCH }));

        const rows = getUnprocessedBatches({
          origins: [PROMPT_BATCH_ORIGIN.HUMAN, PROMPT_BATCH_ORIGIN.AGENT_DISPATCH],
          scope: ALL_PROJECTS_SCOPE,
        });
        expect(rows.map((r) => r.origin).sort()).toEqual(['agent_dispatch', 'human']);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // countUnprocessedSettledBatches
  // ---------------------------------------------------------------------------

  describe('countUnprocessedSettledBatches', () => {
    function settledSessionId(): string {
      const s = makeSession({ status: 'completed' });
      upsertSession(s);
      return s.id;
    }

    it('counts only batches in settled sessions', () => {
      // sessionId from beforeEach is active by default
      insertBatch(makeBatch(sessionId, { origin: PROMPT_BATCH_ORIGIN.HUMAN }));
      const settled = settledSessionId();
      insertBatch(makeBatch(settled, { origin: PROMPT_BATCH_ORIGIN.HUMAN }));
      insertBatch(makeBatch(settled, { origin: PROMPT_BATCH_ORIGIN.HUMAN }));

      expect(countUnprocessedSettledBatches(ALL_PROJECTS_SCOPE)).toBe(2);
    });

    it('respects the origins filter — defaults to all when omitted', () => {
      const settled = settledSessionId();
      insertBatch(makeBatch(settled, { origin: PROMPT_BATCH_ORIGIN.HUMAN }));
      insertBatch(makeBatch(settled, { origin: PROMPT_BATCH_ORIGIN.SYSTEM }));
      insertBatch(makeBatch(settled, { origin: PROMPT_BATCH_ORIGIN.AGENT_DISPATCH }));

      expect(countUnprocessedSettledBatches(ALL_PROJECTS_SCOPE)).toBe(3);
    });

    it('respects the origins filter — narrows to listed origins', () => {
      const settled = settledSessionId();
      insertBatch(makeBatch(settled, { origin: PROMPT_BATCH_ORIGIN.HUMAN }));
      insertBatch(makeBatch(settled, { origin: PROMPT_BATCH_ORIGIN.SYSTEM }));
      insertBatch(makeBatch(settled, { origin: PROMPT_BATCH_ORIGIN.AGENT_DISPATCH }));

      expect(
        countUnprocessedSettledBatches(ALL_PROJECTS_SCOPE, {
          origins: INTELLIGENCE_DEFAULT_ORIGINS,
        }),
      ).toBe(1);
    });

    it('honors the early-termination limit', () => {
      const settled = settledSessionId();
      for (let i = 0; i < 10; i++) {
        insertBatch(makeBatch(settled, { origin: PROMPT_BATCH_ORIGIN.HUMAN }));
      }
      // limit clamps result regardless of true total
      expect(
        countUnprocessedSettledBatches(ALL_PROJECTS_SCOPE, { limit: 3 }),
      ).toBe(3);
    });

    it('limit + origins combine correctly', () => {
      const settled = settledSessionId();
      for (let i = 0; i < 5; i++) {
        insertBatch(makeBatch(settled, { origin: PROMPT_BATCH_ORIGIN.HUMAN }));
      }
      for (let i = 0; i < 5; i++) {
        insertBatch(makeBatch(settled, { origin: PROMPT_BATCH_ORIGIN.SYSTEM }));
      }
      expect(
        countUnprocessedSettledBatches(ALL_PROJECTS_SCOPE, {
          limit: 3,
          origins: INTELLIGENCE_DEFAULT_ORIGINS,
        }),
      ).toBe(3);
    });
  });

  describe('listBatchesBySession', () => {
    it('filters session batches by project_id when requested', () => {
      const scopedSession = makeSession({ id: 'sess-project-a', project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
      upsertSession(scopedSession);
      insertBatch(makeBatch(scopedSession.id, { prompt_number: 1 }));

      expect(listBatchesBySession(scopedSession.id,{ scope: projectScope('proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as GroveProjectId)})).toEqual([]);
      expect(listBatchesBySession(scopedSession.id,{ scope: projectScope('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as GroveProjectId)})).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Full lifecycle: insert → increment → close → mark processed
  // ---------------------------------------------------------------------------

  describe('batch lifecycle', () => {
    it('progresses through full lifecycle', () => {
      // Insert
      const batch = insertBatch(makeBatch(sessionId, {
        prompt_number: 1,
        user_prompt: 'Implement feature X',
      }));
      expect(batch.status).toBe('active');
      expect(batch.activity_count).toBe(0);
      expect(batch.processed).toBe(0);

      // Increment activity count as tools are used
      incrementActivityCount(batch.id);
      incrementActivityCount(batch.id);
      incrementActivityCount(batch.id);

      // Close the batch
      const endTime = epochNow();
      const closed = closeBatch(batch.id, endTime);
      expect(closed!.status).toBe('completed');
      expect(closed!.ended_at).toBe(endTime);
      expect(closed!.activity_count).toBe(3);

      // Still shows as unprocessed
      const unprocessed = getUnprocessedBatches({ scope: ALL_PROJECTS_SCOPE });
      expect(unprocessed).toHaveLength(1);
      expect(unprocessed[0].id).toBe(batch.id);

      // Mark as processed
      const processed = markBatchProcessed(batch.id, ALL_PROJECTS_SCOPE);
      expect(processed!.processed).toBe(1);

      // No longer in unprocessed list
      const empty = getUnprocessedBatches({ scope: ALL_PROJECTS_SCOPE });
      expect(empty).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // setResponseSummary — K4 cross-batch dedupe
  // ---------------------------------------------------------------------------
  //
  // Regression coverage for the bug observed in session
  // 01b979e4-13f3-47e4-a7eb-8a8973cf9226 where batches 3501 (real /ce-review
  // user prompt) and 3502 (first <task-notification>) ended up with
  // IDENTICAL response_summary text. The race: live UserPromptSubmit hook
  // inserting 3502 lagged the Stop hook that fired after the AI emitted
  // its response, so getLatestBatch returned 3501 and the summary was
  // back-stamped onto the human batch. populateBatchResponses then filled
  // 3502 with the same text on the next pass.

  describe('setResponseSummary — cross-batch dedupe', () => {
    it('writes a fresh summary to a NULL batch', () => {
      const a = insertBatch(makeBatch(sessionId, { user_prompt: 'first' }));
      setResponseSummary(a.id, 'response A');

      const after = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE })
        .find((b) => b.id === a.id);
      expect(after?.response_summary).toBe('response A');
    });

    it('refuses to write a summary that already exists on another batch in the same session', () => {
      const a = insertBatch(makeBatch(sessionId, { user_prompt: 'human prompt' }));
      const b = insertBatch(makeBatch(sessionId, { user_prompt: '<task-notification>...' }));

      // First write claims the summary text.
      setResponseSummary(a.id, 'shared response text');

      // Second write attempts to plant the SAME text on a sibling — must
      // be blocked by the dedupe guard.
      setResponseSummary(b.id, 'shared response text');

      const rows = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE });
      const aAfter = rows.find((r) => r.id === a.id);
      const bAfter = rows.find((r) => r.id === b.id);
      expect(aAfter?.response_summary).toBe('shared response text');
      expect(bAfter?.response_summary).toBeNull();
    });

    it('allows the same summary text across DIFFERENT sessions', () => {
      const otherSession = makeSession();
      upsertSession(otherSession);

      const a = insertBatch(makeBatch(sessionId, { user_prompt: 'p1' }));
      const b = insertBatch(makeBatch(otherSession.id, { user_prompt: 'p1' }));

      setResponseSummary(a.id, 'common text');
      setResponseSummary(b.id, 'common text');

      const rowsA = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE });
      const rowsB = listBatchesBySession(otherSession.id, { scope: ALL_PROJECTS_SCOPE });
      expect(rowsA.find((r) => r.id === a.id)?.response_summary).toBe('common text');
      expect(rowsB.find((r) => r.id === b.id)?.response_summary).toBe('common text');
    });

    it('still refuses to overwrite an already-set response_summary (legacy invariant)', () => {
      const a = insertBatch(makeBatch(sessionId, { user_prompt: 'x', response_summary: 'original' }));
      setResponseSummary(a.id, 'replacement');

      const after = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE })
        .find((b) => b.id === a.id);
      expect(after?.response_summary).toBe('original');
    });
  });
});
