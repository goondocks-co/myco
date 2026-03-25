/**
 * Tests for SqliteRecordSource — the EmbeddableRecordSource implementation
 * that queries the record store for rows needing embedding.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { getDatabase } from '@myco/db/client.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertSpore } from '@myco/db/queries/spores.js';
import { upsertPlan } from '@myco/db/queries/plans.js';
import { markEmbedded } from '@myco/db/queries/embeddings.js';
import type { SessionInsert } from '@myco/db/queries/sessions.js';
import type { SporeInsert } from '@myco/db/queries/spores.js';
import type { PlanInsert } from '@myco/db/queries/plans.js';
import { SqliteRecordSource } from '@myco/daemon/embedding/record-source';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const epochNow = () => Math.floor(Date.now() / 1000);

/** Shared agent for spore foreign key. */
const AGENT_ID = 'test-agent-rs';

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

function makeSpore(overrides: Partial<SporeInsert> = {}): SporeInsert {
  const now = epochNow();
  return {
    id: `spore-${Math.random().toString(36).slice(2, 8)}`,
    agent_id: AGENT_ID,
    observation_type: 'gotcha',
    content: 'Some observation content',
    created_at: now,
    ...overrides,
  };
}

function makePlan(overrides: Partial<PlanInsert> = {}): PlanInsert {
  const now = epochNow();
  return {
    id: `plan-${Math.random().toString(36).slice(2, 8)}`,
    created_at: now,
    ...overrides,
  };
}

