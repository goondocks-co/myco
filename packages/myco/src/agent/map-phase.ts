/**
 * Map-phase executor. Drives a fan-out workload by:
 *   1. Calling a configured source tool ONCE (no model) to fetch items.
 *   2. Invoking the harness once per item with a constrained tool surface
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
import type { AgentEmbeddingPort } from '@myco/agent/runtime/ports.js';
import { aggregateUsage } from './executor-state.js';
import { buildMapItemToolSurface } from './map-phase-tool-surface.js';
import { probeProviderAvailable, type ProviderAvailability } from './harness/provider-health.js';
import { isConnectionError } from './harness/classify-error.js';
import {
  HarnessExecutionError,
  type AgentHarness,
  type HarnessExecuteResult,
  type HarnessScope,
} from './harness/types.js';
import type { MapPhaseResult, PhaseDefinition, ProviderConfig, ReasoningLevel, RunLogger, RuntimeUsage } from './types.js';
import type { MycoToolDefinition } from '@myco/agent/tools/types.js';

export interface ExecuteMapPhaseInput {
  phase: PhaseDefinition;
  allTools: MycoToolDefinition<any>[];
  harness: AgentHarness;
  params: Record<string, unknown>;
  systemPrompt: string;
  runId: string;
  agentId: string;
  /** Resolved phase model (from outer phase resolution). Required for the harness adapter to pick the right model. Optional for stub-harness tests. */
  phaseModel?: string;
  /** Reasoning tier resolved for this phase by `resolvePhaseExecution`, sibling of `phaseModel`. Forwarded to the harness so it can set a provider-native thinking/reasoning-effort control. */
  reasoningLevel?: ReasoningLevel;
  /** Resolved provider config (task/phase override aware). Required for the harness adapter to pick the right backend. */
  provider?: ProviderConfig;
  /** Vault dir threaded into per-item toolSurface so freshly-built tools resolve project_id correctly. */
  vaultDir?: string;
  /** Project root threaded into per-item toolSurface (mirrors free-form path). */
  projectRoot?: string;
  /** Embedding manager threaded through so RAG-enabled tools work in flexible mode. */
  embeddingManager?: AgentEmbeddingPort;
  /** Run-level logger. Per-item failures emit debug entries through this. */
  logger?: RunLogger;
  /** Run-level abort controller. Aborting it stops current and future map items. */
  runAbortController?: AbortController;
  /**
   * Provider reachability probe, run once before the source fetch. Injectable
   * for tests; defaults to {@link probeProviderAvailable}. When it resolves
   * `available: false` the phase short-circuits with `providerUnavailable:
   * true` and zero items — no source fetch, no per-item harness calls
   * against a dead endpoint or a cloud provider missing its key.
   */
  probeAvailable?: (p: ProviderConfig | undefined) => Promise<ProviderAvailability>;
}

