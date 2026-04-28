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

import { errorMessage as toErrorMessage } from '@myco/utils/error-message.js';
import { getAtPath } from '@myco/utils/dot-path.js';
import { interpolateArgs } from '@myco/utils/interpolate-args.js';
import { interpolate } from '@myco/utils/interpolate.js';
import type { EmbeddingManager } from '@myco/daemon/embedding/manager.js';
import { aggregateUsage } from './executor-state.js';
import { buildMapItemToolSurface } from './map-phase-tool-surface.js';
import {
  RuntimeExecutionError,
  type AgentRuntime,
  type RuntimeExecuteResult,
  type RuntimeScope,
} from './runtime/types.js';
import type { MapPhaseResult, PhaseDefinition, ProviderConfig, RunLogger, RuntimeUsage } from './types.js';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';

export interface ExecuteMapPhaseInput {
  phase: PhaseDefinition;
  allTools: SdkMcpToolDefinition<any>[];
  runtime: AgentRuntime;
  params: Record<string, unknown>;
  systemPrompt: string;
  runId: string;
  agentId: string;
  /** Resolved phase model (from outer phase resolution). Required for the runtime adapter to pick the right model. Optional for stub-runtime tests. */
  phaseModel?: string;
  /** Resolved provider config (task/phase override aware). Required for the runtime adapter to pick the right backend. */
  provider?: ProviderConfig;
  /** Vault dir threaded into per-item toolSurface so freshly-built tools resolve project_id correctly. */
  vaultDir?: string;
  /** Project root threaded into per-item toolSurface (mirrors free-form path). */
  projectRoot?: string;
  /** Embedding manager threaded through so RAG-enabled tools work in flexible mode. */
  embeddingManager?: EmbeddingManager;
  /** Run-level logger. Per-item failures emit debug entries through this. */
  logger?: RunLogger;
}

