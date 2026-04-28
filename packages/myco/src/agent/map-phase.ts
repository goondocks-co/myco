/**
 * Map-phase executor. Drives a fan-out workload by:
 *   1. Calling a configured source tool ONCE (no model) to fetch items.
 *   2. Invoking the runtime once per item with a constrained tool surface
 *      containing only the sink tool (and optional read-only tools).
 *   3. Aggregating per-item outcomes into a MapPhaseResult.
 *
 * The source tool is structurally absent from the per-item surface, which
 * eliminates the fetch-loop failure mode that motivated this design — the
 * model cannot call a tool that isn't in the surface.
 */

import { interpolateArgs } from '@myco/utils/interpolate-args.js';
import { interpolate } from '@myco/utils/interpolate.js';
import { buildMapItemToolSurface } from './map-phase-tool-surface.js';
import type { AgentRuntime } from './runtime/types.js';
import type { MapPhaseResult, PhaseDefinition } from './types.js';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';

export interface ExecuteMapPhaseInput {
  phase: PhaseDefinition;
  allTools: SdkMcpToolDefinition<any>[];
  runtime: AgentRuntime;
  params: Record<string, unknown>;
  systemPrompt: string;
  runId: string;
  agentId: string;
}

export async function executeMapPhase(input: ExecuteMapPhaseInput): Promise<MapPhaseResult> {
  const { phase, allTools, runtime, params, systemPrompt, runId, agentId } = input;
  if (phase.mode !== 'map' || !phase.source || !phase.item || !phase.sink) {
    throw new Error(`executeMapPhase: phase "${phase.name}" is not a complete map phase`);
  }

  const items = await fetchSourceItems({ phase, allTools, params });

  const result: MapPhaseResult = {
    itemCount: items.length,
    written: 0,
    skipped: 0,
    failed: 0,
    abandoned: 0,
    skipReasons: {},
  };

  for (const item of items) {
    const argMap = interpolateArgs(phase.sink.argMap, { item, params });
    const surface = buildMapItemToolSurface(allTools, {
      sinkName: phase.sink.tool,
      argMap,
      readToolNames: phase.item.readTools ?? [],
    });

    const itemPrompt = interpolate(
      normalizeTemplateBraces(phase.item.prompt),
      flattenForInterpolate({ item, params }),
    );

    let sinkOutcome: { ok: boolean; reason?: string } | undefined;
    const sinkWrapped = wrapSinkForCapture(surface.sinkTool, argMap, (outcome) => {
      sinkOutcome = outcome;
    });
    const tools = surface.tools.map((t) => (t.name === phase.sink!.tool ? sinkWrapped : t));

    try {
      await runtime.execute({
        prompt: itemPrompt,
        systemPrompt,
        model: phase.model ?? '',
        maxTurns: phase.perItemMaxTurns ?? 1,
        // Pass the materialized tools alongside the standard toolSurface fields.
        // Task 10 (the dispatch adapter) is responsible for ensuring the real
        // runtime adapters can consume this. Stub runtimes in tests use this
        // field directly.
        toolSurface: { agentId, runId, toolNames: tools.map((t) => t.name), tools } as any,
      } as any);
    } catch (err) {
      if ((phase.onItemError ?? 'skip') === 'abort') {
        throw err;
      }
      result.failed += 1;
      continue;
    }

    if (sinkOutcome?.ok === true) {
      result.written += 1;
    } else if (sinkOutcome) {
      result.skipped += 1;
      const reason = sinkOutcome.reason ?? 'unknown';
      result.skipReasons[reason] = (result.skipReasons[reason] ?? 0) + 1;
    } else {
      result.skipped += 1;
      result.skipReasons.no_terminal_tool = (result.skipReasons.no_terminal_tool ?? 0) + 1;
    }
  }

  return result;
}

async function fetchSourceItems(input: {
  phase: PhaseDefinition;
  allTools: SdkMcpToolDefinition<any>[];
  params: Record<string, unknown>;
}): Promise<unknown[]> {
  const { phase, allTools, params } = input;
  const sourceDef = allTools.find((t) => t.name === phase.source!.tool);
  if (!sourceDef) {
    throw new Error(`executeMapPhase: source tool "${phase.source!.tool}" not found in registry`);
  }
  const renderedArgs = interpolateArgs(phase.source!.args, { params });
  const response = await (sourceDef as any).handler(renderedArgs);
  const text = (response?.content?.[0] as any)?.text;
  if (typeof text !== 'string') {
    throw new Error(`executeMapPhase: source returned non-text payload`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`executeMapPhase: source textResult is not JSON: ${(err as Error).message}`);
  }
  const items = followItemsPath(parsed, phase.source!.itemsPath);
  if (!Array.isArray(items)) {
    throw new Error(`executeMapPhase: itemsPath "${phase.source!.itemsPath}" did not resolve to an array`);
  }
  return items;
}

function followItemsPath(payload: unknown, path: string): unknown {
  let cursor: unknown = payload;
  for (const part of path.split('.').map((s) => s.trim()).filter(Boolean)) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function wrapSinkForCapture(
  sinkTool: SdkMcpToolDefinition<any>,
  argMap: Record<string, unknown>,
  capture: (outcome: { ok: boolean; reason?: string }) => void,
): SdkMcpToolDefinition<any> {
  return {
    ...sinkTool,
    handler: async (modelArgs: Record<string, unknown>) => {
      const merged = { ...modelArgs, ...argMap };
      const response = await (sinkTool as any).handler(merged);
      const text = (response?.content?.[0] as any)?.text;
      if (typeof text === 'string') {
        try {
          const parsed = JSON.parse(text);
          capture({ ok: parsed.ok === true, reason: parsed.reason });
        } catch {
          capture({ ok: false, reason: 'sink_response_unparseable' });
        }
      } else {
        capture({ ok: false, reason: 'sink_response_missing_text' });
      }
      return response;
    },
  };
}

// `interpolate` (the existing util) takes a flat string-keyed map. Flatten
// nested vars for compatibility — map-phase prompts use {{ item.path }}-style
// dotted lookups, so we flatten one level and key as `item.path`.
function flattenForInterpolate(vars: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') {
      for (const [kk, vv] of Object.entries(v as Record<string, unknown>)) {
        out[`${k}.${kk}`] = stringify(vv);
      }
    } else {
      out[k] = stringify(v);
    }
  }
  return out;
}

// Normalize `{{ key }}` → `{{key}}` so that `interpolate()` (which matches
// without spaces) can substitute dotted keys like `item.path`.
function normalizeTemplateBraces(template: string): string {
  return template.replace(/\{\{\s*(.+?)\s*\}\}/g, '{{$1}}');
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}