export async function executeMapPhase(input: ExecuteMapPhaseInput): Promise<MapPhaseResult> {
  const {
    phase, allTools, harness, params, systemPrompt, runId, agentId,
    phaseModel, reasoningLevel, provider, vaultDir, projectRoot, embeddingManager, logger,
    runAbortController,
  } = input;
  if (phase.mode !== 'map' || !phase.source || !phase.item || !phase.sink) {
    throw new Error(`executeMapPhase: phase "${phase.name}" is not a complete map phase`);
  }

  throwIfRunAborted(runAbortController);
  const probe = input.probeAvailable ?? probeProviderAvailable;
  const availability = await probe(provider);
  if (!availability.available) {
    logger?.info('agent.map.provider-unavailable', `Map phase "${phase.name}" skipped — provider unavailable`, {
      runId, phase: phase.name, reason: availability.reason,
    });
    return {
      itemCount: 0,
      written: 0,
      skipped: 0,
      failed: 0,
      abandoned: 0,
      skipReasons: {},
      writeAfterThrow: 0,
      providerUnavailable: true,
      unavailable: 0,
      usage: {},
    };
  }
  const items = await fetchSourceItems({ phase, allTools, params });
  throwIfRunAborted(runAbortController);
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
    providerUnavailable: false,
    unavailable: 0,
    usage: {},
  };

  // Raw source items whose disposition was a genuine content failure or skip
  // (model ran, produced no accepted write). Written items and
  // connection-unavailable items are never pushed here. Flushed to the
  // accounting tool once after the loop.
  const chargeItems: unknown[] = [];

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
  const strippedSink = sharedSurface.tools.find((t) => t.name === phase.sink!.tool);
  if (!strippedSink) {
    throw new Error(`map-phase: stripped sink tool "${phase.sink.tool}" missing from per-item surface`);
  }
  const sharedSinkWrapped = wrapSinkWithMutableContext(
    sharedSurface.sinkTool,
    strippedSink,
    sharedItemCtx,
  );
  const sharedTools = sharedSurface.tools.map((t) =>
    t.name === phase.sink!.tool ? sharedSinkWrapped : t,
  );
  const sharedToolSurface = {
    agentId, runId,
    toolNames: sharedTools.map((t) => t.name),
    projectRoot, vaultDir, embeddingManager,
    tools: sharedTools,
  };

  let scope: HarnessScope | undefined;
  if (typeof harness.openScope === 'function') {
    scope = await harness.openScope({
      systemPrompt,
      model: phaseModel ?? '',
      reasoningLevel,
      provider,
      toolSurface: sharedToolSurface,
      logger,
    });
  }

  try {
  for (const item of items) {
    throwIfRunAborted(runAbortController);
    const argMap = interpolateArgs(phase.sink.argMap, { item, params });
    const itemPrompt = interpolate(
      normalizedItemPrompt,
      flattenForInterpolate({ item, params }),
    );

    let sinkOutcome: { ok: boolean; reason?: string } | undefined;
    sharedItemCtx.argMap = argMap;
    sharedItemCtx.capture = (outcome) => {
      if (sinkOutcome?.ok === true && outcome.ok !== true) return;
      sinkOutcome = outcome;
    };

    const controller = new AbortController();
    const detachRunAbort = linkRunAbort(runAbortController, controller);
    const timer = phase.perItemTimeoutSeconds && phase.perItemTimeoutSeconds > 0
      ? setTimeout(
          () => controller.abort(new Error('per-item timeout')),
          phase.perItemTimeoutSeconds * 1000,
        )
      : null;
    try {
      const itemResult: HarnessExecuteResult = scope
        ? await scope.run({
            prompt: itemPrompt,
            maxTurns: phase.perItemMaxTurns ?? 1,
            abortController: controller,
          })
        : await harness.execute({
            prompt: itemPrompt,
            systemPrompt,
            model: phaseModel ?? '',
            reasoningLevel,
            maxTurns: phase.perItemMaxTurns ?? 1,
            provider,
            toolSurface: sharedToolSurface,
            abortController: controller,
            logger,
          });
      if (itemResult.usage) itemUsages.push(itemResult.usage);
    } catch (err) {
      if (runAbortController?.signal.aborted) throw toAbortError(runAbortController.signal.reason);
      const reason = toErrorMessage(err);
      if (err instanceof HarnessExecutionError && err.telemetry?.usage) {
        itemUsages.push(err.telemetry.usage);
      }
      // If the wrapped sink already wrote successfully before the harness
      // threw, count as written — the data side succeeded, only the SDK
      // termination glitched.
      if (sinkOutcome?.ok === true) {
        result.written += 1;
        result.writeAfterThrow += 1;
        logger?.debug('agent.map.item-write-then-throw', `Map phase "${phase.name}" item wrote successfully then harness threw`, {
          runId, phase: phase.name, item: (item as any)?.path ?? null, reason,
        });
        continue;
      }
      // A per-item timeout aborts THIS item's controller (not the run-level
      // one, which the rethrow above already handled). Its abort reason can
      // surface as a message matching a connection pattern (e.g. /timeout/),
      // but a per-item timeout is a per-item content-budget failure, NOT a
      // provider outage — it must fall through to the normal failed/skip path
      // and never open the circuit. A genuine harness connection error does not
      // abort the per-item controller, so this guard won't suppress real outages.
      const perItemTimedOut = controller.signal.aborted && !runAbortController?.signal.aborted;
      // Connection-class failure: the provider endpoint was never reached (or
      // dropped mid-request), so this item was not evaluated. Don't count it as
      // a content failure, and open the circuit — grinding the remaining items
      // against a dead endpoint is futile. Auth failures ('auth') halt the
      // same way: the run's credential state cannot change mid-batch, so
      // every remaining item would fail identically. The
      // `isConnectionError(reason)` message-fallback is a best-effort net for
      // adapters that don't set `telemetry.kind`; per-item timeouts are
      // deliberately excluded above.
      const kind = err instanceof HarnessExecutionError ? err.telemetry?.kind : undefined;
      if (!perItemTimedOut && (kind === 'connection' || kind === 'auth' || isConnectionError(reason))) {
        result.unavailable += 1;
        result.providerUnavailable = true;
        logger?.info('agent.map.item-unavailable', `Map phase "${phase.name}" item hit provider outage — circuit open, halting batch`, {
          runId, phase: phase.name, item: (item as any)?.path ?? null, reason,
        });
        break;
      }
      logger?.debug('agent.map.item-failed', `Map phase "${phase.name}" item failed`, {
        runId, phase: phase.name, item: (item as any)?.path ?? null, reason,
      });
      if ((phase.onItemError ?? 'skip') === 'abort') {
        throw err;
      }
      chargeItems.push(item);
      result.failed += 1;
      continue;
    } finally {
      if (timer) clearTimeout(timer);
      detachRunAbort();
    }

    if (sinkOutcome?.ok === true) {
      result.written += 1;
    } else if (sinkOutcome) {
      chargeItems.push(item);
      result.skipped += 1;
      const reason = sinkOutcome.reason ?? 'unknown';
      result.skipReasons[reason] = (result.skipReasons[reason] ?? 0) + 1;
    } else {
      chargeItems.push(item);
      result.skipped += 1;
      result.skipReasons.no_terminal_tool = (result.skipReasons.no_terminal_tool ?? 0) + 1;
    }
  }
  } finally {
    if (scope) await scope.close();
  }

  // Charge attempts for the content-failed/skip items. Reached even after a
  // connection `break`, so pre-outage content failures are still charged
  // while the outage item (never pushed) is not.
  if (phase.accounting && chargeItems.length > 0) {
    const accountingTool = allTools.find((t) => t.name === phase.accounting!.tool);
    if (accountingTool) {
      // The tool receives the raw source items (full rows) via a direct handler()
      // call that bypasses zod validation; the tool extracts .path itself — so
      // {items:[{path}]} is the MCP surface shape, not the in-process payload shape.
      await (accountingTool as any).handler({ items: chargeItems });
    } else {
      logger?.warn('agent.map.accounting-tool-missing', `Map phase "${phase.name}" accounting tool "${phase.accounting.tool}" not found — ${chargeItems.length} item(s) were NOT charged`, {
        runId, phase: phase.name, tool: phase.accounting.tool, itemCount: chargeItems.length,
      });
    }
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
  sinkTool: MycoToolDefinition<any>,
  exposedTool: MycoToolDefinition<any>,
  ctx: {
    argMap: Record<string, unknown>;
    capture: (outcome: { ok: boolean; reason?: string }) => void;
  },
): MycoToolDefinition<any> {
  return {
    ...exposedTool,
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
  allTools: MycoToolDefinition<any>[];
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

function throwIfRunAborted(runAbortController?: AbortController): void {
  if (!runAbortController?.signal.aborted) return;
  throw toAbortError(runAbortController.signal.reason);
}

function toAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === 'string' && reason.length > 0) return new Error(reason);
  return new Error('Agent run aborted');
}

function linkRunAbort(
  runAbortController: AbortController | undefined,
  itemController: AbortController,
): () => void {
  const signal = runAbortController?.signal;
  if (!signal) return () => undefined;

  const abortItem = () => {
    if (!itemController.signal.aborted) {
      itemController.abort(signal.reason ?? new Error('Agent run aborted'));
    }
  };

  if (signal.aborted) {
    abortItem();
    return () => undefined;
  }

  signal.addEventListener('abort', abortItem, { once: true });
  return () => signal.removeEventListener('abort', abortItem);
}