export async function executeMapPhase(input: ExecuteMapPhaseInput): Promise<MapPhaseResult> {
  const {
    phase, allTools, runtime, params, systemPrompt, runId, agentId,
    phaseModel, provider, vaultDir, projectRoot, embeddingManager, logger,
  } = input;
  if (phase.mode !== 'map' || !phase.source || !phase.item || !phase.sink) {
    throw new Error(`executeMapPhase: phase "${phase.name}" is not a complete map phase`);
  }

  const items = await fetchSourceItems({ phase, allTools, params });
  logger?.debug('agent.map.fetched', `Map phase "${phase.name}" fetched ${items.length} items`, {
    runId, phase: phase.name, itemCount: items.length, source: phase.source.tool,
  });

  const itemUsages: RuntimeUsage[] = [];
  const result: MapPhaseResult = {
    itemCount: items.length,
    written: 0,
    skipped: 0,
    failed: 0,
    abandoned: 0,
    skipReasons: {},
    writeAfterThrow: 0,
    usage: {},
  };

  const normalizedItemPrompt = normalizeTemplateBraces(phase.item.prompt);
  const sharedItemCtx: {
    argMap: Record<string, unknown>;
    capture: (outcome: { ok: boolean; reason?: string }) => void;
  } = {
    argMap: {},
    capture: () => undefined,
  };
  // The sink schema and read tools are fixed for the phase — only argMap
  // values change per item. Build the surface once; the wrapped sink reads
  // per-item state from sharedItemCtx.
  const sharedSurface = buildMapItemToolSurface(allTools, {
    sinkName: phase.sink.tool,
    argMap: phase.sink.argMap,
    readToolNames: phase.item.readTools ?? [],
  });
  const sharedSinkWrapped = wrapSinkWithMutableContext(sharedSurface.sinkTool, sharedItemCtx);
  const sharedTools = sharedSurface.tools.map((t) =>
    t.name === phase.sink!.tool ? sharedSinkWrapped : t,
  );
  const sharedToolSurface = {
    agentId, runId,
    toolNames: sharedTools.map((t) => t.name),
    projectRoot, vaultDir, embeddingManager,
    tools: sharedTools,
  };

  let scope: RuntimeScope | undefined;
  if (typeof runtime.openScope === 'function') {
    scope = await runtime.openScope({
      systemPrompt,
      model: phaseModel ?? '',
      provider,
      toolSurface: sharedToolSurface,
      logger,
    });
  }

  try {
  for (const item of items) {
    const argMap = interpolateArgs(phase.sink.argMap, { item, params });
    const itemPrompt = interpolate(
      normalizedItemPrompt,
      flattenForInterpolate({ item, params }),
    );

    let sinkOutcome: { ok: boolean; reason?: string } | undefined;
    sharedItemCtx.argMap = argMap;
    sharedItemCtx.capture = (outcome) => { sinkOutcome = outcome; };

    const controller = new AbortController();
    const timer = phase.perItemTimeoutSeconds && phase.perItemTimeoutSeconds > 0
      ? setTimeout(
          () => controller.abort(new Error('per-item timeout')),
          phase.perItemTimeoutSeconds * 1000,
        )
      : null;
    try {
      const itemResult: RuntimeExecuteResult = scope
        ? await scope.run({
            prompt: itemPrompt,
            maxTurns: phase.perItemMaxTurns ?? 1,
            abortController: controller,
          })
        : await runtime.execute({
            prompt: itemPrompt,
            systemPrompt,
            model: phaseModel ?? '',
            maxTurns: phase.perItemMaxTurns ?? 1,
            provider,
            toolSurface: sharedToolSurface,
            abortController: controller,
            logger,
          });
      if (itemResult.usage) itemUsages.push(itemResult.usage);
    } catch (err) {
      const reason = toErrorMessage(err);
      if (err instanceof RuntimeExecutionError && err.telemetry?.usage) {
        itemUsages.push(err.telemetry.usage);
      }
      // If the wrapped sink already wrote successfully before the runtime
      // threw, count as written — the data side succeeded, only the SDK
      // termination glitched.
      if (sinkOutcome?.ok === true) {
        result.written += 1;
        result.writeAfterThrow += 1;
        logger?.debug('agent.map.item-write-then-throw', `Map phase "${phase.name}" item wrote successfully then runtime threw`, {
          runId, phase: phase.name, item: (item as any)?.path ?? null, reason,
        });
        continue;
      }
      logger?.debug('agent.map.item-failed', `Map phase "${phase.name}" item failed`, {
        runId, phase: phase.name, item: (item as any)?.path ?? null, reason,
      });
      if ((phase.onItemError ?? 'skip') === 'abort') {
        throw err;
      }
      result.failed += 1;
      continue;
    } finally {
      if (timer) clearTimeout(timer);
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
  } finally {
    if (scope) await scope.close();
  }

  result.usage = aggregateUsage(itemUsages);
  return result;
}

/**
 * Wrap the sink tool with a closure that reads its per-item argMap and
 * capture target from a mutable context object. Used in scoped mode so
 * the same wrapped sink instance can be embedded in the shared MCP server
 * yet still record per-item outcomes correctly when scope.run() is
 * called serially across N items.
 */
function wrapSinkWithMutableContext(
  sinkTool: SdkMcpToolDefinition<any>,
  ctx: {
    argMap: Record<string, unknown>;
    capture: (outcome: { ok: boolean; reason?: string }) => void;
  },
): SdkMcpToolDefinition<any> {
  return {
    ...sinkTool,
    handler: async (modelArgs: Record<string, unknown>) => {
      const merged = { ...modelArgs, ...ctx.argMap };
      const response = await (sinkTool as any).handler(merged);
      const text = (response?.content?.[0] as any)?.text;
      if (typeof text === 'string') {
        try {
          const parsed = JSON.parse(text);
          ctx.capture({ ok: parsed.ok === true, reason: parsed.reason });
        } catch {
          ctx.capture({ ok: false, reason: 'sink_response_unparseable' });
        }
      } else {
        ctx.capture({ ok: false, reason: 'sink_response_missing_text' });
      }
      return response;
    },
  };
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
  const items = getAtPath(parsed, phase.source!.itemsPath);
  if (!Array.isArray(items)) {
    throw new Error(`executeMapPhase: itemsPath "${phase.source!.itemsPath}" did not resolve to an array`);
  }
  return items;
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
