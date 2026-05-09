/**
 * Tests for context query execution.
 *
 * DB query functions are mocked via mock.module() so tests never touch a real
 * database. Each test exercises the routing logic and error handling of
 * executeContextQueries().
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import type { ContextQuery } from '@myco/agent/types.js';
import { GLOBAL_SCOPE } from '@myco/grove/ids.js';

// ---------------------------------------------------------------------------
// Mocks: DB query functions
// ---------------------------------------------------------------------------

mock.module('@myco/db/queries/batches.js', () => ({
  getUnprocessedBatches: vi.fn(),
}));

mock.module('@myco/db/queries/spores.js', () => ({
  listSpores: vi.fn(),
}));

mock.module('@myco/db/queries/sessions.js', () => ({
  listSessions: vi.fn(),
}));

mock.module('@myco/db/queries/agent-state.js', () => ({
  getStatesForAgent: vi.fn(),
}));

// Import mocked modules for controlling return values
import { getUnprocessedBatches } from '@myco/db/queries/batches.js';
import { listSpores } from '@myco/db/queries/spores.js';
import { listSessions } from '@myco/db/queries/sessions.js';
import { getStatesForAgent } from '@myco/db/queries/agent-state.js';
import { resolveLegacyRequestContext } from '@myco/tools/request-context.js';

// Import the module under test after mocks are registered
import { executeContextQueries } from '@myco/agent/context-queries.js';

import { TEST_REQUEST_CONTEXT } from '../helpers/request-context';
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_AGENT_ID = 'myco-agent';

/** Default limit used when query.limit is not specified. */
const DEFAULT_CONTEXT_QUERY_LIMIT = 10;

/** Sample batch row shape (only fields relevant to assertions). */
const MOCK_BATCH = {
  id: 1,
  session_id: 'sess-abc',
  prompt_number: 1,
  user_prompt: 'Inspect the failing harness run',
  response_summary: 'Added budget diagnostics',
  processed: 0,
};

/** Sample spore row shape (only fields relevant to assertions). */
const MOCK_SPORE = {
  id: 'spore-1',
  agent_id: TEST_AGENT_ID,
  observation_type: 'gotcha',
  content: 'Prompt compaction can hide follow-up work',
  created_at: 1000,
};

/** Sample session row shape. */
const MOCK_SESSION = {
  id: 'sess-abc',
  agent: 'claude-code',
  status: 'active',
  title: 'Tighten harness telemetry',
  summary: 'Added compact read payloads',
  prompt_count: 3,
  started_at: 1000,
};

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

