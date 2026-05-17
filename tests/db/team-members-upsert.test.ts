import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { getDatabase } from '@myco/db/client.js';
import { upsertSelfMember } from '@myco/db/queries/team-members.js';

describe('upsertSelfMember', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('inserts a row keyed by machine_id on first call', () => {
    const { inserted, row } = upsertSelfMember('alice_abcd1234', '2026-05-17T12:00:00.000Z');
    expect(inserted).toBe(true);
    expect(row.id).toBe('alice_abcd1234');
    expect(row.user).toBe('alice_abcd1234');
    expect(row.machine_id).toBe('alice_abcd1234');
    expect(row.joined).toBe('2026-05-17T12:00:00.000Z');
    expect(row.role).toBeNull();
    expect(row.tags).toBeNull();
  });

  it('is idempotent — second call reports inserted=false and leaves the row untouched', () => {
    upsertSelfMember('alice_abcd1234', '2026-05-17T12:00:00.000Z');
    getDatabase().prepare(
      `UPDATE team_members SET "user" = 'Alice', role = 'owner' WHERE id = ?`,
    ).run('alice_abcd1234');

    const { inserted, row } = upsertSelfMember('alice_abcd1234', '2026-05-18T00:00:00.000Z');
    expect(inserted).toBe(false);
    expect(row.user).toBe('Alice');
    expect(row.role).toBe('owner');
    expect(row.joined).toBe('2026-05-17T12:00:00.000Z');
  });
});
