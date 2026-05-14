/**
 * Tests for the session_id filter on the /spores list endpoint.
 *
 * Verifies that handleListSpores scopes results to a single session when
 * session_id is provided, and returns all spores when it is absent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initDatabase, closeDatabase } from '@myco/db/client';
import { createSchema } from '@myco/db/schema';
import { insertSpore } from '@myco/db/queries/spores';
import { upsertSession } from '@myco/db/queries/sessions';
import { registerAgent } from '@myco/db/queries/agents';
import { DEFAULT_AGENT_ID } from '@myco/constants';
import { handleListSpores } from '@myco/daemon/api/mycelium';
import type { RouteRequest } from '@myco/daemon/router';
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

describe('listSpores with session_id filter', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-spores-session-'));
    const dbPath = path.join(tmpDir, 'myco.db');
    const db = initDatabase(dbPath);
    createSchema(db);
    registerAgent({ id: DEFAULT_AGENT_ID, name: 'myco-agent', created_at: Math.floor(Date.now() / 1000) });

    const now = Math.floor(Date.now() / 1000);

    // Insert sessions so the spore session_id FK constraint is satisfied
    upsertSession({ id: 'session-a', agent: DEFAULT_AGENT_ID, started_at: now, created_at: now });
    upsertSession({ id: 'session-b', agent: DEFAULT_AGENT_ID, started_at: now, created_at: now });

    // Two spores linked to session-a
    insertSpore({
      id: 'spore-a1',
      agent_id: DEFAULT_AGENT_ID,
      observation_type: 'decision',
      content: 'session a spore 1',
      created_at: now,
      session_id: 'session-a',
    });
    insertSpore({
      id: 'spore-a2',
      agent_id: DEFAULT_AGENT_ID,
      observation_type: 'gotcha',
      content: 'session a spore 2',
      created_at: now - 1,
      session_id: 'session-a',
    });

    // Two spores linked to session-b
    insertSpore({
      id: 'spore-b1',
      agent_id: DEFAULT_AGENT_ID,
      observation_type: 'decision',
      content: 'session b spore 1',
      created_at: now - 2,
      session_id: 'session-b',
    });
    insertSpore({
      id: 'spore-b2',
      agent_id: DEFAULT_AGENT_ID,
      observation_type: 'gotcha',
      content: 'session b spore 2',
      created_at: now - 3,
      session_id: 'session-b',
    });
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns only spores for the requested session_id', async () => {
    const res = await handleListSpores(makeRequest({
      query: { session_id: 'session-a' },
    }));

    const body = res.body as { spores: Array<{ id: string }>; total: number };
    const ids = body.spores.map((s) => s.id).sort();
    expect(ids).toEqual(['spore-a1', 'spore-a2']);
    expect(body.total).toBe(2);
  });

  it('returns all spores when session_id is undefined', async () => {
    const res = await handleListSpores(makeRequest({
      query: {},
    }));

    const body = res.body as { spores: Array<{ id: string }>; total: number };
    expect(body.total).toBe(4);
    expect(body.spores).toHaveLength(4);
  });

  it('returns empty list when session_id matches no spores', async () => {
    const res = await handleListSpores(makeRequest({
      query: { session_id: 'session-nonexistent' },
    }));

    const body = res.body as { spores: Array<{ id: string }>; total: number };
    expect(body.spores).toHaveLength(0);
    expect(body.total).toBe(0);
  });
});