/** Insert an artifact directly — no query module exists for artifacts. */
function insertArtifact(id: string, content: string | null): void {
  const db = getDatabase();
  const now = epochNow();
  db.prepare(
    `INSERT INTO artifacts (id, artifact_type, source_path, title, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, 'file', '/tmp/test', 'Test Artifact', content, now);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SqliteRecordSource', () => {
  let source: SqliteRecordSource;

  beforeAll(() => {
    setupTestDb();
    registerAgent({ id: AGENT_ID, name: 'Test Agent', created_at: epochNow() });
  });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    // Re-insert the agent after cleanTestDb deletes all rows
    registerAgent({ id: AGENT_ID, name: 'Test Agent', created_at: epochNow() });
    source = new SqliteRecordSource();
  });

  // -------------------------------------------------------------------------
  // getEmbeddableRows
  // -------------------------------------------------------------------------

  describe('getEmbeddableRows', () => {
    it('returns sessions with summary and embedded=0, includes project_root in metadata', () => {
      upsertSession(makeSession({
        id: 'sess-emb-1',
        summary: 'Built the embedding system',
        project_root: '/home/user/project',
      }));

      const rows = source.getEmbeddableRows('sessions', 10);

      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('sess-emb-1');
      expect(rows[0].text).toBe('Built the embedding system');
      expect(rows[0].metadata.project_root).toBe('/home/user/project');
    });

    it('returns only active spores with embedded=0', () => {
      const now = epochNow();
      insertSpore(makeSpore({
        id: 'spore-active',
        content: 'Active spore content',
        status: 'active',
        session_id: null,
        observation_type: 'decision',
        created_at: now,
      }));

      const rows = source.getEmbeddableRows('spores', 10);

      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('spore-active');
      expect(rows[0].text).toBe('Active spore content');
      expect(rows[0].metadata).toEqual({
        status: 'active',
        observation_type: 'decision',
      });
    });

    it('excludes non-active spores (superseded, archived)', () => {
      insertSpore(makeSpore({ id: 'spore-superseded', status: 'superseded' }));
      insertSpore(makeSpore({ id: 'spore-archived', status: 'archived' }));
      insertSpore(makeSpore({ id: 'spore-ok', status: 'active' }));

      const rows = source.getEmbeddableRows('spores', 10);

      const ids = rows.map((r) => r.id);
      expect(ids).toContain('spore-ok');
      expect(ids).not.toContain('spore-superseded');
      expect(ids).not.toContain('spore-archived');
    });

    it('excludes already-embedded rows (embedded=1)', () => {
      upsertSession(makeSession({ id: 'sess-already', summary: 'Already embedded' }));
      markEmbedded('sessions', 'sess-already');

      upsertSession(makeSession({ id: 'sess-pending', summary: 'Needs embedding' }));

      const rows = source.getEmbeddableRows('sessions', 10);

      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('sess-pending');
    });

    it('returns spore metadata with session_id when present', () => {
      const sessId = 'sess-for-spore';
      upsertSession(makeSession({ id: sessId }));
      insertSpore(makeSpore({
        id: 'spore-with-sess',
        session_id: sessId,
        observation_type: 'gotcha',
      }));

      const rows = source.getEmbeddableRows('spores', 10);

      expect(rows).toHaveLength(1);
      expect(rows[0].metadata.session_id).toBe(sessId);
    });

    it('excludes sessions without summary', () => {
      upsertSession(makeSession({ id: 'sess-no-summary' }));
      upsertSession(makeSession({ id: 'sess-with-summary', summary: 'Has a summary' }));

      const rows = source.getEmbeddableRows('sessions', 10);

      const ids = rows.map((r) => r.id);
      expect(ids).not.toContain('sess-no-summary');
      expect(ids).toContain('sess-with-summary');
    });

    it('throws for invalid namespace', () => {
      expect(() => source.getEmbeddableRows('invalid_table', 10)).toThrow(
        /Invalid namespace/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // getActiveRecordIds
  // -------------------------------------------------------------------------

  describe('getActiveRecordIds', () => {
    it('returns IDs of sessions with summary', () => {
      upsertSession(makeSession({ id: 'sess-with', summary: 'Has summary' }));
      upsertSession(makeSession({ id: 'sess-without' }));

      const ids = source.getActiveRecordIds('sessions');

      expect(ids).toContain('sess-with');
      expect(ids).not.toContain('sess-without');
    });

    it('returns only active spore IDs', () => {
      insertSpore(makeSpore({ id: 'spore-a', status: 'active' }));
      insertSpore(makeSpore({ id: 'spore-s', status: 'superseded' }));

      const ids = source.getActiveRecordIds('spores');

      expect(ids).toContain('spore-a');
      expect(ids).not.toContain('spore-s');
    });

    it('returns plan IDs with content', () => {
      upsertPlan(makePlan({ id: 'plan-has', content: 'Plan content' }));
      upsertPlan(makePlan({ id: 'plan-empty', content: null }));

      const ids = source.getActiveRecordIds('plans');

      expect(ids).toContain('plan-has');
      expect(ids).not.toContain('plan-empty');
    });

    it('returns artifact IDs with content', () => {
      insertArtifact('art-has', 'Artifact content');
      insertArtifact('art-empty', null);

      const ids = source.getActiveRecordIds('artifacts');

      expect(ids).toContain('art-has');
      expect(ids).not.toContain('art-empty');
    });

    it('throws for invalid namespace', () => {
      expect(() => source.getActiveRecordIds('bad')).toThrow(/Invalid namespace/);
    });
  });

  // -------------------------------------------------------------------------
  // getRecordContent
  // -------------------------------------------------------------------------

  describe('getRecordContent', () => {
    it('returns content for specific spore IDs', () => {
      insertSpore(makeSpore({ id: 'spore-c1', content: 'Content one', observation_type: 'gotcha' }));
      insertSpore(makeSpore({ id: 'spore-c2', content: 'Content two', observation_type: 'decision' }));
      insertSpore(makeSpore({ id: 'spore-c3', content: 'Not requested' }));

      const rows = source.getRecordContent('spores', ['spore-c1', 'spore-c2']);

      expect(rows).toHaveLength(2);
      const ids = rows.map((r) => r.id);
      expect(ids).toContain('spore-c1');
      expect(ids).toContain('spore-c2');

      const c1 = rows.find((r) => r.id === 'spore-c1')!;
      expect(c1.text).toBe('Content one');
      expect(c1.metadata.observation_type).toBe('gotcha');
    });

    it('returns empty array for empty ids', () => {
      const rows = source.getRecordContent('sessions', []);
      expect(rows).toEqual([]);
    });

    it('returns session content with project_root metadata', () => {
      upsertSession(makeSession({
        id: 'sess-content',
        summary: 'My session summary',
        project_root: '/workspace',
      }));

      const rows = source.getRecordContent('sessions', ['sess-content']);

      expect(rows).toHaveLength(1);
      expect(rows[0].text).toBe('My session summary');
      expect(rows[0].metadata.project_root).toBe('/workspace');
    });

    it('throws for invalid namespace', () => {
      expect(() => source.getRecordContent('nope', ['id1'])).toThrow(/Invalid namespace/);
    });
  });

  // -------------------------------------------------------------------------
  // markEmbedded / clearEmbedded
  // -------------------------------------------------------------------------

  describe('markEmbedded', () => {
    it('sets embedded=1 on the record', () => {
      upsertSession(makeSession({ id: 'sess-mark', summary: 'Test' }));

      source.markEmbedded('sessions', 'sess-mark');

      const db = getDatabase();
      const row = db.prepare(
        `SELECT embedded FROM sessions WHERE id = ?`,
      ).get('sess-mark') as { embedded: number };
      expect(row.embedded).toBe(1);
    });
  });

  describe('clearEmbedded', () => {
    it('sets embedded=0 on the record', () => {
      upsertSession(makeSession({ id: 'sess-clear', summary: 'Test' }));
      markEmbedded('sessions', 'sess-clear');

      source.clearEmbedded('sessions', 'sess-clear');

      const db = getDatabase();
      const row = db.prepare(
        `SELECT embedded FROM sessions WHERE id = ?`,
      ).get('sess-clear') as { embedded: number };
      expect(row.embedded).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // clearAllEmbedded
  // -------------------------------------------------------------------------

  describe('clearAllEmbedded', () => {
    it('clears all tables when no namespace given', () => {
      const db = getDatabase();

      upsertSession(makeSession({ id: 'sess-ca1', summary: 'Test' }));
      markEmbedded('sessions', 'sess-ca1');

      insertSpore(makeSpore({ id: 'spore-ca1' }));
      markEmbedded('spores', 'spore-ca1');

      source.clearAllEmbedded();

      const sessRow = db.prepare(
        `SELECT embedded FROM sessions WHERE id = ?`,
      ).get('sess-ca1') as { embedded: number };
      const sporeRow = db.prepare(
        `SELECT embedded FROM spores WHERE id = ?`,
      ).get('spore-ca1') as { embedded: number };

      expect(sessRow.embedded).toBe(0);
      expect(sporeRow.embedded).toBe(0);
    });

    it('clears only the specified namespace', () => {
      const db = getDatabase();

      upsertSession(makeSession({ id: 'sess-ca2', summary: 'Test' }));
      markEmbedded('sessions', 'sess-ca2');

      insertSpore(makeSpore({ id: 'spore-ca2' }));
      markEmbedded('spores', 'spore-ca2');

      source.clearAllEmbedded('spores');

      const sessRow = db.prepare(
        `SELECT embedded FROM sessions WHERE id = ?`,
      ).get('sess-ca2') as { embedded: number };
      const sporeRow = db.prepare(
        `SELECT embedded FROM spores WHERE id = ?`,
      ).get('spore-ca2') as { embedded: number };

      // Sessions should remain embedded
      expect(sessRow.embedded).toBe(1);
      // Spores should be cleared
      expect(sporeRow.embedded).toBe(0);
    });

    it('throws for invalid namespace', () => {
      expect(() => source.clearAllEmbedded('bad_table')).toThrow(/Invalid namespace/);
    });
  });
});
