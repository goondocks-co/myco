import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import { getDatabase } from '@myco/db/client.js';
import { getTeamSyncEnabled, setTeamSyncEnabled, setProjectSyncMembership } from '@myco/db/queries/team-sync-state.js';
import { syncRow } from '@myco/db/queries/team-outbox.js';

describe('team_sync_state', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('defaults to disabled when no row exists', () => {
    expect(getTeamSyncEnabled()).toBe(false);
  });

  it('round-trips enabled state via UPSERT (single row)', () => {
    setTeamSyncEnabled(true);
    expect(getTeamSyncEnabled()).toBe(true);
    setTeamSyncEnabled(false);
    expect(getTeamSyncEnabled()).toBe(false);
    const db = getDatabase();
    const count = db.prepare('SELECT COUNT(*) AS n FROM team_sync_state').get() as { n: number };
    expect(count.n).toBe(1);
  });
});

describe('syncRow gate reads team_sync_membership (project-scoped)', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('does not enqueue when the project is not a sync member', () => {
    // No setProjectSyncMembership -> the project is absent from team_sync_membership.
    syncRow('spores', { id: 'sp_gate1', project_id: 'proj_x', created_at: 1 } as never);
    const n = getDatabase().prepare(`SELECT COUNT(*) AS n FROM team_outbox WHERE row_id='sp_gate1'`).get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('enqueues an upsert when the project is a sync member', () => {
    setProjectSyncMembership([{ project_id: 'proj_x', team_id: 'team_x' }]);
    syncRow('spores', { id: 'sp_gate2', project_id: 'proj_x', created_at: 1 } as never);
    const rows = getDatabase().prepare(`SELECT operation, row_id FROM team_outbox WHERE row_id='sp_gate2'`).all() as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows[0].operation).toBe('upsert');
  });
});
