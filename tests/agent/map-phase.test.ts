import { describe, it, expect, mock } from 'bun:test';
import { z } from 'zod/v4';
import { executeMapPhase } from '@myco/agent/map-phase.js';
import type { PhaseDefinition } from '@myco/agent/types.js';
import type { MycoToolDefinition } from '@myco/agent/tools/types.js';

function makeSinkSpy() {
  const calls: any[] = [];
  const sink: MycoToolDefinition = {
    name: 'test_write',
    description: 'sink',
    inputSchema: { path: z.string(), description: z.string() },
    async handler(args: Record<string, unknown>) {
      calls.push(args);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    },
    annotations: {},
  };
  return { sink, calls };
}

function makeSource(items: any[]) {
  return {
    name: 'test_source',
    description: 'src',
    inputSchema: { limit: z.number().optional() },
    async handler() {
      return { content: [{ type: 'text', text: JSON.stringify({ entries: items }) }] };
    },
    annotations: { readOnlyHint: true },
  } satisfies MycoToolDefinition;
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
      execute: mock(async (input: any) => {
        const sinkInSurface = input.toolSurface.tools.find((t: any) => t.name === 'test_write');
        expect(Object.keys(sinkInSurface.inputSchema).sort()).toEqual(['description']);
        const itemPath = input.prompt.match(/item is (\S+)/)![1];
        await sinkInSurface.handler({ description: `summary of ${itemPath}` });
        return { finalText: '', turnsUsed: 1, usage: { totalTokens: 0, requests: 1 }, sessionRef: undefined };
      }),
    };

    const result = await executeMapPhase({
      phase: happyPhase,
      allTools: [source, sink],
      harness: stubRuntime as any,
      params: {},
      systemPrompt: 'sys',
      runId: 'r1',
      agentId: 'a',
      reasoningLevel: 'high',
    });

    expect(result.itemCount).toBe(3);
    expect(result.written).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(stubRuntime.execute).toHaveBeenCalledTimes(3);
    expect(calls).toHaveLength(3);
    // The harness pins `path` from argMap; the model only supplies `description`.
    expect(calls[0]).toMatchObject({ path: 'a.ts', description: 'summary of a.ts' });
    // Regression for the reasoningLevel plumbing gap: the no-openScope
    // execute-fallback path (this stub has no `openScope`) must forward
    // reasoningLevel on every per-item harness.execute() call.
    for (const call of (stubRuntime.execute as any).mock.calls) {
      expect(call[0].reasoningLevel).toBe('high');
    }
  });
});

