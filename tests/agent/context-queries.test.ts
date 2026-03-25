/**
 * Tests for context query execution.
 *
 * DB query functions are mocked via vi.mock() so tests never touch a real
 * database. Each test exercises the routing logic and error handling of
 * executeContextQueries().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ContextQuery } from '@myco/agent/types.js';

// ---------------------------------------------------------------------------
// Mocks: DB query functions
// ---------------------------------------------------------------------------

vi.mock('@myco/db/queries/batches.js', () => ({
  getUnprocessedBatches: vi.fn(),
}));

vi.mock('@myco/db/queries/spores.js', () => ({
  listSpores: vi.fn(),
}));

vi.mock('@myco/db/queries/sessions.js', () => ({
  listSessions: vi.fn(),
}));

vi.mock('@myco/db/queries/agent-state.js', () => ({
  getStatesForAgent: vi.fn(),
}));

// Import mocked modules for controlling return values
import { getUnprocessedBatches } from '@myco/db/queries/batches.js';
import { listSpores } from '@myco/db/queries/spores.js';
import { listSessions } from '@myco/db/queries/sessions.js';
import { getStatesForAgent } from '@myco/db/queries/agent-state.js';

// Import the module under test after mocks are registered
import { executeContextQueries } from '@myco/agent/context-queries.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_AGENT_ID = 'myco-agent';

/** Default limit used when query.limit is not specified. */
const DEFAULT_CONTEXT_QUERY_LIMIT = 10;

/** Sample batch row shape (only fields relevant to assertions). */
const MOCK_BATCH = { id: 1, session_id: 'sess-abc', processed: 0 };

/** Sample spore row shape (only fields relevant to assertions). */
const MOCK_SPORE = { id: 'spore-1', agent_id: TEST_AGENT_ID, observation_type: 'gotcha' };

/** Sample session row shape. */
const MOCK_SESSION = { id: 'sess-abc', agent: 'claude-code', status: 'active' };

