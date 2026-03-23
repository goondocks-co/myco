/**
 * Tests for myco_recall tool handler.
 *
 * The handler now proxies through DaemonClient. Tests mock the client
 * to verify correct endpoint usage and response mapping.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleMycoRecall } from '@myco/mcp/tools/recall.js';
import { DaemonClient } from '@myco/hooks/client.js';

function mockClient(responses: Record<string, { ok: boolean; data?: unknown }>): DaemonClient {
  const client = {
    get: vi.fn().mockImplementation((endpoint: string) => {
      for (const [pattern, response] of Object.entries(responses)) {
        if (endpoint.includes(pattern)) return Promise.resolve(response);
      }
      return Promise.resolve({ ok: false });
    }),
    post: vi.fn().mockResolvedValue({ ok: false }),
  } as unknown as DaemonClient;
  return client;
}

describe('myco_recall', () => {
  it('recalls a session by ID', async () => {
    const client = mockClient({
      '/api/sessions/sess-1': { ok: true, data: { id: 'sess-1', agent: 'claude-code' } },
      '/api/spores/sess-1': { ok: false },
    });
    const result = await handleMycoRecall({ note_id: 'sess-1' }, client);
    expect(result.type).toBe('session');
    expect(result.id).toBe('sess-1');
  });

  it('recalls a spore by ID', async () => {
    const client = mockClient({
      '/api/sessions/gotcha-abc': { ok: false },
      '/api/spores/gotcha-abc': { ok: true, data: { id: 'gotcha-abc', observation_type: 'gotcha' } },
    });
    const result = await handleMycoRecall({ note_id: 'gotcha-abc' }, client);
    expect(result.type).toBe('spore');
    expect(result.id).toBe('gotcha-abc');
  });

  it('returns error for unknown ID', async () => {
    const client = mockClient({
      '/api/sessions/nonexistent': { ok: false },
      '/api/spores/nonexistent': { ok: false },
    });
    const result = await handleMycoRecall({ note_id: 'nonexistent' }, client);
    expect(result.error).toBeDefined();
  });

  it('prefers session over spore when both match', async () => {
    const client = mockClient({
      '/api/sessions/dual-id': { ok: true, data: { id: 'dual-id', agent: 'test' } },
      '/api/spores/dual-id': { ok: true, data: { id: 'dual-id', observation_type: 'gotcha' } },
    });
    const result = await handleMycoRecall({ note_id: 'dual-id' }, client);
    expect(result.type).toBe('session');
  });
});