describe('executeMapPhase — skip modes', () => {
  it('records skipped + no_terminal_tool when runtime emits no sink call', async () => {
    const { sink, calls } = makeSinkSpy();
    const source = makeSource([{ path: 'a.ts' }, { path: 'b.ts' }]);
    const stubRuntime = {
      id: 'claude-sdk' as const,
      supports: () => false,
      execute: mock(async () => ({ finalText: '', turnsUsed: 1, usage: { totalTokens: 0, requests: 1 } })),
    };
    const result = await executeMapPhase({
      phase: happyPhase,
      allTools: [source, sink],
      harness: stubRuntime as any,
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
    const sink: MycoToolDefinition = {
      name: 'test_write',
      description: 'sink',
      inputSchema: { path: z.string(), description: z.string() },
      async handler() {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, reason: 'boilerplate' }) }] };
      },
      annotations: {},
    };
    const source = makeSource([{ path: 'a.ts' }]);
    const stubRuntime = {
      id: 'claude-sdk' as const,
      supports: () => false,
      execute: mock(async (input: any) => {
        const s = input.toolSurface.tools.find((t: any) => t.name === 'test_write');
        await s.handler({ description: 'x' });
        return { finalText: '', turnsUsed: 1, usage: { totalTokens: 0, requests: 1 } };
      }),
    };
    const result = await executeMapPhase({
      phase: happyPhase, allTools: [source, sink], harness: stubRuntime as any,
      params: {}, systemPrompt: 's', runId: 'r', agentId: 'a',
    });
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.skipReasons.boilerplate).toBe(1);
  });

  it('keeps a successful sink outcome when a later duplicate call fails', async () => {
    let calls = 0;
    const sink: MycoToolDefinition = {
      name: 'test_write',
      description: 'sink',
      inputSchema: { path: z.string(), description: z.string() },
      async handler() {
        calls += 1;
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(calls === 1
              ? { ok: true }
            : { ok: false, reason: 'duplicate_rejected' }),
          }],
        };
      },
      annotations: {},
    };
    const source = makeSource([{ path: 'a.ts' }]);
    const stubRuntime = {
      id: 'claude-sdk' as const,
      supports: () => false,
      execute: mock(async (input: any) => {
        const s = input.toolSurface.tools.find((t: any) => t.name === 'test_write');
        await s.handler({ description: 'first' });
        await s.handler({ description: 'second' });
        return { finalText: '', turnsUsed: 1, usage: { totalTokens: 0, requests: 1 } };
      }),
    };

    const result = await executeMapPhase({
      phase: happyPhase, allTools: [source, sink], harness: stubRuntime as any,
      params: {}, systemPrompt: 's', runId: 'r', agentId: 'a',
    });

    expect(result.written).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.skipReasons.duplicate_rejected).toBeUndefined();
  });

  it('records failed when runtime throws and onItemError is skip', async () => {
    const { sink } = makeSinkSpy();
    const source = makeSource([{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }]);
    let n = 0;
    const stubRuntime = {
      id: 'claude-sdk' as const,
      supports: () => false,
      execute: mock(async (input: any) => {
        n += 1;
        if (n === 2) throw new Error('runtime exploded');
        const s = input.toolSurface.tools.find((t: any) => t.name === 'test_write');
        await s.handler({ description: 'x' });
        return { finalText: '', turnsUsed: 1, usage: { totalTokens: 0, requests: 1 } };
      }),
    };
    const result = await executeMapPhase({
      phase: happyPhase, allTools: [source, sink], harness: stubRuntime as any,
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
      execute: mock(async (input: any) => {
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
      phase, allTools: [source, sink], harness: stubRuntime as any,
      params: {}, systemPrompt: 's', runId: 'r', agentId: 'a',
    });
    expect(result.written).toBe(2);
    expect(result.failed).toBe(1);
  });
});

