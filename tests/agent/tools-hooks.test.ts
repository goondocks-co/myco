/**
 * Tests that createVaultTools emits preToolUse/postToolUse hook events
 * around every tool call, for both success and error outcomes, when
 * hooks + hookContext are supplied via VaultToolOptions.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';

mock.module('@myco/intelligence/embed-query.js', () => ({ tryEmbed: async () => null }));

import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { getDatabase } from '@myco/db/client.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { createVaultTools } from '@myco/agent/tools.js';
import type { PreToolUseEvent, PostToolUseEvent } from '@myco/agent/harness/hooks.js';
import { TEST_REQUEST_CONTEXT } from '../helpers/request-context';

const TEST_AGENT_ID = 'test-agent-hooks';
const TEST_RUN_ID = 'run-hooks-001';
const epochNow = () => Math.floor(Date.now() / 1000);

function createAgent(id: string): void {
  const db = getDatabase();
  db.prepare(`INSERT INTO agents (id, name, created_at) VALUES (?, ?, ?)`).run(id, `agent-${id}`, epochNow());
}

function findTool(tools: ReturnType<typeof createVaultTools>, name: string) {
  const t = tools.find((tool) => tool.name === name);
  if (!t) throw new Error(`Tool not found: ${name}`);
  return t;
}

describe('createVaultTools hook emission', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    createAgent(TEST_AGENT_ID);
    insertRun({ id: TEST_RUN_ID, agent_id: TEST_AGENT_ID, status: 'running', started_at: epochNow() });
  });

  it('emits preToolUse then postToolUse (success) around a read tool call', async () => {
    const preEvents: PreToolUseEvent[] = [];
    const postEvents: PostToolUseEvent[] = [];

    const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
      requestContext: TEST_REQUEST_CONTEXT,
      hooks: {
        preToolUse: (e) => { preEvents.push(e); },
        postToolUse: (e) => { postEvents.push(e); },
      },
      hookContext: { runId: TEST_RUN_ID, agentId: TEST_AGENT_ID, harnessId: 'claude-sdk', phaseName: 'gather' },
    } as any);

    const tool = findTool(tools, 'vault_spores');
    await (tool as any).handler({ limit: 5 }, {});

    expect(preEvents).toHaveLength(1);
    expect(preEvents[0].toolName).toBe('vault_spores');
    expect(preEvents[0].phaseName).toBe('gather');
    expect(postEvents).toHaveLength(1);
    expect(postEvents[0].toolName).toBe('vault_spores');
    expect(postEvents[0].outcome).toBe('success');
    expect(postEvents[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('emits postToolUse with outcome "error" when the handler throws', async () => {
    const postEvents: PostToolUseEvent[] = [];

    const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
      requestContext: TEST_REQUEST_CONTEXT,
      hooks: { postToolUse: (e) => { postEvents.push(e); } },
      hookContext: { runId: TEST_RUN_ID, agentId: TEST_AGENT_ID, harnessId: 'claude-sdk' },
    } as any);

    // vault_resolve_spore with a spore_id that doesn't exist errors inside
    // the handler in a way that surfaces as a normal error result, not a
    // thrown exception in most tool handlers — use the unknown-arg-key
    // rejection path instead, which is guaranteed to throw a caught error
    // inside wrapToolWithAudit's try/catch via a genuine exception path.
    // Simplest reliable throw: call a tool with a required arg omitted so
    // the underlying handler throws.
    const tool = findTool(tools, 'vault_create_spore');
    await expect((tool as any).handler({}, {})).rejects.toBeDefined();

    expect(postEvents.length).toBeGreaterThanOrEqual(1);
    expect(postEvents[0].outcome).toBe('error');
    expect(postEvents[0].errorMessage).toBeDefined();
  });

  it('does not throw or emit hooks when hooks/hookContext are both absent (backward compat)', async () => {
    const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, { requestContext: TEST_REQUEST_CONTEXT });
    const tool = findTool(tools, 'vault_spores');
    const result = await (tool as any).handler({ limit: 5 }, {});
    expect(result).toBeDefined();
  });

  it('awaits preToolUse and postToolUse in order around the handler (blocking, not fire-and-forget)', async () => {
    const order: string[] = [];
    const db = getDatabase();
    const projectId = TEST_REQUEST_CONTEXT.projectId;
    const stateKey = 'hook-order-probe';
    const rowExists = () => db.prepare(
      `SELECT 1 FROM agent_state WHERE agent_id = ? AND project_id = ? AND key = ?`,
    ).get(TEST_AGENT_ID, projectId, stateKey) != null;

    const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
      requestContext: TEST_REQUEST_CONTEXT,
      hooks: {
        preToolUse: async () => {
          await new Promise((r) => setTimeout(r, 20));
          // The write hasn't happened yet: preToolUse must complete
          // strictly BEFORE the handler runs.
          expect(rowExists()).toBe(false);
          order.push('pre');
        },
        postToolUse: async () => {
          await new Promise((r) => setTimeout(r, 20));
          // By the time postToolUse fires, the handler's write is
          // already committed — proving the handler ran strictly
          // between preToolUse and postToolUse.
          expect(rowExists()).toBe(true);
          order.push('post');
        },
      },
      hookContext: { runId: TEST_RUN_ID, agentId: TEST_AGENT_ID, harnessId: 'claude-sdk' },
    } as any);

    // vault_set_state's handler performs a synchronous DB write with no
    // delay of its own, so any row-existence check made from inside a
    // hook callback pins that hook's timing relative to the real handler
    // execution — no mocking of internals required.
    const tool = findTool(tools, 'vault_set_state');
    const startedAt = Date.now();
    await (tool as any).handler({ key: stateKey, value: 'x' }, {});
    const elapsedMs = Date.now() - startedAt;

    expect(order).toEqual(['pre', 'post']);
    expect(rowExists()).toBe(true);
    // Both hook delays (20ms each) must have been awaited serially around
    // the handler — if hooks were fire-and-forget, this call would return
    // in a few ms instead of at least ~40ms.
    expect(elapsedMs).toBeGreaterThanOrEqual(35);
  });

  it('isolates emission-site failures: sync throw and rejected-promise hooks never fail the tool call, and the audit path still runs', async () => {
    const db = getDatabase();

    // Variant A: hooks throw synchronously.
    const toolsSyncThrow = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
      requestContext: TEST_REQUEST_CONTEXT,
      hooks: {
        preToolUse: () => { throw new Error('pre boom (sync)'); },
        postToolUse: () => { throw new Error('post boom (sync)'); },
      },
      hookContext: { runId: TEST_RUN_ID, agentId: TEST_AGENT_ID, harnessId: 'claude-sdk' },
    } as any);

    const toolSyncThrow = findTool(toolsSyncThrow, 'vault_spores');
    const resultSyncThrow = await (toolSyncThrow as any).handler({ limit: 5 }, {});
    expect(resultSyncThrow).toBeDefined();

    // Variant B: hooks return rejected promises.
    const toolsRejected = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
      requestContext: TEST_REQUEST_CONTEXT,
      hooks: {
        preToolUse: () => Promise.reject(new Error('pre boom (rejected)')),
        postToolUse: () => Promise.reject(new Error('post boom (rejected)')),
      },
      hookContext: { runId: TEST_RUN_ID, agentId: TEST_AGENT_ID, harnessId: 'claude-sdk' },
    } as any);

    const toolRejected = findTool(toolsRejected, 'vault_spores');
    const resultRejected = await (toolRejected as any).handler({ limit: 5 }, {});
    expect(resultRejected).toBeDefined();

    // Audit path (agent_turns) still ran for both calls despite hook failures.
    const turns = db.prepare(
      `SELECT tool_output_summary, completed_at FROM agent_turns WHERE run_id = ? ORDER BY id ASC`,
    ).all(TEST_RUN_ID) as Array<{ tool_output_summary: string | null; completed_at: number | null }>;

    expect(turns.length).toBeGreaterThanOrEqual(2);
    for (const turn of turns) {
      expect(turn.completed_at).not.toBeNull();
      expect(turn.tool_output_summary).not.toBeNull();
    }
  });
});
