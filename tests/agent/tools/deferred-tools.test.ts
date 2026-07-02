import { describe, it, expect } from 'bun:test';
import { z } from 'zod/v4';
import type { MycoToolDefinition } from '@myco/agent/tools/types.js';
import {
  applyDeferredStubs,
  buildSearchToolsTool,
  DEFERRED_STUB_DESCRIPTION,
} from '@myco/agent/tools/deferred-tools.js';

/** True when `value` is a Zod schema instance (mirrors the SDK's own discriminator). */
function isZodSchema(value: unknown): value is z.ZodTypeAny {
  return typeof value === 'object' && value !== null && '_zod' in value;
}

function makeTool(overrides: Partial<MycoToolDefinition> = {}): MycoToolDefinition {
  return {
    name: 'vault_example',
    description: 'Example tool description',
    inputSchema: { foo: z.string().describe('bar-schema-marker') },
    handler: async () => ({ content: [{ type: 'text' as const, text: '{}' }] }),
    ...overrides,
  };
}

describe('MycoToolDefinition deferred-loading fields', () => {
  it('accepts deferrable and searchSummary as optional fields', () => {
    const eager = makeTool();
    const deferred = makeTool({ deferrable: true, searchSummary: 'Does the example thing' });
    expect(eager.deferrable).toBeUndefined();
    expect(deferred.deferrable).toBe(true);
    expect(deferred.searchSummary).toBe('Does the example thing');
  });
});

describe('applyDeferredStubs', () => {
  it('replaces description and inputSchema on deferrable tools', () => {
    const deferred = makeTool({
      name: 'vault_scan_skill_contamination',
      deferrable: true,
      searchSummary: 'Scan a skill for contamination',
    });
    const [stubbed] = applyDeferredStubs([deferred]);
    expect(stubbed.name).toBe('vault_scan_skill_contamination');
    expect(stubbed.description).toBe(DEFERRED_STUB_DESCRIPTION);
    // Stub schema MUST be a full Zod schema, not a raw `{}` shape — the MCP
    // dispatch layer (createSdkMcpServer) treats a raw shape with zero
    // declared properties as "reject every arg", silently stripping
    // whatever the model sends. See tests/agent/tools/deferred-tools-mcp-dispatch.test.ts
    // for the empirical proof at the real MCP registration/dispatch layer.
    expect(isZodSchema(stubbed.inputSchema)).toBe(true);
    const parsed = (stubbed.inputSchema as z.ZodTypeAny).safeParse({ anything: 'goes', nested: { ok: true } });
    expect(parsed.success).toBe(true);
  });

  it('leaves non-deferrable tools completely unchanged', () => {
    const eager = makeTool({ name: 'vault_report' });
    const [result] = applyDeferredStubs([eager]);
    expect(result).toBe(eager);
  });

  it('never modifies the handler reference on a deferred tool', () => {
    const handler = async () => ({ content: [{ type: 'text' as const, text: 'real-result' }] });
    const deferred = makeTool({ deferrable: true, searchSummary: 'x', handler });
    const [stubbed] = applyDeferredStubs([deferred]);
    expect(stubbed.handler).toBe(handler);
  });

  it('returns an empty array for an empty input', () => {
    expect(applyDeferredStubs([])).toEqual([]);
  });
});

describe('buildSearchToolsTool', () => {
  it('returns null when no tool is deferrable', () => {
    const tools = [makeTool({ name: 'a' }), makeTool({ name: 'b' })];
    expect(buildSearchToolsTool(tools)).toBeNull();
  });

  it('returns null for an empty input', () => {
    expect(buildSearchToolsTool([])).toBeNull();
  });

  it('returns a vault_search_tools tool when at least one tool is deferrable', () => {
    const tools = [
      makeTool({ name: 'a' }),
      makeTool({ name: 'b', deferrable: true, searchSummary: 'Handles b-shaped work' }),
    ];
    const searchTool = buildSearchToolsTool(tools);
    expect(searchTool).not.toBeNull();
    expect(searchTool!.name).toBe('vault_search_tools');
    expect(searchTool!.deferrable).toBeUndefined();
  });

  it('search handler matches on name and searchSummary substrings, case-insensitive', async () => {
    const tools = [
      makeTool({
        name: 'vault_scan_skill_contamination',
        description: 'Full real description with schema details',
        inputSchema: { skill_name: z.string().describe('Name of the skill to scan for contamination markers') },
        deferrable: true,
        searchSummary: 'Scan a skill for CONTAMINATION patterns',
      }),
      makeTool({
        name: 'vault_write_skill',
        deferrable: true,
        searchSummary: 'Write or evolve a skill file',
      }),
    ];
    const searchTool = buildSearchToolsTool(tools)!;
    const result = await searchTool.handler({ query: 'contamination' }, undefined);
    const parsed = JSON.parse(result.content[0].text) as Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;

    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe('vault_scan_skill_contamination');
    // Full, non-stubbed description/schema — NOT the placeholder.
    expect(parsed[0].description).toBe('Full real description with schema details');
    // A real JSON Schema, converted via z.toJSONSchema (not a raw
    // JSON.stringify of zod internals) — field .describe() text MUST
    // survive the conversion. zod v4 keeps description metadata in a
    // side registry, not on the schema's own `def`, so a naive
    // JSON.stringify of the raw shape silently drops it.
    expect(parsed[0].inputSchema.type).toBe('object');
    const properties = parsed[0].inputSchema.properties as Record<string, { description?: string; type?: string }>;
    expect(properties.skill_name.type).toBe('string');
    expect(properties.skill_name.description).toBe('Name of the skill to scan for contamination markers');
  });

  it('search handler returns an empty array when no deferred tool matches', async () => {
    const tools = [
      makeTool({ name: 'vault_write_skill', deferrable: true, searchSummary: 'Write or evolve a skill file' }),
    ];
    const searchTool = buildSearchToolsTool(tools)!;
    const result = await searchTool.handler({ query: 'nonexistent-topic-xyz' }, undefined);
    const parsed = JSON.parse(result.content[0].text) as unknown[];
    expect(parsed).toEqual([]);
  });

  it('search handler never surfaces non-deferrable tools', async () => {
    const tools = [
      makeTool({ name: 'vault_report', searchSummary: 'never actually used since not deferrable' }),
      makeTool({ name: 'vault_write_skill', deferrable: true, searchSummary: 'Write or evolve a skill file' }),
    ];
    const searchTool = buildSearchToolsTool(tools)!;
    const result = await searchTool.handler({ query: 'used' }, undefined);
    const parsed = JSON.parse(result.content[0].text) as unknown[];
    expect(parsed).toEqual([]);
  });
});
