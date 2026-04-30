/**
 * Tests for myco_search MCP tool with `type: 'canopy'`.
 *
 * The MCP handler is a thin proxy over `/api/search` via `DaemonClient`. This
 * suite asserts that:
 *   - `type=canopy` is forwarded to the daemon endpoint, and
 *   - canopy result rows are normalized with stable IDs and retrieve hints.
 *
 * The daemon-side canopy branch (which actually routes to the
 * `canopy_entries` namespace and hydrates `llm_description`) is exercised in
 * `tests/daemon/api/search-canopy.test.ts`.
 */

import { describe, it, expect } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import { handleMycoSearch } from '@myco/tools/search.js';
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

  it('normalizes canopy result rows with retrieve hints', async () => {
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
      id: 'p:src/auth/login.ts',
      type: 'canopy_entry',
      title: 'src/auth/login.ts',
      preview: 'login flow handler',
      project_id: 'p',
      path: 'src/auth/login.ts',
      llm_description: 'login flow handler',
      language: 'typescript',
      retrieve: {
        tool: 'myco_cortex',
        input: {
          op: 'canopy_entry',
          id: 'p:src/auth/login.ts',
          project_id: 'p',
          path: 'src/auth/login.ts',
        },
      },
    });
  });

  it('returns empty when daemon returns no canopy results', async () => {
    const client = mockClient({ mode: 'semantic', results: [] });
    const results = await handleMycoSearch({ query: 'nothing', type: 'canopy' }, client);
    expect(results).toEqual([]);
  });
});
