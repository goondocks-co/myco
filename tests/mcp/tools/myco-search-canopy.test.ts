/**
 * Tests for myco_search MCP tool with `type: 'canopy'`.
 *
 * The MCP handler is a thin proxy over `/api/search` via `DaemonClient`. This
 * suite asserts that:
 *   - `type=canopy` is forwarded to the daemon endpoint, and
 *   - the canopy result rows the daemon returns (`{ project_id, path,
 *     llm_description, language, score }`) are passed through unchanged.
 *
 * The daemon-side canopy branch (which actually routes to the
 * `canopy_entries` namespace and hydrates `llm_description`) is exercised in
 * `tests/daemon/api/search-canopy.test.ts`.
 */

import { describe, it, expect } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import { handleMycoSearch } from '@myco/mcp/tools/search.js';
import { DaemonClient } from '@myco/hooks/client.js';

function mockClient(getData: unknown = null, ok = true): DaemonClient {
  const client = {
    get: vi.fn().mockResolvedValue({ ok, data: getData }),
    post: vi.fn().mockResolvedValue({ ok, data: getData }),
  } as unknown as DaemonClient;
  return client;
}

describe('myco_search type=canopy', () => {
  it('forwards type=canopy to the daemon endpoint', async () => {
    const client = mockClient({ mode: 'semantic', results: [] });
    await handleMycoSearch({ query: 'login', type: 'canopy', limit: 5 }, client);
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('type=canopy'));
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('q=login'));
    expect(client.get).toHaveBeenCalledWith(expect.stringContaining('limit=5'));
  });

  it('passes canopy result rows through unchanged', async () => {
    const canopyRows = [
      {
        id: 'p:src/auth/login.ts',
        type: 'canopy',
        project_id: 'p',
        path: 'src/auth/login.ts',
        llm_description: 'login flow handler',
        language: 'typescript',
        score: 0.91,
        content: '',
      },
    ];
    const client = mockClient({ mode: 'semantic', results: canopyRows });
    const results = await handleMycoSearch({ query: 'login', type: 'canopy' }, client);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      project_id: 'p',
      path: 'src/auth/login.ts',
      llm_description: 'login flow handler',
      language: 'typescript',
    });
  });

  it('returns empty when daemon returns no canopy results', async () => {
    const client = mockClient({ mode: 'semantic', results: [] });
    const results = await handleMycoSearch({ query: 'nothing', type: 'canopy' }, client);
    expect(results).toEqual([]);
  });
});
