import { describe, it, expect } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { createMycoTools } from '@myco/tools/index.js';
import type { DaemonClient } from '@myco/hooks/client.js';

function mockClient(options?: { collective?: boolean; digest?: unknown }): DaemonClient {
  return {
    get: vi.fn(async (endpoint: string) => {
      if (endpoint === '/api/team/status') {
        return { ok: true, data: { collective_connected: options?.collective ?? false } };
      }
      if (endpoint === '/api/digest') {
        return { ok: true, data: options?.digest ?? { tiers: [] } };
      }
      return { ok: true, data: {} };
    }),
    post: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    put: vi.fn().mockResolvedValue({ ok: true, data: {} }),
    delete: vi.fn().mockResolvedValue({ ok: true, data: {} }),
  } as unknown as DaemonClient;
}

describe('Myco tools dispatcher', () => {
  it('lists the core tool surface without collective tools by default', async () => {
    const tools = createMycoTools('/tmp/myco-vault', mockClient());
    const names = (await tools.listTools()).map((tool) => tool.name);

    expect(names).toContain('myco_context');
    expect(names).toContain('canopy_map');
    expect(names).not.toContain('collective_search');
  });

  it('includes collective tools when the daemon reports a collective connection', async () => {
    const tools = createMycoTools('/tmp/myco-vault', mockClient({ collective: true }));
    const names = (await tools.listTools()).map((tool) => tool.name);

    expect(names).toContain('collective_search');
    expect(names).toContain('collective_projects');
  });

  it('dispatches a core tool through the shared path', async () => {
    const tools = createMycoTools('/tmp/myco-vault', mockClient({
      digest: {
        tiers: [{ tier: 5000, content: 'digest', generated_at: 1 }],
      },
    }));

    const result = await tools.callTool('myco_context', { tier: 5000 });

    expect(result).toEqual({
      content: 'digest',
      tier: 5000,
      fallback: false,
      generated_at: 1,
    });
  });

  it('rejects unknown tools', async () => {
    const tools = createMycoTools('/tmp/myco-vault', mockClient());

    await expect(tools.callTool('missing_tool', {})).rejects.toThrow('Unknown tool: missing_tool');
  });

  it('rejects unavailable collective tools', async () => {
    const tools = createMycoTools('/tmp/myco-vault', mockClient());

    await expect(tools.callTool('collective_search', { query: 'q' })).rejects.toThrow('Tool unavailable: collective_search');
  });

  it('rejects non-object input', async () => {
    const tools = createMycoTools('/tmp/myco-vault', mockClient());

    await expect(tools.callTool('myco_context', 'bad')).rejects.toThrow('Tool arguments must be a JSON object');
  });

  it('validates required schema fields before dispatch', async () => {
    const tools = createMycoTools('/tmp/myco-vault', mockClient());

    await expect(tools.callTool('myco_search', {})).rejects.toThrow("Missing required argument 'query'");
  });

  it('validates schema property types before dispatch', async () => {
    const tools = createMycoTools('/tmp/myco-vault', mockClient());

    await expect(tools.callTool('myco_search', { query: 7 })).rejects.toThrow("Invalid argument 'query'");
  });

  it('validates schema enum values before dispatch', async () => {
    const tools = createMycoTools('/tmp/myco-vault', mockClient());

    await expect(tools.callTool('myco_context', { tier: 1234 })).rejects.toThrow("Invalid argument 'tier'");
  });

  it('validates array item types before dispatch', async () => {
    const tools = createMycoTools('/tmp/myco-vault', mockClient());

    await expect(tools.callTool('myco_remember', {
      content: 'note',
      type: 'gotcha',
      tags: ['ok', 7],
    })).rejects.toThrow("Invalid argument 'tags[1]'");
  });
});
