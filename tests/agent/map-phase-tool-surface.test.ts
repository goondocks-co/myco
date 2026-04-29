import { describe, it, expect } from 'bun:test';
import { z } from 'zod/v4';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { buildMapItemToolSurface } from '@myco/agent/map-phase-tool-surface.js';

function makeFakeTool(name: string, inputs: Record<string, z.ZodTypeAny>, readOnly = false) {
  return tool(name, `${name} tool`, inputs, async () => ({ content: [{ type: 'text', text: '{}' }] }), {
    annotations: readOnly ? { readOnlyHint: true } : {},
  });
}

describe('buildMapItemToolSurface', () => {
  const sinkTool = makeFakeTool('canopy_describe_write', { path: z.string(), description: z.string() });
  const readTool = makeFakeTool('vault_recall', { id: z.string() }, true);
  const sourceTool = makeFakeTool('canopy_describe_next', { limit: z.number().optional() }, true);
  const otherWriter = makeFakeTool('vault_create_spore', { content: z.string() });
  const allTools = [sinkTool, readTool, sourceTool, otherWriter];

  it('strict mode: surface contains only the sink tool', () => {
    const surface = buildMapItemToolSurface(allTools, {
      sinkName: 'canopy_describe_write',
      argMap: { path: 'src/foo.ts' },
      readToolNames: [],
    });
    const names = surface.tools.map((t: any) => t.name);
    expect(names).toEqual(['canopy_describe_write']);
  });

  it('strict mode: source tool is absent even though it is read-only', () => {
    const surface = buildMapItemToolSurface(allTools, {
      sinkName: 'canopy_describe_write',
      argMap: { path: 'src/foo.ts' },
      readToolNames: [],
    });
    const names = surface.tools.map((t: any) => t.name);
    expect(names).not.toContain('canopy_describe_next');
    expect(names).not.toContain('vault_create_spore');
  });

  it('flexible mode: read tools are included alongside the sink', () => {
    const surface = buildMapItemToolSurface(allTools, {
      sinkName: 'canopy_describe_write',
      argMap: { path: 'src/foo.ts' },
      readToolNames: ['vault_recall'],
    });
    const names = surface.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(['canopy_describe_write', 'vault_recall']);
  });

  it('throws when a readToolName names a non-read-only tool', () => {
    expect(() =>
      buildMapItemToolSurface(allTools, {
        sinkName: 'canopy_describe_write',
        argMap: {},
        readToolNames: ['vault_create_spore'],
      }),
    ).toThrow(/readOnly/i);
  });

  it('throws when sink tool is missing from the registry', () => {
    expect(() =>
      buildMapItemToolSurface(allTools, {
        sinkName: 'no_such_sink',
        argMap: {},
        readToolNames: [],
      }),
    ).toThrow(/sink tool/i);
  });

  it('strips argMap-pinned fields from the sink input schema', () => {
    const surface = buildMapItemToolSurface(allTools, {
      sinkName: 'canopy_describe_write',
      argMap: { path: 'src/foo.ts' },
      readToolNames: [],
    });
    const sinkInSurface: any = surface.tools[0];
    const schema = sinkInSurface.inputSchema as Record<string, any>;
    expect(Object.keys(schema).sort()).toEqual(['description']);
  });
});
