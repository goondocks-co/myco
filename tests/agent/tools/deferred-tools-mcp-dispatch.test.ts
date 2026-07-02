/**
 * Empirical regression guard for the two Critical findings in the final
 * whole-branch review of deferred tool loading: both bugs only reproduce
 * at the REAL MCP registration/dispatch layer (`createSdkMcpServer` +
 * the underlying `@modelcontextprotocol/sdk` `Client`/`Server` request
 * cycle). Every other deferred-tools test in this repo calls
 * `tool.handler(args)` directly — which bypasses the SDK's own schema
 * normalization and argument validation entirely, so those tests cannot
 * see either bug.
 *
 * This file drives `applyDeferredStubs`/`buildSearchToolsTool` output
 * through the SAME registration path the harness uses in production
 * (`createSdkMcpServer` from `@anthropic-ai/claude-agent-sdk`), talking
 * to it over a real MCP `Client` connected via `InMemoryTransport` — the
 * transport-level wiring, not a mock.
 *
 * Bug 1 (stub schema): a stubbed tool's `inputSchema` used to be a raw
 * `{}` shape. The SDK's schema normalizer (`ls()` in the vendored
 * `@anthropic-ai/claude-agent-sdk/sdk.mjs`) treats a raw shape with zero
 * declared properties as "reject every argument" at the protocol level —
 * NOT as "accept anything". A `tools/call` request with real arguments
 * against a `{}`-schema tool has every argument silently stripped before
 * the handler ever sees them, regardless of whether the model already
 * discovered the tool's real schema via `vault_search_tools` (each phase
 * registers tool schemas once — there is no re-registration mid-phase).
 * Fixed by making the stub a genuinely permissive full Zod schema
 * (`z.object({}).passthrough()`), which the same normalizer passes
 * through unmodified.
 *
 * Bug 2 (discovery payload): `vault_search_tools` used to return
 * `JSON.stringify(rawZodShape)` — zod v4 internals, not a JSON Schema —
 * which drops every `.describe()` call (zod v4 stores description
 * metadata in a side registry keyed by schema identity, not on the
 * schema's own serializable `def`). Fixed by converting through
 * `z.toJSONSchema`, the same conversion `normalizeInputSchema` in
 * `agent/harness/openai-local-mcp.ts` already uses.
 */

import { describe, it, expect } from 'bun:test';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod/v4';
import { applyDeferredStubs, buildSearchToolsTool } from '@myco/agent/tools/deferred-tools.js';
import { toSdkMcpToolDefinitions } from '@myco/agent/tools/types.js';
import type { MycoToolDefinition } from '@myco/agent/tools/types.js';

/**
 * Connect a real MCP Client to a real MCP server instance built via
 * `createSdkMcpServer`, over `InMemoryTransport` — the linked in-process
 * transport pair the `@modelcontextprotocol/sdk` ships for exactly this
 * kind of end-to-end test. Returns the connected client; caller closes it.
 */
async function connectClient(tools: MycoToolDefinition[]): Promise<Client> {
  const serverConfig = createSdkMcpServer({
    name: 'test-deferred-dispatch',
    version: '0.0.1',
    tools: toSdkMcpToolDefinitions(tools),
    alwaysLoad: true,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.1' }, { capabilities: {} });

  await Promise.all([
    client.connect(clientTransport),
    serverConfig.instance.connect(serverTransport),
  ]);

  return client;
}

describe('deferred-tools MCP dispatch (real createSdkMcpServer + Client)', () => {
  it('a stubbed tool receives the EXACT args the client sent, not an empty object', async () => {
    const received: unknown[] = [];
    const realTool: MycoToolDefinition = tool(
      'vault_example_deferred',
      'Real description with real schema details',
      { foo: z.string().describe('the foo value'), count: z.number().optional() },
      async (args) => {
        received.push(args);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }] };
      },
    ) as unknown as MycoToolDefinition;
    (realTool as { deferrable?: boolean }).deferrable = true;

    const [stubbed] = applyDeferredStubs([realTool]);
    const client = await connectClient([stubbed]);

    try {
      const sentArgs = { foo: 'bar-value', count: 7 };
      const callResult = await client.callTool({ name: 'vault_example_deferred', arguments: sentArgs });

      // The handler must have received the client's args verbatim — proves
      // the stub schema does not silently strip arguments at the MCP
      // dispatch layer, the exact failure mode a raw `{}` inputSchema
      // produced (empirically verified against this repo's SDK version
      // before this fix: the handler received `{}` instead).
      expect(received).toEqual([sentArgs]);
      expect(callResult.isError).not.toBe(true);
    } finally {
      await client.close();
    }
  });

  it('an unrecognized/extra argument against a stubbed tool also reaches the handler (passthrough, not rejection)', async () => {
    const received: unknown[] = [];
    const realTool: MycoToolDefinition = tool(
      'vault_example_extra_args',
      'Real description',
      { known: z.string() },
      async (args) => {
        received.push(args);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }] };
      },
    ) as unknown as MycoToolDefinition;
    (realTool as { deferrable?: boolean }).deferrable = true;

    const [stubbed] = applyDeferredStubs([realTool]);
    const client = await connectClient([stubbed]);

    try {
      const sentArgs = { known: 'x', extra_unlisted_field: 'still-arrives' };
      await client.callTool({ name: 'vault_example_extra_args', arguments: sentArgs });
      expect(received).toEqual([sentArgs]);
    } finally {
      await client.close();
    }
  });

  it('vault_search_tools round-trips a real JSON Schema whose field .describe() text survives dispatch', async () => {
    const realTool: MycoToolDefinition = tool(
      'vault_scan_skill_contamination',
      'Full real description with schema details',
      {
        skill_name: z.string().describe('Name of the skill to scan for contamination markers'),
      },
      async () => ({ content: [{ type: 'text' as const, text: '{}' }] }),
    ) as unknown as MycoToolDefinition;
    (realTool as { deferrable?: boolean; searchSummary?: string }).deferrable = true;
    (realTool as { searchSummary?: string }).searchSummary = 'Scan a skill for contamination';

    const searchTool = buildSearchToolsTool([realTool]);
    expect(searchTool).not.toBeNull();
    const [stubbedRealTool] = applyDeferredStubs([realTool]);

    const client = await connectClient([stubbedRealTool, searchTool!]);

    try {
      const callResult = await client.callTool({ name: 'vault_search_tools', arguments: { query: 'contamination' } });
      expect(callResult.isError).not.toBe(true);

      const content = callResult.content as Array<{ type: string; text?: string }>;
      const textBlock = content.find((c) => c.type === 'text');
      expect(textBlock?.text).toBeDefined();

      const parsed = JSON.parse(textBlock!.text!) as Array<{
        name: string;
        description: string;
        inputSchema: { type?: string; properties?: Record<string, { description?: string; type?: string }> };
      }>;

      expect(parsed).toHaveLength(1);
      expect(parsed[0].name).toBe('vault_scan_skill_contamination');
      expect(parsed[0].inputSchema.type).toBe('object');

      // The load-bearing assertion: the field's .describe() text must be
      // present in the payload returned over the real MCP round-trip. A
      // JSON.stringify of the raw zod shape (the prior implementation)
      // drops this entirely — zod v4 keeps .describe() text in a
      // registry, not in the schema's serializable def.
      const skillNameProp = parsed[0].inputSchema.properties?.skill_name;
      expect(skillNameProp?.description).toBe('Name of the skill to scan for contamination markers');
    } finally {
      await client.close();
    }
  });
});
