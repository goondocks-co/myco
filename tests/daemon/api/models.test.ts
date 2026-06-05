import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import { handleGetModels } from '@myco/daemon/api/models.js';
import { OPENAI_API_KEY_ENV } from '@myco/providers/env.js';

const originalFetch = global.fetch;
const fetchMock = vi.fn();
global.fetch = fetchMock as unknown as typeof fetch;
// Restore global.fetch at file end so this override does not leak into sibling
// test files sharing the process.
afterAll(() => { global.fetch = originalFetch; });

describe('handleGetModels', () => {
  afterEach(() => {
    fetchMock.mockReset();
    delete process.env[OPENAI_API_KEY_ENV];
    delete process.env.OPENAI_API_KEY;
  });

  it('returns remote OpenAI models when an API key is configured', async () => {
    process.env[OPENAI_API_KEY_ENV] = 'sk-test';
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: 'gpt-5.4' }, { id: 'text-embedding-3-small' }],
      }),
    });

    const result = await handleGetModels({
      body: undefined,
      params: {},
      pathname: '/api/models',
      query: { provider: 'openai', type: 'llm' },
    });

    expect((result.body as { models: string[] }).models).toEqual(['gpt-5.4']);
  });

  it('returns an empty list when remote auth is missing', async () => {
    const result = await handleGetModels({
      body: undefined,
      params: {},
      pathname: '/api/models',
      query: { provider: 'openai', type: 'llm' },
    });

    expect((result.body as { models: string[] }).models).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
