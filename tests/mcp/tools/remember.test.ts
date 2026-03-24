/**
 * Tests for myco_remember tool handler.
 *
 * The handler now proxies through DaemonClient. Tests mock the client
 * to verify correct endpoint usage and response mapping.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleMycoRemember } from '@myco/mcp/tools/remember.js';
import { DaemonClient } from '@myco/hooks/client.js';

function mockClient(getData: unknown = null, ok = true): DaemonClient {
  const client = {
    get: vi.fn().mockResolvedValue({ ok, data: getData }),
    post: vi.fn().mockResolvedValue({ ok, data: getData }),
  } as unknown as DaemonClient;
  return client;
}

describe('myco_remember', () => {
  it('creates a spore and returns its ID', async () => {
    const client = mockClient({
      id: 'gotcha-abcd1234',
      observation_type: 'gotcha',
      status: 'active',
      created_at: 1700000000,
    });

    const result = await handleMycoRemember({
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

    await handleMycoRemember({
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

    const result = await handleMycoRemember({
      content: 'Something',
    }, client);

    expect(result.status).toBe('error');
    expect(result.id).toBe('');
  });

  it('defaults observation_type to discovery', async () => {
    const client = mockClient({
      id: 'discovery-1234',
      observation_type: 'discovery',
      status: 'active',
      created_at: 1700000000,
    });

    const result = await handleMycoRemember({
      content: 'Something interesting',
    }, client);

    expect(result.observation_type).toBe('discovery');
  });
});
