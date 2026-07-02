import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { createLocalVaultMcpServer } from '@myco/agent/harness/openai-local-mcp.js';
import { TEST_REQUEST_CONTEXT } from '../helpers/request-context';
import { setupTestDb, teardownTestDb } from '../helpers/db';
import { getDatabase } from '@myco/db/client.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { listRunEvents } from '@myco/db/queries/agent-run-events.js';
import { buildAuditEventHooks } from '@myco/agent/harness/audit-hooks.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

const epochNow = () => Math.floor(Date.now() / 1000);

function createAgent(id: string): void {
  const db = getDatabase();
  db.prepare(`INSERT INTO agents (id, name, created_at) VALUES (?, ?, ?)`).run(id, `agent-${id}`, epochNow());
}

describe('createLocalVaultMcpServer', () => {
  it('exports JSON Schema for Anthropic SDK tools', async () => {
    const server = createLocalVaultMcpServer({
      agentId: 'agent-test',
      runId: 'run-test',
      toolNames: ['vault_create_spore'],
      requestContext: TEST_REQUEST_CONTEXT,
    });

    const tools = await server.listTools();
    const createSpore = tools.find((tool) => tool.name === 'vault_create_spore');

    expect(tools).toHaveLength(1);
    expect(createSpore).toBeDefined();
    expect(createSpore?.inputSchema).toMatchObject({
      type: 'object',
      required: ['observation_type', 'content'],
      additionalProperties: false,
      properties: {
        observation_type: { type: 'string' },
        content: { type: 'string' },
        session_id: { type: 'string' },
        tags: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    });
    expect((createSpore?.inputSchema?.properties as Record<string, unknown>)?.optional).toBeUndefined();

    await server.close();
  });

  describe('hook threading', () => {
    // Regression: LocalVaultMcpServer's createVaultTools() call used to omit
    // toolSurface.hooks/hookContext, so wrapToolWithAudit inside tools.ts
    // always received undefined for OpenAI-harness runs — no
    // pre_tool_use/post_tool_use events were ever recorded in production
    // even when a run had real hooks configured. This exercises the real
    // (unmocked) createVaultTools/wrapToolWithAudit path end to end: invoke
    // a tool through the constructed server and assert the DB row lands.
    beforeEach(() => {
      setupTestDb();
      createAgent('agent-1');
      insertRun({ id: 'run-1', agent_id: 'agent-1', status: 'running', started_at: epochNow() });
    });

    afterEach(() => {
      teardownTestDb();
    });

    it('threads hooks/hookContext through to wrapToolWithAudit, recording pre/post tool-use events', async () => {
      const server = createLocalVaultMcpServer({
        agentId: 'agent-1',
        runId: 'run-1',
        toolNames: ['vault_report'],
        requestContext: TEST_REQUEST_CONTEXT,
        hooks: buildAuditEventHooks('run-1', null),
        hookContext: { runId: 'run-1', agentId: 'agent-1', harnessId: 'openai-agents', phaseName: 'gather' },
      });

      await server.callTool('vault_report', {
        action: 'test_action',
        summary: 'test summary',
      });

      const events = listRunEvents('run-1', { scope: ALL_PROJECTS_SCOPE });
      const eventTypes = events.map((e) => e.event_type);
      expect(eventTypes).toEqual(['pre_tool_use', 'post_tool_use']);
      expect(events[0].tool_name).toBe('vault_report');
      expect(events[0].phase_name).toBe('gather');
      expect(events[1].outcome).toBe('success');

      await server.close();
    });
  });
});
