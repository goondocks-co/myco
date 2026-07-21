/**
 * Tests for session CRUD query helpers.
 *
 * Each test initializes an in-memory PGlite instance, creates the schema,
 * exercises the query function, and tears down the database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { getDatabase } from '@myco/db/client.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import {
  upsertSession,
  getSession,
  listSessions,
  countSessions,
  updateSession,
  closeSession,
  getSessionImpact,
  deleteSessionCascade,
  reactivateSessionIfCompleted,
} from '@myco/db/queries/sessions.js';
import type { SessionInsert } from '@myco/db/queries/sessions.js';
import {
  SESSION_TOMBSTONE_SOURCE,
  getSessionTombstone,
  hasSessionTombstone,
  pruneSessionTombstones,
} from '@myco/db/queries/session-tombstones.js';
import { ALL_PROJECTS_SCOPE, GLOBAL_SCOPE, createGroveEraId, projectScope, type GroveProjectId } from '@myco/grove/ids.js';

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

describe('session query helpers', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  // ---------------------------------------------------------------------------
  // upsertSession + getSession
  // ---------------------------------------------------------------------------

  describe('upsertSession', () => {
    it('inserts a new session and retrieves it', async () => {
      const data = makeSession({ title: 'First session' });
      upsertSession(data);

      const row = getSession(data.id, ALL_PROJECTS_SCOPE);
      expect(row).not.toBeNull();
      expect(row!.id).toBe(data.id);
      expect(row!.agent).toBe('claude-code');
      expect(row!.title).toBe('First session');
      expect(row!.status).toBe('active');
      expect(row!.prompt_count).toBe(0);
      expect(row!.tool_count).toBe(0);
    });

    it('is idempotent — second upsert updates without error', async () => {
      const data = makeSession({ title: 'Original' });
      upsertSession(data);
      upsertSession({ ...data, title: 'Updated' });

      const row = getSession(data.id, ALL_PROJECTS_SCOPE);
      expect(row).not.toBeNull();
      expect(row!.title).toBe('Updated');
    });

    it('preserves fields not included in the update', async () => {
      const now = epochNow();
      const data = makeSession({
        title: 'Keep me',
        summary: 'A detailed summary',
        started_at: now,
      });
      upsertSession(data);

      // Upsert with only agent changed — title and summary should persist
      upsertSession({ ...data, agent: 'cursor' });

      const row = getSession(data.id, ALL_PROJECTS_SCOPE);
      expect(row!.agent).toBe('cursor');
      expect(row!.title).toBe('Keep me');
      expect(row!.summary).toBe('A detailed summary');
    });
  });

  // ---------------------------------------------------------------------------
  // getSession
  // ---------------------------------------------------------------------------

  describe('getSession', () => {
    it('returns null for non-existent id', async () => {
      const row = getSession('does-not-exist', ALL_PROJECTS_SCOPE);
      expect(row).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // updateSession
  // ---------------------------------------------------------------------------

  describe('updateSession', () => {
    it('updates specific fields', async () => {
      const data = makeSession();
      upsertSession(data);

      updateSession(data.id, {
        title: 'New title',
        prompt_count: 5,
        tool_count: 12,
      }, ALL_PROJECTS_SCOPE);

      const row = getSession(data.id, ALL_PROJECTS_SCOPE);
      expect(row!.title).toBe('New title');
      expect(row!.prompt_count).toBe(5);
      expect(row!.tool_count).toBe(12);
    });

    it('returns null when updating non-existent session', async () => {
      const result = updateSession('nope', { title: 'x' }, ALL_PROJECTS_SCOPE);
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // closeSession
  // ---------------------------------------------------------------------------

  describe('closeSession', () => {
    it('sets status to completed and records ended_at', async () => {
      const data = makeSession();
      upsertSession(data);

      const endTime = epochNow();
      const row = closeSession(data.id, endTime);

      expect(row).not.toBeNull();
      expect(row!.status).toBe('completed');
      expect(row!.ended_at).toBe(endTime);
    });

    it('returns null for non-existent session', async () => {
      const result = closeSession('nope', epochNow());
      expect(result).toBeNull();
    });

    it('closes the session\'s still-open batches (completion chokepoint invariant)', () => {
      // A completed session must not retain open turns. Completing the session
      // is the single point that owns batch-closing, so every completion path
      // (SessionEnd, manual API, stale sweep) inherits it.
      const data = makeSession();
      upsertSession(data);
      const db = getDatabase();
      db.prepare(
        `INSERT INTO prompt_batches (id, session_id, prompt_number, started_at, created_at, status)
         VALUES (?, ?, 1, ?, ?, 'active')`,
      ).run(createGroveEraId('prompt_batch'), data.id, epochNow(), epochNow());
      const openCount = (): number =>
        (db.prepare(`SELECT COUNT(*) AS n FROM prompt_batches WHERE session_id = ? AND ended_at IS NULL`)
          .get(data.id) as { n: number }).n;
      expect(openCount()).toBe(1);

      closeSession(data.id, epochNow());

      expect(openCount()).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // listSessions
  // ---------------------------------------------------------------------------

  describe('listSessions', () => {
    it('returns sessions ordered by created_at DESC', async () => {
      const now = epochNow();
      const s1 = makeSession({ id: 'sess-old', created_at: now - 100, started_at: now - 100 });
      const s2 = makeSession({ id: 'sess-mid', created_at: now - 50, started_at: now - 50 });
      const s3 = makeSession({ id: 'sess-new', created_at: now, started_at: now });

      // Insert out of order to verify ordering
      upsertSession(s2);
      upsertSession(s1);
      upsertSession(s3);

      const rows = listSessions({ scope: ALL_PROJECTS_SCOPE });
      expect(rows).toHaveLength(3);
      expect(rows[0].id).toBe('sess-new');
      expect(rows[1].id).toBe('sess-mid');
      expect(rows[2].id).toBe('sess-old');
    });

    it('respects the limit option', async () => {
      const now = epochNow();
      for (let i = 0; i < 5; i++) {
        upsertSession(makeSession({ created_at: now + i, started_at: now + i }));
      }

      const rows = listSessions({ limit: 2, scope: ALL_PROJECTS_SCOPE });
      expect(rows).toHaveLength(2);
    });

    it('filters by status', async () => {
      const now = epochNow();
      const active = makeSession({ id: 'sess-active', created_at: now, started_at: now });
      const done = makeSession({ id: 'sess-done', created_at: now + 1, started_at: now + 1 });

      upsertSession(active);
      upsertSession(done);
      closeSession(done.id, now + 2);

      const rows = listSessions({ status: 'completed', scope: ALL_PROJECTS_SCOPE });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('sess-done');
    });

    it('filters by agent', async () => {
      const now = epochNow();
      upsertSession(makeSession({ id: 'sess-cc', agent: 'claude-code', created_at: now, started_at: now }));
      upsertSession(makeSession({ id: 'sess-cu', agent: 'cursor', created_at: now + 1, started_at: now + 1 }));

      const rows = listSessions({ agent: 'cursor', scope: ALL_PROJECTS_SCOPE });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('sess-cu');
    });

    it('filters by explicit project scope', async () => {
      const now = epochNow();
      upsertSession(makeSession({ id: 'sess-legacy', created_at: now, started_at: now }));
      upsertSession(makeSession({ id: 'sess-a', project_id: 'proj_a', created_at: now + 1, started_at: now + 1 }));
      upsertSession(makeSession({ id: 'sess-b', project_id: 'proj_b', created_at: now + 2, started_at: now + 2 }));

      expect(getSession('sess-a', projectScope('proj_a' as GroveProjectId))?.project_id).toBe('proj_a');
      expect(getSession('sess-a', projectScope('proj_b' as GroveProjectId))).toBeNull();
      expect(listSessions({ scope: GLOBAL_SCOPE}).map((row) => row.id)).toEqual(['sess-legacy']);
      expect(listSessions({ scope: projectScope('proj_a' as GroveProjectId)}).map((row) => row.id)).toEqual(['sess-a']);
      expect(countSessions({ scope: projectScope('proj_b' as GroveProjectId)})).toBe(1);
    });

    it('returns empty array when no sessions match', async () => {
      const rows = listSessions({ status: 'completed', scope: ALL_PROJECTS_SCOPE });
      expect(rows).toEqual([]);
    });

    it('combines multiple filters', async () => {
      const now = epochNow();
      upsertSession(makeSession({ id: 's1', agent: 'claude-code', created_at: now, started_at: now }));
      upsertSession(makeSession({ id: 's2', agent: 'cursor', created_at: now + 1, started_at: now + 1 }));
      upsertSession(makeSession({ id: 's3', agent: 'cursor', created_at: now + 2, started_at: now + 2 }));
      closeSession('s3', now + 3);

      const rows = listSessions({ agent: 'cursor', status: 'completed', scope: ALL_PROJECTS_SCOPE });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('s3');
    });

    describe('active-session gating (includeActive flag)', () => {
      it('by default (omitted) returns active sessions', async () => {
        // Preserves existing UI behavior — the gate only engages when
        // intelligence-task callers explicitly opt in.
        const now = epochNow();
        upsertSession(makeSession({ id: 'live', created_at: now, started_at: now }));
        const rows = listSessions({ scope: ALL_PROJECTS_SCOPE });
        expect(rows.map((r) => r.id)).toContain('live');
      });

      it('with includeActive:false excludes active sessions', async () => {
        const now = epochNow();
        upsertSession(makeSession({ id: 'live', created_at: now, started_at: now }));
        const done = makeSession({ id: 'done', created_at: now + 1, started_at: now + 1 });
        upsertSession(done);
        closeSession('done', now + 2);

        const rows = listSessions({ includeActive: false, scope: ALL_PROJECTS_SCOPE });
        expect(rows.map((r) => r.id)).toEqual(['done']);
      });

      it('an explicit status filter overrides includeActive:false', async () => {
        const now = epochNow();
        upsertSession(makeSession({ id: 'live', created_at: now, started_at: now }));

        // Explicit status='active' takes precedence — caller is asking for
        // in-flight sessions and shouldn't be silently filtered.
        const rows = listSessions({ includeActive: false, status: 'active', scope: ALL_PROJECTS_SCOPE });
        expect(rows.map((r) => r.id)).toEqual(['live']);
      });
    });

    it('paginates with offset', async () => {
      const now = epochNow();
      for (let i = 0; i < 5; i++) {
        upsertSession(makeSession({ id: `sess-pg-${i}`, created_at: now + i, started_at: now + i }));
      }

      const page1 = listSessions({ limit: 2, offset: 0, scope: ALL_PROJECTS_SCOPE });
      const page2 = listSessions({ limit: 2, offset: 2, scope: ALL_PROJECTS_SCOPE });
      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      // Pages should be distinct
      expect(page1[0].id).not.toBe(page2[0].id);
      expect(page1[1].id).not.toBe(page2[1].id);
    });

    it('applies offset together with a filter', async () => {
      const now = epochNow();
      for (let i = 0; i < 4; i++) {
        upsertSession(makeSession({ id: `sess-off-${i}`, agent: 'cursor', created_at: now + i, started_at: now + i }));
      }
      upsertSession(makeSession({ id: 'sess-cc', agent: 'claude-code', created_at: now + 5, started_at: now + 5 }));

      const page1 = listSessions({ agent: 'cursor', limit: 2, offset: 0, scope: ALL_PROJECTS_SCOPE });
      const page2 = listSessions({ agent: 'cursor', limit: 2, offset: 2, scope: ALL_PROJECTS_SCOPE });
      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(2);
      // All returned sessions must be cursor agent
      for (const row of [...page1, ...page2]) {
        expect(row.agent).toBe('cursor');
      }
    });

    it('returns empty array when offset exceeds total', async () => {
      const now = epochNow();
      upsertSession(makeSession({ created_at: now, started_at: now }));

      const rows = listSessions({ offset: 100, scope: ALL_PROJECTS_SCOPE });
      expect(rows).toEqual([]);
    });

    it('filters by search term in title', async () => {
      const now = epochNow();
      upsertSession(makeSession({ id: 'sess-match', title: 'Fix the nasty bug', created_at: now, started_at: now }));
      upsertSession(makeSession({ id: 'sess-no', title: 'Refactor auth', created_at: now + 1, started_at: now + 1 }));

      const rows = listSessions({ search: 'nasty', scope: ALL_PROJECTS_SCOPE });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('sess-match');
    });

    it('filters by search term in id', async () => {
      const now = epochNow();
      upsertSession(makeSession({ id: 'unique-abc123', created_at: now, started_at: now }));
      upsertSession(makeSession({ id: 'other-xyz999', created_at: now + 1, started_at: now + 1 }));

      const rows = listSessions({ search: 'abc123', scope: ALL_PROJECTS_SCOPE });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('unique-abc123');
    });

    it('combines search with filter and pagination', async () => {
      const now = epochNow();
      for (let i = 0; i < 3; i++) {
        upsertSession(makeSession({
          id: `sess-combo-${i}`,
          agent: 'cursor',
          title: `Feature work ${i}`,
          created_at: now + i,
          started_at: now + i,
        }));
      }
      upsertSession(makeSession({ id: 'sess-other', agent: 'cursor', title: 'Unrelated', created_at: now + 10, started_at: now + 10 }));

      const rows = listSessions({ agent: 'cursor', search: 'Feature', limit: 2, offset: 0, scope: ALL_PROJECTS_SCOPE });
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.agent).toBe('cursor');
        expect(row.title).toMatch(/Feature/);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // countSessions
  // ---------------------------------------------------------------------------

  describe('countSessions', () => {
    it('returns total count of all sessions', async () => {
      const now = epochNow();
      for (let i = 0; i < 4; i++) {
        upsertSession(makeSession({ created_at: now + i, started_at: now + i }));
      }

      expect(countSessions({ scope: ALL_PROJECTS_SCOPE })).toBe(4);
    });

    it('counts sessions matching status filter', async () => {
      const now = epochNow();
      const s1 = makeSession({ id: 'cs-active', created_at: now, started_at: now });
      const s2 = makeSession({ id: 'cs-done', created_at: now + 1, started_at: now + 1 });
      upsertSession(s1);
      upsertSession(s2);
      closeSession(s2.id, now + 2);

      expect(countSessions({ status: 'completed', scope: ALL_PROJECTS_SCOPE })).toBe(1);
      expect(countSessions({ status: 'active', scope: ALL_PROJECTS_SCOPE })).toBe(1);
    });

    it('counts sessions matching agent filter', async () => {
      const now = epochNow();
      upsertSession(makeSession({ id: 'cnt-cc', agent: 'claude-code', created_at: now, started_at: now }));
      upsertSession(makeSession({ id: 'cnt-cu1', agent: 'cursor', created_at: now + 1, started_at: now + 1 }));
      upsertSession(makeSession({ id: 'cnt-cu2', agent: 'cursor', created_at: now + 2, started_at: now + 2 }));

      expect(countSessions({ agent: 'cursor', scope: ALL_PROJECTS_SCOPE })).toBe(2);
      expect(countSessions({ agent: 'claude-code', scope: ALL_PROJECTS_SCOPE })).toBe(1);
    });

    it('counts sessions matching search term', async () => {
      const now = epochNow();
      upsertSession(makeSession({ id: 'cnt-s1', title: 'Search feature impl', created_at: now, started_at: now }));
      upsertSession(makeSession({ id: 'cnt-s2', title: 'Search bug fix', created_at: now + 1, started_at: now + 1 }));
      upsertSession(makeSession({ id: 'cnt-s3', title: 'Unrelated work', created_at: now + 2, started_at: now + 2 }));

      expect(countSessions({ search: 'Search', scope: ALL_PROJECTS_SCOPE })).toBe(2);
      expect(countSessions({ search: 'Unrelated', scope: ALL_PROJECTS_SCOPE })).toBe(1);
    });

    it('returns 0 when no sessions match', async () => {
      expect(countSessions({ status: 'completed', scope: ALL_PROJECTS_SCOPE })).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Helpers for cascade tests
  // ---------------------------------------------------------------------------

  /** Insert an agent row directly (needed as FK for spores / graph_edges). */
  function createAgent(id: string): string {
    const db = getDatabase();
    db.prepare(`INSERT INTO agents (id, name, created_at) VALUES (?, ?, ?)`).run(id, `agent-${id}`, epochNow());
    return id;
  }

  /** Insert a prompt_batch row directly and return its generated id. */
  function createBatch(sessionId: string): string {
    const db = getDatabase();
    const now = epochNow();
    const id = createGroveEraId('prompt_batch');
    db.prepare(
      `INSERT INTO prompt_batches (id, session_id, started_at, created_at) VALUES (?, ?, ?, ?)`,
    ).run(id, sessionId, now, now);
    return id;
  }

  /**
   * Insert a spore row directly and return its id.
   *
   * Optionally link the spore to a prompt_batch via `promptBatchId` — this
   * matches how agent-generated spores are created in production and
   * exercises the `spores.prompt_batch_id → prompt_batches(id)` foreign key
   * that caused the cascade delete ordering bug.
   */
  function createSpore(
    agentId: string,
    sessionId: string,
    sporeId: string,
    promptBatchId?: string,
  ): string {
    const db = getDatabase();
    const now = epochNow();
    db.prepare(
      `INSERT INTO spores (id, agent_id, session_id, prompt_batch_id, observation_type, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(sporeId, agentId, sessionId, promptBatchId ?? null, 'gotcha', 'test content', now);
    return sporeId;
  }

  /** Insert a plan row directly — exercises plans.session_id / prompt_batch_id FKs. */
  function createPlan(sessionId: string, planId: string, promptBatchId?: string): void {
    const db = getDatabase();
    const now = epochNow();
    db.prepare(
      `INSERT INTO plans (id, logical_key, session_id, prompt_batch_id, title, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(planId, `session-plan:${planId}`, sessionId, promptBatchId ?? null, 'test plan', 'plan content', now);
  }

  /** Insert a skill_record + skill_usage row — exercises skill_usage.session_id FK. */
  function createSkillUsage(agentId: string, sessionId: string, skillId: string): void {
    const db = getDatabase();
    const now = epochNow();
    db.prepare(
      `INSERT INTO skill_records (id, agent_id, name, display_name, description, path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(skillId, agentId, `skill-${skillId}`, `Skill ${skillId}`, 'test skill', `.agents/skills/${skillId}`, now, now);
    db.prepare(
      `INSERT INTO skill_usage (id, skill_id, session_id, detected_at)
       VALUES (?, ?, ?, ?)`,
    ).run(`usage-${skillId}`, skillId, sessionId, now);
  }

  /** Insert a resolution_event row — exercises resolution_events.spore_id FK. */
  function createResolutionEvent(
    agentId: string,
    sporeId: string,
    sessionId: string | null,
  ): void {
    const db = getDatabase();
    const now = epochNow();
    db.prepare(
      `INSERT INTO resolution_events (id, agent_id, spore_id, action, session_id, created_at)
       VALUES (?, ?, ?, 'supersede', ?, ?)`,
    ).run(`res-${Math.random().toString(36).slice(2, 8)}`, agentId, sporeId, sessionId, now);
  }

  /** Insert release provenance rows that hold FKs to sessions / prompt_batches. */
  function createReleaseEvidence(sessionId: string, promptBatchId?: string): void {
    const db = getDatabase();
    const now = epochNow();
    const suffix = Math.random().toString(36).slice(2, 8);
    db.prepare(
      `INSERT INTO knowledge_git_provenance (
         identity_key, session_id, prompt_batch_id, capture_point, captured_at,
         status_hash, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(`git:${suffix}`, sessionId, promptBatchId ?? null, 'prompt_capture', now, `status:${suffix}`, now);
    db.prepare(
      `INSERT INTO knowledge_release_state (
         identity_key, namespace, record_id, source_session_id, source_prompt_batch_id,
         state, confidence, checked_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(`release:${suffix}`, 'sessions', sessionId, sessionId, promptBatchId ?? null, 'unknown', 'low', now, now);
  }

  /** Insert an attachment row directly. */
  function createAttachment(sessionId: string, filePath: string): void {
    const db = getDatabase();
    const now = epochNow();
    db.prepare(
      `INSERT INTO attachments (session_id, file_path, created_at) VALUES (?, ?, ?)`,
    ).run(sessionId, filePath, now);
  }

  /** Insert a graph_edge row directly. */
  function createGraphEdge(agentId: string, sessionId: string): void {
    const db = getDatabase();
    const now = epochNow();
    db.prepare(
      `INSERT INTO graph_edges (id, agent_id, source_id, source_type, target_id, target_type, type, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(`edge-${Math.random().toString(36).slice(2, 8)}`, agentId, 'spore-x', 'spore', sessionId, 'session', 'FROM_SESSION', sessionId, now);
  }

  // ---------------------------------------------------------------------------
  // getSessionImpact
  // ---------------------------------------------------------------------------

  describe('getSessionImpact', () => {
    it('returns zeros for a session with no related data', () => {
      const session = makeSession();
      upsertSession(session);

      const impact = getSessionImpact(session.id);
      expect(impact.promptCount).toBe(0);
      expect(impact.sporeCount).toBe(0);
      expect(impact.attachmentCount).toBe(0);
      expect(impact.graphEdgeCount).toBe(0);
    });

    it('returns correct counts of related data', () => {
      const session = makeSession({ id: 'sess-impact' });
      upsertSession(session);
      const agentId = createAgent('agent-impact');

      createBatch(session.id);
      createBatch(session.id);
      createSpore(agentId, session.id, 'spore-impact-1');
      createSpore(agentId, session.id, 'spore-impact-2');
      createSpore(agentId, session.id, 'spore-impact-3');
      createAttachment(session.id, '/path/to/image1.png');
      createGraphEdge(agentId, session.id);

      const impact = getSessionImpact(session.id);
      expect(impact.promptCount).toBe(2);
      expect(impact.sporeCount).toBe(3);
      expect(impact.attachmentCount).toBe(1);
      expect(impact.graphEdgeCount).toBe(1);
    });

    it('does not count data from other sessions', () => {
      const sess1 = makeSession({ id: 'sess-a' });
      const sess2 = makeSession({ id: 'sess-b' });
      upsertSession(sess1);
      upsertSession(sess2);
      const agentId = createAgent('agent-isolation');

      createBatch(sess2.id);
      createSpore(agentId, sess2.id, 'spore-other');

      const impact = getSessionImpact(sess1.id);
      expect(impact.promptCount).toBe(0);
      expect(impact.sporeCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // deleteSessionCascade
  // ---------------------------------------------------------------------------

  describe('deleteSessionCascade', () => {
    it('deletes session and all related data, returns correct counts', () => {
      const session = makeSession({ id: 'sess-cascade' });
      upsertSession(session);
      const agentId = createAgent('agent-cascade');

      const batch1 = createBatch(session.id);
      createBatch(session.id);
      // Link spores to a prompt_batch — this is what agent-generated spores
      // do in production, and it exercises the spores.prompt_batch_id FK
      // that made the cascade ordering bug invisible to prior tests.
      createSpore(agentId, session.id, 'spore-cas-1', batch1);
      createSpore(agentId, session.id, 'spore-cas-2', batch1);
      createAttachment(session.id, '/path/file1.png');
      createAttachment(session.id, '/path/file2.png');
      createGraphEdge(agentId, session.id);

      const result = deleteSessionCascade(session.id, SESSION_TOMBSTONE_SOURCE.API_DELETE);

      expect(result.deleted).toBe(true);
      expect(result.counts.prompts).toBe(2);
      expect(result.counts.spores).toBe(2);
      expect(result.counts.attachments).toBe(2);
      expect(result.counts.graphEdges).toBe(1);
      expect(result.counts.resolutionEvents).toBe(0);
      expect(result.deletedSporeIds).toHaveLength(2);
      expect(result.deletedSporeIds).toContain('spore-cas-1');
      expect(result.deletedSporeIds).toContain('spore-cas-2');
      expect(result.deletedAttachmentPaths).toHaveLength(2);
      expect(result.deletedAttachmentPaths).toContain('/path/file1.png');
      expect(result.deletedAttachmentPaths).toContain('/path/file2.png');

      // Session should no longer exist
      expect(getSession(session.id, ALL_PROJECTS_SCOPE)).toBeNull();
    });

    it('deletes plans, skill_usage, and batch-linked spores without FK errors', () => {
      // Regression test for the session-maintenance FK failure:
      // spores with prompt_batch_id set must be deleted before prompt_batches,
      // and plans/skill_usage must be part of the cascade.
      const session = makeSession({ id: 'sess-fk-regression' });
      upsertSession(session);
      const agentId = createAgent('agent-fk-regression');

      const batchId = createBatch(session.id);
      createSpore(agentId, session.id, 'spore-linked', batchId);
      createPlan(session.id, 'plan-linked', batchId);
      createSkillUsage(agentId, session.id, 'skill-linked');

      const result = deleteSessionCascade(session.id, SESSION_TOMBSTONE_SOURCE.API_DELETE);
      expect(result.deleted).toBe(true);

      const db = getDatabase();
      const remaining = db.prepare(
        `SELECT
           (SELECT COUNT(*) FROM spores WHERE session_id = ?) AS spores,
           (SELECT COUNT(*) FROM plans WHERE session_id = ?) AS plans,
           (SELECT COUNT(*) FROM skill_usage WHERE session_id = ?) AS skill_usage,
           (SELECT COUNT(*) FROM prompt_batches WHERE session_id = ?) AS batches`,
      ).get(session.id, session.id, session.id, session.id) as Record<string, number>;
      expect(remaining.spores).toBe(0);
      expect(remaining.plans).toBe(0);
      expect(remaining.skill_usage).toBe(0);
      expect(remaining.batches).toBe(0);
    });

    it('deletes resolution_events that reference this session\'s spores from other sessions', () => {
      // A spore from session A can be superseded by session B, leaving a
      // resolution_event with spore_id=A's spore and session_id=B.
      // Deleting session A must still remove that event, or the spore
      // delete fails on the resolution_events.spore_id FK.
      const sessA = makeSession({ id: 'sess-res-a' });
      const sessB = makeSession({ id: 'sess-res-b' });
      upsertSession(sessA);
      upsertSession(sessB);
      const agentId = createAgent('agent-res');

      createSpore(agentId, sessA.id, 'spore-res-a');
      createResolutionEvent(agentId, 'spore-res-a', sessB.id);

      const result = deleteSessionCascade(sessA.id, SESSION_TOMBSTONE_SOURCE.API_DELETE);
      expect(result.deleted).toBe(true);
      expect(result.counts.resolutionEvents).toBe(1);
    });

    it('deletes release provenance rows before deleting sessions and prompt batches', () => {
      const session = makeSession({ id: 'sess-release-provenance-cascade' });
      upsertSession(session);
      const batchId = createBatch(session.id);
      createReleaseEvidence(session.id);
      createReleaseEvidence(session.id, batchId);

      const result = deleteSessionCascade(session.id, SESSION_TOMBSTONE_SOURCE.API_DELETE);
      expect(result.deleted).toBe(true);

      const db = getDatabase();
      const remaining = db.prepare(
        `SELECT
           (SELECT COUNT(*) FROM knowledge_git_provenance WHERE session_id = ?) AS git_rows,
           (SELECT COUNT(*) FROM knowledge_release_state WHERE source_session_id = ?) AS release_rows,
           (SELECT COUNT(*) FROM prompt_batches WHERE session_id = ?) AS batches`,
      ).get(session.id, session.id, session.id) as Record<string, number>;
      expect(remaining.git_rows).toBe(0);
      expect(remaining.release_rows).toBe(0);
      expect(remaining.batches).toBe(0);
    });

    it('returns deleted: false for non-existent session', () => {
      const result = deleteSessionCascade('does-not-exist', SESSION_TOMBSTONE_SOURCE.API_DELETE);

      expect(result.deleted).toBe(false);
      expect(result.counts.prompts).toBe(0);
      expect(result.counts.spores).toBe(0);
      expect(result.counts.attachments).toBe(0);
      expect(result.counts.graphEdges).toBe(0);
      expect(result.counts.resolutionEvents).toBe(0);
      expect(result.deletedSporeIds).toEqual([]);
      expect(result.deletedAttachmentPaths).toEqual([]);
    });

    it('does not affect data belonging to other sessions', () => {
      const sess1 = makeSession({ id: 'sess-del-1' });
      const sess2 = makeSession({ id: 'sess-del-2' });
      upsertSession(sess1);
      upsertSession(sess2);
      const agentId = createAgent('agent-other-sess');

      createBatch(sess1.id);
      createSpore(agentId, sess1.id, 'spore-keep-1');
      createBatch(sess2.id);
      createSpore(agentId, sess2.id, 'spore-keep-2');

      deleteSessionCascade(sess1.id, SESSION_TOMBSTONE_SOURCE.API_DELETE);

      // sess2 data should be untouched
      expect(getSession(sess2.id, ALL_PROJECTS_SCOPE)).not.toBeNull();
      const db = getDatabase();
      const remaining = db.prepare(`SELECT COUNT(*) as count FROM spores WHERE session_id = ?`).get(sess2.id) as { count: number };
      expect(remaining.count).toBe(1);
    });

    it('is idempotent — second call returns deleted: false', () => {
      const session = makeSession({ id: 'sess-idem' });
      upsertSession(session);

      const first = deleteSessionCascade(session.id, SESSION_TOMBSTONE_SOURCE.API_DELETE);
      expect(first.deleted).toBe(true);

      const second = deleteSessionCascade(session.id, SESSION_TOMBSTONE_SOURCE.API_DELETE);
      expect(second.deleted).toBe(false);
    });

    it('writes a tombstone with the deleted row\'s project_id and the caller\'s source', () => {
      const session = makeSession({ id: 'sess-tomb', project_id: 'project-tomb' });
      upsertSession(session);

      deleteSessionCascade(session.id, SESSION_TOMBSTONE_SOURCE.MAINTENANCE_SWEEP);

      const tombstone = getSessionTombstone(session.id)!;
      expect(tombstone).not.toBeNull();
      expect(tombstone.project_id).toBe('project-tomb');
      expect(tombstone.source).toBe('maintenance_sweep');
      expect(tombstone.deleted_at).toBeGreaterThan(0);
    });

    it('writes NO tombstone for a no-row session (deleted: false)', () => {
      const result = deleteSessionCascade('never-existed', SESSION_TOMBSTONE_SOURCE.API_DELETE);

      expect(result.deleted).toBe(false);
      expect(hasSessionTombstone('never-existed')).toBe(false);
    });

    it('pruneSessionTombstones removes only rows older than the window', () => {
      const session = makeSession({ id: 'sess-prune' });
      upsertSession(session);
      deleteSessionCascade(session.id, SESSION_TOMBSTONE_SOURCE.INVALID_CAPTURE);

      // Fresh tombstone survives a 14d window.
      expect(pruneSessionTombstones(14 * 24 * 60 * 60 * 1000)).toBe(0);
      expect(hasSessionTombstone(session.id)).toBe(true);

      // Age the row past the window, then prune.
      getDatabase().prepare(
        `UPDATE session_tombstones SET deleted_at = deleted_at - 15 * 24 * 60 * 60 WHERE session_id = ?`,
      ).run(session.id);
      expect(pruneSessionTombstones(14 * 24 * 60 * 60 * 1000)).toBe(1);
      expect(hasSessionTombstone(session.id)).toBe(false);
    });
  });

  describe('reactivateSessionIfCompleted', () => {
    it('flips a completed session back to active and returns true', () => {
      const now = epochNow();
      const session = makeSession({ id: 'sess-completed', status: 'completed', created_at: now, started_at: now });
      upsertSession(session);

      const flipped = reactivateSessionIfCompleted('sess-completed', ALL_PROJECTS_SCOPE);

      expect(flipped).toBe(true);
      expect(getSession('sess-completed', ALL_PROJECTS_SCOPE)?.status).toBe('active');
    });

    it('is a no-op for an already-active session and returns false', () => {
      const session = makeSession({ id: 'sess-active', status: 'active' });
      upsertSession(session);

      const flipped = reactivateSessionIfCompleted('sess-active', ALL_PROJECTS_SCOPE);

      expect(flipped).toBe(false);
      expect(getSession('sess-active', ALL_PROJECTS_SCOPE)?.status).toBe('active');
    });

    it('returns false for a missing session', () => {
      expect(reactivateSessionIfCompleted('nope', ALL_PROJECTS_SCOPE)).toBe(false);
    });

    it('preserves ended_at when reactivating — the next completion overwrites it', () => {
      const now = epochNow();
      upsertSession({
        ...makeSession({ id: 'sess-keep-end', status: 'completed', created_at: now, started_at: now }),
        ended_at: now + 100,
      });

      reactivateSessionIfCompleted('sess-keep-end', ALL_PROJECTS_SCOPE);

      expect(getSession('sess-keep-end', ALL_PROJECTS_SCOPE)?.ended_at).toBe(now + 100);
    });
  });
});
