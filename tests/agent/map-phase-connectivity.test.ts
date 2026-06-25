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
      probeAvailable: async () => false,
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
      probeAvailable: async () => true,
    });
    expect(runs).toBe(1); // broke after the first connection failure
    expect(res.failed).toBe(0); // infra failure not counted as content failure
    expect(res.unavailable).toBe(1);
    expect(res.providerUnavailable).toBe(true);
  });
});
