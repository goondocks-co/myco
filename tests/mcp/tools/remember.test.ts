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
import { DaemonClient } from '@myco/daemon/client.js';
import { getDatabase } from '@myco/db/client.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { TEST_REQUEST_CONTEXT } from '../../helpers/request-context.js';
import { resolveLegacyRequestContext } from '@myco/grove/request-context.js';

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
    // Explicit project/grove pivot = caller-asserted tenancy; the scope seam
    // binds a Grove-bound context to its project scope only when caller-asserted.
    tenancySource: 'caller',
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
    }, mockClient(), requestContext('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')) as SporeSaveResult;

    const db = getDatabase();
    const row = db.prepare('SELECT project_id FROM spores WHERE id = ?').get(result.id) as { project_id: string };
    expect(row.project_id).toBe('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('files the spore under the session the caller names, and refuses one the vault does not hold', async () => {
    upsertSession({ id: 'sess-1', agent: 'myco-agent', started_at: 1700000000, created_at: 1700000000 });

    const result = await handleMycoSpores({
      op: 'save',
      content: 'the tool carries the session through',
      type: 'decision',
      session_id: 'sess-1',
    }, mockClient(), TEST_REQUEST_CONTEXT) as SporeSaveResult;
    const row = getDatabase().prepare('SELECT session_id FROM spores WHERE id = ?').get(result.id) as { session_id: string };
    expect(row.session_id).toBe('sess-1');

    expect(await handleMycoSpores({
      op: 'save', content: 'x', type: 'decision', session_id: 'sess-nowhere',
    }, mockClient(), TEST_REQUEST_CONTEXT)).toEqual({ ok: false, error: 'session_id not found' });
    expect((getDatabase().prepare("SELECT COUNT(*) c FROM spores WHERE content = 'x'").get() as { c: number }).c).toBe(0);
  });

  it('names the session on the events every retirement writes, and refuses an id the vault does not hold', async () => {
    upsertSession({ id: 'sess-1', agent: 'myco-agent', started_at: 1700000000, created_at: 1700000000 });
    const save = async (content: string) => (await handleMycoSpores({ op: 'save', content, type: 'gotcha' }, mockClient(), TEST_REQUEST_CONTEXT) as SporeSaveResult).id;
    const [a, b, c, d] = [await save('a'), await save('b'), await save('c'), await save('d')];
    const db = getDatabase();
    const sessionOf = (sporeId: string) => db.prepare('SELECT session_id FROM resolution_events WHERE spore_id = ?').get(sporeId) as { session_id: string } | undefined;

    await handleMycoSpores({ op: 'supersede', old_spore_id: a, new_spore_id: b, session_id: 'sess-1' }, mockClient(), TEST_REQUEST_CONTEXT);
    expect(sessionOf(a)?.session_id).toBe('sess-1');

    await handleMycoSpores({ op: 'obsolete', id: c, reason: 'gone', session_id: 'sess-1' }, mockClient(), TEST_REQUEST_CONTEXT);
    expect(sessionOf(c)?.session_id).toBe('sess-1');

    const merged = await handleMycoSpores({
      op: 'consolidate', source_spore_ids: [d], consolidated_content: 'wisdom', observation_type: 'wisdom', session_id: 'sess-1',
    }, mockClient(), TEST_REQUEST_CONTEXT) as { new_spore_id: string };
    expect(sessionOf(d)?.session_id).toBe('sess-1');
    expect((db.prepare('SELECT session_id FROM spores WHERE id = ?').get(merged.new_spore_id) as { session_id: string }).session_id).toBe('sess-1');

    for (const call of [
      { op: 'supersede' as const, old_spore_id: b, new_spore_id: a, session_id: 'sess-nowhere' },
      { op: 'obsolete' as const, id: b, reason: 'gone', session_id: 'sess-nowhere' },
      { op: 'consolidate' as const, source_spore_ids: [b], consolidated_content: 'w', observation_type: 'wisdom', session_id: 'sess-nowhere' },
    ]) {
      expect(await handleMycoSpores(call, mockClient(), TEST_REQUEST_CONTEXT)).toEqual({ ok: false, error: 'session_id not found' });
    }
    expect((db.prepare('SELECT status FROM spores WHERE id = ?').get(b) as { status: string }).status).toBe('active');
    expect(sessionOf(b) ?? null).toBeNull();
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