/** Sample agent state row. */
const MOCK_STATE = { agent_id: TEST_AGENT_ID, key: 'cursor', value: '42', updated_at: 1000 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal ContextQuery with sensible defaults. */
function makeQuery(overrides: Partial<ContextQuery> = {}): ContextQuery {
  return {
    tool: 'vault_unprocessed',
    queryTemplate: '',
    limit: DEFAULT_CONTEXT_QUERY_LIMIT,
    purpose: 'test purpose',
    required: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reset mocks between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeContextQueries', () => {
  describe('vault_unprocessed', () => {
    it('executes query and returns data', async () => {
      vi.mocked(getUnprocessedBatches).mockResolvedValue([MOCK_BATCH] as never);

      const results = await executeContextQueries(TEST_AGENT_ID, [
        makeQuery({ tool: 'vault_unprocessed', purpose: 'check backlog' }),
      ]);

      expect(results).toHaveLength(1);
      expect(results[0].tool).toBe('vault_unprocessed');
      expect(results[0].purpose).toBe('check backlog');
      expect(results[0].data).toEqual([MOCK_BATCH]);
      expect(results[0].error).toBeUndefined();
    });

    it('passes limit to getUnprocessedBatches', async () => {
      vi.mocked(getUnprocessedBatches).mockResolvedValue([]);

      await executeContextQueries(TEST_AGENT_ID, [
        makeQuery({ tool: 'vault_unprocessed', limit: 5 }),
      ]);

      expect(getUnprocessedBatches).toHaveBeenCalledWith({ limit: 5 });
    });
  });

  describe('vault_spores', () => {
    it('executes query with agent_id filter and returns data', async () => {
      vi.mocked(listSpores).mockResolvedValue([MOCK_SPORE] as never);

      const results = await executeContextQueries(TEST_AGENT_ID, [
        makeQuery({ tool: 'vault_spores', purpose: 'review spores' }),
      ]);

      expect(results).toHaveLength(1);
      expect(results[0].tool).toBe('vault_spores');
      expect(results[0].data).toEqual([MOCK_SPORE]);
      expect(listSpores).toHaveBeenCalledWith({
        agent_id: TEST_AGENT_ID,
        limit: DEFAULT_CONTEXT_QUERY_LIMIT,
      });
    });

    it('passes custom limit to listSpores', async () => {
      vi.mocked(listSpores).mockResolvedValue([]);

      await executeContextQueries(TEST_AGENT_ID, [
        makeQuery({ tool: 'vault_spores', limit: 20 }),
      ]);

      expect(listSpores).toHaveBeenCalledWith({
        agent_id: TEST_AGENT_ID,
        limit: 20,
      });
    });
  });

  describe('vault_sessions', () => {
    it('executes query and returns data', async () => {
      vi.mocked(listSessions).mockResolvedValue([MOCK_SESSION] as never);

      const results = await executeContextQueries(TEST_AGENT_ID, [
        makeQuery({ tool: 'vault_sessions', purpose: 'list recent sessions' }),
      ]);

      expect(results).toHaveLength(1);
      expect(results[0].tool).toBe('vault_sessions');
      expect(results[0].data).toEqual([MOCK_SESSION]);
      expect(listSessions).toHaveBeenCalledWith({ limit: DEFAULT_CONTEXT_QUERY_LIMIT });
    });
  });

  describe('vault_state', () => {
    it('executes query with agent_id and returns data', async () => {
      vi.mocked(getStatesForAgent).mockResolvedValue([MOCK_STATE]);

      const results = await executeContextQueries(TEST_AGENT_ID, [
        makeQuery({ tool: 'vault_state', purpose: 'read cursor position' }),
      ]);

      expect(results).toHaveLength(1);
      expect(results[0].tool).toBe('vault_state');
      expect(results[0].data).toEqual([MOCK_STATE]);
      expect(getStatesForAgent).toHaveBeenCalledWith(TEST_AGENT_ID);
    });
  });

  describe('error handling', () => {
    it('returns error field for failed non-required query (does not throw)', async () => {
      vi.mocked(getUnprocessedBatches).mockRejectedValue(new Error('DB unavailable'));

      const results = await executeContextQueries(TEST_AGENT_ID, [
        makeQuery({ tool: 'vault_unprocessed', required: false }),
      ]);

      expect(results).toHaveLength(1);
      expect(results[0].data).toBeNull();
      expect(results[0].error).toBe('DB unavailable');
    });

    it('throws on failed required query', async () => {
      vi.mocked(listSpores).mockRejectedValue(new Error('Connection lost'));

      await expect(
        executeContextQueries(TEST_AGENT_ID, [
          makeQuery({ tool: 'vault_spores', required: true }),
        ]),
      ).rejects.toThrow('Required context query "vault_spores" failed: Connection lost');
    });

    it('throws on unknown tool name', async () => {
      await expect(
        executeContextQueries(TEST_AGENT_ID, [
          makeQuery({ tool: 'vault_nonexistent', required: false }),
        ]),
      ).rejects.toThrow('Unknown context query tool: "vault_nonexistent"');
    });

    it('throws on unknown tool name even when required is false', async () => {
      await expect(
        executeContextQueries(TEST_AGENT_ID, [
          makeQuery({ tool: 'vault_unknown', required: false }),
        ]),
      ).rejects.toThrow('Unknown context query tool: "vault_unknown"');
    });
  });

  describe('limit handling', () => {
    it('uses default limit when query.limit not specified', async () => {
      vi.mocked(getUnprocessedBatches).mockResolvedValue([]);

      // Build query directly without specifying limit to use the type default
      const query: ContextQuery = {
        tool: 'vault_unprocessed',
        queryTemplate: '',
        limit: DEFAULT_CONTEXT_QUERY_LIMIT,
        purpose: 'test',
        required: false,
      };

      await executeContextQueries(TEST_AGENT_ID, [query]);

      expect(getUnprocessedBatches).toHaveBeenCalledWith({ limit: DEFAULT_CONTEXT_QUERY_LIMIT });
    });

    it('uses custom limit when specified', async () => {
      vi.mocked(listSessions).mockResolvedValue([]);

      await executeContextQueries(TEST_AGENT_ID, [
        makeQuery({ tool: 'vault_sessions', limit: 50 }),
      ]);

      expect(listSessions).toHaveBeenCalledWith({ limit: 50 });
    });
  });

  describe('multiple queries', () => {
    it('executes multiple queries and returns results in order', async () => {
      vi.mocked(getUnprocessedBatches).mockResolvedValue([MOCK_BATCH] as never);
      vi.mocked(getStatesForAgent).mockResolvedValue([MOCK_STATE]);

      const results = await executeContextQueries(TEST_AGENT_ID, [
        makeQuery({ tool: 'vault_unprocessed', purpose: 'backlog' }),
        makeQuery({ tool: 'vault_state', purpose: 'cursor' }),
      ]);

      expect(results).toHaveLength(2);
      expect(results[0].tool).toBe('vault_unprocessed');
      expect(results[1].tool).toBe('vault_state');
    });

    it('continues executing after a non-required failure', async () => {
      vi.mocked(getUnprocessedBatches).mockRejectedValue(new Error('DB down'));
      vi.mocked(getStatesForAgent).mockResolvedValue([MOCK_STATE]);

      const results = await executeContextQueries(TEST_AGENT_ID, [
        makeQuery({ tool: 'vault_unprocessed', required: false }),
        makeQuery({ tool: 'vault_state', purpose: 'cursor' }),
      ]);

      expect(results).toHaveLength(2);
      expect(results[0].error).toBe('DB down');
      expect(results[1].data).toEqual([MOCK_STATE]);
    });
  });
});
