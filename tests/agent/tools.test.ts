/**
 * Tests for vault MCP tool server.
 *
 * Each test initializes an in-memory PGlite instance, creates the schema,
 * and exercises tool handlers directly against the database.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '@myco/db/client.js';

// Mock tryEmbed to return null immediately — no real embedding provider in tests
vi.mock('@myco/intelligence/embed-query.js', () => ({
  tryEmbed: async () => null,
}));
import { createSchema } from '@myco/db/schema.js';
import { upsertSession, type SessionInsert } from '@myco/db/queries/sessions.js';
import { insertBatch, type BatchInsert } from '@myco/db/queries/batches.js';
import { insertRun, type RunInsert } from '@myco/db/queries/runs.js';
import { insertSpore, type SporeInsert } from '@myco/db/queries/spores.js';
import { setState } from '@myco/db/queries/agent-state.js';
import { createVaultTools, VAULT_TOOL_COUNT } from '@myco/agent/tools.js';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_AGENT_ID = 'test-agent';
const TEST_RUN_ID = 'run-test-001';

/** Epoch seconds helper. */
const epochNow = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Insert an agent directly into the agents table. */
async function createAgent(id: string): Promise<void> {
  const db = getDatabase();
  const now = epochNow();
  await db.query(
    `INSERT INTO agents (id, name, created_at) VALUES ($1, $2, $3)`,
    [id, `agent-${id}`, now],
  );
}

/** Insert an agent run directly (required FK for reports and turns). */
async function createRun(id: string, agentId: string): Promise<void> {
  await insertRun({
    id,
    agent_id: agentId,
    status: 'running',
    started_at: epochNow(),
  });
}

/** Factory for minimal valid session data. */
function makeSession(overrides: Partial<SessionInsert> = {}): SessionInsert {
  const now = epochNow();
  return {
    id: `sess-${Math.random().toString(36).slice(2, 8)}`,
    agent: 'claude-code',
    started_at: now,
    created_at: now,
    ...overrides,
  };
}

/** Factory for minimal valid batch data. */
function makeBatch(sessionId: string, overrides: Partial<BatchInsert> = {}): BatchInsert {
  return {
    session_id: sessionId,
    created_at: epochNow(),
    user_prompt: 'Test prompt',
    ...overrides,
  };
}

