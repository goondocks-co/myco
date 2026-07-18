/**
 * Coverage for the spore get-by-id handler and project-scoped listing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

describe('createGetSporeHandler — local get', () => {
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

  it('returns local record with source=local', async () => {
    const now = Math.floor(Date.now() / 1000);
    insertSpore({
      id: 'spore-local',
      agent_id: DEFAULT_AGENT_ID,
      observation_type: 'gotcha',
      content: 'local content',
      created_at: now,
      status: 'active',
    });

    const handler = createGetSporeHandler();

    const res = await handler(makeRequest({ params: { id: 'spore-local' } }));
    expect(res.status === undefined || res.status < 400).toBe(true);
    const body = res.body as { id: string; source: string };
    expect(body.id).toBe('spore-local');
    expect(body.source).toBe('local');
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

  it('returns 404 for an unknown id (a local miss is a plain not-found)', async () => {
    const handler = createGetSporeHandler();

    const res = await handler(makeRequest({ params: { id: 'absent' } }));
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'not_found' });
  });
});
