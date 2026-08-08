/**
 * Residency backfill (Phase F) — enqueue one project's rows for the attach push.
 *
 * Verifies the project-scoped, membership-free enqueue (only the target
 * project's rows, null team_id, idempotent, sanitize strip preserved) and the
 * generic sidecar pager (composite-key paging; the `content_publications`
 * artifact→project join).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { getDatabase } from '@myco/db/client.js';
import { listPending, listPendingForProject } from '@myco/db/queries/team-outbox.js';
import {
  backfillProjectForResidency,
  deleteContentPublicationsForProject,
  listSidecarPage,
} from '@myco/db/queries/residency-backfill.js';
import { RESIDENCY_SIDECARS } from '@myco/db/queries/residency-apply.js';

/** The declared sidecar for `table` — the pager is driven by declaration, so a
 *  test that hand-rolled the key would stop testing what the drain actually sends. */
const sidecar = (table: string) => RESIDENCY_SIDECARS.find((s) => s.table === table)!;

const PROJ_A = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PROJ_B = 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function seedWithoutFk(fn: () => void): void {
  const db = getDatabase();
  db.run('PRAGMA foreign_keys = OFF');
  try { fn(); } finally { db.run('PRAGMA foreign_keys = ON'); }
}

function insertSpore(id: string, projectId: string): void {
  getDatabase().prepare(
    `INSERT INTO spores (id, project_id, agent_id, observation_type, content, created_at, machine_id)
     VALUES (?, ?, 'user', 'decision', 'c', 1, 'local')`,
  ).run(id, projectId);
}

describe('backfillProjectForresidency', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  test('enqueues only the target project\'s rows, with a null team_id', () => {
    seedWithoutFk(() => {
      insertSpore('sp_a1', PROJ_A);
      insertSpore('sp_a2', PROJ_A);
      insertSpore('sp_b1', PROJ_B);
    });

    const enqueued = backfillProjectForResidency(PROJ_A, 'local');
    expect(enqueued).toBe(2);

    const pending = listPendingForProject(PROJ_A);
    expect(pending.map((r) => r.row_id).sort()).toEqual(['sp_a1', 'sp_a2']);
    expect(pending.every((r) => r.team_id === null)).toBe(true);
    // Project B was untouched.
    expect(listPendingForProject(PROJ_B)).toHaveLength(0);
  });

  test('is idempotent — a resumed run does not double-enqueue rows still pending', () => {
    seedWithoutFk(() => insertSpore('sp_a1', PROJ_A));

    expect(backfillProjectForResidency(PROJ_A, 'local')).toBe(1);
    expect(backfillProjectForResidency(PROJ_A, 'local')).toBe(0);
    expect(listPending().filter((r) => r.row_id === 'sp_a1')).toHaveLength(1);
  });

  test('cross-table send order matches enqueue order under the shared backfill timestamp (parent before child)', () => {
    // The backfill stamps every table with ONE timestamp, so created_at alone
    // leaves order unspecified; the id tiebreak must keep the FK-topological
    // enqueue order (sessions before prompt_batches) so a child never ships
    // ahead of its parent and wedges the give-up-on-409 drain.
    seedWithoutFk(() => {
      const db = getDatabase();
      db.prepare(`INSERT INTO sessions (id, agent, started_at, created_at, project_id, machine_id) VALUES ('sess1', 'claude-code', 1, 1, ?, 'local')`).run(PROJ_A);
      db.prepare(`INSERT INTO prompt_batches (id, project_id, session_id, created_at, machine_id) VALUES ('pbatch1', ?, 'sess1', 1, 'local')`).run(PROJ_A);
    });

    backfillProjectForResidency(PROJ_A, 'local');

    const pending = listPendingForProject(PROJ_A);
    expect(pending.map((r) => r.table_name)).toEqual(['sessions', 'prompt_batches']);
    // Equal timestamps, so it is the id order (enqueue order) doing the work.
    expect(pending[0].created_at).toBe(pending[1].created_at);
    expect(pending[0].id).toBeLessThan(pending[1].id);
  });

  test('strips local-only columns from the shipped payload (knowledge_release_state.basis_ref)', () => {
    seedWithoutFk(() => {
      getDatabase().prepare(
        `INSERT INTO knowledge_release_state
           (id, project_id, machine_id, identity_key, namespace, record_id, state, confidence, basis_ref, checked_at, created_at)
         VALUES ('krel_x', ?, 'local', 'idk', 'ns', 'rid', 'released', 'high', 'feat/secret-branch', 1, 1)`,
      ).run(PROJ_A);
    });

    backfillProjectForResidency(PROJ_A, 'local');

    const row = listPendingForProject(PROJ_A).find((r) => r.table_name === 'knowledge_release_state');
    expect(row).toBeDefined();
    expect('basis_ref' in row!.payload).toBe(false);
    expect(row!.payload.id).toBe('krel_x');
  });
});

