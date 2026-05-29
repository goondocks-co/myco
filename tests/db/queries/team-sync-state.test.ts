import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import { getDatabase } from '@myco/db/client.js';
import { getTeamSyncEnabled, setTeamSyncEnabled } from '@myco/db/queries/team-sync-state.js';

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
