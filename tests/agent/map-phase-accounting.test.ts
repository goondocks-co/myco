import { describe, expect, test } from 'bun:test';
import { z } from 'zod/v4';
import { executeMapPhase } from '@myco/agent/map-phase.js';
import { HarnessExecutionError } from '@myco/agent/harness/types.js';
import type { PhaseDefinition } from '@myco/agent/types.js';
import type { MycoToolDefinition } from '@myco/agent/tools/types.js';

// Mirrors the fixture shape of map-phase-connectivity.test.ts so the tools
// pass through the real source-fetch + per-item tool-surface code path
// (buildMapItemToolSurface strips argMap keys from the sink's inputSchema, so
// the sink must declare a real schema).
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
    accounting: { tool: 'charge' },
    ...extra,
  };
}

// Sink accepts only 'written'; every other path is rejected (ok:false → skip).
function makeSink(): MycoToolDefinition {
  return {
    name: 'sink',
    description: 'sink',
    inputSchema: { path: z.string(), description: z.string() },
    async handler(args: Record<string, unknown>) {
      const ok = args.path === 'written';
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(ok ? { ok: true } : { ok: false, reason: 'rejected' }),
          },
        ],
      };
    },
    annotations: {},
  };
}

function makeCharge(sink: unknown[]): MycoToolDefinition {
  return {
    name: 'charge',
    description: 'charge',
    inputSchema: { items: z.array(z.object({ path: z.string() })) },
    async handler(args: Record<string, unknown>) {
      const items = (args.items ?? []) as unknown[];
      sink.push(...items);
      return { content: [{ type: 'text', text: JSON.stringify({ charged: items.length }) }] };
    },
    annotations: {},
  };
}

function makeSource(items: unknown[]): MycoToolDefinition {
  return {
    name: 'src',
    description: 'src',
    inputSchema: {},
    async handler() {
      return { content: [{ type: 'text', text: JSON.stringify({ entries: items }) }] };
    },
    annotations: { readOnlyHint: true },
  };
}

// Harness that runs the sink once per item (no scope; uses execute()).
function sinkRunningHarness() {
  return {
    id: 'claude-sdk' as const,
    supports: () => false,
    execute: async (input: any) => {
      const s = input.toolSurface.tools.find((t: any) => t.name === 'sink');
      await s.handler({ description: 'x' });
      return { finalText: '', turnsUsed: 1, usage: {} };
    },
  };
}

describe('executeMapPhase accounting hook', () => {
  test('charges only content-failed/skip items, never written ones', async () => {
    const charged: unknown[] = [];
    const res = await executeMapPhase({
      phase: makePhase(),
      allTools: [makeSource([{ path: 'written' }, { path: 'skipped' }]), makeSink(), makeCharge(charged)],
      harness: sinkRunningHarness() as any,
      params: {},
      systemPrompt: 's',
      runId: 'r',
      agentId: 'a',
      provider: { type: 'lmstudio', baseUrl: 'http://x:1234', model: 'm' },
      probeAvailable: async () => true,
    });
    expect(res.written).toBe(1);
    expect(res.skipped).toBe(1);
    // Only the skipped item burns an attempt — the written item never does.
    expect(charged).toEqual([{ path: 'skipped' }]);
  });

  test('connection-break items are NOT charged', async () => {
    const charged: unknown[] = [];
    const harness = {
      id: 'claude-sdk' as const,
      supports: () => false,
      execute: async () => {
        throw new HarnessExecutionError('Was there a typo in the url or port?', {
          usage: {},
          kind: 'connection',
        });
      },
    };
    const res = await executeMapPhase({
      phase: makePhase(),
      allTools: [makeSource([{ path: 'a' }, { path: 'b' }]), makeSink(), makeCharge(charged)],
      harness: harness as any,
      params: {},
      systemPrompt: 's',
      runId: 'r',
      agentId: 'a',
      provider: { type: 'lmstudio', baseUrl: 'http://x:1234', model: 'm' },
      probeAvailable: async () => true,
    });
    expect(res.providerUnavailable).toBe(true);
    expect(res.unavailable).toBe(1);
    // The outage item was never evaluated → no attempt charged.
    expect(charged).toEqual([]);
  });

  test('pre-outage content failures flush even after a connection break', async () => {
    const charged: unknown[] = [];
    // First item is rejected by the sink (skip → charge); second item hits a
    // connection error and breaks the batch. The flush after the loop still
    // runs, so the pre-outage skip is charged but the outage item is not.
    const harness = {
      id: 'claude-sdk' as const,
      supports: () => false,
      execute: async (input: any) => {
        const itemPath = input.prompt.match(/do (\S+)/)![1];
        if (itemPath === 'down') {
          throw new HarnessExecutionError('connection refused', { usage: {}, kind: 'connection' });
        }
        const s = input.toolSurface.tools.find((t: any) => t.name === 'sink');
        await s.handler({ description: 'x' });
        return { finalText: '', turnsUsed: 1, usage: {} };
      },
    };
    const res = await executeMapPhase({
      phase: makePhase(),
      allTools: [makeSource([{ path: 'bad' }, { path: 'down' }]), makeSink(), makeCharge(charged)],
      harness: harness as any,
      params: {},
      systemPrompt: 's',
      runId: 'r',
      agentId: 'a',
      provider: { type: 'lmstudio', baseUrl: 'http://x:1234', model: 'm' },
      probeAvailable: async () => true,
    });
    expect(res.skipped).toBe(1);
    expect(res.unavailable).toBe(1);
    expect(charged).toEqual([{ path: 'bad' }]);
  });
});
