/**
 * Tests for plan CRUD query helpers.
 *
 * Each test initializes an in-memory PGlite instance, creates the schema,
 * exercises the query function, and tears down the database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import {
  upsertPlan,
  deletePlan,
  getPlan,
  getPlanByLogicalKey,
  listPlans,
  listPlansBySession,
} from '@myco/db/queries/plans.js';
import type { PlanInsert } from '@myco/db/queries/plans.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import type { SessionInsert } from '@myco/db/queries/sessions.js';
import { buildPlanId } from '@myco/plans/identity.js';
import { getDatabase } from '@myco/db/client.js';
import { setTeamSyncEnabled } from '@myco/db/queries/team-sync-state.js';
import { initTeamContext, resetTeamContext } from '@myco/team/context.js';
import { ALL_PROJECTS_SCOPE, GLOBAL_SCOPE, projectScope, type GroveProjectId } from '@myco/grove/ids.js';

/** Epoch seconds helper. */
const epochNow = () => Math.floor(Date.now() / 1000);

/** Factory for minimal valid plan data. */
function makePlan(overrides: Partial<PlanInsert> = {}): PlanInsert {
  const now = epochNow();
  const logicalKey = overrides.logical_key ?? `test:${overrides.id ?? Math.random().toString(36).slice(2, 8)}`;
  return {
    id: overrides.id ?? buildPlanId(logicalKey),
    logical_key: logicalKey,
    created_at: now,
    ...overrides,
  };
}

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

