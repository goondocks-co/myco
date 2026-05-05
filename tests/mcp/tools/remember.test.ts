/**
 * Tests for myco_spores write paths.
 *
 * `op:save` calls `saveSpore` against the in-process DB (no HTTP).
 * `op:get` and `op:list` still proxy through DaemonClient to /api/spores; those
 * paths keep their mock-based tests.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import { handleMycoSpores } from '@myco/tools/spores.js';
import { DaemonClient } from '@myco/hooks/client.js';
import { getDatabase } from '@myco/db/client.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import { resolveLegacyRequestContext } from '@myco/tools/request-context.js';

function mockClient(getData: unknown = null, ok = true): DaemonClient {
  return {
    get: vi.fn().mockResolvedValue({ ok, data: getData }),
    post: vi.fn().mockResolvedValue({ ok, data: getData }),
  } as unknown as DaemonClient;
}

interface SporeSaveResult {
  id: string;
  observation_type: string;
  status: string;
  created_at: number;
}

function requestContext(projectId: string) {
  return resolveLegacyRequestContext('/tmp/myco-spore-save-test/.myco', {
    projectRoot: `/workspace/${projectId}`,
    projectId,
    groveId: 'grove-test',
    machineId: 'machine-test',
    source: 'explicit',
  });
}

describe('myco_spores op: save (in-process)', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('creates a spore and returns its envelope', async () => {
    const result = await handleMycoSpores({
      op: 'save',
      content: 'CORS proxy strips auth headers',
      type: 'gotcha',
      tags: ['cors', 'auth'],
    }, mockClient()) as SporeSaveResult;

    expect(result.id).toMatch(/^gotcha-[0-9a-f]+$/);
    expect(result.observation_type).toBe('gotcha');
    expect(result.status).toBe('active');
    expect(typeof result.created_at).toBe('number');
  });

  it('persists spore content + tags to the DB', async () => {
    const result = await handleMycoSpores({
      op: 'save',
      content: 'Decision: use RS256',
      type: 'decision',
      tags: ['auth', 'jwt'],
    }, mockClient()) as SporeSaveResult;

    const db = getDatabase();
    const row = db.prepare('SELECT id, content, observation_type, tags FROM spores WHERE id = ?').get(result.id) as {
      content: string;
      observation_type: string;
      tags: string;
    };
    expect(row.content).toBe('Decision: use RS256');
    expect(row.observation_type).toBe('decision');
    expect(row.tags).toBe('auth, jwt');
  });

  it('registers the user agent on first write', async () => {
    await handleMycoSpores({
      op: 'save',
      content: 'first ever spore',
      type: 'discovery',
    }, mockClient());

    const db = getDatabase();
    const agent = db.prepare("SELECT id FROM agents WHERE id = 'user'").get();
    expect(agent).toBeTruthy();
  });

  it('persists the request-context project id on Grove-scoped writes', async () => {
    const result = await handleMycoSpores({
      op: 'save',
      content: 'Scope this spore to project A',
      type: 'decision',
    }, mockClient(), requestContext('project-a')) as SporeSaveResult;

    const db = getDatabase();
    const row = db.prepare('SELECT project_id FROM spores WHERE id = ?').get(result.id) as { project_id: string };
    expect(row.project_id).toBe('project-a');
  });

  it('rejects op:save without content', async () => {
    const result = await handleMycoSpores({ op: 'save', type: 'gotcha' }, mockClient());
    expect(result).toEqual({ ok: false, error: 'content is required for op: save' });
  });

  it('rejects op:save without type', async () => {
    const result = await handleMycoSpores({ op: 'save', content: 'Something' }, mockClient());
    expect(result).toEqual({ ok: false, error: 'type is required for op: save' });
  });
});

describe('myco_spores op: get (HTTP, unchanged)', () => {
  it('rejects without id', async () => {
    const client = mockClient({});
    const result = await handleMycoSpores({ op: 'get' }, client);
    expect(result).toEqual({ ok: false, error: 'id is required for op: get' });
    expect(client.get).not.toHaveBeenCalled();
  });

  it('fetches a single spore by encoded id', async () => {
    const client = mockClient({ id: 'gotcha/a', content: 'content' });
    const result = await handleMycoSpores({ op: 'get', id: 'gotcha/a' }, client);
    expect(result).toEqual({ id: 'gotcha/a', content: 'content' });
    expect(client.get).toHaveBeenCalledWith('/api/spores/gotcha%2Fa');
  });

  it('returns structured not-found on missing spore', async () => {
    const client = mockClient(null, false);
    const result = await handleMycoSpores({ op: 'get', id: 'missing' }, client);
    expect(result).toEqual({ ok: false, error: 'Spore not found' });
  });
});

describe('myco_spores op: list (HTTP, unchanged)', () => {
  it('forwards list filters to /api/spores', async () => {
    const client = mockClient({ spores: [{ id: 's1' }], total: 1, offset: 2, limit: 5 });
    const result = await handleMycoSpores({
      status: 'active',
      observation_type: 'decision',
      agent_id: 'agent',
      search: 'sqlite',
      limit: 5,
      offset: 2,
    }, client);

    expect(result).toEqual({ spores: [{ id: 's1' }], total: 1, offset: 2, limit: 5 });
    const url = (client.get as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toContain('/api/spores');
    expect(url).toContain('status=active');
    expect(url).toContain('type=decision');
    expect(url).toContain('agent_id=agent');
    expect(url).toContain('search=sqlite');
    expect(url).toContain('limit=5');
    expect(url).toContain('offset=2');
  });
});
