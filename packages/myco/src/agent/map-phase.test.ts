import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod/v4';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { executeMapPhase } from './map-phase.js';
import type { PhaseDefinition } from './types.js';

function makeSinkSpy() {
  const calls: any[] = [];
  const sink = tool(
    'test_write',
    'sink',
    { path: z.string(), description: z.string() },
    async (args) => {
      calls.push(args);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    },
    { annotations: {} },
  );
  return { sink, calls };
}

function makeSource(items: any[]) {
  return tool(
    'test_source',
    'src',
    { limit: z.number().optional() },
    async () => ({ content: [{ type: 'text', text: JSON.stringify({ entries: items }) }] }),
    { annotations: { readOnlyHint: true } },
  );
}

const happyPhase: PhaseDefinition = {
  name: 'describe',
  prompt: 'unused',
  tools: [],
  maxTurns: 1,
  required: true,
  mode: 'map',
  perItemMaxTurns: 1,
  perItemTimeoutSeconds: 30,
  onItemError: 'skip',
  source: { tool: 'test_source', args: { limit: 5 }, itemsPath: 'entries' },
  item: { prompt: 'item is {{ item.path }}' },
  sink: { tool: 'test_write', argMap: { path: '{{ item.path }}' } },
};

describe('executeMapPhase — happy path', () => {
  it('fetches items, runs runtime once per item, invokes sink with merged args', async () => {
    const { sink, calls } = makeSinkSpy();
    const source = makeSource([
      { path: 'a.ts', language: 'ts' },
      { path: 'b.ts', language: 'ts' },
      { path: 'c.ts', language: 'ts' },
    ]);
    const stubRuntime = {
      id: 'claude-sdk' as const,
      supports: () => false,
      execute: vi.fn(async (input: any) => {
        const sinkInSurface = input.toolSurface.tools.find((t: any) => t.name === 'test_write');
        const itemPath = input.prompt.match(/item is (\S+)/)![1];
        await sinkInSurface.handler({ description: `summary of ${itemPath}` });
        return { finalText: '', turnsUsed: 1, usage: { totalTokens: 0, requests: 1 }, sessionRef: undefined };
      }),
    };

    const result = await executeMapPhase({
      phase: happyPhase,
      allTools: [source, sink],
      runtime: stubRuntime as any,
      params: {},
      systemPrompt: 'sys',
      runId: 'r1',
      agentId: 'a',
    });

    expect(result.itemCount).toBe(3);
    expect(result.written).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(stubRuntime.execute).toHaveBeenCalledTimes(3);
    expect(calls).toHaveLength(3);
    // The harness pins `path` from argMap; the model only supplies `description`.
    expect(calls[0]).toMatchObject({ path: 'a.ts', description: 'summary of a.ts' });
  });
});
