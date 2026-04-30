/**
 * Build a constrained per-item tool surface for a map-phase invocation.
 *
 * Strict mode: { sink-tool only, with argMap-pinned fields stripped from
 * the sink's input schema }. The full agent registry is NOT included.
 * The model can ONLY call the sink — there is no fetch tool surface to
 * fall into.
 *
 * Flexible mode: same as strict, plus the explicitly-named read tools.
 * Each named read tool MUST advertise readOnlyHint: true (validated).
 *
 * The returned `tools` array is what the harness adapter sees; the sink
 * tool's inputSchema has the argMap fields removed so the model literally
 * cannot supply them. The harness re-merges argMap fields with the model's
 * args before invoking the wrapped sink.
 */

import { z } from 'zod/v4';
import type { MycoToolDefinition } from '@myco/agent/tools/types.js';

export interface BuildMapItemSurfaceOptions {
  sinkName: string;
  argMap: Record<string, unknown>;
  readToolNames: string[];
}

export interface MapItemToolSurface {
  /** Tools to expose to the harness for this item's invocation. */
  tools: MycoToolDefinition<any>[];
  /** Reference to the original sink tool (with full schema), for harness-side invocation. */
  sinkTool: MycoToolDefinition<any>;
}

export function buildMapItemToolSurface(
  allTools: MycoToolDefinition<any>[],
  opts: BuildMapItemSurfaceOptions,
): MapItemToolSurface {
  const sinkTool = allTools.find((t) => t.name === opts.sinkName);
  if (!sinkTool) {
    throw new Error(`map-phase: sink tool "${opts.sinkName}" not found in tool registry`);
  }

  const readTools: MycoToolDefinition<any>[] = [];
  for (const name of opts.readToolNames) {
    const t = allTools.find((tt) => tt.name === name);
    if (!t) {
      throw new Error(`map-phase: read tool "${name}" not found in tool registry`);
    }
    if (t.annotations?.readOnlyHint !== true) {
      throw new Error(`map-phase: read tool "${name}" must have readOnlyHint: true`);
    }
    readTools.push(t);
  }

  const strippedSink = stripArgMapFromSchema(sinkTool, Object.keys(opts.argMap));

  return {
    tools: [strippedSink, ...readTools],
    sinkTool,
  };
}

function stripArgMapFromSchema(
  toolDef: MycoToolDefinition<any>,
  pinnedKeys: string[],
): MycoToolDefinition<any> {
  if (pinnedKeys.length === 0) return toolDef;
  const original = toolDef.inputSchema as Record<string, z.ZodTypeAny>;
  const pinnedSet = new Set(pinnedKeys);
  const filtered: Record<string, z.ZodTypeAny> = {};
  for (const [key, value] of Object.entries(original)) {
    if (!pinnedSet.has(key)) {
      filtered[key] = value;
    }
  }
  return {
    ...toolDef,
    inputSchema: filtered,
  };
}