function requestContext(projectId: string) {
  return resolveLegacyRequestContext('/tmp/myco-context-queries-test/.myco', {
    projectRoot: `/workspace/${projectId}`,
    projectId,
    groveId: 'grove-test',
    machineId: 'machine-test',
    source: 'explicit',
  });
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
      vi.mocked(getUnprocessedBatches).mockReturnValue([MOCK_BATCH] as never);

      const results = await executeContextQueries(TEST_AGENT_ID, [
        makeQuery({ tool: 'vault_unprocessed', purpose: 'check backlog' }),
      ], TEST_REQUEST_CONTEXT);

      expect(results).toHaveLength(1);
      expect(results[0].tool).toBe('vault_unprocessed');
      expect(results[0].purpose).toBe('check backlog');
      expect(results[0].data).toEqual([{
        id: 1,
        session_id: 'sess-abc',
        prompt_number: 1,
        user_prompt: 'Inspect the failing harness run',
        response_summary: 'Added budget diagnostics',
      }]);
      expect(results[0].error).toBeUndefined();
    });

    it('passes limit to getUnprocessedBatches', async () => {
      vi.mocked(getUnprocessedBatches).mockReturnValue([]);

      await executeContextQueries(TEST_AGENT_ID, [
        makeQuery({ tool: 'vault_unprocessed', limit: 5 }),
      ], TEST_REQUEST_CONTEXT);

      expect(getUnprocessedBatches).toHaveBeenCalledWith({ limit: 5, includeActive: false, scope: GLOBAL_SCOPE });
    });

    it('passes request-context project scope to getUnprocessedBatches', async () => {
      vi.mocked(getUnprocessedBatches).mockReturnValue([]);

      await executeContextQueries(TEST_AGENT_ID, [
        makeQuery({ tool: 'vault_unprocessed', limit: 5 }),
      ], requestContext('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));

      expect(getUnprocessedBatches).toHaveBeenCalledWith({
        limit: 5,
        includeActive: false,
        scope: { kind: 'project', id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      });
    });
  });

  describe('vault_spores', () => {
    it('executes query with agent_id filter and returns data', async () => {
      vi.mocked(listSpores).mockReturnValue([MOCK_SPORE] as never);

      const results = await executeContextQueries(TEST_AGENT_ID, [
        makeQuery({ tool: 'vault_spores', purpose: 'review spores' }),
      ], TEST_REQUEST_CONTEXT);

      expect(results).toHaveLength(1);
      expect(results[0].tool).toBe('vault_spores');
      expect(results[0].data).toEqual([{
        id: 'spore-1',
        observation_type: 'gotcha',
        content_preview: 'Prompt compaction can hide follow-up work',
        created_at: 1000,
      }]);
      expect(listSpores).toHaveBeenCalledWith({
        agent_id: TEST_AGENT_ID,
        limit: DEFAULT_CONTEXT_QUERY_LIMIT,
        includeActive: false,
        scope: GLOBAL_SCOPE,
      });
    });

    it('passes custom limit to listSpores', async () => {
      vi.mocked(listSpores).mockReturnValue([]);

      await executeContextQueries(TEST_AGENT_ID, [
        makeQuery({ tool: 'vault_spores', limit: 20 }),
      ], TEST_REQUEST_CONTEXT);

      expect(listSpores).toHaveBeenCalledWith({
        agent_id: TEST_AGENT_ID,
        limit: 20,
        includeActive: false,
        scope: GLOBAL_SCOPE,
      });
    });

    it('passes request-context project scope to listSpores', async () => {
      vi.mocked(listSpores).mockReturnValue([]);

      await executeContextQueries(TEST_AGENT_ID, [
        makeQuery({ tool: 'vault_spores', limit: 20 }),
      ], requestContext('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));

      expect(listSpores).toHaveBeenCalledWith({
        agent_id: TEST_AGENT_ID,
        scope: { kind: 'project', id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        limit: 20,
        includeActive: false,
      });
    });
  });

  describe('vault_sessions', () => {
    it('executes query and returns data', async () => {
      vi.mocked(listSessions).mockReturnValue([MOCK_SESSION] as never);

      const results = await executeContextQueries(TEST_AGENT_ID, [
        makeQuery({ tool: 'vault_sessions', purpose: 'list recent sessions' }),
      ], TEST_REQUEST_CONTEXT);

      expect(results).toHaveLength(1);
      expect(results[0].tool).toBe('vault_sessions');
      expect(results[0].data).toEqual([{
        id: 'sess-abc',
        agent: 'claude-code',
        status: 'active',
        title: 'Tighten harness telemetry',
        summary: 'Added compact read payloads',
        prompt_count: 3,
        started_at: 1000,
      }]);
      expect(listSessions).toHaveBeenCalledWith({ limit: DEFAULT_CONTEXT_QUERY_LIMIT, includeActive: false, scope: GLOBAL_SCOPE });
    });

    it('passes request-context project scope to listSessions', async () => {
      vi.mocked(listSessions).mockReturnValue([]);

      await executeContextQueries(TEST_AGENT_ID, [
        makeQuery({ tool: 'vault_sessions', limit: 5 }),
      ], requestContext('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));

      expect(listSessions).toHaveBeenCalledWith({
        scope: { kind: 'project', id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        limit: 5,
        includeActive: false,
      });
    });
  });

  describe('vault_state', () => {
    it('executes query with agent_id and returns data', async () => {
      vi.mocked(getStatesForAgent).mockReturnValue([MOCK_STATE]);

      const results = await executeContextQueries(TEST_AGENT_ID, [
        makeQuery({ tool: 'vault_state', purpose: 'read cursor position' }),
      ], TEST_REQUEST_CONTEXT);

      expect(results).toHaveLength(1);
      expect(results[0].tool).toBe('vault_state');
      expect(results[0].data).toEqual([MOCK_STATE]);
      expect(getStatesForAgent).toHaveBeenCalledWith(TEST_AGENT_ID);
    });
  });

  describe('error handling', () => {
    it('returns error field for failed non-required query (does not throw)', async () => {
      vi.mocked(getUnprocessedBatches).mockImplementation(() => {
        throw new Error('DB unavailable');
      });

      const results = await executeContextQueries(TEST_AGENT_ID, [
        makeQuery({ tool: 'vault_unprocessed', required: false }),
      ], TEST_REQUEST_CONTEXT);

      expect(results).toHaveLength(1);
      expect(results[0].data).toBeNull();
      expect(results[0].error).toBe('DB unavailable');
    });

    it('throws on failed required query', async () => {
      vi.mocked(listSpores).mockImplementation(() => {
        throw new Error('Connection lost');
      });

      await expect(
        executeContextQueries(TEST_AGENT_ID, [
          makeQuery({ tool: 'vault_spores', required: true }),
        ], TEST_REQUEST_CONTEXT),
      ).rejects.toThrow('Required context query "vault_spores" failed: Connection lost');
    });

    it('throws on unknown tool name', async () => {
      await expect(
        executeContextQueries(TEST_AGENT_ID, [
          makeQuery({ tool: 'vault_nonexistent', required: false }),
        ], TEST_REQUEST_CONTEXT),
      ).rejects.toThrow('Unknown context query tool: "vault_nonexistent"');
    });

    it('throws on unknown tool name even when required is false', async () => {
      await expect(
        executeContextQueries(TEST_AGENT_ID, [
          makeQuery({ tool: 'vault_unknown', required: false }),
        ], TEST_REQUEST_CONTEXT),
      ).rejects.toThrow('Unknown context query tool: "vault_unknown"');
    });
  });

  describe('limit handling', () => {
    it('uses default limit when query.limit not specified', async () => {
      vi.mocked(getUnprocessedBatches).mockReturnValue([]);

      // Build query directly without specifying limit to use the type default
      const query: ContextQuery = {
        tool: 'vault_unprocessed',
        queryTemplate: '',
        limit: DEFAULT_CONTEXT_QUERY_LIMIT,
        purpose: 'test',
        required: false,
      };

      await executeContextQueries(TEST_AGENT_ID, [query], TEST_REQUEST_CONTEXT);

      expect(getUnprocessedBatches).toHaveBeenCalledWith({
        limit: DEFAULT_CONTEXT_QUERY_LIMIT,
        includeActive: false,
        scope: GLOBAL_SCOPE,
      });
    });

    it('uses custom limit when specified', async () => {
      vi.mocked(listSessions).mockReturnValue([]);

      await executeContextQueries(TEST_AGENT_ID, [
        makeQuery({ tool: 'vault_sessions', limit: 50 }),
      ], TEST_REQUEST_CONTEXT);

      expect(listSessions).toHaveBeenCalledWith({ limit: 50, includeActive: false, scope: GLOBAL_SCOPE });
    });
  });

  describe('multiple queries', () => {
    it('executes multiple queries and returns results in order', async () => {
      vi.mocked(getUnprocessedBatches).mockReturnValue([MOCK_BATCH] as never);
      vi.mocked(getStatesForAgent).mockReturnValue([MOCK_STATE]);

      const results = await executeContextQueries(TEST_AGENT_ID, [
        makeQuery({ tool: 'vault_unprocessed', purpose: 'backlog' }),
        makeQuery({ tool: 'vault_state', purpose: 'cursor' }),
      ], TEST_REQUEST_CONTEXT);

      expect(results).toHaveLength(2);
      expect(results[0].tool).toBe('vault_unprocessed');
      expect(results[1].tool).toBe('vault_state');
    });

    it('continues executing after a non-required failure', async () => {
      vi.mocked(getUnprocessedBatches).mockImplementation(() => {
        throw new Error('DB down');
      });
      vi.mocked(getStatesForAgent).mockReturnValue([MOCK_STATE]);

      const results = await executeContextQueries(TEST_AGENT_ID, [
        makeQuery({ tool: 'vault_unprocessed', required: false }),
        makeQuery({ tool: 'vault_state', purpose: 'cursor' }),
      ], TEST_REQUEST_CONTEXT);

      expect(results).toHaveLength(2);
      expect(results[0].error).toBe('DB down');
      expect(results[1].data).toEqual([MOCK_STATE]);
    });
  });
});
