/**
 * Regression guard for the deferred-loading wiring inside `createVaultTools()`.
 *
 * `tests/agent/tools/deferred-tools.test.ts` covers the pure helpers
 * (`applyDeferredStubs`, `buildSearchToolsTool`) in isolation. This file
 * proves `createVaultTools()` itself calls them correctly — including that
 * the synthesized `vault_search_tools` meta-tool is wrapped with
 * `wrapToolWithAudit` (so it writes an `agent_turns` row like every other
 * tool call) rather than appended raw.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';

// Mock tryEmbed to return null immediately — no real embedding provider in tests
mock.module('@myco/intelligence/embed-query.js', () => ({
  tryEmbed: async () => null,
}));

import { getDatabase } from '@myco/db/client.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { insertRun } from '@myco/db/queries/runs.js';
import { TEST_REQUEST_CONTEXT } from '../../helpers/request-context';
import { createVaultTools } from '@myco/agent/tools.js';
import { DEFERRED_STUB_DESCRIPTION } from '@myco/agent/tools/deferred-tools.js';

const TEST_AGENT_ID = 'test-agent-deferred';
const TEST_RUN_ID = 'run-test-deferred-001';

const epochNow = () => Math.floor(Date.now() / 1000);

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

describe('createVaultTools deferred-loading wiring', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('never adds vault_search_tools while no shipped tool is deferrable', () => {
    const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, { requestContext: TEST_REQUEST_CONTEXT });
    expect(tools.find((t) => t.name === 'vault_search_tools')).toBeUndefined();
  });

  it('every returned tool has a defined name and either a real or stub description', () => {
    const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, { requestContext: TEST_REQUEST_CONTEXT });
    for (const t of tools) {
      expect(typeof t.name).toBe('string');
      if (t.deferrable === true) {
        expect(t.description).toBe(DEFERRED_STUB_DESCRIPTION);
      } else {
        expect(t.description).not.toBe(DEFERRED_STUB_DESCRIPTION);
      }
    }
  });

  it('calling vault_search_tools writes an agent_turns audit row', async () => {
    createAgent(TEST_AGENT_ID);
    createRun(TEST_RUN_ID, TEST_AGENT_ID);

    // No shipped tool is deferrable yet (Task 4 adds the real `deferredNames`
    // opt-in to createVaultTools). To exercise the ACTUAL wiring inside
    // createVaultTools — not just the Task-2 helpers in isolation — this
    // test marks vault_state deferrable at the read-tools factory boundary
    // via mock.module, the same seam Task 4 will later drive through a
    // first-class `deferredNames` option. That keeps vault_search_tools's
    // construction routed through createVaultTools's real internal
    // wrapToolWithAudit closure (private, unexported — the only way to
    // reach it is via createVaultTools itself), so this test fails if the
    // meta-tool is ever appended unwrapped.
    const readTools = await import('@myco/agent/tools/read-tools.js');
    const originalCreateReadTools = readTools.createReadTools;
    const spy = vi.spyOn(readTools, 'createReadTools').mockImplementation((deps) => {
      const built = originalCreateReadTools(deps);
      return built.map((t) => (t.name === 'vault_state' ? { ...t, deferrable: true, searchSummary: 'state' } : t));
    });

    try {
      const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, { requestContext: TEST_REQUEST_CONTEXT });
      const searchTool = tools.find((t) => t.name === 'vault_search_tools')!;
      expect(searchTool).toBeDefined();

      await searchTool.handler({ query: 'state' }, undefined);
    } finally {
      spy.mockRestore();
    }

    // Wait a tick for fire-and-forget turn insertion (same as the
    // existing 'records an audit turn' test).
    await new Promise((resolve) => setTimeout(resolve, 50));

    const db = getDatabase();
    const turns = db.prepare(
      `SELECT * FROM agent_turns WHERE run_id = ? AND tool_name = ?`,
    ).all(TEST_RUN_ID, 'vault_search_tools');
    expect(turns.length).toBeGreaterThanOrEqual(1);
  });

  it('stubbed deferrable tool executes real handler through full wrap chain', async () => {
    createAgent(TEST_AGENT_ID);
    createRun(TEST_RUN_ID, TEST_AGENT_ID);

    // Mark vault_state deferrable with a searchSummary, then invoke it
    // directly (bypassing vault_search_tools) to prove:
    // 1. The stub description matches DEFERRED_STUB_DESCRIPTION
    // 2. The real handler executes (not blocked by deferred stub)
    // 3. An audit row is recorded (full wrap chain executed)
    const readTools = await import('@myco/agent/tools/read-tools.js');
    const originalCreateReadTools = readTools.createReadTools;
    let realHandlerCalled = false;
    const spy = vi.spyOn(readTools, 'createReadTools').mockImplementation((deps) => {
      const built = originalCreateReadTools(deps);
      return built.map((t) => {
        if (t.name === 'vault_state') {
          return {
            ...t,
            deferrable: true,
            searchSummary: 'state machine and process state',
            // Wrap the original handler to detect when it actually executes
            handler: async (...handlerArgs) => {
              realHandlerCalled = true;
              return (t.handler as any)(...handlerArgs);
            },
          };
        }
        return t;
      });
    });

    try {
      const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, { requestContext: TEST_REQUEST_CONTEXT });
      const stateTool = tools.find((t) => t.name === 'vault_state');
      expect(stateTool).toBeDefined();

      // Verify it was stubbed
      expect(stateTool!.description).toBe(DEFERRED_STUB_DESCRIPTION);

      // Invoke the stubbed tool directly
      const result = await stateTool!.handler({ key: 'test' }, undefined);

      // Verify the real handler executed
      expect(realHandlerCalled).toBe(true);

      // Verify the result is defined (real handler returned something)
      expect(result).toBeDefined();
    } finally {
      spy.mockRestore();
    }

    // Wait a tick for fire-and-forget turn insertion
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify an audit row was recorded for the tool call
    const db = getDatabase();
    const turns = db.prepare(
      `SELECT * FROM agent_turns WHERE run_id = ? AND tool_name = ?`,
    ).all(TEST_RUN_ID, 'vault_state');
    expect(turns.length).toBeGreaterThanOrEqual(1);
  });

  // ---------------------------------------------------------------------
  // Scope-leak hardening (final-review Fix 4)
  //
  // `onlyNames` only narrows which tool-GROUP factories run (see
  // `setsOverlap` in tools.ts) — a group that overlaps `onlyNames` still
  // produces every tool the factory defines internally, including ones
  // outside the caller's declared name list. `createVaultTools()` itself
  // has always returned that full per-group set — narrowing the RETURNED
  // ARRAY down to exactly `onlyNames` is `createScopedVaultToolServer` /
  // `LocalVaultMcpServer`'s job, applied on top of this return value, and
  // is unchanged by this fix. What Fix 4 changes is that the
  // `vault_search_tools` closure built INSIDE `createVaultTools` must not
  // capture a tool outside `onlyNames` even though that tool is present
  // in the raw return array — otherwise the meta-tool discloses an
  // out-of-surface tool's name/description/schema via search results even
  // though the tool itself is correctly filtered out downstream.
  //
  // Both read-tools.ts tools used below (`vault_state` and
  // `vault_spores`) live in the same READ_TOOL_NAMES group, so scoping to
  // just `vault_spores` still runs `createReadTools()` and gets
  // `vault_state` back in the raw array — exactly the shape a real
  // deferrable tool factory + a narrow phase tool list would produce.
  // ---------------------------------------------------------------------

  it('a deferrable tool outside onlyNames is not marked deferrable, so vault_search_tools is not synthesized when it is the only deferral', async () => {
    const readTools = await import('@myco/agent/tools/read-tools.js');
    const originalCreateReadTools = readTools.createReadTools;
    const spy = vi.spyOn(readTools, 'createReadTools').mockImplementation((deps) => {
      const built = originalCreateReadTools(deps);
      // vault_state is marked deferrable at the factory level (simulating
      // a future factory-level `deferrable: true`), but the scoped call
      // below only requests vault_spores — vault_state is NOT in scope.
      return built.map((t) => (t.name === 'vault_state' ? { ...t, deferrable: true, searchSummary: 'state' } : t));
    });

    try {
      const scopedTools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
        requestContext: TEST_REQUEST_CONTEXT,
        onlyNames: new Set(['vault_spores']),
      });

      // vault_state is present in the raw array (createVaultTools only
      // narrows by tool-GROUP, not individual name — the caller applies
      // the final name filter), but its `deferrable` flag must have been
      // cleared because it is outside `onlyNames`.
      const stateTool = scopedTools.find((t) => t.name === 'vault_state');
      expect(stateTool).toBeDefined();
      expect(stateTool!.deferrable).not.toBe(true);

      // No in-scope tool is deferrable here, so vault_search_tools must
      // not be synthesized either — an unrequested meta-tool disclosing
      // an out-of-surface schema is exactly the leak this test guards.
      expect(scopedTools.find((t) => t.name === 'vault_search_tools')).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('when an in-scope tool IS deferrable, vault_search_tools appears but never surfaces an out-of-scope deferrable tool', async () => {
    const readTools = await import('@myco/agent/tools/read-tools.js');
    const originalCreateReadTools = readTools.createReadTools;
    const spy = vi.spyOn(readTools, 'createReadTools').mockImplementation((deps) => {
      const built = originalCreateReadTools(deps);
      return built.map((t) => {
        if (t.name === 'vault_state') return { ...t, deferrable: true, searchSummary: 'state machine' };
        if (t.name === 'vault_spores') return { ...t, deferrable: true, searchSummary: 'spore listing' };
        return t;
      });
    });

    try {
      // Scope only includes vault_spores — vault_state stays out of
      // scope even though the same factory (and mock) marks it
      // deferrable too.
      const scopedTools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
        requestContext: TEST_REQUEST_CONTEXT,
        onlyNames: new Set(['vault_spores']),
      });

      const searchTool = scopedTools.find((t) => t.name === 'vault_search_tools');
      expect(searchTool).toBeDefined();
      expect(scopedTools.find((t) => t.name === 'vault_state')!.deferrable).not.toBe(true);

      const result = await searchTool!.handler({ query: 'state' }, undefined);
      const parsed = JSON.parse(result.content[0].text) as Array<{ name: string }>;
      // "state" matches vault_state's searchSummary — if the closure
      // still captured the out-of-scope tool, it would show up here even
      // though its `deferrable` flag was cleared on the returned object.
      expect(parsed.find((t) => t.name === 'vault_state')).toBeUndefined();
      expect(parsed).toEqual([]);

      const sporesResult = await searchTool!.handler({ query: 'spore' }, undefined);
      const sporesParsed = JSON.parse(sporesResult.content[0].text) as Array<{ name: string }>;
      expect(sporesParsed.map((t) => t.name)).toEqual(['vault_spores']);
    } finally {
      spy.mockRestore();
    }
  });

  it('marking an out-of-scope tool via deferredNames does not disclose it either', async () => {
    const scopedTools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, {
      requestContext: TEST_REQUEST_CONTEXT,
      onlyNames: new Set(['vault_spores']),
      // vault_state is in the same tool-group as vault_spores (both
      // read-tools.ts) so it still comes back in the raw array, but it
      // was never requested via onlyNames.
      deferredNames: new Set(['vault_state']),
    });

    const stateTool = scopedTools.find((t) => t.name === 'vault_state');
    expect(stateTool).toBeDefined();
    expect(stateTool!.deferrable).not.toBe(true);
    expect(scopedTools.find((t) => t.name === 'vault_search_tools')).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // The same guarantee at the ACTUAL caller layer that applies the final
  // name-scoping filter on top of createVaultTools()'s return value —
  // createScopedVaultToolServer is what phases really get wired through
  // (see agent/harness/claude.ts's buildToolServer). Asserts against the
  // real MCP server's advertised tool list, not internal fields.
  // ---------------------------------------------------------------------

  it('createScopedVaultToolServer never advertises an out-of-scope deferrable tool, nor an unwarranted vault_search_tools', async () => {
    const { createScopedVaultToolServer } = await import('@myco/agent/tools.js');
    const readTools = await import('@myco/agent/tools/read-tools.js');
    const originalCreateReadTools = readTools.createReadTools;
    const spy = vi.spyOn(readTools, 'createReadTools').mockImplementation((deps) => {
      const built = originalCreateReadTools(deps);
      return built.map((t) => (t.name === 'vault_state' ? { ...t, deferrable: true, searchSummary: 'state' } : t));
    });

    try {
      const server = createScopedVaultToolServer(TEST_AGENT_ID, TEST_RUN_ID, ['vault_spores'], {
        requestContext: TEST_REQUEST_CONTEXT,
      });
      // McpSdkServerConfigWithInstance carries the constructed tool list
      // on `.instance` internals; assert via the same registered-tools
      // surface the other tests in this repo use for SDK server configs.
      const registeredTools = (server as unknown as { instance: { _registeredTools: Record<string, unknown> } })
        .instance._registeredTools;
      const names = Object.keys(registeredTools);

      expect(names).toContain('vault_spores');
      expect(names).not.toContain('vault_state');
      expect(names).not.toContain('vault_search_tools');
    } finally {
      spy.mockRestore();
    }
  });
});
