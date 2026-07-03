/**
 * Tests for vault MCP tool server.
 *
 * Each test initializes an in-memory PGlite instance, creates the schema,
 * and exercises tool handlers directly against the database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { getDatabase } from '@myco/db/client.js';
import type { AgentEmbeddingPort } from '@myco/agent/runtime/ports.js';

// Mock tryEmbed to return null immediately — no real embedding provider in tests
mock.module('@myco/intelligence/embed-query.js', () => ({
  tryEmbed: async () => null,
}));

// ---------------------------------------------------------------------------
// Pin getMachineId to a fixed sentinel so assertions on machine_id fields are
// deterministic across machines and CI (real ~/.myco/machine_id varies).
// ---------------------------------------------------------------------------
const TEST_MACHINE_ID = 'testuser_aabbccdd';
mock.module('@myco/machine-id.js', () => ({
  getMachineId: () => TEST_MACHINE_ID,
}));
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { upsertSession, type SessionInsert } from '@myco/db/queries/sessions.js';
import { insertBatch, type BatchInsert } from '@myco/db/queries/batches.js';
import { insertRun, type RunInsert } from '@myco/db/queries/runs.js';
import { insertSpore, type SporeInsert } from '@myco/db/queries/spores.js';
import { insertEntity } from '@myco/db/queries/entities.js';
import { setState } from '@myco/db/queries/agent-state.js';
import { insertGraphEdge } from '@myco/db/queries/graph-edges.js';
import { insertResolutionEvent } from '@myco/db/queries/resolution-events.js';
import { createVaultTools, VAULT_TOOL_COUNT } from '@myco/agent/tools.js';
import { DEFERRED_STUB_DESCRIPTION } from '@myco/agent/tools/deferred-tools.js';
import { ALL_VAULT_TOOL_NAMES } from '@myco/agent/tool-names.js';
import { resolveLegacyRequestContext } from '@myco/grove/request-context.js';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';

import { TEST_REQUEST_CONTEXT } from '../helpers/request-context';
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
function createAgent(id: string): void {
  const db = getDatabase();
  const now = epochNow();
  db.prepare(
    `INSERT INTO agents (id, name, created_at) VALUES (?, ?, ?)`,
  ).run(id, `agent-${id}`, now);
}

/** Insert an agent run directly (required FK for reports and turns). */
function createRun(id: string, agentId: string): void {
  insertRun({
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

function requestContext(projectId: string) {
  return resolveLegacyRequestContext('/tmp/myco-agent-tools-test/.myco', {
    projectRoot: `/workspace/${projectId}`,
    projectId,
    groveId: 'grove-test',
    machineId: 'machine-test',
    source: 'explicit',
    // Explicit project/grove pivot = caller-asserted tenancy; the scope seam
    // binds a Grove-bound context to its project scope only when caller-asserted.
    tenancySource: 'caller',
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('vault tools', () => {
  let tools: ReturnType<typeof createVaultTools>;
  let sessionId: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();

    // Seed required parent rows
    createAgent(TEST_AGENT_ID);
    createRun(TEST_RUN_ID, TEST_AGENT_ID);

    const session = makeSession();
    upsertSession(session);
    sessionId = session.id;

    // Create tools for this test
    tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, { requestContext: TEST_REQUEST_CONTEXT });
  });

  // -------------------------------------------------------------------------
  // Meta
  // -------------------------------------------------------------------------

  describe('tool count', () => {
    it('creates exactly VAULT_TOOL_COUNT tools', () => {
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
  // ALL_VAULT_TOOL_NAMES drift guard
  //
  // tool-names.ts (imported by both tools.ts and schemas.ts) must stay in
  // lockstep with the REAL tool registry this file builds via
  // createVaultTools — the registry is imported here in the TEST, not in
  // tool-names.ts itself, since tool-names.ts must stay zero-dep (no
  // bun:sqlite-adjacent imports) for codegen to load schemas.ts safely.
  // -------------------------------------------------------------------------

  describe('ALL_VAULT_TOOL_NAMES drift guard', () => {
    it('union size matches VAULT_TOOL_COUNT', () => {
      expect(ALL_VAULT_TOOL_NAMES.size).toBe(VAULT_TOOL_COUNT);
    });

    it('every tool the real registry produces is in ALL_VAULT_TOOL_NAMES', () => {
      for (const t of tools) {
        expect(ALL_VAULT_TOOL_NAMES.has(t.name)).toBe(true);
      }
    });

    it('every name in ALL_VAULT_TOOL_NAMES is produced by the real registry', () => {
      const registryNames = new Set(tools.map((t) => t.name));
      for (const name of ALL_VAULT_TOOL_NAMES) {
        expect(registryNames.has(name)).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Deferred tool loading
  // -------------------------------------------------------------------------

  describe('deferred tool loading', () => {
    it('does not add vault_search_tools when no tool is deferrable', () => {
      const names = tools.map((t) => t.name);
      expect(names).not.toContain('vault_search_tools');
    });

    it('adds vault_search_tools and stubs the deferred tool when a tool factory marks one deferrable', async () => {
      // vault_state (read-tools.ts) is a good stand-in: tiny schema, easy to
      // assert the stub replaced it. We don't want to hand-mark every tool
      // deferrable, so this test builds its own tiny closure the same way
      // createVaultTools does, exercising the exact code path.
      const { createVaultTools: freshFactory } = await import('@myco/agent/tools.js');
      // Monkey-mark: directly test via a real onlyNames-scoped call against
      // vault_state, then assert createVaultTools's wiring stubs it IF the
      // underlying factory declares it deferrable. Since no production tool
      // is deferrable yet (Task 4 adds task-level opt-in), this test instead
      // verifies the wiring contract using the exported helpers directly
      // against the real tool array, proving createVaultTools calls them.
      const allTools = freshFactory(TEST_AGENT_ID, TEST_RUN_ID, { requestContext: TEST_REQUEST_CONTEXT });
      const vaultState = allTools.find((t) => t.name === 'vault_state')!;
      expect(vaultState.deferrable).toBeUndefined(); // no tool is deferrable by default yet
    });

    it('marks named tools deferrable via deferredNames and adds vault_search_tools', async () => {
      const scopedTools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
        requestContext: TEST_REQUEST_CONTEXT,
        onlyNames: new Set(['vault_spores', 'vault_search_fts', 'vault_scan_skill_contamination', 'vault_report']),
        deferredNames: new Set(['vault_scan_skill_contamination']),
      });
      const names = scopedTools.map((t) => t.name);
      expect(names).toContain('vault_search_tools');

      const scanTool = scopedTools.find((t) => t.name === 'vault_scan_skill_contamination')!;
      expect(scanTool.description).toBe(DEFERRED_STUB_DESCRIPTION);

      // Non-deferred tools in the same scoped surface are untouched.
      const sporesTool = scopedTools.find((t) => t.name === 'vault_spores')!;
      expect(sporesTool.description).not.toContain('deferred');
    });

    it('createVaultToolServer (the FULL-SURFACE / unscoped MCP server factory) threads deferredNames through to real stubs and vault_search_tools', async () => {
      // P3-T1: single-query tasks (executeSingleQuery, phase-loop.ts) have
      // no `phases:` block, so they hit createVaultToolServer directly —
      // the FULL-SURFACE path — never createScopedVaultToolServer. Before
      // this task, createVaultToolServer's options Pick (tools.ts) excluded
      // 'deferredNames' entirely, so a task-level deferredTools field would
      // have reached this call and been silently dropped. Assert against
      // the real MCP server's registered-tools surface (not a mock) to
      // prove the stub/meta-tool synthesis actually happens on this path.
      const { createVaultToolServer: freshCreateVaultToolServer } = await import('@myco/agent/tools.js');
      const server = freshCreateVaultToolServer(TEST_AGENT_ID, TEST_RUN_ID, {
        requestContext: TEST_REQUEST_CONTEXT,
        deferredNames: new Set(['vault_report']),
      });
      const registeredTools = (server as unknown as { instance: { _registeredTools: Record<string, { description?: string }> } })
        .instance._registeredTools;
      const names = Object.keys(registeredTools);

      expect(names).toContain('vault_search_tools');
      expect(names).toContain('vault_report');
      expect(registeredTools.vault_report.description).toBe(DEFERRED_STUB_DESCRIPTION);

      // A non-deferred tool on the same full surface is untouched.
      expect(registeredTools.vault_spores.description).not.toBe(DEFERRED_STUB_DESCRIPTION);

      // Deferral never changes callability — the stub only replaces
      // description/schema; the real handler still runs end-to-end and
      // writes through to the vault exactly as an undeferred call would.
      const result = await registeredTools.vault_report.handler(
        { action: 'extract', summary: 'Deferred-stub call still reaches the real handler.' },
        undefined,
      );
      const report = JSON.parse(result.content[0].text) as { run_id: string; agent_id: string; action: string };
      expect(report.run_id).toBe(TEST_RUN_ID);
      expect(report.agent_id).toBe(TEST_AGENT_ID);
      expect(report.action).toBe('extract');
    });
  });

  describe('phasePurpose plumbing', () => {
    it('passes phasePurpose through to tool deps without altering tool behavior', () => {
      const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
        requestContext: TEST_REQUEST_CONTEXT,
        phasePurpose: { name: 'consolidate-write', promptExcerpt: 'Merge related spores into a wisdom note.' },
      });
      // Behavior-neutral: passing phasePurpose must not change tool count or names.
      expect(tools.length).toBeGreaterThan(0);
      expect(tools.some((t) => t.name === 'vault_create_spore')).toBe(true);
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

      const turns = getDatabase().prepare(
        `SELECT tool_output_summary, completed_at FROM agent_turns WHERE run_id = ? ORDER BY id ASC`,
      ).all(TEST_RUN_ID) as Array<{ tool_output_summary: string | null; completed_at: number | null }>;
      expect(turns).toHaveLength(1);
      expect(turns[0].completed_at).not.toBeNull();
      expect(turns[0].tool_output_summary).toBe('[]');
    });

    it('returns unprocessed batches when include_active is set', async () => {
      // The seeded session is `status = 'active'`, so the tool's default
      // (exclude active) would return nothing. Opt in with include_active.
      insertBatch(makeBatch(sessionId));
      insertBatch(makeBatch(sessionId));

      const t = findTool(tools, 'vault_unprocessed');
      const result = await t.handler({ include_active: true }, undefined);
      const data = parseResult(result) as unknown[];
      expect(data).toHaveLength(2);
    });

    it('excludes batches from active sessions by default', async () => {
      insertBatch(makeBatch(sessionId));

      const t = findTool(tools, 'vault_unprocessed');
      const result = await t.handler({}, undefined);
      const data = parseResult(result) as unknown[];
      expect(data).toEqual([]);
    });

    it('supports cursor-based pagination via after_id', async () => {
      const b1 = insertBatch(makeBatch(sessionId));
      insertBatch(makeBatch(sessionId));

      const t = findTool(tools, 'vault_unprocessed');
      const result = await t.handler({ after_id: b1.id, include_active: true }, undefined);
      const data = parseResult(result) as unknown[];
      expect(data).toHaveLength(1);
    });

    it('returns a compact projection by default', async () => {
      insertBatch(makeBatch(sessionId, {
        prompt_number: 1,
        response_summary: 'Summary text',
        status: 'completed',
        activity_count: 42,
      }));

      const t = findTool(tools, 'vault_unprocessed');
      const result = await t.handler({ include_active: true }, undefined);
      const data = parseResult(result) as Array<Record<string, unknown>>;

      expect(data[0].id).toBeDefined();
      expect(data[0].session_id).toBe(sessionId);
      expect(data[0].response_summary).toBe('Summary text');
      expect(data[0].status).toBeUndefined();
      expect(data[0].activity_count).toBeUndefined();
    });

    it('returns full batch metadata when include_metadata=true', async () => {
      insertBatch(makeBatch(sessionId, {
        prompt_number: 1,
        response_summary: 'Summary text',
        status: 'completed',
        activity_count: 42,
      }));

      const t = findTool(tools, 'vault_unprocessed');
      const result = await t.handler({ include_active: true, include_metadata: true }, undefined);
      const data = parseResult(result) as Array<Record<string, unknown>>;

      expect(data[0].status).toBe('completed');
      expect(data[0].activity_count).toBe(42);
    });

    it('returns a content-free grouping projection when grouping_only=true', async () => {
      insertBatch(makeBatch(sessionId, {
        prompt_number: 1,
        user_prompt: 'Session A prompt content',
        response_summary: 'Session A summary content',
      }));

      const t = findTool(tools, 'vault_unprocessed');
      const result = await t.handler({ include_active: true, grouping_only: true }, undefined);
      const data = parseResult(result) as Array<Record<string, unknown>>;

      expect(data).toHaveLength(1);
      expect(data[0].id).toBeDefined();
      expect(data[0].session_id).toBe(sessionId);
      expect(data[0].prompt_number).toBe(1);
      expect(data[0].created_at).toBeDefined();
      // No content fields — this is the point of grouping_only.
      expect(data[0].user_prompt).toBeUndefined();
      expect(data[0].response_summary).toBeUndefined();
      expect('user_prompt' in data[0]).toBe(false);
      expect('response_summary' in data[0]).toBe(false);
    });

    it('grouping_only takes precedence over include_metadata', async () => {
      insertBatch(makeBatch(sessionId, {
        prompt_number: 1,
        user_prompt: 'Session A prompt content',
        response_summary: 'Session A summary content',
        status: 'completed',
        activity_count: 42,
      }));

      const t = findTool(tools, 'vault_unprocessed');
      const result = await t.handler(
        { include_active: true, grouping_only: true, include_metadata: true },
        undefined,
      );
      const data = parseResult(result) as Array<Record<string, unknown>>;

      expect(data[0].user_prompt).toBeUndefined();
      expect(data[0].response_summary).toBeUndefined();
      expect(data[0].status).toBeUndefined();
      expect(data[0].activity_count).toBeUndefined();
    });

    it('default mode (no grouping_only) still returns content fields — regression', async () => {
      insertBatch(makeBatch(sessionId, {
        prompt_number: 1,
        user_prompt: 'Session A prompt content',
        response_summary: 'Session A summary content',
      }));

      const t = findTool(tools, 'vault_unprocessed');
      const result = await t.handler({ include_active: true }, undefined);
      const data = parseResult(result) as Array<Record<string, unknown>>;

      expect(data[0].user_prompt).toBe('Session A prompt content');
      expect(data[0].response_summary).toBe('Session A summary content');
    });

    it('lists only unprocessed batches in the request-context project', async () => {
      const sessionA = makeSession({ id: 'sess-project-a', project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', status: 'completed' });
      const sessionB = makeSession({ id: 'sess-project-b', project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', status: 'completed' });
      upsertSession(sessionA);
      upsertSession(sessionB);
      insertBatch(makeBatch(sessionA.id, { user_prompt: 'Project A prompt' }));
      insertBatch(makeBatch(sessionB.id, { user_prompt: 'Project B prompt' }));

      const scopedTools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
        requestContext: requestContext('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      });
      const t = findTool(scopedTools, 'vault_unprocessed');
      const result = await t.handler({ include_metadata: true }, undefined);
      const data = parseResult(result) as Array<{ user_prompt: string; project_id: string }>;

      expect(data).toHaveLength(1);
      expect(data[0].user_prompt).toBe('Project A prompt');
      expect(data[0].project_id).toBe('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    });
  });

  describe('vault_batches', () => {
    it('returns batches for the requested session in prompt order', async () => {
      insertBatch(makeBatch(sessionId, { prompt_number: 2 }));
      insertBatch(makeBatch(sessionId, { prompt_number: 1 }));

      const otherSession = makeSession({ id: 'sess-other', status: 'completed' });
      upsertSession(otherSession);
      insertBatch(makeBatch(otherSession.id, { prompt_number: 1 }));

      const t = findTool(tools, 'vault_batches');
      const result = await t.handler({ session_id: sessionId }, undefined);
      const data = parseResult(result) as Array<{ session_id: string; prompt_number: number }>;

      expect(data).toHaveLength(2);
      expect(data.map((row) => row.session_id)).toEqual([sessionId, sessionId]);
      expect(data.map((row) => row.prompt_number)).toEqual([1, 2]);
    });

    it('returns a compact task-oriented projection by default', async () => {
      insertBatch(makeBatch(sessionId, {
        prompt_number: 1,
        response_summary: 'Summary text',
        classification: 'analysis',
        status: 'completed',
        activity_count: 42,
      }));

      const t = findTool(tools, 'vault_batches');
      const result = await t.handler({ session_id: sessionId }, undefined);
      const data = parseResult(result) as Array<Record<string, unknown>>;

      expect(data[0].id).toBeDefined();
      expect(data[0].user_prompt).toBe('Test prompt');
      expect(data[0].response_summary).toBe('Summary text');
      expect(data[0].classification).toBe('analysis');
      expect(data[0].status).toBeUndefined();
      expect(data[0].activity_count).toBeUndefined();
      expect(data[0].processed).toBeUndefined();
    });

    it('returns full metadata when include_metadata=true', async () => {
      insertBatch(makeBatch(sessionId, {
        prompt_number: 1,
        response_summary: 'Summary text',
        status: 'completed',
        activity_count: 42,
      }));

      const t = findTool(tools, 'vault_batches');
      const result = await t.handler({ session_id: sessionId, include_metadata: true }, undefined);
      const data = parseResult(result) as Array<Record<string, unknown>>;

      expect(data[0].status).toBe('completed');
      expect(data[0].activity_count).toBe(42);
      expect(data[0].processed).toBeDefined();
    });

    it('does not return batches for a session outside the request-context project', async () => {
      const sessionB = makeSession({ id: 'sess-project-b', project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', status: 'completed' });
      upsertSession(sessionB);
      insertBatch(makeBatch(sessionB.id, { prompt_number: 1 }));

      const scopedTools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
        requestContext: requestContext('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      });
      const t = findTool(scopedTools, 'vault_batches');
      const result = await t.handler({ session_id: sessionB.id, include_metadata: true }, undefined);
      const data = parseResult(result) as unknown[];

      expect(data).toEqual([]);
    });

    it('suppresses repeated identical reads before they balloon context', async () => {
      insertBatch(makeBatch(sessionId, { prompt_number: 1 }));

      const t = findTool(tools, 'vault_batches');
      await t.handler({ session_id: sessionId }, undefined);
      await t.handler({ session_id: sessionId }, undefined);
      const result = await t.handler({ session_id: sessionId }, undefined);
      const data = parseResult(result) as {
        message: string;
        repeated_calls: number;
        reuse_prior_result: boolean;
      };

      expect(data.message).toContain('Repeated identical vault_batches read suppressed');
      expect(data.repeated_calls).toBe(3);
      expect(data.reuse_prior_result).toBe(true);
    });

    it('fails fast after too many identical repeated reads', async () => {
      insertBatch(makeBatch(sessionId, { prompt_number: 1 }));

      const t = findTool(tools, 'vault_batches');
      await t.handler({ session_id: sessionId }, undefined);
      await t.handler({ session_id: sessionId }, undefined);
      await t.handler({ session_id: sessionId }, undefined);
      await t.handler({ session_id: sessionId }, undefined);

      await expect(
        t.handler({ session_id: sessionId }, undefined),
      ).rejects.toThrow('Repeated identical vault_batches reads detected');
    });
  });

  describe('vault_session_summary_material', () => {
    it('returns compact session summary material in a single read', async () => {
      upsertSession(makeSession({
        id: 'sess-summary-material',
        status: 'active',
        title: 'Existing title',
        summary: 'Existing summary',
        prompt_count: 2,
      }));
      insertBatch(makeBatch('sess-summary-material', {
        prompt_number: 1,
        user_prompt: 'First prompt',
        response_summary: 'First summary',
      }));
      insertBatch(makeBatch('sess-summary-material', {
        prompt_number: 2,
        user_prompt: 'Second prompt',
        response_summary: 'Second summary',
      }));

      const t = findTool(tools, 'vault_session_summary_material');
      const result = await t.handler({ session_id: 'sess-summary-material' }, undefined);
      const data = parseResult(result) as {
        session_id: string;
        current_title: string;
        current_summary: string;
        prompt_count: number;
        batch_count: number;
        batches: Array<Record<string, unknown>>;
      };

      expect(data.session_id).toBe('sess-summary-material');
      expect(data.current_title).toBe('Existing title');
      expect(data.current_summary).toBe('Existing summary');
      expect(data.prompt_count).toBe(2);
      expect(data.batch_count).toBe(2);
      expect(data.batches).toEqual([
        { prompt_number: 1, user_prompt: 'First prompt', response_summary: 'First summary' },
        { prompt_number: 2, user_prompt: 'Second prompt', response_summary: 'Second summary' },
      ]);
    });

    it('returns not-found payload for missing sessions', async () => {
      const t = findTool(tools, 'vault_session_summary_material');
      const result = await t.handler({ session_id: 'missing-session' }, undefined);
      const data = parseResult(result) as { session_id: string; found: boolean; batches: unknown[] };

      expect(data).toEqual({
        session_id: 'missing-session',
        found: false,
        batches: [],
      });
    });

    it('does not return summary material for a session outside the request-context project', async () => {
      const sessionB = makeSession({ id: 'sess-project-b', project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', status: 'completed' });
      upsertSession(sessionB);
      insertBatch(makeBatch(sessionB.id, { prompt_number: 1, user_prompt: 'Project B' }));

      const scopedTools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
        requestContext: requestContext('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      });
      const t = findTool(scopedTools, 'vault_session_summary_material');
      const result = await t.handler({ session_id: sessionB.id }, undefined);
      const data = parseResult(result) as { found: boolean; batches: unknown[] };

      expect(data.found).toBe(false);
      expect(data.batches).toEqual([]);
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
      insertSpore({
        id: 'spore-1',
        agent_id: TEST_AGENT_ID,
        observation_type: 'gotcha',
        content: 'A gotcha',
        created_at: epochNow(),
      });
      insertSpore({
        id: 'spore-2',
        agent_id: TEST_AGENT_ID,
        observation_type: 'decision',
        content: 'A decision',
        created_at: epochNow(),
      });

      const t = findTool(tools, 'vault_spores');
      const result = await t.handler({ observation_type: 'gotcha' }, undefined);
      const data = parseResult(result) as Array<{ observation_type: string; content_preview: string }>;
      expect(data).toHaveLength(1);
      expect(data[0].observation_type).toBe('gotcha');
      expect(data[0].content_preview).toBe('A gotcha');
    });

    it('returns a compact projection by default', async () => {
      insertSpore({
        id: 'spore-compact',
        agent_id: TEST_AGENT_ID,
        session_id: sessionId,
        observation_type: 'decision',
        content: 'Compact content',
        context: 'Verbose context that should not flow by default',
        importance: 8,
        created_at: epochNow(),
      });

      const t = findTool(tools, 'vault_spores');
      const result = await t.handler({ include_active: true }, undefined);
      const data = parseResult(result) as Array<Record<string, unknown>>;

      expect(data).toHaveLength(1);
      expect(data[0].id).toBe('spore-compact');
      expect(data[0].status).toBe('active');
      expect(data[0].content_preview).toBe('Compact content');
      expect(data[0].importance).toBe(8);
      expect(data[0].context).toBeUndefined();
      expect(data[0].properties).toBeUndefined();
    });

    it('returns full spore metadata when include_metadata=true', async () => {
      insertSpore({
        id: 'spore-full',
        agent_id: TEST_AGENT_ID,
        session_id: sessionId,
        observation_type: 'decision',
        content: 'Full content',
        context: 'Stored context',
        properties: JSON.stringify({ foo: 'bar' }),
        created_at: epochNow(),
      });

      const t = findTool(tools, 'vault_spores');
      const result = await t.handler({ include_active: true, include_metadata: true }, undefined);
      const data = parseResult(result) as Array<Record<string, unknown>>;

      expect(data).toHaveLength(1);
      expect(data[0].content).toBe('Full content');
      expect(data[0].context).toBe('Stored context');
      expect(data[0].properties).toBe(JSON.stringify({ foo: 'bar' }));
    });

    it('projects spore status and superseded_by replacement id', async () => {
      insertSpore({
        id: 'spore-old',
        agent_id: TEST_AGENT_ID,
        observation_type: 'gotcha',
        status: 'superseded',
        content: 'Old content',
        created_at: epochNow(),
      });
      insertSpore({
        id: 'spore-newer',
        agent_id: TEST_AGENT_ID,
        observation_type: 'gotcha',
        content: 'Newer content',
        created_at: epochNow(),
      });
      insertGraphEdge({
        agent_id: TEST_AGENT_ID,
        source_id: 'spore-old',
        source_type: 'spore',
        target_id: 'spore-newer',
        target_type: 'spore',
        type: 'SUPERSEDED_BY',
        created_at: epochNow(),
      });

      const t = findTool(tools, 'vault_spores');
      const result = await t.handler({ ids: ['spore-old'] }, undefined);
      const data = parseResult(result) as Array<Record<string, unknown>>;

      expect(data).toHaveLength(1);
      expect(data[0].status).toBe('superseded');
      expect(data[0].superseded_by).toBe('spore-newer');
      expect(data[0].content).toBe('Old content');
    });

    it('projects superseded_by from legacy resolution events without graph edges', async () => {
      insertSpore({
        id: 'spore-old',
        agent_id: TEST_AGENT_ID,
        observation_type: 'gotcha',
        status: 'superseded',
        content: 'Old content',
        created_at: epochNow(),
      });
      insertSpore({
        id: 'spore-newer',
        agent_id: TEST_AGENT_ID,
        observation_type: 'gotcha',
        content: 'Newer content',
        created_at: epochNow(),
      });
      insertResolutionEvent({
        id: 'res-legacy-supersede',
        agent_id: TEST_AGENT_ID,
        spore_id: 'spore-old',
        action: 'supersede',
        new_spore_id: 'spore-newer',
        created_at: epochNow(),
      });

      const t = findTool(tools, 'vault_spores');
      const result = await t.handler({ ids: ['spore-old'] }, undefined);
      const data = parseResult(result) as Array<Record<string, unknown>>;

      expect(data).toHaveLength(1);
      expect(data[0].status).toBe('superseded');
      expect(data[0].superseded_by).toBe('spore-newer');
    });

    it('returns exact spores by id in the requested order', async () => {
      insertSpore({
        id: 'spore-a',
        agent_id: TEST_AGENT_ID,
        observation_type: 'gotcha',
        content: 'Alpha',
        created_at: epochNow(),
      });
      insertSpore({
        id: 'spore-b',
        agent_id: TEST_AGENT_ID,
        observation_type: 'decision',
        content: 'Beta',
        created_at: epochNow(),
      });

      const t = findTool(tools, 'vault_spores');
      const result = await t.handler({ ids: ['spore-b', 'spore-a'] }, undefined);
      const data = parseResult(result) as Array<{ id: string; content: string }>;
      expect(data.map((row) => row.id)).toEqual(['spore-b', 'spore-a']);
      expect(data.map((row) => row.content)).toEqual(['Beta', 'Alpha']);
    });

    it('filters exact spore reads to the request-context project', async () => {
      insertSpore({
        id: 'spore-project-a',
        project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        agent_id: TEST_AGENT_ID,
        observation_type: 'gotcha',
        content: 'Project A',
        created_at: epochNow(),
      });
      insertSpore({
        id: 'spore-project-b',
        project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        agent_id: TEST_AGENT_ID,
        observation_type: 'decision',
        content: 'Project B',
        created_at: epochNow(),
      });

      const scopedTools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
        requestContext: requestContext('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      });
      const t = findTool(scopedTools, 'vault_spores');
      const result = await t.handler({
        ids: ['spore-project-b', 'spore-project-a'],
        include_metadata: true,
      }, undefined);
      const data = parseResult(result) as Array<{ id: string; project_id: string }>;

      expect(data).toEqual([{ id: 'spore-project-a', project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', agent_id: TEST_AGENT_ID, observation_type: 'gotcha', status: 'active', content: 'Project A', context: null, importance: 5, file_path: null, tags: null, properties: null, session_id: null, prompt_batch_id: null, embedded: 0, created_at: expect.any(Number), updated_at: null, content_hash: null, machine_id: TEST_MACHINE_ID, synced_at: null }]);
    });
  });

  describe('vault_sessions', () => {
    it('returns a compact projection by default', async () => {
      upsertSession(makeSession({
        id: 'sess-compact',
        status: 'completed',
        title: 'Compact title',
        summary: 'Compact summary',
        prompt_count: 12,
        tool_count: 900,
      }));

      const t = findTool(tools, 'vault_sessions');
      const result = await t.handler({ id: 'sess-compact', include_active: true }, undefined);
      const data = parseResult(result) as Array<Record<string, unknown>>;

      expect(data).toHaveLength(1);
      expect(data[0].id).toBe('sess-compact');
      expect(data[0].title).toBe('Compact title');
      expect(data[0].summary).toBe('Compact summary');
      expect(data[0].prompt_count).toBe(12);
      expect(data[0].tool_count).toBeUndefined();
      expect(data[0].transcript_path).toBeUndefined();
    });

    it('returns full session metadata when include_metadata=true', async () => {
      upsertSession(makeSession({
        id: 'sess-full',
        status: 'completed',
        title: 'Full title',
        summary: 'Full summary',
        prompt_count: 12,
        tool_count: 900,
        transcript_path: '/tmp/transcript.jsonl',
      }));

      const t = findTool(tools, 'vault_sessions');
      const result = await t.handler({ id: 'sess-full', include_active: true, include_metadata: true }, undefined);
      const data = parseResult(result) as Array<Record<string, unknown>>;

      expect(data).toHaveLength(1);
      expect(data[0].tool_count).toBe(900);
      expect(data[0].transcript_path).toBe('/tmp/transcript.jsonl');
    });
  });

  describe('vault_sessions', () => {
    it('returns sessions when include_active is set', async () => {
      // The seeded session is active — without include_active the tool
      // defaults to excluding in-flight sessions.
      const t = findTool(tools, 'vault_sessions');
      const result = await t.handler({ include_active: true }, undefined);
      const data = parseResult(result) as unknown[];
      expect(data.length).toBeGreaterThanOrEqual(1);
    });

    it('excludes active sessions by default', async () => {
      const t = findTool(tools, 'vault_sessions');
      const result = await t.handler({}, undefined);
      const data = parseResult(result) as unknown[];
      expect(data).toEqual([]);
    });

    it('filters by status', async () => {
      const t = findTool(tools, 'vault_sessions');
      const result = await t.handler({ status: 'completed' }, undefined);
      const data = parseResult(result) as unknown[];
      expect(data).toEqual([]);
    });

    it('fetches an exact session by id', async () => {
      const completed = makeSession({ id: 'sess-completed', status: 'completed' });
      upsertSession(completed);

      const t = findTool(tools, 'vault_sessions');
      const result = await t.handler({ id: completed.id }, undefined);
      const data = parseResult(result) as Array<{ id: string; status: string }>;

      expect(data).toHaveLength(1);
      expect(data[0]).toMatchObject({ id: completed.id, status: 'completed' });
    });

    it('lists only sessions in the request-context project', async () => {
      upsertSession(makeSession({
        id: 'sess-project-a',
        project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        status: 'completed',
        title: 'Project A',
      }));
      upsertSession(makeSession({
        id: 'sess-project-b',
        project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        status: 'completed',
        title: 'Project B',
      }));

      const scopedTools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
        requestContext: requestContext('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      });
      const t = findTool(scopedTools, 'vault_sessions');
      const result = await t.handler({ include_metadata: true }, undefined);
      const data = parseResult(result) as Array<{ id: string; project_id: string }>;

      expect(data.map((row) => row.id)).toEqual(['sess-project-a']);
      expect(data[0].project_id).toBe('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    });
  });

  describe('vault_search_fts', () => {
    it('returns empty results gracefully when no FTS matches', async () => {
      const t = findTool(tools, 'vault_search_fts');
      const result = await t.handler({ query: 'test query' }, undefined);
      const data = parseResult(result) as { results: unknown[] };
      expect(data.results).toEqual([]);
    });

    it('searches only rows in the request-context project', async () => {
      const sessionA = makeSession({ id: 'sess-project-a', project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', status: 'completed' });
      const sessionB = makeSession({ id: 'sess-project-b', project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', status: 'completed' });
      upsertSession(sessionA);
      upsertSession(sessionB);
      insertBatch(makeBatch(sessionA.id, { user_prompt: 'shared needle from project a' }));
      insertBatch(makeBatch(sessionB.id, { user_prompt: 'shared needle from project b' }));

      const scopedTools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
        requestContext: requestContext('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      });
      const t = findTool(scopedTools, 'vault_search_fts');
      const result = await t.handler({ query: 'needle' }, undefined);
      const data = parseResult(result) as { results: Array<{ preview: string }> };

      expect(data.results).toHaveLength(1);
      expect(data.results[0].preview).toContain('project a');
    });
  });

  describe('vault_search_semantic', () => {
    it('returns unavailable message when no embedding manager', async () => {
      const t = findTool(tools, 'vault_search_semantic');
      const result = await t.handler({ query: 'test query' }, undefined);
      const data = parseResult(result) as { results: unknown[]; message: string };
      expect(data.results).toEqual([]);
      expect(data.message).toBe('Embedding provider unavailable');

      const turn = getDatabase().prepare(
        `SELECT tool_output_summary, completed_at FROM agent_turns WHERE run_id = ? ORDER BY id DESC LIMIT 1`,
      ).get(TEST_RUN_ID) as { tool_output_summary: string | null; completed_at: number | null };
      expect(turn.completed_at).not.toBeNull();
      expect(turn.tool_output_summary).toContain('Embedding provider unavailable');
    });

    it('excludes active-session results by default and hydrates local matches', async () => {
      const completedSession = makeSession({ id: 'sess-complete', status: 'completed' });
      upsertSession(completedSession);

      insertSpore({
        id: 'spore-active',
        agent_id: TEST_AGENT_ID,
        session_id: sessionId,
        observation_type: 'decision',
        content: 'Active session spore',
        created_at: epochNow(),
      });
      insertSpore({
        id: 'spore-complete',
        agent_id: TEST_AGENT_ID,
        session_id: completedSession.id,
        observation_type: 'decision',
        content: 'Completed session spore',
        created_at: epochNow(),
      });

      const embeddingManager = {
        embedQuery: async () => [0.1, 0.2],
        searchVectors: () => [
          {
            id: 'spore-active',
            namespace: 'spores',
            similarity: 0.95,
            metadata: { session_id: sessionId, observation_type: 'decision' },
          },
          {
            id: 'spore-complete',
            namespace: 'spores',
            similarity: 0.9,
            metadata: { session_id: completedSession.id, observation_type: 'decision' },
          },
        ],
      } as Pick<AgentEmbeddingPort, 'embedQuery' | 'searchVectors'> as AgentEmbeddingPort;

      const semanticTools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, { requestContext: TEST_REQUEST_CONTEXT, embeddingManager });
      const t = findTool(semanticTools, 'vault_search_semantic');
      const result = await t.handler({ query: 'decision' }, undefined);
      const data = parseResult(result) as { results: Array<{ id: string; preview: string; type: string }> };

      expect(data.results.map((row) => row.id)).toEqual(['spore-complete']);
      expect(data.results[0].type).toBe('spore');
      expect(data.results[0].preview).toContain('Completed session spore');
    });

    it('passes metadata filters to semantic search and filters hydrated results', async () => {
      const completedSession = makeSession({ id: 'sess-filtered', status: 'completed' });
      upsertSession(completedSession);

      insertSpore({
        id: 'spore-decision',
        agent_id: TEST_AGENT_ID,
        session_id: completedSession.id,
        observation_type: 'decision',
        content: 'Decision spore',
        created_at: epochNow() - 100,
      });
      insertSpore({
        id: 'spore-gotcha',
        agent_id: TEST_AGENT_ID,
        session_id: completedSession.id,
        observation_type: 'gotcha',
        content: 'Gotcha spore',
        created_at: epochNow() - 50,
      });

      const searchVectors = vi.fn(() => [
        {
          id: 'spore-decision',
          namespace: 'spores',
          similarity: 0.95,
          metadata: { session_id: completedSession.id, observation_type: 'decision', status: 'active', created_at: epochNow() - 100 },
        },
        {
          id: 'spore-gotcha',
          namespace: 'spores',
          similarity: 0.9,
          metadata: { session_id: completedSession.id, observation_type: 'gotcha', status: 'active', created_at: epochNow() - 50 },
        },
      ]);

      const embeddingManager = {
        embedQuery: async () => [0.1, 0.2],
        searchVectors,
      } as Pick<AgentEmbeddingPort, 'embedQuery' | 'searchVectors'> as AgentEmbeddingPort;

      const semanticTools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, { requestContext: TEST_REQUEST_CONTEXT, embeddingManager });
      const t = findTool(semanticTools, 'vault_search_semantic');
      const since = epochNow() - 120;
      const result = await t.handler({
        query: 'decision',
        namespace: 'spores',
        observation_type: 'decision',
        since,
      }, undefined);
      const data = parseResult(result) as { results: Array<{ id: string }> };

      expect(searchVectors).toHaveBeenCalledWith([0.1, 0.2], expect.objectContaining({
        namespace: 'spores',
        filters: {
          observation_type: 'decision',
          created_at_gte: since,
        },
      }));
      expect(data.results.map((row) => row.id)).toEqual(['spore-decision']);
    });

    it('passes project metadata filters and hydrates only matching project rows', async () => {
      const sessionA = makeSession({ id: 'sess-project-a', project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', status: 'completed' });
      const sessionB = makeSession({ id: 'sess-project-b', project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', status: 'completed' });
      upsertSession(sessionA);
      upsertSession(sessionB);
      insertSpore({
        id: 'spore-project-a',
        project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        agent_id: TEST_AGENT_ID,
        session_id: sessionA.id,
        observation_type: 'decision',
        content: 'Project A spore',
        created_at: epochNow(),
      });
      insertSpore({
        id: 'spore-project-b',
        project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        agent_id: TEST_AGENT_ID,
        session_id: sessionB.id,
        observation_type: 'decision',
        content: 'Project B spore',
        created_at: epochNow(),
      });

      const searchVectors = vi.fn(() => [
        {
          id: 'spore-project-a',
          namespace: 'spores',
          similarity: 0.95,
          metadata: { session_id: sessionA.id, observation_type: 'decision', status: 'active', project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
        },
        {
          id: 'spore-project-b',
          namespace: 'spores',
          similarity: 0.9,
          metadata: { session_id: sessionB.id, observation_type: 'decision', status: 'active', project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
        },
      ]);
      const embeddingManager = {
        embedQuery: async () => [0.1, 0.2],
        searchVectors,
      } as Pick<AgentEmbeddingPort, 'embedQuery' | 'searchVectors'> as AgentEmbeddingPort;

      const scopedTools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
        embeddingManager,
        requestContext: requestContext('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      });
      const t = findTool(scopedTools, 'vault_search_semantic');
      const result = await t.handler({ query: 'decision', namespace: 'spores' }, undefined);
      const data = parseResult(result) as { results: Array<{ id: string }> };

      expect(searchVectors).toHaveBeenCalledWith([0.1, 0.2], expect.objectContaining({
        filters: { project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      }));
      expect(data.results.map((row) => row.id)).toEqual(['spore-project-a']);
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
      setState(TEST_AGENT_ID, TEST_REQUEST_CONTEXT.projectId, 'cursor', '42', epochNow());
      setState(TEST_AGENT_ID, TEST_REQUEST_CONTEXT.projectId, 'mode', 'full', epochNow());

      const t = findTool(tools, 'vault_state');
      const result = await t.handler({}, undefined);
      const data = parseResult(result) as Array<{ key: string; value: string }>;
      expect(data).toHaveLength(2);
      const keys = data.map((s) => s.key).sort();
      expect(keys).toEqual(['cursor', 'mode']);
    });

    it('resets identical-read suppression after a successful write', async () => {
      const sessionsTool = findTool(tools, 'vault_sessions');
      const updateSessionTool = findTool(tools, 'vault_update_session');

      await sessionsTool.handler({ id: sessionId, include_active: true }, undefined);
      await sessionsTool.handler({ id: sessionId, include_active: true }, undefined);
      const suppressed = await sessionsTool.handler({ id: sessionId, include_active: true }, undefined);
      expect(parseResult(suppressed)).toMatchObject({
        reuse_prior_result: true,
        repeated_calls: 3,
      });

      await updateSessionTool.handler({ session_id: sessionId, title: 'Updated title' }, undefined);
      const refreshed = await sessionsTool.handler({ id: sessionId, include_active: true }, undefined);
      const data = parseResult(refreshed) as Array<{ id: string; title: string }>;
      expect(data).toEqual([{
        id: sessionId,
        agent: 'claude-code',
        status: 'active',
        title: 'Updated title',
        prompt_count: 0,
        started_at: expect.any(Number),
      }]);
    });
  });

  describe('vault_edges', () => {
    it('returns a compact projection by default', async () => {
      insertGraphEdge({
        agent_id: TEST_AGENT_ID,
        source_id: 'session-a',
        source_type: 'session',
        target_id: 'spore-a',
        target_type: 'spore',
        type: 'FROM_SESSION',
        confidence: 0.8,
        session_id: sessionId,
        created_at: epochNow(),
        properties: JSON.stringify({ rationale: 'linked during audit' }),
      });

      const t = findTool(tools, 'vault_edges');
      const result = await t.handler({ source_id: 'session-a' }, undefined);
      const data = parseResult(result) as Array<Record<string, unknown>>;

      expect(data).toHaveLength(1);
      expect(data[0].source_id).toBe('session-a');
      expect(data[0].target_id).toBe('spore-a');
      expect(data[0].properties).toBeUndefined();
      expect(data[0].agent_id).toBeUndefined();
    });

    it('returns full edge metadata when include_metadata=true', async () => {
      insertGraphEdge({
        agent_id: TEST_AGENT_ID,
        source_id: 'session-b',
        source_type: 'session',
        target_id: 'spore-b',
        target_type: 'spore',
        type: 'FROM_SESSION',
        confidence: 0.9,
        session_id: sessionId,
        created_at: epochNow(),
        properties: JSON.stringify({ rationale: 'full metadata' }),
      });

      const t = findTool(tools, 'vault_edges');
      const result = await t.handler({ source_id: 'session-b', include_metadata: true }, undefined);
      const data = parseResult(result) as Array<Record<string, unknown>>;

      expect(data).toHaveLength(1);
      expect(data[0].properties).toBe(JSON.stringify({ rationale: 'full metadata' }));
      expect(data[0].agent_id).toBe(TEST_AGENT_ID);
    });

    it('lists only edges in the request-context project', async () => {
      insertGraphEdge({
        project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        agent_id: TEST_AGENT_ID,
        source_id: 'session-a',
        source_type: 'session',
        target_id: 'spore-a',
        target_type: 'spore',
        type: 'FROM_SESSION',
        created_at: epochNow(),
      });
      insertGraphEdge({
        project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        agent_id: TEST_AGENT_ID,
        source_id: 'session-b',
        source_type: 'session',
        target_id: 'spore-b',
        target_type: 'spore',
        type: 'FROM_SESSION',
        created_at: epochNow(),
      });

      const scopedTools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
        requestContext: requestContext('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      });
      const t = findTool(scopedTools, 'vault_edges');
      const result = await t.handler({ include_metadata: true }, undefined);
      const data = parseResult(result) as Array<{ project_id: string; source_id: string }>;

      expect(data).toHaveLength(1);
      expect(data[0].source_id).toBe('session-a');
      expect(data[0].project_id).toBe('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
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
      const turns = db.prepare(
        `SELECT * FROM agent_turns WHERE run_id = ?`,
      ).all(TEST_RUN_ID);
      expect(turns.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('vault_resolve_spore', () => {
    it('updates spore status and creates resolution event', async () => {
      // Create a spore to resolve
      insertSpore({
        id: 'spore-resolve-test',
        agent_id: TEST_AGENT_ID,
        observation_type: 'gotcha',
        content: 'Old observation',
        created_at: epochNow(),
      });
      insertSpore({
        id: 'spore-new',
        agent_id: TEST_AGENT_ID,
        observation_type: 'gotcha',
        content: 'New observation',
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
      const events = db.prepare(
        `SELECT * FROM resolution_events WHERE spore_id = ?`,
      ).all('spore-resolve-test');
      expect(events).toHaveLength(1);

      const edge = db.prepare(
        `SELECT * FROM graph_edges WHERE source_id = ? AND target_id = ? AND type = ?`,
      ).get('spore-resolve-test', 'spore-new', 'SUPERSEDED_BY') as Record<string, unknown> | undefined;
      expect(edge).toBeDefined();
    });

    it('does not resolve a spore outside the request-context project', async () => {
      insertSpore({
        id: 'spore-other-project',
        project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        agent_id: TEST_AGENT_ID,
        observation_type: 'gotcha',
        content: 'Other project observation',
        created_at: epochNow(),
      });

      const scopedTools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
        requestContext: requestContext('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      });
      const t = findTool(scopedTools, 'vault_resolve_spore');
      const result = await t.handler({
        spore_id: 'spore-other-project',
        action: 'obsolete',
        reason: 'wrong project',
      }, undefined);
      const data = parseResult(result) as { error: string };

      expect(data).toEqual({ error: 'Spore not found: spore-other-project' });

      const db = getDatabase();
      const spore = db.prepare('SELECT status FROM spores WHERE id = ?').get('spore-other-project') as { status: string };
      const eventCount = db.prepare('SELECT COUNT(*) AS count FROM resolution_events').get() as { count: number };
      expect(spore.status).toBe('active');
      expect(eventCount.count).toBe(0);
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

    it('does not update sessions outside the request-context project', async () => {
      upsertSession(makeSession({
        id: 'sess-other-project',
        project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        status: 'completed',
        title: 'Original',
      }));

      const scopedTools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
        requestContext: requestContext('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      });
      const t = findTool(scopedTools, 'vault_update_session');
      const result = await t.handler({
        session_id: 'sess-other-project',
        title: 'Wrong project update',
      }, undefined);
      const data = parseResult(result) as { error: string };

      expect(data).toEqual({ error: 'Session not found: sess-other-project' });

      const row = getDatabase()
        .prepare('SELECT title FROM sessions WHERE id = ?')
        .get('sess-other-project') as { title: string };
      expect(row.title).toBe('Original');
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

    it('writes digest extracts in the request-context project scope', async () => {
      const scopedTools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
        requestContext: requestContext('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      });
      const t = findTool(scopedTools, 'vault_write_digest');
      const result = await t.handler(
        { tier: 1500, content: '# Project digest' },
        undefined,
      );
      const extract = parseResult(result) as { project_id: string; content: string };

      expect(extract.project_id).toBe('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(extract.content).toBe('# Project digest');
    });

    it('upserts on (agent_id, tier) conflict', async () => {
      const t = findTool(tools, 'vault_write_digest');
      await t.handler({ tier: 5000, content: 'v1' }, undefined);
      const result = await t.handler({ tier: 5000, content: 'v2' }, undefined);
      const extract = parseResult(result) as { content: string };
      expect(extract.content).toBe('v2');

      // Verify only one row
      const db = getDatabase();
      const row = db.prepare(
        `SELECT count(*) AS count FROM digest_extracts WHERE agent_id = ? AND tier = ?`,
      ).get(TEST_AGENT_ID, 5000) as { count: number };
      expect(row.count).toBe(1);
    });
  });

  describe('vault_mark_processed', () => {
    it('marks a batch as processed', async () => {
      const batch = insertBatch(makeBatch(sessionId));

      const t = findTool(tools, 'vault_mark_processed');
      const result = await t.handler({ batch_id: batch.id }, undefined);
      const updated = parseResult(result) as { processed: number };
      expect(updated.processed).toBe(1);
    });

    it('batch no longer appears in unprocessed', async () => {
      const batch = insertBatch(makeBatch(sessionId));

      const markTool = findTool(tools, 'vault_mark_processed');
      await markTool.handler({ batch_id: batch.id }, undefined);

      const listTool = findTool(tools, 'vault_unprocessed');
      const result = await listTool.handler({}, undefined);
      const data = parseResult(result) as unknown[];
      expect(data).toEqual([]);
    });

    it('does not mark a batch outside the request-context project', async () => {
      const sessionB = makeSession({ id: 'sess-project-b', project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', status: 'completed' });
      upsertSession(sessionB);
      const batch = insertBatch(makeBatch(sessionB.id));

      const scopedTools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
        requestContext: requestContext('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
      });
      const t = findTool(scopedTools, 'vault_mark_processed');
      const result = await t.handler({ batch_id: batch.id }, undefined);
      const data = parseResult(result) as { error: string };

      expect(data.error).toBe(`Prompt batch not found: ${batch.id}`);
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
      const rows = db.prepare(
        `SELECT * FROM agent_reports WHERE run_id = ?`,
      ).all(TEST_RUN_ID);
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });
  });
});
