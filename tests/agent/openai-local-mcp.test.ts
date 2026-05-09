import { describe, expect, it } from 'bun:test';
import { createLocalVaultMcpServer } from '@myco/agent/harness/openai-local-mcp.js';
import { TEST_REQUEST_CONTEXT } from '../helpers/request-context';

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
});