/** Look up a tool by name from the tools array. */
function findTool(tools: ReturnType<typeof createVaultTools>, name: string) {
  const t = tools.find((tool) => tool.name === name);
  if (!t) throw new Error(`Tool not found: ${name}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return t as SdkMcpToolDefinition<any>;
}

/** Parse the JSON text from a tool result. */
function parseResult(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('vault tools', () => {
  let tools: ReturnType<typeof createVaultTools>;
  let sessionId: string;

  beforeEach(async () => {
    const db = await initDatabase(); // in-memory
    await createSchema(db);

    // Seed required parent rows
    await createAgent(TEST_AGENT_ID);
    await createRun(TEST_RUN_ID, TEST_AGENT_ID);

    const session = makeSession();
    await upsertSession(session);
    sessionId = session.id;

    // Create tools for this test
    tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID);
  });

  afterEach(async () => {
    await closeDatabase();
  });

  // -------------------------------------------------------------------------
  // Meta
  // -------------------------------------------------------------------------

  describe('tool count', () => {
    it('creates exactly 14 tools', () => {
      expect(tools).toHaveLength(VAULT_TOOL_COUNT);
    });

    it('all tools have name, description, and handler', () => {
      for (const t of tools) {
        expect(typeof t.name).toBe('string');
        expect(t.name.length).toBeGreaterThan(0);
        expect(typeof t.description).toBe('string');
        expect(typeof t.handler).toBe('function');
      }
    });

    it('all tool names are unique', () => {
      const names = tools.map((t) => t.name);
      expect(new Set(names).size).toBe(names.length);
    });
  });

  // -------------------------------------------------------------------------
  // Read tools
  // -------------------------------------------------------------------------

  describe('vault_unprocessed', () => {
    it('returns empty array when no unprocessed batches exist', async () => {
      const t = findTool(tools, 'vault_unprocessed');
      const result = await t.handler({}, undefined);
      const data = parseResult(result) as unknown[];
      expect(data).toEqual([]);
    });

    it('returns unprocessed batches', async () => {
      await insertBatch(makeBatch(sessionId));
      await insertBatch(makeBatch(sessionId));

      const t = findTool(tools, 'vault_unprocessed');
      const result = await t.handler({}, undefined);
      const data = parseResult(result) as unknown[];
      expect(data).toHaveLength(2);
    });

    it('supports cursor-based pagination via after_id', async () => {
      const b1 = await insertBatch(makeBatch(sessionId));
      await insertBatch(makeBatch(sessionId));

      const t = findTool(tools, 'vault_unprocessed');
      const result = await t.handler({ after_id: b1.id }, undefined);
      const data = parseResult(result) as unknown[];
      expect(data).toHaveLength(1);
    });
  });

  describe('vault_spores', () => {
    it('returns empty array when no spores exist', async () => {
      const t = findTool(tools, 'vault_spores');
      const result = await t.handler({}, undefined);
      const data = parseResult(result) as unknown[];
      expect(data).toEqual([]);
    });

    it('returns spores filtered by observation_type', async () => {
      await insertSpore({
        id: 'spore-1',
        agent_id: TEST_AGENT_ID,
        observation_type: 'gotcha',
        content: 'A gotcha',
        created_at: epochNow(),
      });
      await insertSpore({
        id: 'spore-2',
        agent_id: TEST_AGENT_ID,
        observation_type: 'decision',
        content: 'A decision',
        created_at: epochNow(),
      });

      const t = findTool(tools, 'vault_spores');
      const result = await t.handler({ observation_type: 'gotcha' }, undefined);
      const data = parseResult(result) as Array<{ observation_type: string }>;
      expect(data).toHaveLength(1);
      expect(data[0].observation_type).toBe('gotcha');
    });
  });

  describe('vault_sessions', () => {
    it('returns sessions', async () => {
      const t = findTool(tools, 'vault_sessions');
      const result = await t.handler({}, undefined);
      const data = parseResult(result) as unknown[];
      // At least the one session we created in beforeEach
      expect(data.length).toBeGreaterThanOrEqual(1);
    });

    it('filters by status', async () => {
      const t = findTool(tools, 'vault_sessions');
      const result = await t.handler({ status: 'completed' }, undefined);
      const data = parseResult(result) as unknown[];
      expect(data).toEqual([]);
    });
  });

  describe('vault_search', () => {
    it('returns empty results gracefully when embedding unavailable', async () => {
      const t = findTool(tools, 'vault_search');
      const result = await t.handler({ query: 'test query' }, undefined);
      const data = parseResult(result) as { results: unknown[] };
      expect(data.results).toEqual([]);
    });
  });

  describe('vault_state', () => {
    it('returns empty array when no state set', async () => {
      const t = findTool(tools, 'vault_state');
      const result = await t.handler({}, undefined);
      const data = parseResult(result) as unknown[];
      expect(data).toEqual([]);
    });

    it('returns state entries after setting them', async () => {
      await setState(TEST_AGENT_ID, 'cursor', '42', epochNow());
      await setState(TEST_AGENT_ID, 'mode', 'full', epochNow());

      const t = findTool(tools, 'vault_state');
      const result = await t.handler({}, undefined);
      const data = parseResult(result) as Array<{ key: string; value: string }>;
      expect(data).toHaveLength(2);
      const keys = data.map((s) => s.key).sort();
      expect(keys).toEqual(['cursor', 'mode']);
    });
  });

  // -------------------------------------------------------------------------
  // Write tools
  // -------------------------------------------------------------------------

  describe('vault_create_spore', () => {
    it('creates a spore with agent_id injected', async () => {
      const t = findTool(tools, 'vault_create_spore');
      const result = await t.handler(
        {
          observation_type: 'gotcha',
          content: 'Watch out for this',
          session_id: sessionId,
          importance: 8,
          tags: ['testing', 'example'],
        },
        undefined,
      );
      const spore = parseResult(result) as { id: string; agent_id: string; importance: number; tags: string };
      expect(spore.id).toBeDefined();
      expect(spore.agent_id).toBe(TEST_AGENT_ID);
      expect(spore.importance).toBe(8);
      expect(JSON.parse(spore.tags)).toEqual(['testing', 'example']);
    });

    it('creates a spore with defaults', async () => {
      const t = findTool(tools, 'vault_create_spore');
      const result = await t.handler(
        {
          observation_type: 'discovery',
          content: 'Found something',
        },
        undefined,
      );
      const spore = parseResult(result) as { importance: number; session_id: string | null };
      expect(spore.importance).toBe(5);
      expect(spore.session_id).toBeNull();
    });

    it('records an audit turn', async () => {
      const t = findTool(tools, 'vault_create_spore');
      await t.handler(
        { observation_type: 'gotcha', content: 'test' },
        undefined,
      );

      // Wait a tick for fire-and-forget turn insertion
      await new Promise((resolve) => setTimeout(resolve, 50));

      const db = getDatabase();
      const turns = await db.query(
        `SELECT * FROM agent_turns WHERE run_id = $1`,
        [TEST_RUN_ID],
      );
      expect(turns.rows.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('vault_create_entity', () => {
    it('creates an entity with agent_id injected', async () => {
      const t = findTool(tools, 'vault_create_entity');
      const result = await t.handler(
        {
          type: 'component',
          name: 'AuthModule',
          properties: { language: 'TypeScript' },
        },
        undefined,
      );
      const entity = parseResult(result) as { agent_id: string; type: string; name: string; properties: string };
      expect(entity.agent_id).toBe(TEST_AGENT_ID);
      expect(entity.type).toBe('component');
      expect(entity.name).toBe('AuthModule');
      expect(JSON.parse(entity.properties)).toEqual({ language: 'TypeScript' });
    });

    it('upserts on conflict (same agent, type, name)', async () => {
      const t = findTool(tools, 'vault_create_entity');
      await t.handler(
        { type: 'component', name: 'AuthModule' },
        undefined,
      );
      const result = await t.handler(
        { type: 'component', name: 'AuthModule', properties: { version: 2 } },
        undefined,
      );
      const entity = parseResult(result) as { properties: string };
      expect(JSON.parse(entity.properties)).toEqual({ version: 2 });

      // Verify only one entity exists
      const db = getDatabase();
      const count = await db.query(
        `SELECT count(*) AS count FROM entities WHERE name = 'AuthModule'`,
      );
      expect(Number((count.rows[0] as { count: string }).count)).toBe(1);
    });
  });

  describe('vault_create_edge', () => {
    it('creates a semantic edge in graph_edges', async () => {
      // Create two entities first
      const db = getDatabase();
      const now = epochNow();
      await db.query(
        `INSERT INTO entities (id, agent_id, type, name, first_seen, last_seen)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['entity-a', TEST_AGENT_ID, 'component', 'CompA', now, now],
      );
      await db.query(
        `INSERT INTO entities (id, agent_id, type, name, first_seen, last_seen)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        ['entity-b', TEST_AGENT_ID, 'component', 'CompB', now, now],
      );

      const t = findTool(tools, 'vault_create_edge');
      const result = await t.handler(
        {
          source_id: 'entity-a',
          source_type: 'entity',
          target_id: 'entity-b',
          target_type: 'entity',
          type: 'DEPENDS_ON',
          confidence: 0.9,
        },
        undefined,
      );
      const edge = parseResult(result) as {
        agent_id: string; type: string; confidence: number;
        source_type: string; target_type: string;
      };
      expect(edge.agent_id).toBe(TEST_AGENT_ID);
      expect(edge.type).toBe('DEPENDS_ON');
      expect(edge.confidence).toBe(0.9);
      expect(edge.source_type).toBe('entity');
      expect(edge.target_type).toBe('entity');

      // Verify it's stored in graph_edges, not edges
      const graphEdges = await db.query(
        `SELECT * FROM graph_edges WHERE type = 'DEPENDS_ON'`,
      );
      expect(graphEdges.rows).toHaveLength(1);
    });
  });

  describe('vault_resolve_spore', () => {
    it('updates spore status and creates resolution event', async () => {
      // Create a spore to resolve
      await insertSpore({
        id: 'spore-resolve-test',
        agent_id: TEST_AGENT_ID,
        observation_type: 'gotcha',
        content: 'Old observation',
        created_at: epochNow(),
      });

      const t = findTool(tools, 'vault_resolve_spore');
      const result = await t.handler(
        {
          spore_id: 'spore-resolve-test',
          action: 'supersede',
          new_spore_id: 'spore-new',
          reason: 'Better observation available',
        },
        undefined,
      );
      const data = parseResult(result) as {
        spore: { status: string };
        resolution_event_id: string;
      };
      expect(data.spore.status).toBe('superseded');
      expect(data.resolution_event_id).toBeDefined();

      // Verify resolution event in DB
      const db = getDatabase();
      const events = await db.query(
        `SELECT * FROM resolution_events WHERE spore_id = $1`,
        ['spore-resolve-test'],
      );
      expect(events.rows).toHaveLength(1);
    });
  });

  describe('vault_update_session', () => {
    it('updates session title and summary', async () => {
      const t = findTool(tools, 'vault_update_session');
      const result = await t.handler(
        {
          session_id: sessionId,
          title: 'New Title',
          summary: 'New summary of the session',
        },
        undefined,
      );
      const session = parseResult(result) as { title: string; summary: string };
      expect(session.title).toBe('New Title');
      expect(session.summary).toBe('New summary of the session');
    });
  });

  describe('vault_set_state', () => {
    it('sets a state value for the current agent', async () => {
      const t = findTool(tools, 'vault_set_state');
      const result = await t.handler(
        { key: 'last_processed_batch_id', value: '42' },
        undefined,
      );
      const state = parseResult(result) as { agent_id: string; key: string; value: string };
      expect(state.agent_id).toBe(TEST_AGENT_ID);
      expect(state.key).toBe('last_processed_batch_id');
      expect(state.value).toBe('42');
    });

    it('overwrites existing state', async () => {
      const t = findTool(tools, 'vault_set_state');
      await t.handler({ key: 'cursor', value: '10' }, undefined);
      const result = await t.handler({ key: 'cursor', value: '20' }, undefined);
      const state = parseResult(result) as { value: string };
      expect(state.value).toBe('20');
    });
  });

  describe('vault_write_digest', () => {
    it('creates a digest extract', async () => {
      const t = findTool(tools, 'vault_write_digest');
      const result = await t.handler(
        { tier: 1500, content: '# Digest\nCompact context.' },
        undefined,
      );
      const extract = parseResult(result) as { agent_id: string; tier: number; content: string };
      expect(extract.agent_id).toBe(TEST_AGENT_ID);
      expect(extract.tier).toBe(1500);
      expect(extract.content).toBe('# Digest\nCompact context.');
    });

    it('upserts on (agent_id, tier) conflict', async () => {
      const t = findTool(tools, 'vault_write_digest');
      await t.handler({ tier: 3000, content: 'v1' }, undefined);
      const result = await t.handler({ tier: 3000, content: 'v2' }, undefined);
      const extract = parseResult(result) as { content: string };
      expect(extract.content).toBe('v2');

      // Verify only one row
      const db = getDatabase();
      const count = await db.query(
        `SELECT count(*) AS count FROM digest_extracts WHERE agent_id = $1 AND tier = $2`,
        [TEST_AGENT_ID, 3000],
      );
      expect(Number((count.rows[0] as { count: string }).count)).toBe(1);
    });
  });

  describe('vault_mark_processed', () => {
    it('marks a batch as processed', async () => {
      const batch = await insertBatch(makeBatch(sessionId));

      const t = findTool(tools, 'vault_mark_processed');
      const result = await t.handler({ batch_id: batch.id }, undefined);
      const updated = parseResult(result) as { processed: number };
      expect(updated.processed).toBe(1);
    });

    it('batch no longer appears in unprocessed', async () => {
      const batch = await insertBatch(makeBatch(sessionId));

      const markTool = findTool(tools, 'vault_mark_processed');
      await markTool.handler({ batch_id: batch.id }, undefined);

      const listTool = findTool(tools, 'vault_unprocessed');
      const result = await listTool.handler({}, undefined);
      const data = parseResult(result) as unknown[];
      expect(data).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Observability tool
  // -------------------------------------------------------------------------

  describe('vault_report', () => {
    it('writes a report with run_id and agent_id injected', async () => {
      const t = findTool(tools, 'vault_report');
      const result = await t.handler(
        {
          action: 'extract',
          summary: 'Extracted 3 spores from batch 42',
          details: { batch_id: 42, spore_count: 3 },
        },
        undefined,
      );
      const report = parseResult(result) as {
        run_id: string;
        agent_id: string;
        action: string;
        summary: string;
        details: string;
      };
      expect(report.run_id).toBe(TEST_RUN_ID);
      expect(report.agent_id).toBe(TEST_AGENT_ID);
      expect(report.action).toBe('extract');
      expect(report.summary).toBe('Extracted 3 spores from batch 42');
      expect(JSON.parse(report.details)).toEqual({ batch_id: 42, spore_count: 3 });
    });

    it('writes a report without details', async () => {
      const t = findTool(tools, 'vault_report');
      const result = await t.handler(
        { action: 'skip', summary: 'No work to do' },
        undefined,
      );
      const report = parseResult(result) as { details: string | null };
      expect(report.details).toBeNull();
    });

    it('report is persisted in agent_reports table', async () => {
      const t = findTool(tools, 'vault_report');
      await t.handler(
        { action: 'test', summary: 'Testing persistence' },
        undefined,
      );

      const db = getDatabase();
      const result = await db.query(
        `SELECT * FROM agent_reports WHERE run_id = $1`,
        [TEST_RUN_ID],
      );
      expect(result.rows.length).toBeGreaterThanOrEqual(1);
    });
  });
});
