import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { getDatabase } from '@myco/db/client.js';
import { createListTeamMembersHandler } from '@myco/daemon/api/team-members.js';
import type { ListTeamMembersResponse } from '@myco/daemon/api/team-members.js';

describe('GET /api/team/members handler', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('returns team members shaped for the UI', async () => {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO team_members (id, "user", role, joined, tags, machine_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('m1', 'Alice', 'owner', '2026-04-01', 'core', 'machine-1');
    db.prepare(
      `INSERT INTO team_members (id, "user", role, joined, tags, machine_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('m2', 'Bob', 'member', null, null, 'machine-2');

    const handler = createListTeamMembersHandler();
    const response = await handler({
      body: undefined,
      query: {},
      params: {},
      pathname: '/api/team/members',
    });

    const body = response.body as ListTeamMembersResponse;
    expect(body.members).toHaveLength(2);

    const [alice, bob] = body.members;
    expect(alice.id).toBe('m1');
    expect(alice.user).toBe('Alice');
    expect(alice.role).toBe('owner');
    expect(alice.joined).toBe('2026-04-01');
    expect(alice.tags).toEqual(['core']);
    expect(alice.machine_id).toBe('machine-1');

    expect(bob.id).toBe('m2');
    expect(bob.user).toBe('Bob');
    expect(bob.role).toBe('member');
    expect(bob.joined).toBeNull();
    expect(bob.tags).toEqual([]);
    expect(bob.machine_id).toBe('machine-2');
  });

  it('orders members by user name ascending', async () => {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO team_members (id, "user", machine_id) VALUES (?, ?, ?)`,
    ).run('z1', 'Zoe', 'machine-1');
    db.prepare(
      `INSERT INTO team_members (id, "user", machine_id) VALUES (?, ?, ?)`,
    ).run('a1', 'Aaron', 'machine-1');

    const response = await createListTeamMembersHandler()({
      body: undefined,
      query: {},
      params: {},
      pathname: '/api/team/members',
    });
    const body = response.body as ListTeamMembersResponse;
    expect(body.members.map((m) => m.user)).toEqual(['Aaron', 'Zoe']);
  });

  it('splits comma-joined tags into an array and trims whitespace', async () => {
    getDatabase().prepare(
      `INSERT INTO team_members (id, "user", tags, machine_id) VALUES (?, ?, ?, ?)`,
    ).run('m1', 'Alice', 'core, ops , ', 'machine-1');

    const response = await createListTeamMembersHandler()({
      body: undefined,
      query: {},
      params: {},
      pathname: '/api/team/members',
    });
    const body = response.body as ListTeamMembersResponse;
    expect(body.members[0].tags).toEqual(['core', 'ops']);
  });
});
