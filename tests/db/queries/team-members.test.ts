/**
 * Tests for team member query helpers.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { markSelfMemberUnsynced, upsertSelfMember } from '@myco/db/queries/team-members.js';
import { getDatabase } from '@myco/db/client.js';

describe('team member query helpers', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  describe('markSelfMemberUnsynced', () => {
    it('clears synced_at for the matching machine and reports the row updated', () => {
      getDatabase().prepare(
        `INSERT INTO team_members (id, "user", machine_id, synced_at)
         VALUES (?, ?, ?, ?)`,
      ).run('machine-a', 'machine-a', 'machine-a', 123);

      expect(markSelfMemberUnsynced('machine-a')).toBe(1);

      const row = getDatabase().prepare(
        `SELECT synced_at FROM team_members WHERE machine_id = ?`,
      ).get('machine-a') as { synced_at: number | null };
      expect(row.synced_at).toBeNull();
    });

    it('returns 0 for an unknown machine_id', () => {
      upsertSelfMember('machine-a', new Date().toISOString());
      expect(markSelfMemberUnsynced('machine-unknown')).toBe(0);
    });
  });
});
