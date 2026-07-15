import { describe, expect, test } from 'bun:test';
import { z } from 'zod/v4';
import { executeMapPhase } from '@myco/agent/map-phase.js';
import { HarnessExecutionError } from '@myco/agent/harness/types.js';
import type { PhaseDefinition } from '@myco/agent/types.js';
import type { MycoToolDefinition } from '@myco/agent/tools/types.js';

// Mirrors the fixture shape of map-phase.test.ts so the tools pass through
// the real source-fetch + per-item tool-surface code path (the brief's
// minimal `schema: {}` sink would crash buildMapItemToolSurface, which
// strips argMap keys from the sink's `inputSchema`).
function makePhase(extra: Partial<PhaseDefinition> = {}): PhaseDefinition {
  return {
    name: 'describe',
    prompt: 'unused',
    tools: [],
    maxTurns: 1,
    required: true,
    mode: 'map',
    onItemError: 'skip',
    perItemMaxTurns: 5,
    source: { tool: 'src', args: {}, itemsPath: 'entries' },
    item: { prompt: 'do {{ item.path }}' },
    sink: { tool: 'sink', argMap: { path: '{{ item.path }}' } },
    ...extra,
  };
}

function makeSink(): MycoToolDefinition {
  return {
    name: 'sink',
    description: 'sink',
    inputSchema: { path: z.string(), description: z.string() },
    async handler() {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    },
    annotations: {},
  };
}

describe('executeMapPhase connectivity', () => {
  test('provider down → source never called, providerUnavailable, 0 items', async () => {
    let sourceCalls = 0;
    const source: MycoToolDefinition = {
      name: 'src',
      description: 'src',
      inputSchema: {},
      async handler() {
        sourceCalls++;
        return { content: [{ type: 'text', text: JSON.stringify({ entries: [] }) }] };
      },
      annotations: { readOnlyHint: true },
    };
    const res = await executeMapPhase({
      phase: makePhase(),
      allTools: [source, makeSink()],
      harness: {} as any,
      params: {},
      systemPrompt: 's',
      runId: 'r',
      agentId: 'a',
      provider: { type: 'lmstudio', baseUrl: 'http://x:1234', model: 'm' },
      probeAvailable: async () => ({ available: false }),
    });
    expect(sourceCalls).toBe(0);
    expect(res.providerUnavailable).toBe(true);
    expect(res.itemCount).toBe(0);
  });

  test('mid-batch connection error breaks the loop and does not count as failed', async () => {
    const items = [{ path: 'a' }, { path: 'b' }, { path: 'c' }];
    const source: MycoToolDefinition = {
      name: 'src',
      description: 'src',
      inputSchema: {},
      async handler() {
        return { content: [{ type: 'text', text: JSON.stringify({ entries: items }) }] };
      },
      annotations: { readOnlyHint: true },
    };
    let runs = 0;
    const harness = {
      id: 'claude-sdk' as const,
      supports: () => false,
      execute: async () => {
        runs++;
        throw new HarnessExecutionError('Was there a typo in the url or port?', {
          usage: {},
          kind: 'connection',
        });
      },
    };
    const res = await executeMapPhase({
      phase: makePhase(),
      allTools: [source, makeSink()],
      harness: harness as any,
      params: {},
      systemPrompt: 's',
      runId: 'r',
      agentId: 'a',
      provider: { type: 'lmstudio', baseUrl: 'http://x:1234', model: 'm' },
      probeAvailable: async () => ({ available: true }),
    });
    expect(runs).toBe(1); // broke after the first connection failure
    expect(res.itemCount).toBe(3); // break happened mid-batch, not pre-fetch
    expect(res.failed).toBe(0); // infra failure not counted as content failure
    expect(res.unavailable).toBe(1);
    expect(res.providerUnavailable).toBe(true);
  });

  test('per-item timeout is a content failure, not a provider outage', async () => {
    // Faithful to the real path: a genuine timer-based per-item timeout aborts
    // THIS item's controller; the harness surfaces the abort reason
    // (`new Error('per-item timeout')`), whose message matches isConnectionError's
    // /\btimeout\b/ pattern. Before the guard, that misclassified a single slow
    // item as a provider outage (providerUnavailable=true + break the batch).
    const items = [{ path: 'fast' }, { path: 'slow' }, { path: 'fast2' }];
    const source: MycoToolDefinition = {
      name: 'src',
      description: 'src',
      inputSchema: {},
      async handler() {
        return { content: [{ type: 'text', text: JSON.stringify({ entries: items }) }] };
      },
      annotations: { readOnlyHint: true },
    };
    let runs = 0;
    const harness = {
      id: 'claude-sdk' as const,
      supports: () => false,
      execute: async (input: any) => {
        runs++;
        const itemPath = input.prompt.match(/do (\S+)/)![1];
        if (itemPath === 'slow') {
          // Block until the per-item AbortController fires, then surface its
          // abort reason — exactly what a real adapter does on per-item timeout.
          await new Promise((_, reject) => {
            input.abortController?.signal.addEventListener('abort', () =>
              reject(input.abortController.signal.reason),
            );
          });
        }
        const s = input.toolSurface.tools.find((t: any) => t.name === 'sink');
        await s.handler({ description: 'x' });
        return { finalText: '', turnsUsed: 1, usage: {} };
      },
    };
    const res = await executeMapPhase({
      phase: makePhase({ perItemTimeoutSeconds: 0.05 }), // 50ms — slow item times out
      allTools: [source, makeSink()],
      harness: harness as any,
      params: {},
      systemPrompt: 's',
      runId: 'r',
      agentId: 'a',
      provider: { type: 'lmstudio', baseUrl: 'http://x:1234', model: 'm' },
      probeAvailable: async () => ({ available: true }),
    });
    expect(runs).toBe(3); // batch did NOT break — every item was attempted
    expect(res.providerUnavailable).toBe(false); // not classified as an outage
    expect(res.unavailable).toBe(0);
    expect(res.failed).toBe(1); // counted as a normal per-item content failure
    expect(res.written).toBe(2); // the two fast items still wrote
  });
});
