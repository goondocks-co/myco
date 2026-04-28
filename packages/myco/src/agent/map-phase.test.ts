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

describe('executeMapPhase — skip modes', () => {
  it('records skipped + no_terminal_tool when runtime emits no sink call', async () => {
    const { sink, calls } = makeSinkSpy();
    const source = makeSource([{ path: 'a.ts' }, { path: 'b.ts' }]);
    const stubRuntime = {
      id: 'claude-sdk' as const,
      supports: () => false,
      execute: vi.fn(async () => ({ finalText: '', turnsUsed: 1, usage: { totalTokens: 0, requests: 1 } })),
    };
    const result = await executeMapPhase({
      phase: happyPhase,
      allTools: [source, sink],
      runtime: stubRuntime as any,
      params: {},
      systemPrompt: 's',
      runId: 'r',
      agentId: 'a',
    });
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.skipReasons.no_terminal_tool).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it('records skip when sink returns ok:false', async () => {
    const sink = tool('test_write', 'sink', { path: z.string(), description: z.string() },
      async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'boilerplate' }) }] }),
      { annotations: {} });
    const source = makeSource([{ path: 'a.ts' }]);
    const stubRuntime = {
      id: 'claude-sdk' as const,
      supports: () => false,
      execute: vi.fn(async (input: any) => {
        const s = input.toolSurface.tools.find((t: any) => t.name === 'test_write');
        await s.handler({ description: 'x' });
        return { finalText: '', turnsUsed: 1, usage: { totalTokens: 0, requests: 1 } };
      }),
    };
    const result = await executeMapPhase({
      phase: happyPhase, allTools: [source, sink], runtime: stubRuntime as any,
      params: {}, systemPrompt: 's', runId: 'r', agentId: 'a',
    });
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.skipReasons.boilerplate).toBe(1);
  });

  it('records failed when runtime throws and onItemError is skip', async () => {
    const { sink } = makeSinkSpy();
    const source = makeSource([{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }]);
    let n = 0;
    const stubRuntime = {
      id: 'claude-sdk' as const,
      supports: () => false,
      execute: vi.fn(async (input: any) => {
        n += 1;
        if (n === 2) throw new Error('runtime exploded');
        const s = input.toolSurface.tools.find((t: any) => t.name === 'test_write');
        await s.handler({ description: 'x' });
        return { finalText: '', turnsUsed: 1, usage: { totalTokens: 0, requests: 1 } };
      }),
    };
    const result = await executeMapPhase({
      phase: happyPhase, allTools: [source, sink], runtime: stubRuntime as any,
      params: {}, systemPrompt: 's', runId: 'r', agentId: 'a',
    });
    expect(result.written).toBe(2);
    expect(result.failed).toBe(1);
    expect(stubRuntime.execute).toHaveBeenCalledTimes(3); // all 3 items still attempted
  });
});

describe('executeMapPhase — per-item timeout', () => {
  it('aborts an item that exceeds perItemTimeoutSeconds and continues', async () => {
    const { sink } = makeSinkSpy();
    const source = makeSource([{ path: 'fast.ts' }, { path: 'slow.ts' }, { path: 'fast2.ts' }]);
    const stubRuntime = {
      id: 'claude-sdk' as const,
      supports: () => false,
      execute: vi.fn(async (input: any) => {
        const itemPath = input.prompt.match(/item is (\S+)/)![1];
        if (itemPath === 'slow.ts') {
          // Block until the per-item AbortController fires.
          await new Promise((_, reject) => {
            input.abortController?.signal.addEventListener('abort', () => reject(new Error('aborted')));
          });
        }
        const s = input.toolSurface.tools.find((t: any) => t.name === 'test_write');
        await s.handler({ description: 'x' });
        return { finalText: '', turnsUsed: 1, usage: { totalTokens: 0, requests: 1 } };
      }),
    };
    const phase = { ...happyPhase, perItemTimeoutSeconds: 0.05 }; // 50ms
    const result = await executeMapPhase({
      phase, allTools: [source, sink], runtime: stubRuntime as any,
      params: {}, systemPrompt: 's', runId: 'r', agentId: 'a',
    });
    expect(result.written).toBe(2);
    expect(result.failed).toBe(1);
  });
});

describe('executeMapPhase — abort + source-failure', () => {
  it('onItemError: abort throws on first item failure and stops iteration', async () => {
    const { sink } = makeSinkSpy();
    const source = makeSource([{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }]);
    let calls = 0;
    const stubRuntime = {
      id: 'claude-sdk' as const,
      supports: () => false,
      execute: vi.fn(async () => {
        calls += 1;
        if (calls === 2) throw new Error('boom');
        return { finalText: '', turnsUsed: 1, usage: { totalTokens: 0, requests: 1 } };
      }),
    };
    const phase = { ...happyPhase, onItemError: 'abort' as const };
    await expect(executeMapPhase({
      phase, allTools: [source, sink], runtime: stubRuntime as any,
      params: {}, systemPrompt: 's', runId: 'r', agentId: 'a',
    })).rejects.toThrow('boom');
    expect(calls).toBe(2); // item 3 was never reached
  });

  it('throws when source tool errors during fetch', async () => {
    const errSource = tool('test_source', 'src', { limit: z.number().optional() },
      async () => { throw new Error('db blown'); },
      { annotations: { readOnlyHint: true } });
    const { sink } = makeSinkSpy();
    const stubRuntime = {
      id: 'claude-sdk' as const,
      supports: () => false,
      execute: vi.fn(),
    };
    await expect(executeMapPhase({
      phase: happyPhase, allTools: [errSource, sink], runtime: stubRuntime as any,
      params: {}, systemPrompt: 's', runId: 'r', agentId: 'a',
    })).rejects.toThrow('db blown');
    expect(stubRuntime.execute).not.toHaveBeenCalled();
  });

  it('returns instantly with itemCount: 0 when source returns empty', async () => {
    const source = makeSource([]);
    const { sink } = makeSinkSpy();
    const stubRuntime = {
      id: 'claude-sdk' as const,
      supports: () => false,
      execute: vi.fn(),
    };
    const result = await executeMapPhase({
      phase: happyPhase, allTools: [source, sink], runtime: stubRuntime as any,
      params: {}, systemPrompt: 's', runId: 'r', agentId: 'a',
    });
    expect(result).toEqual({ itemCount: 0, written: 0, skipped: 0, failed: 0, abandoned: 0, skipReasons: {} });
    expect(stubRuntime.execute).not.toHaveBeenCalled();
  });
});
