/**
 * Tests for the `vault_search_canopy` harness tool — a thin wrapper over the
 * embedding manager's `searchVectors` pinned to the `canopy_entries` namespace
 * and hydrated with `llm_description` straight from the row.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { getDatabase } from '@myco/db/client.js';
import type { AgentEmbeddingPort } from '@myco/agent/runtime/ports.js';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { createVaultTools } from '@myco/agent/tools.js';
import { setupTestDb, cleanTestDb, teardownTestDb, seedCanopyEntry } from '../../helpers/db';
import { insertRun } from '@myco/db/queries/runs.js';
import { hydrateCanopyDescription, parseCanopyRecordId } from '@myco/canopy/hydrate.js';

import { TEST_REQUEST_CONTEXT } from '../../helpers/request-context';
const TEST_AGENT_ID = 'test-agent';
const TEST_RUN_ID = 'run-test-canopy';

const epochNow = () => Math.floor(Date.now() / 1000);

function createAgent(id: string): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO agents (id, name, created_at) VALUES (?, ?, ?)`,
  ).run(id, `agent-${id}`, epochNow());
}

function seedCanopyRow(opts: {
  project_id: string;
  path: string;
  language?: string | null;
  description: string;
}): void {
  const now = epochNow();
  seedCanopyEntry(getDatabase(), {
    project_id: opts.project_id,
    path: opts.path,
    size_bytes: 100,
    token_estimate: 20,
    line_count: 10,
    language: opts.language ?? null,
    mechanical_updated_at: now,
    llm_description: opts.description,
    llm_updated_at: now,
    embedded: 1,
  });
}

function findTool(
  tools: ReturnType<typeof createVaultTools>,
  name: string,
): SdkMcpToolDefinition<Record<string, unknown>> {
  const t = tools.find((tool) => tool.name === name);
  if (!t) throw new Error(`Tool not found: ${name}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return t as SdkMcpToolDefinition<any>;
}

function parseResult(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

describe('vault_search_canopy', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    createAgent(TEST_AGENT_ID);
    insertRun({ id: TEST_RUN_ID, agent_id: TEST_AGENT_ID, status: 'running', started_at: epochNow() });
  });

  it('returns unavailable message when no embedding manager is configured', async () => {
    const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, { requestContext: TEST_REQUEST_CONTEXT });
    const t = findTool(tools, 'vault_search_canopy');
    const result = await t.handler({ query: 'auth' }, undefined);
    const data = parseResult(result) as { results: unknown[]; message?: string };
    expect(data.results).toEqual([]);
    expect(data.message).toBe('Embedding provider unavailable');
  });

  it('hydrates llm_description from canopy_entries by synthesized id', async () => {
    seedCanopyRow({
      project_id: 'p',
      path: 'auth/login.ts',
      language: 'typescript',
      description: 'login flow handler',
    });

    const embeddingManager = {
      embedQuery: async () => Array(8).fill(0.5),
      searchVectors: () => [
        {
          id: 'p:auth/login.ts',
          namespace: 'canopy_entries',
          similarity: 0.9,
          metadata: { project_id: 'p', path: 'auth/login.ts', language: 'typescript' },
        },
      ],
    } as Pick<AgentEmbeddingPort, 'embedQuery' | 'searchVectors'> as AgentEmbeddingPort;

    const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, { requestContext: TEST_REQUEST_CONTEXT, embeddingManager });
    const t = findTool(tools, 'vault_search_canopy');
    const result = await t.handler({ query: 'authentication' }, undefined);
    const data = parseResult(result) as {
      results: Array<{
        project_id: string;
        path: string;
        llm_description: string | null;
        language: string | null;
        score: number;
      }>;
    };

    expect(data.results).toHaveLength(1);
    expect(data.results[0]).toMatchObject({
      project_id: 'p',
      path: 'auth/login.ts',
      llm_description: 'login flow handler',
      language: 'typescript',
    });
    expect(typeof data.results[0].score).toBe('number');
  });

  it('passes the language filter to searchVectors when set', async () => {
    seedCanopyRow({
      project_id: 'p',
      path: 'src/auth/login.ts',
      language: 'typescript',
      description: 'login handler',
    });

    let capturedFilters: Record<string, unknown> | undefined;
    let capturedNamespace: string | undefined;

    const embeddingManager = {
      embedQuery: async () => Array(8).fill(0.5),
      searchVectors: (_query: number[], opts?: { namespace?: string; filters?: Record<string, unknown> }) => {
        capturedNamespace = opts?.namespace;
        capturedFilters = opts?.filters;
        return [
          {
            id: 'p:src/auth/login.ts',
            namespace: 'canopy_entries',
            similarity: 0.85,
            metadata: { project_id: 'p', path: 'src/auth/login.ts', language: 'typescript' },
          },
        ];
      },
    } as Pick<AgentEmbeddingPort, 'embedQuery' | 'searchVectors'> as AgentEmbeddingPort;

    const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, { requestContext: TEST_REQUEST_CONTEXT, embeddingManager });
    const t = findTool(tools, 'vault_search_canopy');
    await t.handler({ query: 'auth', language: 'typescript' }, undefined);

    expect(capturedNamespace).toBe('canopy_entries');
    expect(capturedFilters).toEqual({ language: 'typescript' });
  });

  it('omits filters when none of the optional inputs are provided', async () => {
    let capturedFilters: Record<string, unknown> | undefined;

    const embeddingManager = {
      embedQuery: async () => Array(8).fill(0.5),
      searchVectors: (_query: number[], opts?: { filters?: Record<string, unknown> }) => {
        capturedFilters = opts?.filters;
        return [];
      },
    } as Pick<AgentEmbeddingPort, 'embedQuery' | 'searchVectors'> as AgentEmbeddingPort;

    const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, { requestContext: TEST_REQUEST_CONTEXT, embeddingManager });
    const t = findTool(tools, 'vault_search_canopy');
    await t.handler({ query: 'anything' }, undefined);

    expect(capturedFilters).toBeUndefined();
  });

  it('returns null for malformed synthesized ids', () => {
    expect(hydrateCanopyDescription('no-colon')).toBeNull();
    expect(hydrateCanopyDescription(':leading-colon')).toBeNull();
    expect(hydrateCanopyDescription('trailing:')).toBeNull();
    expect(parseCanopyRecordId('no-colon')).toBeNull();
    expect(parseCanopyRecordId(':leading-colon')).toBeNull();
    expect(parseCanopyRecordId('trailing:')).toBeNull();
    expect(parseCanopyRecordId('proj:path/with:colon.ts')).toEqual({ projectId: 'proj', path: 'path/with:colon.ts' });
  });

  it('returns null llm_description when the canopy_entries row is missing', async () => {
    const embeddingManager = {
      embedQuery: async () => Array(8).fill(0.5),
      searchVectors: () => [
        {
          id: 'p:ghost.ts',
          namespace: 'canopy_entries',
          similarity: 0.7,
          metadata: { project_id: 'p', path: 'ghost.ts', language: 'typescript' },
        },
      ],
    } as Pick<AgentEmbeddingPort, 'embedQuery' | 'searchVectors'> as AgentEmbeddingPort;

    const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, { requestContext: TEST_REQUEST_CONTEXT, embeddingManager });
    const t = findTool(tools, 'vault_search_canopy');
    const result = await t.handler({ query: 'ghost' }, undefined);
    const data = parseResult(result) as { results: Array<{ llm_description: string | null }> };

    expect(data.results).toHaveLength(1);
    expect(data.results[0].llm_description).toBeNull();
  });
});
