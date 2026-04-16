import { describe, expect, it } from 'vitest';
import { createLocalVaultMcpServer } from '@myco/agent/runtime/openai-local-mcp.js';

describe('createLocalVaultMcpServer', () => {
  it('exports JSON Schema for Anthropic SDK tools', async () => {
    const server = createLocalVaultMcpServer({
      agentId: 'agent-test',
      runId: 'run-test',
      toolNames: ['vault_create_spore'],
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
});