describe('executeMapPhase — run abort', () => {
  it('aborts the current item and stops later items when the run controller aborts', async () => {
    const { sink } = makeSinkSpy();
    const source = makeSource([{ path: 'a.ts' }, { path: 'b.ts' }]);
    const runAbortController = new AbortController();
    const stubRuntime = {
      id: 'claude-sdk' as const,
      supports: () => false,
      execute: mock(async (input: any) => {
        runAbortController.abort(new Error('task timeout'));
        if (input.abortController?.signal.aborted) {
          throw input.abortController.signal.reason;
        }
        await new Promise((_, reject) => {
          input.abortController?.signal.addEventListener('abort', () => reject(input.abortController.signal.reason));
        });
      }),
    };

    await expect(executeMapPhase({
      phase: happyPhase,
      allTools: [source, sink],
      harness: stubRuntime as any,
      params: {},
      systemPrompt: 's',
      runId: 'r',
      agentId: 'a',
      runAbortController,
    })).rejects.toThrow('task timeout');

    expect(stubRuntime.execute).toHaveBeenCalledTimes(1);
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
      execute: mock(async () => {
        calls += 1;
        if (calls === 2) throw new Error('boom');
        return { finalText: '', turnsUsed: 1, usage: { totalTokens: 0, requests: 1 } };
      }),
    };
    const phase = { ...happyPhase, onItemError: 'abort' as const };
    await expect(executeMapPhase({
      phase, allTools: [source, sink], harness: stubRuntime as any,
      params: {}, systemPrompt: 's', runId: 'r', agentId: 'a',
    })).rejects.toThrow('boom');
    expect(calls).toBe(2); // item 3 was never reached
  });

  it('throws when source tool errors during fetch', async () => {
    const errSource: MycoToolDefinition = {
      name: 'test_source',
      description: 'src',
      inputSchema: { limit: z.number().optional() },
      async handler() {
        throw new Error('db blown');
      },
      annotations: { readOnlyHint: true },
    };
    const { sink } = makeSinkSpy();
    const stubRuntime = {
      id: 'claude-sdk' as const,
      supports: () => false,
      execute: mock(() => Promise.resolve({ finalText: "", turnsUsed: 0, usage: { totalTokens: 0, requests: 0 } })),
    };
    await expect(executeMapPhase({
      phase: happyPhase, allTools: [errSource, sink], harness: stubRuntime as any,
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
      execute: mock(() => Promise.resolve({ finalText: "", turnsUsed: 0, usage: { totalTokens: 0, requests: 0 } })),
    };
    const result = await executeMapPhase({
      phase: happyPhase, allTools: [source, sink], harness: stubRuntime as any,
      params: {}, systemPrompt: 's', runId: 'r', agentId: 'a',
    });
    expect(result).toMatchObject({
      itemCount: 0, written: 0, skipped: 0, failed: 0, abandoned: 0,
      skipReasons: {},
      usage: { requests: 0, totalTokens: 0 },
    });
    expect(stubRuntime.execute).not.toHaveBeenCalled();
  });
});

describe('executeMapPhase — scoped fast path', () => {
  it('opens scope once and calls scope.run per item when runtime supports openScope', async () => {
    const { sink, calls } = makeSinkSpy();
    const source = makeSource([{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }]);
    let scopeOpens = 0;
    let scopeCloses = 0;
    let scopeRuns = 0;
    const stubRuntime = {
      id: 'claude-sdk' as const,
      supports: () => false,
      execute: mock(() => Promise.resolve({ finalText: '', turnsUsed: 0, usage: {} } as any)),
      openScope: mock(async (setup: any) => {
        scopeOpens += 1;
        return {
          run: mock(async (input: any) => {
            scopeRuns += 1;
            const sinkInSurface = setup.toolSurface.tools.find((t: any) => t.name === 'test_write');
            const itemPath = input.prompt.match(/item is (\S+)/)![1];
            await sinkInSurface.handler({ description: `summary of ${itemPath}` });
            return { finalText: '', turnsUsed: 1, usage: { totalTokens: 100, requests: 1 } };
          }),
          close: mock(async () => { scopeCloses += 1; }),
        };
      }),
    };
    const result = await executeMapPhase({
      phase: happyPhase,
      allTools: [source, sink],
      harness: stubRuntime as any,
      params: {},
      systemPrompt: 'sys',
      runId: 'r',
      agentId: 'a',
      reasoningLevel: 'high',
    });
    expect(scopeOpens).toBe(1);
    expect(scopeRuns).toBe(3);
    expect(scopeCloses).toBe(1);
    expect(result.written).toBe(3);
    expect(result.usage.totalTokens).toBe(300);
    // execute() should NOT be called when openScope is implemented.
    expect(stubRuntime.execute).not.toHaveBeenCalled();
    // Sink was called via the wrapped sink in the shared surface; harness
    // pinned `path` from argMap each time.
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ path: 'a.ts', description: 'summary of a.ts' });
    // Regression for the reasoningLevel plumbing gap: executeMapPhase's
    // openScope call must forward the phase's resolved reasoningLevel on
    // the setup object, not just phaseModel/provider.
    const openScopeSetup = (stubRuntime.openScope as any).mock.calls[0][0];
    expect(openScopeSetup.reasoningLevel).toBe('high');
  });

  it('closes scope even when an item throws under onItemError: abort', async () => {
    const { sink } = makeSinkSpy();
    const source = makeSource([{ path: 'a.ts' }, { path: 'b.ts' }]);
    let scopeCloses = 0;
    const stubRuntime = {
      id: 'claude-sdk' as const,
      supports: () => false,
      execute: mock(() => Promise.resolve({ finalText: '', turnsUsed: 0, usage: {} } as any)),
      openScope: mock(async (_setup: any) => ({
        run: mock(async () => { throw new Error('item exploded'); }),
        close: mock(async () => { scopeCloses += 1; }),
      })),
    };
    const phase = { ...happyPhase, onItemError: 'abort' as const };
    await expect(executeMapPhase({
      phase, allTools: [source, sink], harness: stubRuntime as any,
      params: {}, systemPrompt: 's', runId: 'r', agentId: 'a',
    })).rejects.toThrow('item exploded');
    expect(scopeCloses).toBe(1);
  });
});