describe('residency sidecar enumerators', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  test('the pager walks entity_mentions by its four-column key and scopes to the project', () => {
    seedWithoutFk(() => {
      const db = getDatabase();
      const insert = db.prepare(
        `INSERT INTO entity_mentions (project_id, entity_id, note_id, note_type, agent_id, machine_id)
         VALUES (?, ?, ?, ?, ?, 'local')`,
      );
      insert.run(PROJ_A, 'ent_1', 'note_1', 'session', 'user');
      insert.run(PROJ_A, 'ent_1', 'note_2', 'session', 'user');
      insert.run(PROJ_A, 'ent_2', 'note_1', 'session', 'user');
      insert.run(PROJ_B, 'ent_9', 'note_9', 'session', 'user'); // other project
    });

    const page1 = listSidecarPage(sidecar('entity_mentions'), PROJ_A, null, 2);
    expect(page1.rows).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = listSidecarPage(sidecar('entity_mentions'), PROJ_A, page1.nextCursor, 2);
    expect(page2.rows).toHaveLength(1); // 3 rows total for A, none for B
    expect(page2.nextCursor).toBeNull();

    const allIds = [...page1.rows, ...page2.rows].map((r) => r.entity_id);
    expect(allIds.every((id) => id === 'ent_1' || id === 'ent_2')).toBe(true);
  });

  test('the pager joins content_publications to the project through their artifacts', () => {
    seedWithoutFk(() => {
      const db = getDatabase();
      db.prepare(
        `INSERT INTO skill_records (id, project_id, agent_id, name, display_name, description, path, created_at, updated_at)
         VALUES ('skill_a', ?, 'user', 'a', 'A', 'd', 'p', 1, 1)`,
      ).run(PROJ_A);
      db.prepare(
        `INSERT INTO skill_records (id, project_id, agent_id, name, display_name, description, path, created_at, updated_at)
         VALUES ('skill_b', ?, 'user', 'b', 'B', 'd', 'p', 1, 1)`,
      ).run(PROJ_B);
      const pub = db.prepare(
        `INSERT INTO content_publications (artifact_kind, artifact_id, published_generation, published_at, published_by, machine_id)
         VALUES ('skill', ?, 1, 1, 'user', 'local')`,
      );
      pub.run('skill_a');
      pub.run('skill_b');
    });

    const page = listSidecarPage(sidecar('content_publications'), PROJ_A, null, 50);
    expect(page.rows.map((r) => r.artifact_id)).toEqual(['skill_a']); // only A's artifact
    expect(page.nextCursor).toBeNull();
  });

  test('deleteContentPublicationsForProject removes only the project\'s publications', () => {
    seedWithoutFk(() => {
      const db = getDatabase();
      db.prepare(
        `INSERT INTO skill_records (id, project_id, agent_id, name, display_name, description, path, created_at, updated_at)
         VALUES ('skill_a', ?, 'user', 'a', 'A', 'd', 'p', 1, 1)`,
      ).run(PROJ_A);
      db.prepare(
        `INSERT INTO skill_records (id, project_id, agent_id, name, display_name, description, path, created_at, updated_at)
         VALUES ('skill_b', ?, 'user', 'b', 'B', 'd', 'p', 1, 1)`,
      ).run(PROJ_B);
      const pub = db.prepare(
        `INSERT INTO content_publications (artifact_kind, artifact_id, published_generation, published_at, published_by, machine_id)
         VALUES ('skill', ?, 1, 1, 'user', 'local')`,
      );
      pub.run('skill_a');
      pub.run('skill_b');
    });

    expect(deleteContentPublicationsForProject(PROJ_A)).toBe(1);
    const remaining = getDatabase().prepare(`SELECT artifact_id FROM content_publications`).all() as Array<{ artifact_id: string }>;
    expect(remaining.map((r) => r.artifact_id)).toEqual(['skill_b']);
  });
});
