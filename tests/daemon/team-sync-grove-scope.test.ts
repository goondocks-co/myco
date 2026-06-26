import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { setupTestDb, teardownTestDb, cleanTestDb } from '../helpers/db.js';
import { getDatabase } from '@myco/db/client.js';
import { setTeamSyncEnabled, setProjectSyncMembership } from '@myco/db/queries/team-sync-state.js';
import {
  backfillAll,
  backfillAllForRebuild,
  backfillProjectForTeam,
  countPending,
} from '@myco/db/queries/team-outbox.js';

describe('rebuildFromLocal local half: backfillAll re-enqueues the Grove', () => {
  beforeAll(() => setupTestDb());
  afterAll(() => teardownTestDb());
  beforeEach(() => cleanTestDb());

  it('backfillAll enqueues a sync-eligible row even when already marked synced', () => {
    const db = getDatabase();
    setTeamSyncEnabled(true, db);
    setProjectSyncMembership([{ project_id: 'proj_x', team_id: 'team-a' }], db);
    // agents row required by spores.agent_id FK
    db.prepare(
      `INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('user','user','built-in',1,1)`,
    ).run();
    db.prepare(
      `INSERT INTO spores (id, project_id, agent_id, observation_type, status, content, created_at, machine_id, synced_at)
       VALUES ('sp_rebuild','proj_x','user','decision','active','c',1,'local',12345)`,
    ).run();
    const enqueued = backfillAll('local');
    expect(enqueued).toBeGreaterThanOrEqual(1);
    expect(countPending()).toBeGreaterThanOrEqual(1);
  });
});

describe('backfillAllForRebuild: includes skill_usage; backfillAll does not', () => {
  beforeAll(() => setupTestDb());
  afterAll(() => teardownTestDb());
  beforeEach(() => cleanTestDb());

  /**
   * Insert the FK chain required for a skill_usage row:
   *   agents → sessions + skill_records → skill_usage
   */
  function seedSkillUsage(db: ReturnType<typeof getDatabase>): void {
    db.prepare(
      `INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at)
       VALUES ('user', 'user', 'built-in', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, agent, started_at, created_at, machine_id)
       VALUES ('sess_su', 'user', 1, 1, 'local')`,
    ).run();
    db.prepare(
      `INSERT INTO skill_records
         (id, agent_id, machine_id, name, display_name, description, status, path, created_at, updated_at)
       VALUES ('sr_su', 'user', 'local', 'test-skill', 'Test Skill', 'desc', 'active', '/tmp/test.md', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO skill_usage (id, project_id, skill_id, session_id, machine_id, detected_at)
       VALUES ('su_1', 'proj_su', 'sr_su', 'sess_su', 'local', 1)`,
    ).run();
  }

  it('backfillAllForRebuild enqueues skill_usage rows', () => {
    const db = getDatabase();
    setTeamSyncEnabled(true, db);
    setProjectSyncMembership([{ project_id: 'proj_su', team_id: 'team-a' }], db);
    seedSkillUsage(db);

    const enqueued = backfillAllForRebuild('local');

    // At minimum the skill_usage row must be enqueued
    expect(enqueued).toBeGreaterThanOrEqual(1);
    const pendingRows = db.prepare(
      `SELECT table_name FROM team_outbox WHERE sent_at IS NULL AND table_name = 'skill_usage'`,
    ).all() as Array<{ table_name: string }>;
    expect(pendingRows.length).toBe(1);
  });

  it('backfillAll does NOT enqueue skill_usage rows', () => {
    const db = getDatabase();
    setTeamSyncEnabled(true, db);
    setProjectSyncMembership([{ project_id: 'proj_su', team_id: 'team-a' }], db);
    seedSkillUsage(db);

    backfillAll('local');

    const skillUsageRows = db.prepare(
      `SELECT table_name FROM team_outbox WHERE sent_at IS NULL AND table_name = 'skill_usage'`,
    ).all() as Array<{ table_name: string }>;
    expect(skillUsageRows.length).toBe(0);
  });

  it('backfillProjectForTeam re-enqueues skill_usage for a re-added project', () => {
    const db = getDatabase();
    setTeamSyncEnabled(true, db);
    setProjectSyncMembership([{ project_id: 'proj_su', team_id: 'team-a' }], db);
    seedSkillUsage(db);

    const enqueued = backfillProjectForTeam('local', 'proj_su', 'team-a');

    expect(enqueued).toBeGreaterThanOrEqual(1);
    const row = db.prepare(
      `SELECT table_name, team_id, project_id
         FROM team_outbox
        WHERE sent_at IS NULL AND table_name = 'skill_usage'`,
    ).get() as { table_name: string; team_id: string | null; project_id: string | null } | undefined;
    expect(row).toEqual({ table_name: 'skill_usage', team_id: 'team-a', project_id: 'proj_su' });
  });
});
