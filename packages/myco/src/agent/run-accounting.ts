import type { RunUpdate } from '@myco/db/queries/runs.js';
import type { CostResolution } from './cost/types.js';
import {
  buildActionsTaken,
  buildUsageData,
  serializeCheckpointState,
  type RunCheckpointState,
} from './executor-state.js';
import { inferDefaultContextWindowFromProviderType } from './provider-runtime.js';
import type { PhaseResult, ProviderConfig, RuntimeId, RuntimeTokenBudget, RuntimeUsage } from './types.js';

const TOKEN_BUDGET_WARNING_PERCENT = 75;
const TOKEN_BUDGET_CRITICAL_PERCENT = 90;

/**
 * Compute the elapsed duration of a run in milliseconds. Returns `null`
 * unless both timestamps are populated. Started/completed timestamps on
 * `agent_runs` are stored in seconds; this helper converts to ms for UI
 * consumers that expect millisecond precision.
 */
export function runDurationMs(run: {
  started_at: number | null;
  completed_at: number | null;
}): number | null {
  if (run.started_at === null || run.completed_at === null) return null;
  return (run.completed_at - run.started_at) * 1000;
}

function toRequestTokenNumber(
  entry: Record<string, unknown>,
  key: 'inputTokens' | 'outputTokens' | 'totalTokens',
): number {
  const value = entry[key];
  return typeof value === 'number' ? value : 0;
}

function resolveContextWindow(
  provider: ProviderConfig | undefined,
  usage: RuntimeUsage,
): { tokens: number | null; source?: RuntimeTokenBudget['contextWindowSource'] } {
  if (provider?.contextLength) {
    return { tokens: provider.contextLength, source: 'provider-config' };
  }
  const providerData = usage.providerData;
  if (providerData) {
    const candidates = [
      providerData.contextWindowTokens,
      providerData.context_window,
      providerData.maxContextTokens,
      providerData.max_context_tokens,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'number' && candidate > 0) {
        return { tokens: candidate, source: 'provider-metadata' };
      }
    }
  }
  const providerDefault = inferDefaultContextWindowFromProviderType(provider?.type);
  if (providerDefault) {
    return { tokens: providerDefault, source: 'provider-default' };
  }
  return { tokens: null };
}