describe('plan query helpers', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });
  afterEach(() => { resetTeamContext(); });

  // ---------------------------------------------------------------------------
  // upsertPlan + getPlan
  // ---------------------------------------------------------------------------

  describe('upsertPlan', () => {
    it('preserves an existing row id on update even when the incoming id differs', () => {
      // Post-migration shape: a re-keyed logical_key but the ORIGINAL
      // (path-derived) id retained. A later re-sweep recomputes the id from the
      // new key; upsertPlan must NOT re-home the found row's id onto it, or every
      // reference keyed on the original id (lineage edges, team-sync D1 row)
      // silently orphans.
      const logicalKey = 'session:s1:file:docs/x.md';
      upsertPlan({ id: 'legacy-path-id', logical_key: logicalKey, content: '# v1', created_at: 1000, machine_id: 'local' });
      const recomputedId = buildPlanId(logicalKey);
      expect(recomputedId).not.toBe('legacy-path-id');

      const updated = upsertPlan({ id: recomputedId, logical_key: logicalKey, content: '# v2', created_at: 2000, machine_id: 'local' });
      expect(updated.id).toBe('legacy-path-id');
      expect(updated.content).toBe('# v2');
      expect(getPlan('legacy-path-id', ALL_PROJECTS_SCOPE)?.content).toBe('# v2');
    });

    it('inserts a new plan and retrieves it', async () => {
      const data = makePlan({ title: 'Migration plan' });
      const row = upsertPlan(data);

      expect(row.id).toBe(data.id);
      expect(row.title).toBe('Migration plan');
      expect(row.status).toBe('active');
      expect(row.processed).toBe(0);

      const fetched = getPlan(data.id, ALL_PROJECTS_SCOPE);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(data.id);
      expect(fetched!.title).toBe('Migration plan');
    });

    it('stores all optional fields', async () => {
      const data = makePlan({
        title: 'Full plan',
        author: 'chris',
        content: '## Steps\n1. Do thing\n2. Do other thing',
        source_path: 'plans/migration.md',
        tags: 'v2,migration',
        status: 'draft',
      });
      const row = upsertPlan(data);

      expect(row.author).toBe('chris');
      expect(row.content).toBe('## Steps\n1. Do thing\n2. Do other thing');
      expect(row.source_path).toBe('plans/migration.md');
      expect(row.tags).toBe('v2,migration');
      expect(row.status).toBe('draft');
    });

    it('stores logical_key and upserts on logical-key conflict', async () => {
      const logicalKey = 'path:plans/roadmap.md';
      const first = makePlan({ id: 'plan-a', logical_key: logicalKey, title: 'Original' });
      const second = makePlan({ id: 'plan-b', logical_key: logicalKey, title: 'Updated' });

      upsertPlan(first);
      const row = upsertPlan(second);

      expect(row.logical_key).toBe(logicalKey);
      // id is stable — keyed by logical_key, not re-homed to the incoming id.
      expect(row.id).toBe('plan-a');
      expect(listPlans({ scope: ALL_PROJECTS_SCOPE })).toHaveLength(1);
      expect(getPlan('plan-a', ALL_PROJECTS_SCOPE)?.title).toBe('Updated');
      expect(getPlan('plan-b', ALL_PROJECTS_SCOPE)).toBeNull();
    });

    it('allows the same logical_key in different project scopes', async () => {
      const logicalKey = 'path:plans/roadmap.md';
      upsertPlan(makePlan({
        id: 'plan-project-a',
        project_id: 'proj_a',
        logical_key: logicalKey,
        title: 'Project A original',
      }));
      upsertPlan(makePlan({
        id: 'plan-project-b',
        project_id: 'proj_b',
        logical_key: logicalKey,
        title: 'Project B',
      }));

      const updated = upsertPlan(makePlan({
        id: 'plan-project-a-updated',
        project_id: 'proj_a',
        logical_key: logicalKey,
        title: 'Project A updated',
      }));

      // proj_a row keeps its original id; only content/title update.
      expect(updated.id).toBe('plan-project-a');
      expect(updated.project_id).toBe('proj_a');
      expect(listPlans({ scope: ALL_PROJECTS_SCOPE })).toHaveLength(2);
      expect(getPlan('plan-project-a', ALL_PROJECTS_SCOPE)?.title).toBe('Project A updated');
      expect(getPlan('plan-project-a-updated', ALL_PROJECTS_SCOPE)).toBeNull();
      expect(getPlan('plan-project-b', ALL_PROJECTS_SCOPE)?.title).toBe('Project B');
      expect(getPlan('plan-project-b', ALL_PROJECTS_SCOPE)?.project_id).toBe('proj_b');
    });

    it('is idempotent — second upsert updates without error', async () => {
      const data = makePlan({ title: 'Original' });
      upsertPlan(data);
      upsertPlan({ ...data, title: 'Updated' });

      const row = getPlan(data.id, ALL_PROJECTS_SCOPE);
      expect(row).not.toBeNull();
      expect(row!.title).toBe('Updated');
    });

    it('updates status on conflict', async () => {
      const data = makePlan({ title: 'Plan', status: 'active' });
      upsertPlan(data);

      upsertPlan({ ...data, status: 'completed' });

      const row = getPlan(data.id, ALL_PROJECTS_SCOPE);
      expect(row!.status).toBe('completed');
    });

    it('sets updated_at on conflict update', async () => {
      const now = epochNow();
      const data = makePlan({ created_at: now });
      upsertPlan(data);

      const later = now + 60;
      upsertPlan({ ...data, title: 'Changed', updated_at: later });

      const row = getPlan(data.id, ALL_PROJECTS_SCOPE);
      expect(row!.updated_at).toBe(later);
    });
  });

  // ---------------------------------------------------------------------------
  // getPlan
  // ---------------------------------------------------------------------------

  describe('getPlan', () => {
    it('returns null for non-existent id', async () => {
      const row = getPlan('does-not-exist', ALL_PROJECTS_SCOPE);
      expect(row).toBeNull();
    });
  });

  describe('deletePlan', () => {
    it('deletes a plan row by id', () => {
      const data = makePlan({ title: 'Delete me' });
      upsertPlan(data);

      const deleted = deletePlan(data.id, ALL_PROJECTS_SCOPE);

      expect(deleted?.id).toBe(data.id);
      expect(getPlan(data.id, ALL_PROJECTS_SCOPE)).toBeNull();
    });

    it('returns null when the plan does not exist', () => {
      expect(deletePlan('missing-plan', ALL_PROJECTS_SCOPE)).toBeNull();
    });

    it('journals a delete tombstone via the plans_team_ad trigger when enabled', () => {
      const projectId = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const data = makePlan({ id: 'plan-delete-scoped', project_id: projectId, title: 'Delete scoped' });
      upsertPlan(data);
      initTeamContext('machine-a');
      // The delete tombstone is journaled by the plans_team_ad trigger, which
      // gates on this Grove's per-Grove team_sync_state flag.
      setTeamSyncEnabled(true);

      deletePlan(data.id, projectScope(projectId as GroveProjectId));

      const row = getDatabase().prepare(
        "SELECT payload FROM team_outbox WHERE table_name = 'plans' AND row_id = ? AND operation = 'delete'",
      ).get(data.id) as { payload: string };
      // The trigger payload carries id + machine_id (no project_id — D1 only
      // needs the row id to apply the delete).
      expect(JSON.parse(row.payload)).toMatchObject({ id: data.id });
    });

    it('does not journal a delete tombstone when the Grove flag is disabled', () => {
      const projectId = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const data = makePlan({ id: 'plan-delete-disabled', project_id: projectId, title: 'Delete disabled' });
      upsertPlan(data);
      initTeamContext('machine-a');
      setTeamSyncEnabled(false);

      deletePlan(data.id, projectScope(projectId as GroveProjectId));

      const n = getDatabase().prepare(
        "SELECT COUNT(*) AS n FROM team_outbox WHERE table_name = 'plans' AND row_id = ? AND operation = 'delete'",
      ).get(data.id) as { n: number };
      expect(n.n).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // listPlans
  // ---------------------------------------------------------------------------

  describe('listPlans', () => {
    it('returns plans ordered by created_at DESC', async () => {
      const now = epochNow();
      upsertPlan(makePlan({ id: 'plan-old', created_at: now - 100 }));
      upsertPlan(makePlan({ id: 'plan-mid', created_at: now - 50 }));
      upsertPlan(makePlan({ id: 'plan-new', created_at: now }));

      const rows = listPlans({ scope: ALL_PROJECTS_SCOPE });
      expect(rows).toHaveLength(3);
      expect(rows[0].id).toBe('plan-new');
      expect(rows[1].id).toBe('plan-mid');
      expect(rows[2].id).toBe('plan-old');
    });

    it('filters by status', async () => {
      const now = epochNow();
      upsertPlan(makePlan({ id: 'plan-active', status: 'active', created_at: now }));
      upsertPlan(makePlan({ id: 'plan-done', status: 'completed', created_at: now + 1 }));
      upsertPlan(makePlan({ id: 'plan-draft', status: 'draft', created_at: now + 2 }));

      const rows = listPlans({ status: 'active', scope: ALL_PROJECTS_SCOPE });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('plan-active');
    });

    it('respects the limit option', async () => {
      const now = epochNow();
      for (let i = 0; i < 5; i++) {
        upsertPlan(makePlan({ created_at: now + i }));
      }

      const rows = listPlans({ limit: 2, scope: ALL_PROJECTS_SCOPE });
      expect(rows).toHaveLength(2);
    });

    it('combines status and limit filters', async () => {
      const now = epochNow();
      for (let i = 0; i < 5; i++) {
        upsertPlan(makePlan({ status: 'active', created_at: now + i }));
      }
      upsertPlan(makePlan({ status: 'completed', created_at: now + 10 }));

      const rows = listPlans({ status: 'active', limit: 3, scope: ALL_PROJECTS_SCOPE });
      expect(rows).toHaveLength(3);
      // All should be active
      for (const row of rows) {
        expect(row.status).toBe('active');
      }
    });

    it('returns empty array when no plans match', async () => {
      const rows = listPlans({ status: 'nonexistent', scope: ALL_PROJECTS_SCOPE });
      expect(rows).toEqual([]);
    });

    it('returns empty array when no plans exist', async () => {
      const rows = listPlans({ scope: ALL_PROJECTS_SCOPE });
      expect(rows).toEqual([]);
    });

    it('filters by explicit project scope', async () => {
      const now = epochNow();
      const logicalKey = 'path:plans/shared.md';
      upsertPlan(makePlan({
        id: 'plan-legacy',
        logical_key: logicalKey,
        created_at: now,
      }));
      upsertPlan(makePlan({
        id: 'plan-a',
        project_id: 'proj_a',
        logical_key: logicalKey,
        created_at: now + 1,
      }));
      upsertPlan(makePlan({
        id: 'plan-b',
        project_id: 'proj_b',
        logical_key: logicalKey,
        created_at: now + 2,
      }));

      expect(getPlan('plan-a', projectScope('proj_a' as GroveProjectId))?.project_id).toBe('proj_a');
      expect(getPlan('plan-a', projectScope('proj_b' as GroveProjectId))).toBeNull();
      expect(getPlanByLogicalKey(logicalKey, projectScope('proj_b' as GroveProjectId))?.id).toBe('plan-b');
      expect(listPlans({ scope: GLOBAL_SCOPE}).map((row) => row.id)).toEqual(['plan-legacy']);
      expect(listPlans({ scope: projectScope('proj_a' as GroveProjectId)}).map((row) => row.id)).toEqual(['plan-a']);
    });
  });

  // ---------------------------------------------------------------------------
  // session_id, prompt_batch_id, content_hash columns
  // ---------------------------------------------------------------------------

  describe('session_id and content_hash columns', () => {
    it('stores session_id when provided', async () => {
      const session = makeSession();
      upsertSession(session);

      const data = makePlan({ session_id: session.id });
      const row = upsertPlan(data);

      expect(row.session_id).toBe(session.id);
    });

    it('stores content_hash when provided', async () => {
      const data = makePlan({ content_hash: 'abc123hash' });
      const row = upsertPlan(data);

      expect(row.content_hash).toBe('abc123hash');
    });

    it('defaults session_id and content_hash to null when not provided', async () => {
      const data = makePlan();
      const row = upsertPlan(data);

      expect(row.session_id).toBeNull();
      expect(row.content_hash).toBeNull();
    });

    it('upsert updates session_id association on conflict', async () => {
      const session1 = makeSession();
      const session2 = makeSession();
      upsertSession(session1);
      upsertSession(session2);

      const data = makePlan({ session_id: session1.id });
      upsertPlan(data);
      upsertPlan({ ...data, session_id: session2.id });

      const row = getPlan(data.id, ALL_PROJECTS_SCOPE);
      expect(row!.session_id).toBe(session2.id);
    });

    it('preserves embedded flag when content_hash is unchanged on conflict', async () => {
      const data = makePlan({ content_hash: 'stable-hash' });
      // Insert then manually mark as embedded
      upsertPlan(data);

      // Simulate embedding having been set
      const db = (await import('@myco/db/client.js')).getDatabase();
      db.prepare(`UPDATE plans SET embedded = 1 WHERE id = ?`).run(data.id);

      // Re-upsert with same content_hash
      upsertPlan({ ...data, title: 'Same content, new title' });

      const row = getPlan(data.id, ALL_PROJECTS_SCOPE);
      expect(row!.embedded).toBe(1);
    });

    it('resets embedded flag when content_hash changes on conflict', async () => {
      const data = makePlan({ content_hash: 'original-hash' });
      upsertPlan(data);

      // Simulate embedding having been set
      const db = (await import('@myco/db/client.js')).getDatabase();
      db.prepare(`UPDATE plans SET embedded = 1 WHERE id = ?`).run(data.id);

      // Re-upsert with different content_hash
      upsertPlan({ ...data, content_hash: 'updated-hash' });

      const row = getPlan(data.id, ALL_PROJECTS_SCOPE);
      expect(row!.embedded).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // listPlansBySession
  // ---------------------------------------------------------------------------

  describe('listPlansBySession', () => {
    it('returns plans for the given session ordered by created_at DESC', async () => {
      const session = makeSession();
      upsertSession(session);

      const now = epochNow();
      upsertPlan(makePlan({ id: 'plan-old', session_id: session.id, created_at: now - 100 }));
      upsertPlan(makePlan({ id: 'plan-new', session_id: session.id, created_at: now }));

      const rows = listPlansBySession(session.id, ALL_PROJECTS_SCOPE);
      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe('plan-new');
      expect(rows[1].id).toBe('plan-old');
    });

    it('excludes plans from other sessions', async () => {
      const session1 = makeSession();
      const session2 = makeSession();
      upsertSession(session1);
      upsertSession(session2);

      upsertPlan(makePlan({ id: 'plan-s1', session_id: session1.id }));
      upsertPlan(makePlan({ id: 'plan-s2', session_id: session2.id }));
      upsertPlan(makePlan({ id: 'plan-none' })); // no session

      const rows = listPlansBySession(session1.id, ALL_PROJECTS_SCOPE);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe('plan-s1');
    });

    it('returns empty array for session with no plans', async () => {
      const session = makeSession();
      upsertSession(session);

      const rows = listPlansBySession(session.id, ALL_PROJECTS_SCOPE);
      expect(rows).toEqual([]);
    });

    it('returns empty array for unknown session id', async () => {
      const rows = listPlansBySession('nonexistent-session', ALL_PROJECTS_SCOPE);
      expect(rows).toEqual([]);
    });

    it('filters session plans by explicit project scope', async () => {
      const session = makeSession();
      upsertSession(session);

      upsertPlan(makePlan({ id: 'plan-legacy', session_id: session.id, created_at: 1 }));
      upsertPlan(makePlan({ id: 'plan-a', project_id: 'proj_a', session_id: session.id, created_at: 2 }));
      upsertPlan(makePlan({ id: 'plan-b', project_id: 'proj_b', session_id: session.id, created_at: 3 }));

      expect(listPlansBySession(session.id, GLOBAL_SCOPE).map((row) => row.id)).toEqual(['plan-legacy']);
      expect(listPlansBySession(session.id, projectScope('proj_a' as GroveProjectId)).map((row) => row.id)).toEqual(['plan-a']);
    });
  });
});
