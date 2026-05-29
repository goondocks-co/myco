import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { setupTestDb, teardownTestDb, cleanTestDb } from '../helpers/db.js';
import { getDatabase } from '@myco/db/client.js';
import { setTeamSyncEnabled } from '@myco/db/queries/team-sync-state.js';
import { backfillAll, countPending } from '@myco/db/queries/team-outbox.js';

describe('rebuildFromLocal local half: backfillAll re-enqueues the Grove', () => {
  beforeAll(() => setupTestDb());
  afterAll(() => teardownTestDb());
  beforeEach(() => cleanTestDb());

  it('backfillAll enqueues a sync-eligible row even when already marked synced', () => {
    const db = getDatabase();
    setTeamSyncEnabled(true, db);
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