export function analyzeRuntimeTokenBudget(
  usage: RuntimeUsage,
  provider?: ProviderConfig,
): RuntimeTokenBudget {
  const requestEntries = usage.requestUsageEntries && usage.requestUsageEntries.length > 0
    ? usage.requestUsageEntries
    : [{
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        totalTokens: usage.totalTokens ?? (
          (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
        ),
      }];
  let peakRequestInputTokens = 0;
  let peakRequestOutputTokens = 0;
  let peakRequestTotalTokens = 0;
  for (const entry of requestEntries) {
    const input = toRequestTokenNumber(entry, 'inputTokens');
    const output = toRequestTokenNumber(entry, 'outputTokens');
    const total = toRequestTokenNumber(entry, 'totalTokens');
    if (input > peakRequestInputTokens) peakRequestInputTokens = input;
    if (output > peakRequestOutputTokens) peakRequestOutputTokens = output;
    if (total > peakRequestTotalTokens) peakRequestTotalTokens = total;
  }
  const { tokens: contextWindowTokens, source: contextWindowSource } = resolveContextWindow(provider, usage);

  if (!contextWindowTokens) {
    return {
      contextWindowTokens: null,
      peakRequestInputTokens: peakRequestInputTokens || null,
      peakRequestOutputTokens: peakRequestOutputTokens || null,
      peakRequestTotalTokens: peakRequestTotalTokens || null,
      utilizationPercent: null,
      headroomTokens: null,
      status: 'unknown',
      message: 'Context window unavailable for this provider/model.',
    };
  }

  const utilizationPercent = peakRequestTotalTokens > 0
    ? Math.round((peakRequestTotalTokens / contextWindowTokens) * 100)
    : 0;
  const headroomTokens = Math.max(0, contextWindowTokens - peakRequestTotalTokens);
  const status = utilizationPercent >= TOKEN_BUDGET_CRITICAL_PERCENT
    ? 'critical'
    : utilizationPercent >= TOKEN_BUDGET_WARNING_PERCENT
      ? 'warning'
      : 'ok';
  const statusMessage = status === 'critical'
    ? 'Run operated near the model context limit.'
    : status === 'warning'
      ? 'Run used a large share of the model context window.'
      : undefined;
  const isInferredWindow = contextWindowSource === 'provider-default';
  const message = isInferredWindow
    ? (statusMessage
        ? `${statusMessage} Using inferred provider default context window.`
        : 'Using inferred provider default context window.')
    : statusMessage;

  return {
    contextWindowTokens,
    ...(contextWindowSource ? { contextWindowSource } : {}),
    peakRequestInputTokens: peakRequestInputTokens || null,
    peakRequestOutputTokens: peakRequestOutputTokens || null,
    peakRequestTotalTokens: peakRequestTotalTokens || null,
    utilizationPercent,
    headroomTokens,
    status,
    ...(message ? { message } : {}),
  };
}

export function serializeCostData(cost: CostResolution | undefined): string | null {
  return cost ? JSON.stringify(cost) : null;
}

export function summarizePhaseCosts(phaseResults: PhaseResult[]): CostResolution {
  const costedPhases = phaseResults.filter((phase) => phase.costData && phase.costData.costUsd !== null);
  if (costedPhases.length === 0) {
    return {
      source: 'unavailable',
      costUsd: null,
      actualCostUsd: null,
      estimatedCostUsd: null,
      breakdown: {
        inputTokens: 0,
        cachedInputTokens: 0,
        uncachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        requestCount: 0,
      },
      pricingVersion: null,
      message: 'No phase cost data available',
    };
  }

  const firstCost = costedPhases[0].costData!;
  const aggregate = {
    costUsd: 0,
    actualCostUsd: 0,
    estimatedCostUsd: 0,
    breakdown: {
      inputTokens: 0,
      cachedInputTokens: 0,
      uncachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      requestCount: 0,
      inputCostUsd: 0,
      cachedInputCostUsd: 0,
      outputCostUsd: 0,
      reasoningCostUsd: 0,
      requestCostUsd: 0,
      cacheSavingsUsd: 0,
      totalCostUsd: 0,
    },
  };

  for (const phase of costedPhases) {
    const cost = phase.costData!;
    const breakdown = cost.breakdown;
    aggregate.costUsd += cost.costUsd ?? 0;
    aggregate.actualCostUsd += cost.actualCostUsd ?? 0;
    aggregate.estimatedCostUsd += cost.estimatedCostUsd ?? 0;
    aggregate.breakdown.inputTokens += breakdown.inputTokens;
    aggregate.breakdown.cachedInputTokens += breakdown.cachedInputTokens;
    aggregate.breakdown.uncachedInputTokens += breakdown.uncachedInputTokens;
    aggregate.breakdown.outputTokens += breakdown.outputTokens;
    aggregate.breakdown.reasoningTokens += breakdown.reasoningTokens;
    aggregate.breakdown.requestCount += breakdown.requestCount;
    aggregate.breakdown.inputCostUsd += breakdown.inputCostUsd ?? 0;
    aggregate.breakdown.cachedInputCostUsd += breakdown.cachedInputCostUsd ?? 0;
    aggregate.breakdown.outputCostUsd += breakdown.outputCostUsd ?? 0;
    aggregate.breakdown.reasoningCostUsd += breakdown.reasoningCostUsd ?? 0;
    aggregate.breakdown.requestCostUsd += breakdown.requestCostUsd ?? 0;
    aggregate.breakdown.cacheSavingsUsd += breakdown.cacheSavingsUsd ?? 0;
  }
  aggregate.breakdown.totalCostUsd = aggregate.costUsd;

  const allActual = phaseResults.every((phase) => phase.costData?.source === 'actual');
  const hasUnavailable = phaseResults.some((phase) => phase.costData?.source === 'unavailable');
  return {
    source: allActual ? 'actual' : 'estimated',
    costUsd: aggregate.costUsd,
    actualCostUsd: allActual ? aggregate.actualCostUsd : null,
    estimatedCostUsd: allActual ? null : aggregate.costUsd,
    breakdown: aggregate.breakdown,
    pricingVersion: costedPhases.every((phase) => phase.costData?.pricingVersion === firstCost.pricingVersion)
      ? firstCost.pricingVersion ?? null
      : null,
    ...(hasUnavailable ? { message: 'Some phase costs were unavailable; total reflects known phase costs only' } : {}),
  };
}

interface RunAccountingUpdateInput {
  runtime: RuntimeId;
  provider?: ProviderConfig;
  model: string;
  checkpointState: RunCheckpointState;
  usage: RuntimeUsage;
  costData: CostResolution;
  phaseResults?: PhaseResult[];
  sessionRef?: string | null;
}

interface RunAccountingUpdateFields extends Pick<
  RunUpdate,
  | 'runtime'
  | 'provider'
  | 'model'
  | 'session_ref'
  | 'checkpoints'
  | 'usage_data'
  | 'cost_usd'
  | 'actual_cost_usd'
  | 'estimated_cost_usd'
  | 'cost_source'
  | 'cost_data'
> {
  actions_taken: string;
}

export function buildRunAccountingUpdate(input: RunAccountingUpdateInput): RunAccountingUpdateFields {
  const tokenBudget = analyzeRuntimeTokenBudget(input.usage, input.provider);
  return {
    runtime: input.runtime,
    provider: input.provider?.type ?? null,
    model: input.model,
    session_ref: input.sessionRef ?? input.checkpointState.sessionRef ?? null,
    checkpoints: serializeCheckpointState(input.checkpointState),
    usage_data: buildUsageData(input.usage, input.costData, input.phaseResults, tokenBudget),
    cost_usd: input.costData.costUsd ?? null,
    actual_cost_usd: input.costData.actualCostUsd,
    estimated_cost_usd: input.costData.estimatedCostUsd,
    cost_source: input.costData.source,
    cost_data: serializeCostData(input.costData),
    actions_taken: buildActionsTaken(input.runtime, input.provider, input.model, input.phaseResults),
  };
}
