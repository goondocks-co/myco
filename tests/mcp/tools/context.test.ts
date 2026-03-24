/**
 * Tests for myco_context tool handler.
 *
 * The handler now proxies through DaemonClient. Tests mock the client
 * to verify correct endpoint usage and response mapping.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleMycoContext } from '@myco/mcp/tools/context.js';
import { DaemonClient } from '@myco/hooks/client.js';

function mockClient(getData: unknown = null, ok = true): DaemonClient {
  const client = {
    get: vi.fn().mockResolvedValue({ ok, data: getData }),
    post: vi.fn().mockResolvedValue({ ok, data: getData }),
  } as unknown as DaemonClient;
  return client;
}

describe('myco_context', () => {
  it('returns extract for requested tier', async () => {
    const client = mockClient({
      tiers: [
        { tier: 3000, content: 'Project synthesis at 3000 tokens.', generated_at: 1700000000 },
      ],
    });

    const result = await handleMycoContext({ tier: 3000 }, client);

    expect(result.tier).toBe(3000);
    expect(result.fallback).toBe(false);
    expect(result.content).toBe('Project synthesis at 3000 tokens.');
  });

  it('falls back to nearest tier when requested unavailable', async () => {
    const client = mockClient({
      tiers: [
        { tier: 1500, content: 'Executive briefing.', generated_at: 1700000000 },
        { tier: 5000, content: 'Deep onboarding.', generated_at: 1700000000 },
      ],
    });

    const result = await handleMycoContext({ tier: 3000 }, client);

    // 1500 is distance 1500, 5000 is distance 2000 — should pick 1500
    expect(result.tier).toBe(1500);
    expect(result.fallback).toBe(true);
    expect(result.content).toBe('Executive briefing.');
  });

  it('returns not-ready message when no extracts exist', async () => {
    const client = mockClient({ tiers: [] });

    const result = await handleMycoContext({ tier: 3000 }, client);

    expect(result.tier).toBe(3000);
    expect(result.fallback).toBe(false);
    expect(result.content).toContain('not yet available');
  });

  it('defaults to tier 3000 when no tier specified', async () => {
    const client = mockClient({
      tiers: [
        { tier: 3000, content: 'Default tier content.', generated_at: 1700000000 },
      ],
    });

    const result = await handleMycoContext({}, client);

    expect(result.tier).toBe(3000);
    expect(result.content).toBe('Default tier content.');
  });

  it('returns not-ready on daemon failure', async () => {
    const client = mockClient(null, false);

    const result = await handleMycoContext({ tier: 3000 }, client);

    expect(result.content).toContain('not yet available');
  });
});
