/**
 * Tests for digest_extracts revision history and the dryRun option on
 * upsertDigestExtract (added in schema v15).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertRun } from '@myco/db/queries/runs.js';
import {
  upsertDigestExtract,
  getDigestExtract,
  listDigestRevisions,
  rollbackDigestExtract,
} from '@myco/db/queries/digest-extracts.js';

const epochNow = () => Math.floor(Date.now() / 1000);
const TEST_AGENT_ID = 'agent-digest-test';

describe('digest extract revision helpers', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    registerAgent({ id: TEST_AGENT_ID, name: 'Test', created_at: epochNow() });
  });

  describe('upsertDigestExtract revision behaviour', () => {
    it('creates no revision on first insert (nothing to preserve)', () => {
      upsertDigestExtract({
        agent_id: TEST_AGENT_ID,
        tier: 1500,
        content: 'initial',
        generated_at: 100,
      });
      const revs = listDigestRevisions({ agentId: TEST_AGENT_ID, tier: 1500 });
      expect(revs).toEqual([]);
    });

    it('appends a revision preserving the OLD content on second upsert', () => {
      insertRun({ id: 'run-1', agent_id: TEST_AGENT_ID });
      upsertDigestExtract({
        agent_id: TEST_AGENT_ID,
        tier: 1500,
        content: 'first version',
        generated_at: 100,
      });
      upsertDigestExtract({
        agent_id: TEST_AGENT_ID,
        tier: 1500,
        content: 'second version',
        generated_at: 200,
      }, { runId: 'run-1' });

      const revs = listDigestRevisions({ agentId: TEST_AGENT_ID, tier: 1500 });
      expect(revs).toHaveLength(1);
      // The revision must preserve what was OVERWRITTEN, not what's now live.
      expect(revs[0].content).toBe('first version');
      expect(revs[0].run_id).toBe('run-1');
      expect(revs[0].parent_revision_id).toBeNull();

      const live = getDigestExtract(TEST_AGENT_ID, 1500);
      expect(live!.content).toBe('second version');
    });

    it('chains parent_revision_id across successive upserts', () => {
      upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 1500, content: 'v1', generated_at: 1 });
      upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 1500, content: 'v2', generated_at: 2 });
      upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 1500, content: 'v3', generated_at: 3 });

      const revs = listDigestRevisions({ agentId: TEST_AGENT_ID, tier: 1500 });
      // Newest first: v2 content (overwritten most recently), then v1 content.
      expect(revs.map((r) => r.content)).toEqual(['v2', 'v1']);
      // v1 rev has no parent, v2 rev's parent is the v1 rev's id.
      const v1Rev = revs.find((r) => r.content === 'v1')!;
      const v2Rev = revs.find((r) => r.content === 'v2')!;
      expect(v1Rev.parent_revision_id).toBeNull();
      expect(v2Rev.parent_revision_id).toBe(v1Rev.id);
    });

    it('dryRun: true is a full no-op — no upsert, no revision, returns null', () => {
      upsertDigestExtract({
        agent_id: TEST_AGENT_ID,
        tier: 1500,
        content: 'live content',
        generated_at: 100,
      });

      const result = upsertDigestExtract(
        { agent_id: TEST_AGENT_ID, tier: 1500, content: 'would-be content', generated_at: 200 },
        { dryRun: true, runId: 'run-dry' },
      );
      expect(result).toBeNull();

      const live = getDigestExtract(TEST_AGENT_ID, 1500);
      expect(live!.content).toBe('live content');
      expect(listDigestRevisions({ agentId: TEST_AGENT_ID, tier: 1500 })).toEqual([]);
    });

    it('rolls back the revision and the live-row write atomically on FK failure', async () => {
      // Seed an existing live row so the upsert triggers a revision write.
      upsertDigestExtract({
        agent_id: TEST_AGENT_ID,
        tier: 1500,
        content: 'original',
        generated_at: 100,
      });

      // Passing a non-existent runId makes the revision INSERT fail on the
      // FK to agent_runs. The whole transaction must abort: the live row
      // stays at 'original' AND no orphan revision gets committed.
      expect(() =>
        upsertDigestExtract(
          { agent_id: TEST_AGENT_ID, tier: 1500, content: 'would-be-new', generated_at: 200 },
          { runId: 'run-does-not-exist' },
        ),
      ).toThrow();

      const live = getDigestExtract(TEST_AGENT_ID, 1500);
      expect(live!.content).toBe('original');

      const revs = listDigestRevisions({ agentId: TEST_AGENT_ID, tier: 1500 });
      expect(revs).toEqual([]);
    });

    it('isolates revisions per tier', () => {
      upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 1500, content: 'a1', generated_at: 1 });
      upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 1500, content: 'a2', generated_at: 2 });
      upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 5000, content: 'b1', generated_at: 3 });
      upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 5000, content: 'b2', generated_at: 4 });

      const t1500 = listDigestRevisions({ agentId: TEST_AGENT_ID, tier: 1500 });
      const t5000 = listDigestRevisions({ agentId: TEST_AGENT_ID, tier: 5000 });
      expect(t1500.map((r) => r.content)).toEqual(['a1']);
      expect(t5000.map((r) => r.content)).toEqual(['b1']);
    });
  });

  describe('listDigestRevisions', () => {
    it('returns newest first', () => {
      upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 1500, content: 'v1', generated_at: 1 });
      upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 1500, content: 'v2', generated_at: 2 });
      upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 1500, content: 'v3', generated_at: 3 });

      const revs = listDigestRevisions({ agentId: TEST_AGENT_ID, tier: 1500 });
      // v2 and v1 are in revisions, newest first
      expect(revs.map((r) => r.content)).toEqual(['v2', 'v1']);
    });

    it('honours limit', () => {
      for (let i = 1; i <= 5; i++) {
        upsertDigestExtract({
          agent_id: TEST_AGENT_ID,
          tier: 1500,
          content: `v${i}`,
          generated_at: i,
        });
      }
      // 5 upserts -> 4 revisions
      const revs = listDigestRevisions({ agentId: TEST_AGENT_ID, tier: 1500, limit: 2 });
      expect(revs).toHaveLength(2);
    });

    it('orders deterministically by id even when created_at ties', async () => {
      // All upserts run in the same second; created_at will tie.
      // ORDER BY id DESC must still return them in insertion-reverse order.
      upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 1500, content: 'v1', generated_at: 1 });
      upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 1500, content: 'v2', generated_at: 1 });
      upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 1500, content: 'v3', generated_at: 1 });

      const revs = listDigestRevisions({ agentId: TEST_AGENT_ID, tier: 1500 });
      expect(revs.map((r) => r.content)).toEqual(['v2', 'v1']);

      // Explicitly check that even when we force-equal the created_at value
      // on all revision rows, the sort remains stable by id DESC.
      const { getDatabase } = await import('@myco/db/client.js');
      getDatabase().prepare('UPDATE digest_extract_revisions SET created_at = 100').run();
      const reread = listDigestRevisions({ agentId: TEST_AGENT_ID, tier: 1500 });
      expect(reread.map((r) => r.content)).toEqual(['v2', 'v1']);
    });
  });

  describe('rollbackDigestExtract', () => {
    it('restores the revision content into digest_extracts', () => {
      upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 1500, content: 'v1', generated_at: 1 });
      upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 1500, content: 'v2', generated_at: 2 });

      const revs = listDigestRevisions({ agentId: TEST_AGENT_ID, tier: 1500 });
      // revs[0] is the most recent — content 'v1' (the pre-v2 state).
      const v1Rev = revs[0];
      expect(v1Rev.content).toBe('v1');

      const restored = rollbackDigestExtract({ revisionId: v1Rev.id });
      expect(restored).not.toBeNull();
      expect(restored!.row.content).toBe('v1');
      expect(typeof restored!.newRevisionId).toBe('number');

      const live = getDigestExtract(TEST_AGENT_ID, 1500);
      expect(live!.content).toBe('v1');
    });

    it('appends a new revision row capturing the pre-rollback state', () => {
      insertRun({ id: 'run-rollback', agent_id: TEST_AGENT_ID });
      upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 1500, content: 'v1', generated_at: 1 });
      upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 1500, content: 'v2', generated_at: 2 });

      const before = listDigestRevisions({ agentId: TEST_AGENT_ID, tier: 1500 });
      const v1Rev = before[0]; // content 'v1'
      rollbackDigestExtract({ revisionId: v1Rev.id, runId: 'run-rollback' });

      const after = listDigestRevisions({ agentId: TEST_AGENT_ID, tier: 1500 });
      expect(after.length).toBe(before.length + 1);
      // The new (most-recent) revision preserves the pre-rollback live content ('v2').
      expect(after[0].content).toBe('v2');
      expect(after[0].run_id).toBe('run-rollback');
      const metadata = JSON.parse(after[0].metadata!);
      expect(metadata.rollback_of).toBe(v1Rev.id);
    });

    it('returns null for unknown revision id', () => {
      expect(rollbackDigestExtract({ revisionId: 999999 })).toBeNull();
    });

    it('rollback-of-rollback returns to the originally-live content', () => {
      // Timeline:  v1 -> v2 -> v3  (live is v3; revs contain v1 and v2)
      upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 1500, content: 'v1', generated_at: 1 });
      upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 1500, content: 'v2', generated_at: 2 });
      upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 1500, content: 'v3', generated_at: 3 });

      // Roll back to v1 (newest revision has content 'v2' first, then 'v1').
      const revs = listDigestRevisions({ agentId: TEST_AGENT_ID, tier: 1500 });
      const v1Rev = revs.find((r) => r.content === 'v1')!;
      rollbackDigestExtract({ revisionId: v1Rev.id });

      // Live should now be v1, and a new revision preserved 'v3'.
      expect(getDigestExtract(TEST_AGENT_ID, 1500)!.content).toBe('v1');
      const afterFirstRollback = listDigestRevisions({ agentId: TEST_AGENT_ID, tier: 1500 });
      const v3Rev = afterFirstRollback.find((r) => r.content === 'v3')!;
      expect(v3Rev).toBeDefined();

      // Roll that rollback back: should restore v3.
      rollbackDigestExtract({ revisionId: v3Rev.id });
      expect(getDigestExtract(TEST_AGENT_ID, 1500)!.content).toBe('v3');
    });
  });

  // ---------------------------------------------------------------------------
  // Atomicity (C1): revision-insert + live-row upsert must be transactional.
  // ---------------------------------------------------------------------------

  describe('transaction atomicity', () => {
    /**
     * Force a mid-operation failure between the revision-insert and the
     * live-row upsert by making the ON CONFLICT upsert statement throw.
     * Without a transaction around those two writes, the revision would
     * be persisted while the live row stayed unchanged — an inconsistency
     * the transaction wrapper exists to prevent.
     *
     * Implementation note: we install a temporary shim on `db.prepare`
     * that causes any call matching the live-row INSERT to return a stmt
     * whose `run()` throws. We restore the original prepare before
     * asserting. If the production code ever drops `db.transaction()`,
     * the revision WILL land (assert failure) and this test fails.
     */
    it('upsert: revision is rolled back when the live-row upsert throws mid-transaction', async () => {
      upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 1500, content: 'original', generated_at: 1 });
      expect(listDigestRevisions({ agentId: TEST_AGENT_ID, tier: 1500 })).toEqual([]);

      const { getDatabase } = await import('@myco/db/client.js');
      const db = getDatabase();
      const originalPrepare = db.prepare.bind(db);

      // Shim: force the live-row INSERT into digest_extracts to throw on run().
      (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
        const stmt = originalPrepare(sql);
        if (/INSERT INTO digest_extracts\b/i.test(sql)) {
          const original = stmt.run.bind(stmt);
          stmt.run = (() => {
            // Restore prepare immediately so the implicit post-throw cleanup
            // (rolling back the transaction) proceeds through the normal path.
            (db as unknown as { prepare: typeof db.prepare }).prepare = originalPrepare;
            throw new Error('simulated live-row write failure');
          }) as typeof original;
        }
        return stmt;
      }) as typeof db.prepare;

      try {
        expect(() =>
          upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 1500, content: 'aborted', generated_at: 2 }),
        ).toThrow('simulated live-row write failure');
      } finally {
        (db as unknown as { prepare: typeof db.prepare }).prepare = originalPrepare;
      }

      // Live row unchanged AND no revision persisted — both writes rolled back.
      expect(getDigestExtract(TEST_AGENT_ID, 1500)!.content).toBe('original');
      expect(listDigestRevisions({ agentId: TEST_AGENT_ID, tier: 1500 })).toEqual([]);
    });

    it('rollback: pre-rollback snapshot is rolled back when the restore upsert throws', async () => {
      upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 1500, content: 'v1', generated_at: 1 });
      upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 1500, content: 'v2', generated_at: 2 });

      const revs = listDigestRevisions({ agentId: TEST_AGENT_ID, tier: 1500 });
      const v1Rev = revs[0];
      const beforeRevCount = revs.length;

      const { getDatabase } = await import('@myco/db/client.js');
      const db = getDatabase();
      const originalPrepare = db.prepare.bind(db);

      (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
        const stmt = originalPrepare(sql);
        if (/INSERT INTO digest_extracts\b/i.test(sql)) {
          stmt.run = (() => {
            (db as unknown as { prepare: typeof db.prepare }).prepare = originalPrepare;
            throw new Error('simulated rollback-restore failure');
          }) as typeof stmt.run;
        }
        return stmt;
      }) as typeof db.prepare;

      try {
        expect(() =>
          rollbackDigestExtract({ revisionId: v1Rev.id }),
        ).toThrow('simulated rollback-restore failure');
      } finally {
        (db as unknown as { prepare: typeof db.prepare }).prepare = originalPrepare;
      }

      // Live row still at v2 AND the "pre-rollback snapshot" revision
      // didn't sneak in.
      expect(getDigestExtract(TEST_AGENT_ID, 1500)!.content).toBe('v2');
      expect(listDigestRevisions({ agentId: TEST_AGENT_ID, tier: 1500 }).length).toBe(beforeRevCount);
    });
  });

  // ---------------------------------------------------------------------------
  // FK behaviour pinning (I3): digest_extract_revisions.run_id has
  // ON DELETE SET NULL; it must NOT cascade when the originating run is
  // deleted.
  // ---------------------------------------------------------------------------

  describe('FK behaviour: ON DELETE SET NULL on run_id', () => {
    it('sets revision.run_id to NULL when the originating run is deleted', async () => {
      insertRun({ id: 'run-x', agent_id: TEST_AGENT_ID });
      upsertDigestExtract({ agent_id: TEST_AGENT_ID, tier: 1500, content: 'v1', generated_at: 1 });
      upsertDigestExtract(
        { agent_id: TEST_AGENT_ID, tier: 1500, content: 'v2', generated_at: 2 },
        { runId: 'run-x' },
      );

      const before = listDigestRevisions({ agentId: TEST_AGENT_ID, tier: 1500 });
      expect(before[0].run_id).toBe('run-x');

      const { getDatabase } = await import('@myco/db/client.js');
      getDatabase().prepare('DELETE FROM agent_runs WHERE id = ?').run('run-x');

      const after = listDigestRevisions({ agentId: TEST_AGENT_ID, tier: 1500 });
      expect(after).toHaveLength(before.length); // row not deleted
      expect(after[0].run_id).toBeNull(); // but run_id SET NULL
    });
  });
});
