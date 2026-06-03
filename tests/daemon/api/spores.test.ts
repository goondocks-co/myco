/**
 * Coverage for the spore get-by-id team-fallback fanout.
 *
 * Mirrors `tests/daemon/api/sessions.test.ts`'s fallback block so the recall
 * path has parity across both record shapes (search, sessions, spores).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDatabase, closeDatabase } from '@myco/db/client';
import { createSchema } from '@myco/db/schema';
import { insertSpore } from '@myco/db/queries/spores';
import { registerAgent } from '@myco/db/queries/agents';
import { DEFAULT_AGENT_ID } from '@myco/constants';
import { createGetSporeHandler, handleListSpores } from '@myco/daemon/api/mycelium';
import type { RouteRequest } from '@myco/daemon/router';
import { resolveLegacyRequestContext } from '@myco/grove/request-context';

import { TEST_REQUEST_CONTEXT } from '../../helpers/request-context';
function makeRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    params: {},
    query: {},
    body: undefined,
    requestContext: TEST_REQUEST_CONTEXT,
    ...overrides,
  } as RouteRequest;
}

function requestContext(vaultDir: string, projectId: string) {
  return resolveLegacyRequestContext(vaultDir, {
    projectRoot: `/workspace/${projectId}`,
    projectId,
    groveId: 'grove-test',
    machineId: 'machine-test',
    source: 'explicit',
    // Explicit project/grove pivot = caller-asserted tenancy; the scope seam
    // binds a Grove-bound context to its project scope only when caller-asserted.
    tenancySource: 'caller',
  });
}

function makeTeamClient(impl: (type: string, id: string) => Promise<Record<string, unknown> | null>) {
  const getRecord = vi.fn(impl);
  return { getRecord } as {
    getRecord: typeof getRecord;
  };
}

describe('createGetSporeHandler — team fallback', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-get-spore-team-'));
    const dbPath = path.join(tmpDir, 'myco.db');
    const db = initDatabase(dbPath);
    createSchema(db);
    registerAgent({ id: DEFAULT_AGENT_ID, name: 'myco-agent', created_at: Math.floor(Date.now() / 1000) });
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('local hit: returns local record with source=local and does not call the team', async () => {
    const now = Math.floor(Date.now() / 1000);
    insertSpore({
      id: 'spore-local',
      agent_id: DEFAULT_AGENT_ID,
      observation_type: 'gotcha',
      content: 'local content',
      created_at: now,
      status: 'active',
    });

    const teamClient = makeTeamClient(async () => null);
    const handler = createGetSporeHandler({
      getTeamClient: () => teamClient as never,
      machineId: 'local-machine',
    });

    const res = await handler(makeRequest({ params: { id: 'spore-local' } }));
    expect(res.status === undefined || res.status < 400).toBe(true);
    const body = res.body as { id: string; source: string };
    expect(body.id).toBe('spore-local');
    expect(body.source).toBe('local');
    expect(teamClient.getRecord).not.toHaveBeenCalled();
  });

  it('lists only spores in the requested project context', async () => {
    const now = Math.floor(Date.now() / 1000);
    insertSpore({
      id: 'spore-project-a',
      project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      agent_id: DEFAULT_AGENT_ID,
      observation_type: 'decision',
      content: 'project a content',
      created_at: now,
      status: 'active',
    });
    insertSpore({
      id: 'spore-project-b',
      project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      agent_id: DEFAULT_AGENT_ID,
      observation_type: 'decision',
      content: 'project b content',
      created_at: now,
      status: 'active',
    });

    const res = await handleListSpores(makeRequest({
      requestContext: requestContext(tmpDir, 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    }));

    const body = res.body as { spores: Array<{ id: string }>; total: number };
    expect(body.spores.map((spore) => spore.id)).toEqual(['spore-project-a']);
    expect(body.total).toBe(1);
  });

  it('does not return a local spore from a different project context', async () => {
    const now = Math.floor(Date.now() / 1000);
    insertSpore({
      id: 'spore-other-project',
      project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      agent_id: DEFAULT_AGENT_ID,
      observation_type: 'gotcha',
      content: 'other project content',
      created_at: now,
      status: 'active',
    });

    const handler = createGetSporeHandler();
    const res = await handler(makeRequest({
      params: { id: 'spore-other-project' },
      requestContext: requestContext(tmpDir, 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    }));

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'not_found' });
  });

  it('local miss + team hit: returns team record tagged team:<machine_id>', async () => {
    const teamClient = makeTeamClient(async (type, id) => {
      expect(type).toBe('spores');
      expect(id).toBe('spore-remote');
      return { id: 'spore-remote', machine_id: 'remote-node', content: 'team content' };
    });

    const handler = createGetSporeHandler({
      getTeamClient: () => teamClient as never,
      machineId: 'local-machine',
    });

    const res = await handler(makeRequest({ params: { id: 'spore-remote' } }));
    expect(res.status === undefined || res.status < 400).toBe(true);
    const body = res.body as { id: string; source: string };
    expect(body.id).toBe('spore-remote');
    expect(body.source).toBe('team:remote-node');
  });

  it('local miss + team miss: returns 404', async () => {
    const teamClient = makeTeamClient(async () => null);
    const handler = createGetSporeHandler({
      getTeamClient: () => teamClient as never,
      machineId: 'local-machine',
    });

    const res = await handler(makeRequest({ params: { id: 'absent' } }));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'not_found' });
  });

  it('local miss + team throws: returns 404 (team failures are non-blocking)', async () => {
    const teamClient = {
      getRecord: vi.fn(async () => {
        throw new Error('team down');
      }),
    };
    const handler = createGetSporeHandler({
      getTeamClient: () => teamClient as never,
      machineId: 'local-machine',
    });

    const res = await handler(makeRequest({ params: { id: 'broken' } }));
    expect(res.status).toBe(404);
  });

  it('local miss + team hit with own machine_id: falls through to 404 (no self-echo)', async () => {
    const teamClient = makeTeamClient(async () => ({
      id: 'spore-self',
      machine_id: 'local-machine',
      content: 'echoed back from team',
    }));

    const handler = createGetSporeHandler({
      getTeamClient: () => teamClient as never,
      machineId: 'local-machine',
    });

    const res = await handler(makeRequest({ params: { id: 'spore-self' } }));
    expect(res.status).toBe(404);
  });
});
