/**
 * Tests for myco_spores save handler.
 *
 * The handler now proxies through DaemonClient. Tests mock the client
 * to verify correct endpoint usage and response mapping.
 */

import { describe, it, expect } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import { handleMycoSpores } from '@myco/tools/spores.js';
import { DaemonClient } from '@myco/hooks/client.js';

function mockClient(getData: unknown = null, ok = true): DaemonClient {
  const client = {
    get: vi.fn().mockResolvedValue({ ok, data: getData }),
    post: vi.fn().mockResolvedValue({ ok, data: getData }),
  } as unknown as DaemonClient;
  return client;
}

describe('myco_spores op: save', () => {
  it('creates a spore and returns its ID', async () => {
    const client = mockClient({
      id: 'gotcha-abcd1234',
      observation_type: 'gotcha',
      status: 'active',
      created_at: 1700000000,
    });

    const result = await handleMycoSpores({
      op: 'save',
      content: 'CORS proxy strips auth headers',
      type: 'gotcha',
      tags: ['cors', 'auth'],
    }, client);

    expect(result.id).toBe('gotcha-abcd1234');
    expect(result.observation_type).toBe('gotcha');
    expect(result.status).toBe('active');
    expect(typeof result.created_at).toBe('number');
  });

  it('posts to daemon with correct body', async () => {
    const client = mockClient({
      id: 'discovery-1234',
      observation_type: 'discovery',
      status: 'active',
      created_at: 1700000000,
    });

    await handleMycoSpores({
      op: 'save',
      content: 'Decision: use RS256',
      type: 'decision',
      tags: ['auth'],
    }, client);

    expect(client.post).toHaveBeenCalledWith('/api/mcp/remember', {
      content: 'Decision: use RS256',
      type: 'decision',
      tags: ['auth'],
    });
  });

  it('returns error shape on daemon failure', async () => {
    const client = mockClient(null, false);

    const result = await handleMycoSpores({
      op: 'save',
      content: 'Something',
    }, client);

    expect(result).toEqual({ ok: false, error: 'type is required for op: save' });
  });
});

describe('myco_spores op: get', () => {
  it('requires id', async () => {
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

describe('myco_spores op: list', () => {
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
