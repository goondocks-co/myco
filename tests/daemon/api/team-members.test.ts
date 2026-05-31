import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import { getDatabase } from '@myco/db/client.js';
import type { RouteRequest } from '@myco/daemon/router.js';
import type { TeamMemberWire } from '@myco/daemon/team-sync.js';
import {
  createListTeamMembersHandler,
  type ListTeamMembersResponse,
} from '@myco/daemon/api/team-members.js';
import { createTeamId } from '@myco/grove/ids.js';

import { TEST_REQUEST_CONTEXT } from '../../helpers/request-context';

function makeRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    body: undefined,
    requestContext: TEST_REQUEST_CONTEXT,
    query: {},
    params: {},
    pathname: '/api/team/members',
    ...overrides,
  };
}

const WIRE_ROWS: TeamMemberWire[] = [
  {
    id: 'machine-a',
    machine_id: 'machine-a',
    user: 'Ada',
    role: 'owner',
    joined: '2026-01-01T00:00:00Z',
    tags: 'core, ops',
    synced_at: 1000,
  },
  {
    id: 'machine-b',
    machine_id: 'machine-b',
    user: 'Bo',
    role: null,
    joined: null,
    tags: null,
    synced_at: null,
  },
];

describe('createListTeamMembersHandler', () => {
  beforeAll(() => {
    setupTestDb();
  });

  beforeEach(() => {
    cleanTestDb();
  });

  afterAll(() => {
    teardownTestDb();
  });

  it('returns the worker roster mapped to DTOs when team_id resolves a client', async () => {
    const teamId = createTeamId();
    const handler = createListTeamMembersHandler({
      getTeamClientForId: (id) =>
        id === teamId ? { listMembers: async () => ({ members: WIRE_ROWS }) } : null,
    });

    const res = await handler(makeRequest({ query: { team_id: teamId } }));
    const body = res.body as ListTeamMembersResponse;

    expect(body.members).toHaveLength(2);
    expect(body.members[0]).toEqual({
      id: 'machine-a',
      user: 'Ada',
      role: 'owner',
      joined: '2026-01-01T00:00:00Z',
      tags: ['core', 'ops'],
      machine_id: 'machine-a',
      synced_at: 1000,
    });
    expect(body.members[1].tags).toEqual([]);
    expect(body.members[1].role).toBeNull();
  });

  it('merges the local self-row into the remote roster (local not in remote)', async () => {
    const teamId = createTeamId();
    // Local self-row whose machine_id is absent from the worker roster.
    getDatabase()
      .prepare(
        `INSERT INTO team_members (id, "user", role, joined, tags, machine_id, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('machine-self', 'Self', 'member', '2026-03-03T00:00:00Z', 'me', 'machine-self', 5000);

    const handler = createListTeamMembersHandler({
      getTeamClientForId: (id) =>
        id === teamId ? { listMembers: async () => ({ members: WIRE_ROWS }) } : null,
    });

    const res = await handler(makeRequest({ query: { team_id: teamId } }));
    const body = res.body as ListTeamMembersResponse;

    const byMachine = new Map(body.members.map((m) => [m.machine_id, m]));
    expect(byMachine.has('machine-a')).toBe(true);
    expect(byMachine.has('machine-b')).toBe(true);
    expect(byMachine.has('machine-self')).toBe(true);
    expect(byMachine.get('machine-self')!.user).toBe('Self');
  });

  it('shows the local self-row even against an old/empty worker roster', async () => {
    const teamId = createTeamId();
    getDatabase()
      .prepare(
        `INSERT INTO team_members (id, "user", role, joined, tags, machine_id, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('machine-self', 'Self', 'member', null, null, 'machine-self', 5000);

    const handler = createListTeamMembersHandler({
      // Old worker (pre-team_members migration) returns 200 {members:[]} — no throw.
      getTeamClientForId: (id) =>
        id === teamId ? { listMembers: async () => ({ members: [] }) } : null,
    });

    const res = await handler(makeRequest({ query: { team_id: teamId } }));
    const body = res.body as ListTeamMembersResponse;

    expect(body.members).toHaveLength(1);
    expect(body.members[0].machine_id).toBe('machine-self');
    expect(body.members[0].user).toBe('Self');
  });

  it('local self-row wins on machine_id collision with the remote roster', async () => {
    const teamId = createTeamId();
    // Same machine_id as WIRE_ROWS[0] (machine-a) but with local provenance.
    getDatabase()
      .prepare(
        `INSERT INTO team_members (id, "user", role, joined, tags, machine_id, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('machine-a', 'Ada (local)', 'owner', '2026-01-01T00:00:00Z', 'core', 'machine-a', 9999);

    const handler = createListTeamMembersHandler({
      getTeamClientForId: (id) =>
        id === teamId ? { listMembers: async () => ({ members: WIRE_ROWS }) } : null,
    });

    const res = await handler(makeRequest({ query: { team_id: teamId } }));
    const body = res.body as ListTeamMembersResponse;

    const byMachine = new Map(body.members.map((m) => [m.machine_id, m]));
    expect(body.members).toHaveLength(2);
    expect(byMachine.get('machine-a')!.user).toBe('Ada (local)');
    expect(byMachine.get('machine-a')!.synced_at).toBe(9999);
  });

  it('falls back to the local roster when no team_id is supplied', async () => {
    getDatabase()
      .prepare(
        `INSERT INTO team_members (id, "user", role, joined, tags, machine_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('local-self', 'Local', null, '2026-02-02T00:00:00Z', 'a,b', 'local-self');

    const handler = createListTeamMembersHandler({
      getTeamClientForId: () => {
        throw new Error('should not resolve a client without team_id');
      },
    });

    const res = await handler(makeRequest());
    const body = res.body as ListTeamMembersResponse;

    expect(body.members).toHaveLength(1);
    expect(body.members[0].id).toBe('local-self');
    expect(body.members[0].tags).toEqual(['a', 'b']);
  });

  it('falls back to the local roster when the worker request throws', async () => {
    const teamId = createTeamId();
    getDatabase()
      .prepare(
        `INSERT INTO team_members (id, "user", role, joined, tags, machine_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('local-self', 'Local', null, null, null, 'local-self');

    const handler = createListTeamMembersHandler({
      getTeamClientForId: (id) =>
        id === teamId
          ? {
              listMembers: async () => {
                throw new Error('worker unreachable');
              },
            }
          : null,
    });

    const res = await handler(makeRequest({ query: { team_id: teamId } }));
    const body = res.body as ListTeamMembersResponse;

    expect(body.members).toHaveLength(1);
    expect(body.members[0].id).toBe('local-self');
  });
});
