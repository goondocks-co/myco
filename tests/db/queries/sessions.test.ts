/**
 * Tests for session CRUD query helpers.
 *
 * Each test initializes an in-memory PGlite instance, creates the schema,
 * exercises the query function, and tears down the database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { getDatabase } from '@myco/db/client.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import {
  upsertSession,
  getSession,
  listSessions,
  updateSession,
  closeSession,
  getSessionImpact,
  deleteSessionCascade,
} from '@myco/db/queries/sessions.js';
import type { SessionInsert } from '@myco/db/queries/sessions.js';

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

      const row = getSession(data.id);
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

      const row = getSession(data.id);
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

      const row = getSession(data.id);
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
      const row = getSession('does-not-exist');
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
      });

      const row = getSession(data.id);
      expect(row!.title).toBe('New title');
      expect(row!.prompt_count).toBe(5);
      expect(row!.tool_count).toBe(12);
    });

    it('returns null when updating non-existent session', async () => {
      const result = updateSession('nope', { title: 'x' });
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

      const rows = listSessions();
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

      const rows = listSessions({ limit: 2 });
      expect(rows).toHaveLength(2);
    });

    it('filters by status', async () => {
      const now = epochNow();
      const active = makeSession({ id: 'sess-active', created_at: now, started_at: now });
      const done = makeSession({ id: 'sess-done', created_at: now + 1, started_at: now + 1 });

      upsertSession(active);
      upsertSession(done);
      closeSession(done.id, now + 2);

      const rows = listSessions({ status: 'completed' });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('sess-done');
    });

    it('filters by agent', async () => {
      const now = epochNow();
      upsertSession(makeSession({ id: 'sess-cc', agent: 'claude-code', created_at: now, started_at: now }));
      upsertSession(makeSession({ id: 'sess-cu', agent: 'cursor', created_at: now + 1, started_at: now + 1 }));

      const rows = listSessions({ agent: 'cursor' });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('sess-cu');
    });

    it('returns empty array when no sessions match', async () => {
      const rows = listSessions({ status: 'completed' });
      expect(rows).toEqual([]);
    });

    it('combines multiple filters', async () => {
      const now = epochNow();
      upsertSession(makeSession({ id: 's1', agent: 'claude-code', created_at: now, started_at: now }));
      upsertSession(makeSession({ id: 's2', agent: 'cursor', created_at: now + 1, started_at: now + 1 }));
      upsertSession(makeSession({ id: 's3', agent: 'cursor', created_at: now + 2, started_at: now + 2 }));
      closeSession('s3', now + 3);

      const rows = listSessions({ agent: 'cursor', status: 'completed' });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('s3');
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
  function createBatch(sessionId: string): number {
    const db = getDatabase();
    const now = epochNow();
    const info = db.prepare(
      `INSERT INTO prompt_batches (session_id, started_at, created_at) VALUES (?, ?, ?)`,
    ).run(sessionId, now, now);
    return info.lastInsertRowid as number;
  }

  /** Insert a spore row directly and return its id. */
  function createSpore(agentId: string, sessionId: string, sporeId: string): string {
    const db = getDatabase();
    const now = epochNow();
    db.prepare(
      `INSERT INTO spores (id, agent_id, session_id, observation_type, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(sporeId, agentId, sessionId, 'gotcha', 'test content', now);
    return sporeId;
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

      createBatch(session.id);
      createBatch(session.id);
      createSpore(agentId, session.id, 'spore-cas-1');
      createSpore(agentId, session.id, 'spore-cas-2');
      createAttachment(session.id, '/path/file1.png');
      createAttachment(session.id, '/path/file2.png');
      createGraphEdge(agentId, session.id);

      const result = deleteSessionCascade(session.id);

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
      expect(getSession(session.id)).toBeNull();
    });

    it('returns deleted: false for non-existent session', () => {
      const result = deleteSessionCascade('does-not-exist');

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

      deleteSessionCascade(sess1.id);

      // sess2 data should be untouched
      expect(getSession(sess2.id)).not.toBeNull();
      const db = getDatabase();
      const remaining = db.prepare(`SELECT COUNT(*) as count FROM spores WHERE session_id = ?`).get(sess2.id) as { count: number };
      expect(remaining.count).toBe(1);
    });

    it('is idempotent — second call returns deleted: false', () => {
      const session = makeSession({ id: 'sess-idem' });
      upsertSession(session);

      const first = deleteSessionCascade(session.id);
      expect(first.deleted).toBe(true);

      const second = deleteSessionCascade(session.id);
      expect(second.deleted).toBe(false);
    });
  });
});
